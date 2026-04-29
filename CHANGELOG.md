# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
