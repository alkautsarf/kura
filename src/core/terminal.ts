// Shared terminal teardown for kura's opentui-based screens (TUI + popup).
//
// Why this exists: opentui (and some terminals like Ghostty) enable async
// notification modes (DEC 996/2031 color-scheme reports, OSC 10/11 color
// queries) and the responses arrive on stdin asynchronously. If we exit
// alt-screen mode before draining stdin, queued responses leak into the
// parent shell as visible garbage, e.g. `^[[?997;1n` and `^[]10;rgb:.../...`.
//
// Sequence we need:
//   1. Disable every notification mode so the terminal stops generating new
//      responses (and any final replies it owes us are already on the wire).
//   2. Sleep so those final replies actually arrive in our stdin buffer.
//   3. Drain stdin in raw mode.
//   4. Exit the alt screen / show cursor / reset attrs. Some terminals reply
//      to these too (color reverts can re-trigger 997 if 996 was somehow
//      still latched), so:
//   5. Sleep + drain one more time before letting the process die.
//
// Bun.sleepSync works correctly in `bun build --compile` outputs (verified
// 2026-04-29 against the macOS Tahoe ad-hoc-signed binary). The earlier
// switch to Atomics.wait was based on a wrong diagnosis.

import { writeSync } from "node:fs";

const DISABLE_NOTIFICATIONS =
  "\x1b[?996l" +    // DEC 996: theme-change notifications (terminal sends ?997;Pm n)
  "\x1b[?2031l" +   // DEC 2031: newer color-scheme update notifications
  "\x1b[?2048l" +   // DEC 2048: in-band terminal-size notifications
  "\x1b[?1004l" +   // focus tracking
  "\x1b[?2026l" +   // synchronized output
  "\x1b[?1000l" + "\x1b[?1002l" + "\x1b[?1003l" +  // mouse: button, btn-event, any-event
  "\x1b[?1006l" + "\x1b[?1015l" + "\x1b[?1016l";   // mouse: SGR, urxvt, SGR-pixel

const EXIT_SCREEN =
  "\x1b[?1049l" +   // exit alt screen
  "\x1b[?25h" +     // show cursor
  "\x1b[0m";        // reset SGR attributes

function drainStdin(maxIterations: number): void {
  const stdin = process.stdin as NodeJS.ReadStream;
  for (let i = 0; i < maxIterations; i++) {
    const chunk = stdin.read?.();
    if (!chunk || chunk.length === 0) break;
  }
}

function syncSleep(ms: number): void {
  try {
    Bun.sleepSync(ms);
  } catch {
    try {
      const arr = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(arr, 0, 0, ms);
    } catch {
      // fallback: tight wait
      const t = Date.now() + ms;
      while (Date.now() < t) { /* spin */ }
    }
  }
}

let restored = false;

export function restoreTerminal(): void {
  if (restored) return;
  restored = true;
  try {
    // Phase 1: stop the terminal from generating any further async responses.
    writeSync(1, DISABLE_NOTIFICATIONS);

    const isTty = process.stdin.isTTY;
    if (isTty) {
      try { process.stdin.setRawMode?.(true); } catch {}
    }

    // Phase 2: let the terminal flush whatever responses it still owed us
    // (it had time to generate replies to the disable sequences above), then
    // drain everything queued in our stdin.
    syncSleep(150);
    if (isTty) drainStdin(500);

    // Phase 3: leave alt screen, restore cursor + attrs.
    writeSync(1, EXIT_SCREEN);

    // Phase 4: some terminals reply to alt-screen-exit / attribute-reset with
    // OSC color reports (they check the new visible context). Catch those.
    if (isTty) {
      syncSleep(60);
      drainStdin(500);
      try { process.stdin.setRawMode?.(false); } catch {}
    }
  } catch {
    // best effort
  }
}

export function attachRestoreHandlers(): void {
  process.on("exit", restoreTerminal);
  process.on("SIGINT", () => { restoreTerminal(); process.exit(130); });
  process.on("SIGTERM", () => { restoreTerminal(); process.exit(143); });
  process.on("SIGHUP", () => { restoreTerminal(); process.exit(129); });
}
