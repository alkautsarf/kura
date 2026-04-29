import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../../core/config.ts";
import { start as startProxy, caInstalled } from "../../proxy/index.ts";
import { KURA_HOME } from "../../core/paths.ts";

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
  console.log(`pid ${process.pid}`);
  const shutdown = async (signal: string) => {
    console.log(`\nreceived ${signal}, stopping proxy`);
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
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
