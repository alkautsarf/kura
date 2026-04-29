import { spawn } from "bun";
import { resolve as resolvePath } from "node:path";
import type { PendingRequest, RiskResult, SimulationResult } from "../core/types.ts";
import { emit } from "./events.ts";
import { logAudit } from "../core/audit-log.ts";

export type Decision = "approve" | "reject" | "timeout";

export interface PendingEntry {
  request: PendingRequest;
  simulation?: SimulationResult;
  risk?: RiskResult;
  resolver: (result: { decision: Decision; txHash?: string; error?: string }) => void;
  resolved: boolean;
}

const queue = new Map<string, PendingEntry>();

export function enqueue(
  request: PendingRequest,
  meta: { simulation?: SimulationResult; risk?: RiskResult } = {},
): Promise<{ decision: Decision; txHash?: string; error?: string }> {
  return new Promise((resolve) => {
    const entry: PendingEntry = {
      request,
      simulation: meta.simulation,
      risk: meta.risk,
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
    spawnPopup(request.id).catch((err) => {
      entry.resolver({ decision: "reject", error: `popup spawn failed: ${err.message}` });
    });
  });
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
  const popupCmd = `${process.execPath} --preload @opentui/solid/preload ${entry} popup ${id} 2>${logFile}`;
  // Optional override: spawn into a fixed tmux pane so a tester can drive keypresses.
  // Set KURA_POPUP_PANE=main:5 (or similar) on the daemon process.
  const targetPane = process.env.KURA_POPUP_PANE;
  if (targetPane) {
    const proc = spawn({
      cmd: ["tmux", "send-keys", "-t", targetPane, `clear; ${popupCmd}`, "Enter"],
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.exited.then(async (code) => {
      if (code !== 0) {
        const err = await new Response(proc.stderr).text();
        console.warn(`[daemon] popup-pane spawn failed (${targetPane}) code=${code}: ${err.slice(0, 200)}`);
      }
    }).catch(() => {});
    return;
  }
  if (process.env.TMUX) {
    // Steal focus FIRST so Ghostty is foregrounded by the time the popup
    // renders inside it. Calling activate after spawn races: tmux sometimes
    // shows the popup before macOS finishes the activate, leaving qb on top.
    focusTerminalApp().catch((err) => console.warn(`[daemon] focus failed: ${err.message}`));
    // -B = no tmux popup border (the inner opentui box already draws one).
    // -w/-h = popup size as % of pane.
    const proc = spawn({
      cmd: ["tmux", "display-popup", "-E", "-B", "-d", process.cwd(), "-w", "70%", "-h", "50%", popupCmd],
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.exited.then(async (code) => {
      if (code !== 0) {
        const err = await new Response(proc.stderr).text();
        console.warn(`[daemon] popup ${id.slice(0, 8)} exit ${code}: ${err.slice(0, 200)} (also see ${logFile})`);
      }
    }).catch(() => {});
    return;
  }
  console.warn(`[daemon] no $TMUX in environment, popup queued only: ${popupCmd}`);
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
