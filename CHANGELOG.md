# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.15] - 2026-05-01

### Fixed
- v0.1.14's "discover tmux session" popup fix didn't actually work because the launchd-started daemon has `PATH=/usr/bin:/bin:/usr/sbin:/sbin` — `/opt/homebrew/bin` is missing, so spawning `tmux` failed silently before it could run `list-sessions`. Daemon then logged "no tmux server reachable" even though the user had tmux running. Real fix: resolve `tmux` to its absolute path at module load (`/opt/homebrew/bin/tmux` first, then `/usr/local/bin/tmux`, then `/usr/bin/tmux`, finally PATH-resolved fallback). All `spawn(["tmux", ...])` callsites in `src/daemon/requests.ts` now use the resolved `TMUX_BIN`. Verified locally with launchd-equivalent env (no `$TMUX`, no `/opt/homebrew/bin` in PATH).

[0.1.15]: https://github.com/alkautsarf/kura/releases/tag/v0.1.15

## [0.1.14] - 2026-05-01

### Fixed
- Approval popup never appeared when daemon was started under launchd (`brew services start kura`). Daemon's popup spawn checked `process.env.TMUX` and only ran `tmux display-popup` if it was set; under launchd that env var is empty, so dapp connect/sign requests went into the queue with no UI ever surfacing — user saw the dapp's spinner forever and nothing else. Fix: when `$TMUX` is missing, daemon now queries `tmux list-sessions` to find the attached session and passes it as `-t <session>` to `display-popup`. Falls back to "queued only" warning only when no tmux server is reachable at all (genuine no-tmux environment). Regression introduced when daemon migrated to launchd autostart in v0.1.10's brew services integration.

[0.1.14]: https://github.com/alkautsarf/kura/releases/tag/v0.1.14

## [0.1.13] - 2026-05-01

### Fixed
- Recurring `_debug is not a function` (or `transformAsync is not a function`) bun-compile build failures killed v0.1.6, v0.1.7, v0.1.11, and v0.1.12 attempts on Linux CI. Root cause: `bun --compile`'s CJS interop is non-deterministic for `@babel/traverse → debug` and similar default-export-as-namespace edge cases. Same bun version + same lockfile + same source can succeed one run and fail the next. Fix: postinstall script `scripts/patch-babel-bun-interop.mjs` rewrites the offending `const debug = _debug(...)` to `const debug = (_debug.default || _debug)(...)` so the call works regardless of whether bun wraps the import as a namespace object. Patch is idempotent (no-op if already applied) and runs after every `bun install`. Categorical fix replaces the per-version Bun pinning bandaid.
- CI also passes `--frozen-lockfile` to `bun install` to prevent any silent dependency drift.

[0.1.13]: https://github.com/alkautsarf/kura/releases/tag/v0.1.13

## [0.1.12] - 2026-05-01

### Changed
- (aborted release — same Linux babel/_debug build failure as v0.1.11; ship via v0.1.13 with categorical postinstall patch)

[0.1.12]: https://github.com/alkautsarf/kura/releases/tag/v0.1.12

### Changed
- Release marker only; no functional change. Exercises the new `brew services` auto-restart-on-upgrade pipeline introduced in the v0.1.10_1 formula bump. v0.1.11 was tagged but never built — splitting the App's outer `padding={1}` into per-side `paddingTop`/`paddingLeft`/`paddingRight` to drop the bottom padding triggered a latent bun bundler / `@babel/traverse` CJS interop bug (same family as the v0.1.6 `_debug is not a function` and v0.1.7 babel regressions). Reverted the JSX prop shape; cosmetic footer-flush ask is deferred until the underlying babel/bun interop is patched (likely a postinstall script in a future release).

[0.1.12]: https://github.com/alkautsarf/kura/releases/tag/v0.1.12

## [0.1.11] - 2026-05-01

### Changed
- (aborted release — see v0.1.12)

[0.1.11]: https://github.com/alkautsarf/kura/releases/tag/v0.1.11

## [0.1.10] - 2026-05-01

### Changed
- The brew formula now bundles the Swift `kura-signer` binary alongside `kura`. CI builds it on the macos-14 runner (Swift pre-installed), ad-hoc-signs it the same way as the bun-compiled `kura`, and ships both in the darwin-arm64 tarball. Brew installs them side-by-side at `/opt/homebrew/bin/kura` and `/opt/homebrew/bin/kura-signer`, which is exactly where `findSignerBinary()` in `src/core/keychain.ts` already looked. Net effect: Touch ID Just Works after `brew upgrade kura` from any directory; the manual `sudo ln -s ~/Documents/kura/swift/.build/release/kura-signer /opt/homebrew/bin/kura-signer` workaround documented for v0.1.9 is no longer needed and the existing symlink can be removed (`sudo rm /opt/homebrew/bin/kura-signer && brew upgrade kura` to switch from the symlink to the real bundled binary).

### Fixed
- `findSignerBinary()` returning null for brew users from any cwd outside `~/Documents/kura/`. Was a packaging gap — the absolute paths `/opt/homebrew/bin/kura-signer` and `/usr/local/bin/kura-signer` were already in the discovery list but the formula never installed there. v0.1.10 closes the gap.

[0.1.10]: https://github.com/alkautsarf/kura/releases/tag/v0.1.10

## [0.1.9] - 2026-05-01

### Added
- **Touch ID gating on every signature.** kura-signer now uses `LAContext.evaluatePolicy(.deviceOwnerAuthentication)` (with Mac-password fallback) before reading any wallet key from Keychain. Each `eth_sendTransaction`, `personal_sign`, and `eth_signTypedData_v4` pops a system Touch ID prompt with a meaningful reason string ("kura: send 0.01 ETH on Ethereum (main)", "kura: sign permit2.uniswap.org (main)"). Defense in depth: popup still shows decoded calldata + simulation + risk badge, then `[a]` triggers Touch ID before signing.
- TUI generate flow now requires Touch ID BEFORE printing the new private key into scrollback. Headless triggers (e.g., MCP) cannot reveal a freshly generated key without a physical finger press.
- `kura wallet migrate` subcommand. Rotates pre-v0.1.9 wallet entries (stored via plain `security` CLI, Mac-password ACL) onto the new LAContext-gated path. One Mac password prompt per wallet to read the old entry; afterwards every read pops Touch ID. TUI startup prints a one-line stderr notice when a migration is pending.

### Changed
- Swift signer (`swift/Sources/KuraSigner/main.swift`) dropped `kSecAttrAccessControl + .biometryCurrentSet`. That OS-enforced gate required a paid Apple Developer cert (the calling binary needs the keychain-access-groups entitlement); without it every `store` failed with `errSecMissingEntitlement (-34018)` and the runtime silently fell back to plain `security` CLI with no biometry. The new application-layer LAContext gate works in dev, ad-hoc-signed binaries, and brew binaries — no Apple Developer cert needed. Pattern adopted from pragma-signer's `SecureEnclave.swift`. See `feedback-touchid-lacontext-not-accesscontrol.md`.
- Swift signer's `get` and `delete` accept a `-m <reason>` flag for the localizedReason string shown in the Touch ID prompt. New `auth` subcommand exposes the bare LAContext gate (no keychain read) for the TUI generate flow.
- `src/core/keychain.ts` serializes all kura-signer invocations through a Promise chain (`signerLock`). Two simultaneous dapp requests will now queue Touch ID prompts back-to-back instead of stacking visually.
- Popup status on `[a]` press changed from "approving (Touch ID)..." to "awaiting Touch ID...". Footer hint reads `[a] approve (Touch ID)`.

### Fixed
- TUI generate flow no longer leaks the private key into scrollback after quit. Previously the suspend-window `process.stdout.write` calls printed the key to the main-screen buffer, which was preserved when `resume()` switched back to alt-screen and re-revealed when the user later quit and the alt-screen exited. Fix: after the `cliConfirm("backed up?")` returns, write `\x1b[7F\x1b[J` (cursor up 7 lines + erase to end of screen) to scrub our suspend-window output. Preserves the user's shell history above kura.
- Blinking cursor in TUI text inputs. `FormRow`'s `<input>` now passes `cursorStyle={{ style: "block", blinking: false }}` so name / address / private-key fields render with a steady cursor. Pattern matches whatsapp-tui's standard.

[0.1.9]: https://github.com/alkautsarf/kura/releases/tag/v0.1.9

## [0.1.8] - 2026-05-01

### Fixed
- `kura --version` (and `--help`) reported the wrong version after `brew upgrade`. The CLI used a hardcoded `VERSION = "0.1.5"` constant in `src/index.ts` that was supposed to be hand-bumped per release but was missed for v0.1.6 and v0.1.7. Replaced with `import pkg from "../package.json"` so version is sourced from a single place. Daemon's `/health` endpoint also now reads from `pkg.version` instead of a hand-maintained string. Verified the JSON import survives `bun build --compile`.

[0.1.8]: https://github.com/alkautsarf/kura/releases/tag/v0.1.8

## [0.1.7] - 2026-05-01

### Added
- TUI wallet manager pane. Press `w` from home to list every configured wallet (default marked with `*`), `j/k` to navigate, `Enter` to set the highlighted wallet as default. `a` opens an inline add flow that prompts for the new name then a sub-menu (generate / import private key / watch-only). Generate temporarily suspends the TUI alt screen so the new private key + the same `IMPORTANT  Keychain is NOT a backup` warning the `kura init` wizard prints land in your normal terminal scrollback (so you can copy or write them down before confirming `backed up?`); answering `n` rolls back the keychain entry. `d` removes the highlighted wallet, `Shift+d` removes and purges its keychain entry too. Removing the only remaining wallet is blocked because the daemon's default would otherwise point at a missing entry.

### Changed
- TUI keymap: `w` now opens the new wallets pane and the live SSE event stream moved from `w` to `e` (events). Footer hints updated.
- CI build environment strict-pinned to Bun 1.3.12. Bun 1.3.13 has a CJS bundler regression that mangles `@babel/traverse`'s `debug` import (`_debug` becomes `{default: fn}` instead of `fn`), breaking `bun build.ts` for any project that pulls in babel via `@opentui/solid/bun-plugin`. The aborted v0.1.6 release surfaced this; v0.1.7 is the same wallet-manager feature shipping under a CI that can actually build it.

### Fixed
- v0.1.6 was tagged but never produced binaries because of the Bun 1.3.13 CI break above. v0.1.7 includes the CI pin so the same code now builds.

[0.1.7]: https://github.com/alkautsarf/kura/releases/tag/v0.1.7

## [0.1.5] - 2026-04-30

### Added
- `kura wallet` subcommand for ergonomic wallet management without re-running the full `kura init` wizard:
  - `kura wallet list` (default) prints all wallets with the default marked.
  - `kura wallet add <name>` adds a wallet. Flags: `--generate` (random key), `--import-key <hex|->` (paste or stdin), `--watch-only <0x...>` (watch address), `--default` (set as default after adding). Without flags it prompts interactively.
  - `kura wallet use <name>` (alias `switch`) writes the new default to `~/.kura/config.toml`.
  - `kura wallet remove <name>` drops the wallet from `state.json`. `--purge-key` also deletes the macOS Keychain entry. If the removed wallet was the default, the next remaining wallet (insertion order) becomes default automatically.
  - `kura wallet show <name>` prints address, source, keychain location, and creation date.
- TUI `Shift+Tab` cycles between configured wallets, persists the new default to config, and triggers portfolio + history refetch with the new address. Pairs with `Tab` (chain cycle).

### Changed
- `kura init` now delegates wallet creation to `src/core/wallet.ts` primitives (`createGeneratedWallet`, `createImportedWallet`, `createWatchOnlyWallet`, `createSharedKeychainWallet`) so `kura wallet add` and `kura init` produce identical state. No behavior change for `init`.

### Fixed
- `package.json` `dev` and `daemon` scripts: `--preload` flag must come AFTER `bun run`, not before. Bun 1.3.x's CLI parser rejects `bun --preload X run file.ts` with a help dump (treats `run` as a script name). Changed to `bun run --preload @opentui/solid/preload src/index.ts [daemon]`.
- TUI escape leak (`^[]10;rgb:...`, `^[]11;rgb:...`, `^[[?997;1n` floods bleeding into the parent shell after quit, especially when quitting while balances were still loading). The actual root cause turned out to be deeper than ordering: opentui's `CliRenderer.destroy()` is a no-op when a frame is mid-flight (`this.rendering === true`). It sets `_destroyPending = true` and returns, expecting the render loop's `finally` block to call `finalizeDestroy()` on the next tick. Because our `process.exit` ran on the same tick, the event loop died before that next tick could run, so the native Zig renderer never tore down and its pending stdout writes (plus the unconsumed OSC 10/11 responses sitting in the stdin parser) leaked after the process was gone. Quitting during loading reproduced it almost every time because the active fetches kept the render loop busy. Fix layers:
  1. Centralized shutdown in `src/core/terminal.ts` `quit(code)`: disable async notification modes (mode 996/2031/etc), call `renderer.destroy()`, then force-call `renderer.finalizeDestroy()` to defeat the mid-frame deferral, then `process.exit(code)`. `attachRestoreHandlers` SIGINT/SIGTERM/SIGHUP all route through this; the `'exit'` handler does the drain.
  2. TUI and popup pass `{ exitSignals: [], exitOnCtrlC: false }` to `render()` so opentui's own `CliRenderer` does not register competing signal handlers (kura owns the entire shutdown sequence).
  3. TUI/popup register the renderer with terminal.ts via `setActiveRenderer(useRenderer())` in `onMount`, and route the in-app Ctrl+C keypress through `quit()` for a single canonical shutdown path.
  4. `drainStdinOverWindow` no longer bails early on quietness when no chunk has been received yet (so a slow terminal that takes 200ms to even START responding does not get cut off). Window bumped to 800ms before alt-screen exit + 200ms after.
  5. Final `tcflush(STDIN, TCIFLUSH)` via Bun FFI discards anything still queued in the kernel PTY buffer that arrived between drain end and the parent shell taking over the TTY. Belt-and-suspenders.
- SIGINT and SIGHUP now exit with code 0 instead of 130 / 129. For an interactive TUI, Ctrl+C is the user's chosen quit path (same as `q`), and the previous 130 made `bun run` print "error: script 'dev' exited with code 130" on every clean quit. SIGTERM still exits 143 because that signal usually means an external supervisor decided to stop us, which is worth signaling upward.

[0.1.5]: https://github.com/alkautsarf/kura/releases/tag/v0.1.5

## [0.1.4] - 2026-04-30

### Fixed
- Browser stays alive when the kura csp-strip proxy crashes. Previously, an unhandled exception in any of the proxy's I/O callbacks (e.g. `clientSocket.write` against a destroyed socket inside a `net.connect` callback) would terminate the proxy. qb still had `c.content.proxy = http://127.0.0.1:8422` set and `c.content.proxy` cannot be re-applied at runtime, so every subsequent browser request hit the dead port and the user had to restart qb. Three layered fixes:
  - `kura proxy` is now self-supervising. The top-level process is a tiny watchdog that fork-spawns the actual proxy via `KURA_PROXY_CHILD=1` and respawns it on death with exponential backoff (1s/2s/4s/8s/16s/30s, reset to 1s after 60s clean uptime). Single binary, qb config unchanged.
  - The proxy child installs `uncaughtException` and `unhandledRejection` handlers that log to stderr but do NOT exit. The previous behavior was Bun's default of terminating on these.
  - `src/proxy/server.ts` wraps every socket-callback body in try/catch (CONNECT setup, tunnelDirect setup, response forwarding, plain HTTP pipe) so a destroyed socket can't escalate. Adds a 32 MiB cap on buffered HTML so a pathological upstream can't OOM the process.
- Supervisor uses the v0.1.3 brew-symlink fallback (`resolveSelfBinary`) when respawning, so the proxy survives `brew upgrade kura` mid-flight too. Helper extracted to `src/core/self-binary.ts` and shared with the daemon.

### Changed
- `~/.qutebrowser/config.py` opens `/tmp/kura-proxy.log` in append mode with a session banner, so crash history survives qb restarts. Previously each qb start truncated the log and we lost any record of prior crashes.

[0.1.4]: https://github.com/alkautsarf/kura/releases/tag/v0.1.4

## [0.1.3] - 2026-04-29

### Fixed
- Daemon survives `brew upgrade kura`. Previously the daemon process kept its `process.execPath` pointing at `/opt/homebrew/Cellar/kura/<old-version>/bin/kura`, which Homebrew deletes on upgrade. Every popup spawn then exited 127 silently, so dapp connect/sign requests got no popup. Daemon now resolves the binary lazily per spawn: if `process.execPath` is gone, it falls back to the `/opt/homebrew/bin/kura` brew symlink (which always tracks the current version), or to `/usr/local/bin/kura` for Linuxbrew.

[0.1.3]: https://github.com/alkautsarf/kura/releases/tag/v0.1.3

## [0.1.2] - 2026-04-29

### Fixed
- Terminal escape leak (`^[[?997;1n` and OSC 10/11 color responses) on quit, again. v0.1.1's fix only ran one drain pass before the alt-screen exit, so any responses the terminal generated *in reply to* the alt-screen exit (or to the disable sequences themselves) escaped to the parent shell. New approach: shared `core/terminal.ts` helper does disable -> sleep 150ms -> drain -> alt-screen exit -> sleep 60ms -> drain again. Uses `fs.writeSync` for synchronous flush and `Bun.sleepSync` (verified working in compiled+ad-hoc-signed binaries) instead of `Atomics.wait`. Same helper now powers both TUI and popup teardown.

[0.1.2]: https://github.com/alkautsarf/kura/releases/tag/v0.1.2

## [0.1.1] - 2026-04-29

### Fixed
- Terminal escape leak on quit (`^[[?997;1n` and OSC 10/11 color responses spewing to parent shell). Compiled binary's restoreTerminal now uses `Atomics.wait` for guaranteed synchronous sleep + a 200ms bounded drain loop that consumes terminal-response bytes from stdin in raw mode before exiting alt screen. `Bun.sleepSync` was unreliable under `bun build --compile`.
- Daemon `/health` reports correct version `0.1.1` (was hardcoded `0.0.1` in handlers.ts).

[0.1.1]: https://github.com/alkautsarf/kura/releases/tag/v0.1.1

## [0.1.0] - 2026-04-29

### Added (Apr 29 release polish)
- CSP-strip TLS-MITM proxy (`src/proxy/`, ~600 LOC): per-host RSA leaf certs signed by mkcert root CA; HTTP CONNECT proxy with per-host inner HTTPS server cache; meta CSP regex strip from HTML body, Content-Security-Policy response header strip; gzip/br/deflate decompress before strip; transparent CONNECT pass-through for non-target domains; plain-HTTP forwarding. Auto-spawned by qutebrowser config.py at startup, dies cleanly with browser. Verified: Uniswap (mainnet + Sepolia) connects + signs + broadcasts.
- Mainnet/testnet mode (`n` key in TUI): persisted in `~/.kura/config.toml` as `network_mode`; `tab` cycles only within current mode; `[MAINNET]` (green) / `[TESTNET]` (yellow) badge in header.
- Tenderly account/project in config (`tenderly_account`, `tenderly_project`) so simulator works without env vars; popup shows balance diffs.
- Borderless TUI + popup, sticky footer at bottom regardless of content size.
- macOS focus-steal on popup spawn: `open -a` + System Events `set frontmost` + notification + Glass sound — terminal pops to front even when qutebrowser is the user's frontmost app. KURA_TERM_APP env override.
- `kura proxy --install-launchd` / `--uninstall-launchd` (kept for future, currently unused since qb-spawned model is preferred).

### Fixed (Apr 29 release polish)
- `_is_port_alive` health probe in qutebrowser config.py works correctly: proxy responds 200 to bare `GET /` so urllib-based detection passes (was returning 400 → qb thought proxy was dead → set `c.content.proxy = 'system'` → bypassed proxy entirely → Uniswap connect failed).
- Activity row formatting: scientific notation only for amounts < 1e-9; small ETH transfers like `0.000114 ETH` render readably (was `1.142e-4 ETH`); spam tokens (raw value > 10^36) tagged `[spam]` instead of dumping a 200-char number.
- History view capped at 15 rows in TUI to work around an opentui-solid renderer cell-clear bug that bled chars between adjacent columns when many rows mutated; full feed via `kura history` CLI.
- Watch SSE in CLI: `kura watch` now passes `tls.rejectUnauthorized: false` like the rest of the CLI helpers.
- Daemon shutdown: `server.stop(true)` + `closeAllConnections()` on inner servers force-close active connections so `Ctrl-C` doesn't hang on long-lived SSE.
- Duplicate `esc back` / hint text in modals — single source of truth in FooterHints.
- TUI restoreTerminal: drains stdin and sends additional disable sequences (DEC 996/2031/2048) so terminal color-scheme query responses (`^[[?997;1n`, `^[]10;rgb:.../...`) don't leak to the parent shell on quit; uses `Bun.sleepSync(40)` to let in-flight responses arrive before drain.
- Chain rotation no longer drops Sepolia: `loadAllChains` includes `KNOWN_TESTNETS`; defensive fallback in TUI's `tab` handler keeps current chainId in rotation if missing from the daemon list.
- TUI portfolio + history fetch: AbortController cancels in-flight request when chainId changes; 200ms debounce on tab presses so spam-cycling doesn't fire portfolio fetches.

### Changed (Apr 29 release polish)
- Daemon no longer auto-spawns the proxy. Proxy lifetime is now bound to qutebrowser via config.py spawn block (mirrors elsummariz00r's pattern). Killing the daemon for testing iteration leaves browsing untouched.
- `/chains?mode=mainnet|testnet` filter (no param: returns all known chains).
- qutebrowser config.py spawn pgrep pattern loosened (`bun.*src/index\.ts proxy`) to catch both relative- and absolute-path orphan invocations.
- `tmux display-popup -B` so popup has only its inner border (no double line).

### Added (initial scaffold)
- Initial repo scaffold: flat `src/` with daemon, tui, popup, cli, shim, core subdirs
- Bun project init with viem, opentui core+solid, hypersync-client, mri, qrcode-terminal, solid-js
- GitHub Actions release workflow (matrix darwin-arm64 + linux-x64, codesign fix)
- Entry point `src/index.ts` routes by argv subcommand
- Core foundations: chains, keychain, config, secret, audit-log, paths
- Daemon HTTP+SSE server on `127.0.0.1:8421` with X-Kura-Key auth, 18 endpoints, idleTimeout 0, CORS preflight + headers (so qutebrowser shim's GM.xmlHttpRequest can reach it)
- Bridge popup spawn via `tmux display-popup -E -d <cwd> -- bun --preload @opentui/solid/preload <abs-entry> popup <id>`. `KURA_POPUP_PANE=<target>` env var routes the popup into a fixed tmux pane for tester-controlled keystroke testing.
- Data adapters: viem RPC clients, HyperSync paged history, Tenderly REST sim, openchain.xyz signature decode (Parity Registry fallback), DefiLlama protocols cache, GoPlus token+address security, MetaMask phishing list mirror, ENS+Basename resolver
- Risk engine: 11 default rules with three-tier badges, adapter enrichment for phishing/dapp/token/address/spender flags, unlimited approval and EOA approve detection
- CLI: balance, portfolio, history, connections, audit, watch, send, swap, install-shim, init, daemon, popup. mri parser with `string: ["address","wallet"]` to keep hex addresses from being coerced to scientific notation.
- TUI: opentui+solid full multi-screen router. Home (portfolio + activity), `s` send modal (form with to/amount/token, submits via `/requests`), `r` receive modal (address + ANSI QR via qrcode-terminal), `h` history full view, `c` connections (j/k navigate, d revoke), `w` watch live SSE, `tab` cycles bundled+hot-loaded chains, `g` manual refresh, `q` quit. Reverse name resolution for activity counterparties.
- Approval popup: outcome view (default) + calldata toggle (Tab). Decoded ERC20 / approve / common router function args via viem `decodeFunctionData`, full raw hex calldata wrapped at 80 chars. Kind-specific UIs: connect ("dapp wants to connect"), personal_sign / typed-data ("sign request" with hex→string decoding), batch (per-step list). a / r / q / Esc key handling.
- Onboarding wizard (`kura init`): 8 steps (secret → daemon-autostart → wallet → keychain → shim → service-keys → chain-confirm → sanity-check). Daemon autostart prompts for launchd plist write, qutebrowser config.py append, or manual. Service-keys step prompts for Alchemy/HyperSync/Tenderly when missing. Sanity check pings `/balance` and `/history`. Flag overrides: `--name`, `--import-key`, `--watch-only`, `--default-chain`, `--safe-threshold`, `--daemon-port`, `--skip-shim`, `--skip-autostart`, `--skip-sanity`.
- Qutebrowser userscript template with EIP-6963 announce, isMetaMask masquerade, GM.xmlHttpRequest transport (with onerror/ontimeout reporting), per-install secret in X-Kura-Key header.
- Signing pipeline (`core/signer.ts`) reads keychain on approve, sends via viem walletClient with EIP-1559 fee estimation. Audits `tx_signed` event on success.
- **kura-signer Swift binary** (`swift/Sources/KuraSigner/main.swift`, ~200 LOC): Touch-ID gated wallet key storage using `LAContext.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics)` and `kSecAttrAccessControl` with `.biometryCurrentSet`. Subcommands: has, store (reads hex from stdin), get (Touch ID gated), delete (Touch ID gated). Build with `cd swift && swift build -c release`. `core/keychain.ts` shells out to it for wallet keys; falls back to plain `security` CLI when `KURA_SIGNER=` (empty) or binary missing.
- Smoke-tested live across Mainnet, Base, Arbitrum, BSC, Monad mainnet (143), Sepolia (11155111), Monad testnet (10143)
- End-to-end qutebrowser shim runtime test: agent-browser drove a mock dapp at `localhost:7799` through eth_requestAccounts → kura popup approve → dapp received accounts; eth_chainId returns 0x1 instantly; personal_sign decoded message in popup, reject flow returned 4001 to dapp.
- Real signing pipeline verified on Sepolia: keychain read → viem walletClient.sendTransaction → Sepolia RPC. Test wallet at `0xe3cf5a3b4C0CFb0Dc5aF42Bad0842BC36bF43E2b` reached the broadcast step (failed at "insufficient funds" because the test wallet was unfunded, which is the expected RPC response — proves signing+broadcast wiring works).

[0.1.0]: https://github.com/alkautsarf/kura/releases/tag/v0.1.0
