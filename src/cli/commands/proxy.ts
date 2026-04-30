import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type Subprocess } from "bun";
import { getConfig } from "../../core/config.ts";
import { start as startProxy, caInstalled } from "../../proxy/index.ts";
import { KURA_HOME } from "../../core/paths.ts";
import { resolveSelfBinary, isCompiledBinary } from "../../core/self-binary.ts";

function installCrashLoggers(prefix: string): void {
  process.on("uncaughtException", (err) => {
    console.error(`${prefix} uncaughtException: ${err.stack ?? err.message ?? String(err)}`);
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(`${prefix} unhandledRejection: ${msg}`);
  });
}

interface RunArgs {
  port?: number;
  domain?: string | string[];
  noPac?: boolean;
  installLaunchd?: boolean;
  uninstallLaunchd?: boolean;
}

const PLIST_LABEL = "xyz.kura.proxy";
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);

export async function run(args: RunArgs): Promise<void> {
  if (args.installLaunchd) return installLaunchd();
  if (args.uninstallLaunchd) return uninstallLaunchd();

  // KURA_PROXY_CHILD=1 forces child mode (used by the supervisor when respawning).
  // Production (compiled binary) wraps the child in a supervisor for crash recovery.
  // Dev (`bun run`) skips the supervisor: easier to ^C-iterate on, and `bun proxy`
  // wouldn't dispatch correctly anyway since bun would treat it as a script path.
  if (process.env.KURA_PROXY_CHILD === "1") return runChild(args);
  if (!isCompiledBinary()) return runChild(args);
  return runSupervisor();
}

async function runChild(args: RunArgs): Promise<void> {
  installCrashLoggers("[kura-proxy]");

  if (!caInstalled()) {
    console.error("mkcert root CA not found. Install via: brew install mkcert nss && mkcert -install");
    process.exit(1);
  }
  const cfg = await getConfig();
  const domains = arrayOf(args.domain) ?? cfg.proxyDomains;
  const port = args.port ?? cfg.proxyPort;
  const handle = await startProxy({
    host: cfg.daemonHost,
    port,
    domains,
    writePac: args.noPac !== true,
  });
  console.log(`kura csp-strip proxy listening on http://${handle.host}:${handle.port}`);
  console.log(`domains: ${handle.domains.join(", ")}`);
  if (handle.pacPath) console.log(`pac: ${handle.pacPath}`);
  console.log(`pid ${process.pid} (child of supervisor pid ${process.ppid})`);
  const shutdown = async (signal: string) => {
    console.log(`\n[kura-proxy] received ${signal}, stopping`);
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  await new Promise<void>(() => {});
}

async function runSupervisor(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[kura-proxy-supervisor] starting at ${startedAt}, supervisor pid ${process.pid}`);

  let shutdown = false;
  let child: Subprocess | null = null;
  let backoffMs = 1000;
  let restartCount = 0;
  let childStartedAt = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const env = { ...process.env, KURA_PROXY_CHILD: "1" };
  // In a compiled bun binary, argv[1] is the embedded entry script
  // (`/$bunfs/root/index.js`); user args start at argv[2].
  const childArgs = process.argv.slice(2);

  const spawnChild = (): Subprocess => {
    let selfBin: string;
    try {
      selfBin = resolveSelfBinary();
    } catch (err) {
      console.error(`[kura-proxy-supervisor] cannot find kura binary: ${(err as Error).message}`);
      process.exit(1);
    }
    childStartedAt = Date.now();
    const proc = spawn({
      cmd: [selfBin, ...childArgs],
      stdout: "inherit",
      stderr: "inherit",
      env,
    });
    proc.exited.then((code) => onChildExit(code)).catch((err) => {
      console.error(`[kura-proxy-supervisor] child wait failed: ${(err as Error).message}`);
      onChildExit(-1);
    });
    return proc;
  };

  const onChildExit = (code: number | null) => {
    if (shutdown) return;
    const upMs = Date.now() - childStartedAt;
    console.error(`[kura-proxy-supervisor] child exited code=${code} after ${upMs}ms`);
    // Reset backoff if the child ran cleanly for a full minute. A flapping
    // child (e.g. stuck in a config error) keeps escalating up to 30s so we
    // don't burn CPU spawning forever.
    backoffMs = upMs > 60_000 ? 1000 : Math.min(backoffMs * 2, 30_000);
    restartCount += 1;
    console.error(`[kura-proxy-supervisor] restart #${restartCount} in ${backoffMs}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (shutdown) return;
      child = spawnChild();
    }, backoffMs);
  };

  const stop = (signal: string) => {
    if (shutdown) return;
    shutdown = true;
    console.log(`[kura-proxy-supervisor] received ${signal}, stopping (restarted ${restartCount}x)`);
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (child) {
      try { child.kill("SIGTERM"); } catch {}
      // Escalate to SIGKILL if the child hasn't exited in 3s, otherwise an
      // unresponsive child would hang qb's atexit cleanup chain.
      setTimeout(() => {
        if (child && child.exitCode === null) {
          console.error(`[kura-proxy-supervisor] child still alive after SIGTERM, escalating to SIGKILL`);
          try { child.kill("SIGKILL"); } catch {}
        }
        process.exit(0);
      }, 3000);
    } else {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGHUP", () => stop("SIGHUP"));
  installCrashLoggers("[kura-proxy-supervisor]");

  child = spawnChild();
  await new Promise<void>(() => {});
}

async function installLaunchd(): Promise<void> {
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  await mkdir(plistDir, { recursive: true });
  const bunBin = process.execPath;
  const entry = process.argv[1] ?? "kura";
  const logDir = join(KURA_HOME, "logs");
  await mkdir(logDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunBin}</string>
    <string>${entry}</string>
    <string>proxy</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(logDir, "proxy.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(logDir, "proxy.err.log")}</string>
  <key>WorkingDirectory</key><string>${process.cwd()}</string>
</dict>
</plist>
`;
  await writeFile(PLIST_PATH, plist);
  console.log(`wrote ${PLIST_PATH}`);
  console.log(`activate now with:`);
  console.log(`  launchctl load -w ${PLIST_PATH}`);
  console.log(`(this makes the proxy survive daemon restarts AND machine reboots)`);
}

async function uninstallLaunchd(): Promise<void> {
  if (!existsSync(PLIST_PATH)) {
    console.log("no proxy launchd plist installed");
    return;
  }
  console.log(`disable + remove with:`);
  console.log(`  launchctl unload -w ${PLIST_PATH} && rm ${PLIST_PATH}`);
}

function arrayOf(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}
