import { spawn } from "bun";
import { COLOR } from "../format.ts";
import { post, checkDaemon, printDaemonDown } from "../client.ts";

interface RunArgs {
  hard?: boolean;
}

// Recover from a stuck popup pipeline. Soft = clear daemon state in-process
// (preserves TLS / SSE). --hard = launchctl kickstart the whole daemon.
export async function run(args: RunArgs): Promise<void> {
  if (args.hard) {
    await hardReset();
    return;
  }
  await softReset();
}

async function softReset(): Promise<void> {
  if (!(await checkDaemon())) {
    printDaemonDown(`for a full restart, try: ${COLOR.bold}kura reset --hard${COLOR.reset}`);
    process.exit(1);
  }
  let cleared = 0;
  try {
    const result = (await post("/requests/reset", {})) as { ok: boolean; cleared: number };
    cleared = result.cleared ?? 0;
  } catch (err) {
    console.error(`${COLOR.red}reset endpoint failed${COLOR.reset}: ${(err as Error).message}`);
    process.exit(1);
  }
  const killed = await pkillKuraPopup();
  console.log(`${COLOR.green}OK${COLOR.reset} cleared ${cleared} pending, killed ${killed} popup process(es)`);
}

async function hardReset(): Promise<void> {
  // Best-effort soft prep: nuke orphan popup processes first so the daemon
  // restart doesn't race with them. Failure here is non-fatal.
  await pkillKuraPopup();
  const uid = process.getuid?.() ?? 0;
  // Try the brew-installed daemon label first. If launchctl can't find it
  // (dev install / different label / not under brew services), fall back to
  // pkill on the daemon process itself so the user still gets a restart.
  const label = `homebrew.mxcl.kura`;
  const target = `gui/${uid}/${label}`;
  const kick = spawn({
    cmd: ["launchctl", "kickstart", "-k", target],
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await kick.exited;
  if (code === 0) {
    console.log(`${COLOR.green}OK${COLOR.reset} kickstarted ${COLOR.bold}${label}${COLOR.reset}`);
    return;
  }
  const stderr = (await new Response(kick.stderr).text()).trim();
  console.log(`${COLOR.yellow}launchctl kickstart failed${COLOR.reset}: ${stderr}`);
  console.log(`${COLOR.dim}falling back to pkill kura daemon...${COLOR.reset}`);
  const proc = spawn({ cmd: ["pkill", "-f", "kura daemon"], stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  console.log(`${COLOR.green}OK${COLOR.reset} signalled daemon, restart it manually if not under launchd`);
}

// Match both the compiled brew binary (kura popup <id>) and dev mode
// (bun --preload ... popup <id>). macOS pgrep/pkill lack a -c count flag,
// so we count pgrep's output then kill in a second pass.
async function pkillKuraPopup(): Promise<number> {
  const pg = spawn({ cmd: ["pgrep", "-f", "kura popup"], stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(pg.stdout).text()).trim();
  await pg.exited;
  if (!out) return 0;
  const count = out.split("\n").filter((l) => l.length > 0).length;
  const pk = spawn({ cmd: ["pkill", "-f", "kura popup"], stdout: "pipe", stderr: "pipe" });
  await pk.exited;
  return count;
}
