import { spawn } from "bun";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { PendingRequest, RiskResult, SimulationResult } from "../core/types.ts";
import type { SemanticTx } from "../core/decode-tx.ts";
import { emit } from "./events.ts";
import { logAudit } from "../core/audit-log.ts";
import { resolveSelfBinary, isCompiledBinary } from "../core/self-binary.ts";

// When daemon is started under launchd / brew services, PATH is bare
// (/usr/bin:/bin:/usr/sbin:/sbin) and Homebrew binaries like tmux aren't
// reachable. Resolve tmux's absolute path once at module load. Falls back
// to "tmux" if none of the standard paths exist (assumes PATH-resolvable).
const TMUX_BIN = (() => {
  for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    if (existsSync(p)) return p;
  }
  return "tmux";
})();

export type Decision = "approve" | "reject" | "timeout";

export interface PendingEntry {
  request: PendingRequest;
  simulation?: SimulationResult;
  risk?: RiskResult;
  semantic?: SemanticTx;
  enriched: boolean;
  resolver: (result: { decision: Decision; txHash?: string; error?: string }) => void;
  resolved: boolean;
}

const queue = new Map<string, PendingEntry>();

// tmux display-popup is single-slot per attached client: a second invocation
// while one popup is open returns exit 0 but silently drops the inner shell
// command. Serialize spawns ourselves so anima-style rapid-fire flows (connect
// then personal_sign in the same tick) don't lose their second popup.
let currentPopupId: string | null = null;

function drainQueue(): void {
  if (currentPopupId !== null) return;
  const next = [...queue.values()].find((e) => !e.resolved);
  if (!next) return;
  currentPopupId = next.request.id;
  spawnPopup(next.request.id).catch((err) => {
    if (currentPopupId === next.request.id) currentPopupId = null;
    if (!next.resolved) {
      next.resolver({ decision: "reject", error: `popup spawn failed: ${err.message}` });
    }
    drainQueue();
  });
}

export function enqueue(
  request: PendingRequest,
  meta: { simulation?: SimulationResult; risk?: RiskResult; semantic?: SemanticTx } = {},
): Promise<{ decision: Decision; txHash?: string; error?: string }> {
  return new Promise((resolve) => {
    const entry: PendingEntry = {
      request,
      simulation: meta.simulation,
      risk: meta.risk,
      semantic: meta.semantic,
      enriched: meta.simulation !== undefined || meta.risk !== undefined || meta.semantic !== undefined,
      resolved: false,
      resolver: (result) => {
        if (entry.resolved) return;
        entry.resolved = true;
        queue.delete(request.id);
        emit("request:resolved", { id: request.id, decision: result.decision });
        logAudit("request_resolved", {
          id: request.id,
          source: request.source,
          decision: result.decision,
          chainId: request.chainId,
          kind: request.kind,
        });
        resolve(result);
      },
    };
    queue.set(request.id, entry);
    emit("request:pending", { id: request.id, kind: request.kind, source: request.source });
    // drainQueue spawns immediately if no popup is currently rendering, else
    // leaves the entry queued. proc.exited drains the next one when the
    // current popup's tmux process fully exits (not when /decision lands).
    drainQueue();
  });
}

export function enrich(
  id: string,
  meta: { simulation?: SimulationResult; risk?: RiskResult; semantic?: SemanticTx },
): void {
  const entry = queue.get(id);
  if (!entry) return;
  if (meta.simulation !== undefined) entry.simulation = meta.simulation;
  if (meta.risk !== undefined) entry.risk = meta.risk;
  if (meta.semantic !== undefined) entry.semantic = meta.semantic;
  entry.enriched = true;
  emit("request:enriched", { id });
}

export function get(id: string): PendingEntry | undefined {
  return queue.get(id);
}

export function list(): PendingEntry[] {
  return [...queue.values()];
}

export function decide(
  id: string,
  decision: Decision,
  result: { txHash?: string; error?: string } = {},
): boolean {
  const entry = queue.get(id);
  if (!entry || entry.resolved) return false;
  entry.resolver({ decision, ...result });
  return true;
}

function entrypoint(): string {
  const arg = process.argv[1];
  if (!arg) return "";
  return resolvePath(arg);
}

async function spawnPopup(id: string): Promise<void> {
  const entry = entrypoint();
  const logFile = `/tmp/kura-popup-${id.slice(0, 8)}.log`;
  // Detect compiled-binary mode (`kura` shipped via brew) vs dev mode (`bun run`).
  // In compiled mode the bun JSX transform already ran at build time, so no
  // --preload is needed. The binary itself dispatches `popup <id>` directly,
  // so the entry script path is irrelevant — argv[1] is the subcommand name.
  const compiled = isCompiledBinary();
  const selfBin = compiled ? resolveSelfBinary() : process.execPath;
  const popupCmd = compiled
    ? `${selfBin} popup ${id} 2>${logFile}`
    : `${selfBin} --preload @opentui/solid/preload ${entry} popup ${id} 2>${logFile}`;
  // Optional override: spawn into a fixed tmux pane so a tester can drive keypresses.
  // Set KURA_POPUP_PANE=main:5 (or similar) on the daemon process.
  const targetPane = process.env.KURA_POPUP_PANE;
  if (targetPane) {
    const proc = spawn({
      cmd: [TMUX_BIN, "send-keys", "-t", targetPane, `clear; ${popupCmd}`, "Enter"],
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.exited.then((code) => {
      if (code !== 0) {
        new Response(proc.stderr).text()
          .then((err) => console.warn(`[daemon] popup-pane spawn failed (${targetPane}) code=${code}: ${err.slice(0, 200)}`))
          .catch(() => {});
      }
      onPopupExited(id, code);
    }).catch(() => onPopupExited(id, -1));
    return;
  }
  // Resolve tmux target. When daemon was started inside tmux (manual launch),
  // $TMUX is set and tmux uses it as implicit target. When started under
  // launchd / brew services, $TMUX is empty — discover the attached session
  // by querying the tmux server directly. Without explicit -t, display-popup
  // would fail silently with no client attached.
  const extraArgs: string[] = [];
  if (!process.env.TMUX) {
    const session = await findAttachedTmuxSession();
    if (!session) {
      // No UI surface to render into. Reject the entry so the dapp's HTTP
      // request unblocks instead of hanging, then drain so a subsequent
      // request with a reachable tmux still gets a shot.
      console.warn(`[daemon] no tmux server reachable, rejecting popup: ${popupCmd}`);
      onPopupExited(id, -1);
      return;
    }
    extraArgs.push("-t", session);
  }
  // Steal focus FIRST so Ghostty is foregrounded by the time the popup
  // renders inside it. Calling activate after spawn races: tmux sometimes
  // shows the popup before macOS finishes the activate, leaving qb on top.
  focusTerminalApp().catch((err) => console.warn(`[daemon] focus failed: ${err.message}`));
  // -B = no tmux popup border (the inner opentui box already draws one).
  // -w/-h = popup size as % of pane.
  const proc = spawn({
    cmd: [TMUX_BIN, "display-popup", "-E", "-B", "-d", process.cwd(), "-w", "70%", "-h", "60%", ...extraArgs, popupCmd],
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.exited.then((code) => {
    if (code !== 0) {
      new Response(proc.stderr).text()
        .then((err) => console.warn(`[daemon] popup ${id.slice(0, 8)} exit ${code}: ${err.slice(0, 200)} (also see ${logFile})`))
        .catch(() => {});
    }
    onPopupExited(id, code);
  }).catch(() => onPopupExited(id, -1));
}

// Auto-reject the entry if the popup died without posting /decision (tmux
// silent-drop, crash, SIGKILL, terminal close), then advance the queue.
// Double-resolve is guarded inside resolver, so this is safe if /decision
// already landed.
function onPopupExited(id: string, code: number): void {
  const entry = queue.get(id);
  if (entry && !entry.resolved) {
    console.warn(`[daemon] popup ${id.slice(0, 8)} exited without /decision (code ${code}), auto-rejecting`);
    entry.resolver({ decision: "reject", error: `popup exited without decision (code ${code})` });
  }
  if (currentPopupId === id) {
    currentPopupId = null;
    drainQueue();
  }
}

async function findAttachedTmuxSession(): Promise<string | null> {
  try {
    const proc = spawn({
      cmd: [TMUX_BIN, "list-sessions", "-F", "#{session_name} #{?session_attached,attached,detached}"],
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await proc.exited) !== 0) return null;
    const text = await new Response(proc.stdout).text();
    const lines = text.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    const attached = lines.find((l) => l.endsWith("attached"));
    return (attached ?? lines[0])!.split(" ")[0] ?? null;
  } catch {
    return null;
  }
}

// Bring the terminal emulator that hosts tmux to the foreground so the user
// can immediately press a/r without alt-tabbing from the browser.
// Inside tmux, TERM_PROGRAM is "tmux" (masking the real emulator), so we
// instead probe System Events for the first running terminal-class app and
// activate it. macOS only (osascript). Override via env KURA_TERM_APP.
async function focusTerminalApp(): Promise<void> {
  if (process.platform !== "darwin") return;
  const override = process.env.KURA_TERM_APP;
  // Detect the running terminal app first.
  const detectScript = override
    ? `return "${override}"`
    : `
tell application "System Events"
  set termApps to {"Ghostty", "iTerm", "iTerm2", "Terminal", "WezTerm", "kitty", "Alacritty", "Warp", "Hyper", "tabby"}
  repeat with appName in termApps
    if exists (application process appName) then
      return appName as string
    end if
  end repeat
  return ""
end tell`.trim();
  const detect = spawn({ cmd: ["osascript", "-e", detectScript], stdout: "pipe", stderr: "ignore" });
  const detected = (await new Response(detect.stdout).text()).trim();
  if (!detected) {
    console.warn(`[daemon] focusTerminalApp: no known terminal app running`);
    return;
  }

  // Two-pronged focus:
  // 1. `open -a` is treated as user-initiated by macOS LaunchServices, so it
  //    bypasses the "background process can't steal focus" guard that breaks
  //    plain AppleScript `activate` when qutebrowser is the user's frontmost.
  // 2. AppleScript `set frontmost` after as a belt-and-suspenders for cases
  //    where `open -a` only re-launches without focusing (rare).
  const openProc = spawn({ cmd: ["open", "-a", detected], stdout: "ignore", stderr: "pipe" });
  const openCode = await openProc.exited.catch(() => -1);
  if (openCode !== 0) {
    const err = await new Response(openProc.stderr).text();
    console.warn(`[daemon] open -a ${detected} exit=${openCode}: ${err.slice(0, 200)}`);
  }
  const frontProc = spawn({
    cmd: ["osascript", "-e", `tell application "System Events" to set frontmost of process "${detected}" to true`],
    stdout: "ignore", stderr: "ignore",
  });
  await frontProc.exited.catch(() => {});

  // Belt #3: macOS notification with sound. Always grabs attention even if
  // both focus calls were ignored — user sees a banner + hears the chime and
  // knows to alt-tab to Ghostty.
  const notifyProc = spawn({
    cmd: ["osascript", "-e", `display notification "kura needs you to approve a request" with title "kura" sound name "Glass"`],
    stdout: "ignore", stderr: "ignore",
  });
  await notifyProc.exited.catch(() => {});

  console.log(`[daemon] focused terminal: ${detected}`);
}
