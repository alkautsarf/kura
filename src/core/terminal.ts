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
import { dlopen, FFIType } from "bun:ffi";

// tcflush(STDIN_FILENO, TCIFLUSH) discards anything sitting in the PTY
// receive buffer that we haven't read yet. This is the last-line defense
// against OSC 10/11 / ?997 responses that arrived AFTER our drain loop
// finished but BEFORE the parent shell took over the TTY: without this
// they would land in the shell's prompt as visible garbage. Loaded lazily
// because not every process that imports this module is a TTY.
const TCIFLUSH = 1;
let tcflushFn: ((fd: number, action: number) => number) | null | undefined;
function flushPtyInput(): void {
  if (tcflushFn === undefined) {
    try {
      const lib = dlopen("libSystem.dylib", {
        tcflush: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      tcflushFn = lib.symbols.tcflush;
    } catch {
      tcflushFn = null;
    }
  }
  if (!tcflushFn) return;
  try { tcflushFn(0, TCIFLUSH); } catch { /* best effort */ }
}

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

// Drain stdin over a time window. Some terminal responses arrive in chunks
// over 100-1000ms (e.g., OSC 10/11 color queries fired by opentui's startup
// palette detector — the terminal can take a while to formulate the response,
// especially under load).
//
// Bail policy: only allow early-exit on quietness AFTER we have read at
// least one chunk. Without that guard, a slow terminal that takes 200ms
// to even START sending the response would hit our 120ms quiet bail and
// we'd return before the bytes ever arrived, leaking them post-exit.
function drainStdinOverWindow(windowMs: number, postReadQuietMs: number = 120): void {
  const stdin = process.stdin as NodeJS.ReadStream;
  // Resume the stream so Node actively pulls bytes from the PTY into its
  // internal buffer. Without this, process.stdin.read() can return null even
  // when the PTY has bytes queued, because Node hasn't been asked to pull.
  try { stdin.resume?.(); } catch {}
  const deadline = Date.now() + windowMs;
  let lastReadAt = 0;
  let everRead = false;
  while (Date.now() < deadline) {
    const chunk = stdin.read?.();
    if (chunk && chunk.length > 0) {
      lastReadAt = Date.now();
      everRead = true;
      continue;
    }
    if (everRead && Date.now() - lastReadAt >= postReadQuietMs) break;
    syncSleep(10);
  }
  try { stdin.pause?.(); } catch {}
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

// Send the disable-notifications sequence WITHOUT touching the alt screen or
// stdin. Safe to call multiple times. Use cases:
//   - At TUI startup, to clear stale mode 996/2031 enabled by a prior unclean
//     exit (so opentui's own startup writes don't trigger ?997 floods).
//   - Before opentui's renderer.destroy() at quit, so destroy()'s cleanup
//     writes (color resets, cursor positioning) don't pulse more notifications.
export function disableTerminalNotifications(): void {
  try { writeSync(1, DISABLE_NOTIFICATIONS); } catch {}
}

// Renderer registry. App.onMount registers the live renderer here so quit()
// can destroy it cleanly on signals fired from terminal.ts (which knows
// nothing about opentui itself). Null when no renderer is active.
//
// finalizeDestroy is opentui's private "actually flush + tear down native
// renderer" method. We call it because plain destroy() defers to the next
// render-loop tick when a frame is mid-flight (rendering=true), and our
// process.exit happens before that tick can run. Without the force-finalize
// the Zig renderer never flushes its pending stdout writes and they leak
// after the process is gone. See finalizeDestroy at index-mw2x3082.js:23281.
// Untyped on purpose: opentui's CliRenderer marks finalizeDestroy private,
// but we need to call it to defeat the rendering=true defer. Inside quit()
// we treat the renderer as a duck-typed bag of optional methods.
let activeRenderer: unknown = null;

export function setActiveRenderer(r: unknown): void {
  activeRenderer = r;
}

let quitting = false;

// Single shutdown path. Order matters and is the whole point of this file:
//   1. disable async notification modes (996/2031/2048/etc) so the next
//      writes the renderer emits during destroy don't trigger new ?997
//      floods that would arrive AFTER process.exit and leak into the shell;
//   2. opentui.destroy flushes the native render pipeline and exits the
//      alt screen via the Zig binding (synchronous);
//   3. force-call finalizeDestroy IF the renderer was mid-frame: plain
//      destroy() returns early in that case (sets _destroyPending and lets
//      the render loop's finally hook do the work), but our process.exit
//      kills the loop before that tick can run, so the native renderer
//      never tears down and its pending stdout writes leak post-exit;
//   4. process.exit triggers the 'exit' handler which calls restoreTerminal
//      to drain any straggler stdin responses (OSC 10/11 etc).
// Idempotent: a second call is a no-op so SIGINT + 'c' keypress racing each
// other can't double-destroy.
export function quit(code: number = 0): void {
  if (quitting) return;
  quitting = true;
  disableTerminalNotifications();
  try {
    const r = activeRenderer as {
      destroy?: () => void;
      finalizeDestroy?: () => void;
      isDestroyed?: boolean;
    } | null;
    if (r && !r.isDestroyed) {
      r.destroy?.();
      // If destroy deferred to the render loop because a frame was in
      // flight, force the synchronous teardown ourselves. finalizeDestroy
      // is idempotent (guarded by _destroyFinalized inside opentui).
      r.finalizeDestroy?.();
    }
  } catch { /* best effort */ }
  activeRenderer = null;
  process.exit(code);
}

let restored = false;

export function restoreTerminal(): void {
  if (restored) return;
  restored = true;
  try {
    // Phase 1: stop the terminal from generating any further async responses.
    // Idempotent with disableTerminalNotifications() (which the TUI calls
    // before renderer.destroy() to close the race-window during destroy's
    // cleanup writes). Sending the disable sequence twice is harmless.
    writeSync(1, DISABLE_NOTIFICATIONS);

    const isTty = process.stdin.isTTY;
    if (isTty) {
      try { process.stdin.setRawMode?.(true); } catch {}
    }

    // Phase 2: drain over an 800ms window. Catches OSC 10/11 color-detection
    // responses (opentui's TerminalPaletteDetector queries them at startup,
    // and the terminal's response can take 50-700ms to arrive — sometimes
    // longer if the user quits BEFORE opentui's input parser had a chance
    // to consume them). Holds the full window unless we've actually read
    // bytes and the PTY then went quiet for 120ms, so a slow first-byte
    // doesn't get missed.
    if (isTty) drainStdinOverWindow(800, 120);

    // Phase 3: leave alt screen, restore cursor + attrs.
    writeSync(1, EXIT_SCREEN);

    // Phase 4: alt-screen-exit / attribute-reset can themselves prompt OSC
    // replies (the terminal checks the new visible context). Drain those too.
    if (isTty) {
      drainStdinOverWindow(200, 80);
      try { process.stdin.setRawMode?.(false); } catch {}
    }

    // Phase 5: last-ditch tcflush. After all the read-loops above, anything
    // still queued in the PTY receive buffer (e.g., a response that arrived
    // 1ms after our drain expired) gets discarded by the kernel before the
    // parent shell can see it. Belt-and-suspenders: cheap, can't hurt.
    if (isTty) flushPtyInput();
  } catch {
    // best effort
  }
}

export function attachRestoreHandlers(): void {
  // 'exit' fires synchronously from process.exit (called by quit() and by
  // anything else that exits). It drains stdin so async OSC replies that
  // arrived after the renderer's last writeSync don't leak into the shell.
  process.on("exit", restoreTerminal);
  // Signal handlers route through quit() so the disable -> destroy -> exit
  // ordering is preserved. Without this, a raw process.exit on SIGINT would
  // skip renderer.destroy() and the native render pipeline's pending writes
  // would leak after the process is gone.
  //
  // Exit 0 on SIGINT/SIGHUP because Ctrl+C in an interactive TUI is a
  // user-initiated graceful quit, not an error. Exiting 130 makes `bun run`
  // print "error: script 'dev' exited with code 130" on every quit, which
  // looks alarming for what is the normal shutdown path. SIGTERM stays at
  // its conventional 143 because that signal usually means an external
  // supervisor decided to stop us, which IS worth signaling upward.
  process.on("SIGINT", () => quit(0));
  process.on("SIGTERM", () => quit(143));
  process.on("SIGHUP", () => quit(0));
}
