# kura

Terminal-native EVM wallet for the qutebrowser-first workflow. Replaces MetaMask/Rabby with a small Bun daemon, a tmux-popup approval flow, and a userscript that injects `window.ethereum` into any web dapp.

```
qutebrowser ──┐                       ┌── TUI
              ├─ shim ──▶ kura daemon ─┤
   Aave/      │   :8421                │── CLI
   Uniswap/   │   (HTTPS, mkcert)      │
   ...        │                       └── popup (tmux display-popup)
              │
              └─ csp-strip proxy :8422 (qb-spawned, intercepts CSP-restricted dapps)
```

## Status

v0.1.0 — usable for daily browsing + signing on a single machine. macOS only. Tested live on Aave (Sepolia + mainnet) and Uniswap (Sepolia + mainnet via CSP-strip proxy). WalletConnect deferred to v0.2.

## Install

```sh
brew install alkautsarf/tap/kura
```

After install, run the wizard:

```sh
kura init
```

It walks 8 steps: per-install secret, daemon autostart (launchd / qutebrowser config / manual), wallet import or generate, keychain entry, qutebrowser shim install, service-key prompts (Alchemy / HyperSync / Tenderly), chain confirmation, sanity check.

## Usage

```sh
kura                  # open the TUI (portfolio + activity + send/receive/etc)
kura daemon           # run the wallet RPC daemon (auto-started by launchd by default)
kura proxy            # standalone CSP-strip HTTPS proxy (also spawned by qb)
kura send 0.01 ETH 0xVitalik
kura balance --chain 1
kura history --chain 11155111 --limit 50
kura connections      # list active dapp sessions
kura audit -n 20      # off-chain event log
kura watch            # live SSE stream of daemon events
kura wallet list      # manage wallets (also: add | use | remove | show | migrate)
kura chain list       # manage chains (also: add <id> <rpc> | remove | show)
kura install-shim     # (re)install the qutebrowser userscript
```

`kura wallet add <name>` accepts `--generate`, `--import-key <hex|->`, `--watch-only <0x...>`, `--default`. Without flags it prompts interactively. `kura wallet use <name>` (alias `switch`) sets the default. `kura wallet remove <name> [--purge-key] [-y]` drops the wallet (and optionally its Keychain entry); the next remaining wallet becomes default.

`kura wallet migrate` rotates pre-v0.1.9 wallet entries (created with the old `security` CLI ACL) onto the new LAContext-gated path so future signs pop Touch ID instead of Mac password. Run once after `brew upgrade kura` if you have wallets predating v0.1.9.

## TUI keys (home view)

`j`/`k` move cursor on activity rows · `enter` open tx detail · `y` copy wallet address · `s` send · `r` receive (QR) · `h` history · `c` connections · `w` wallets · `N` networks · `e` watch · `tab` cycle chain · `shift+tab` cycle wallet · `n` mainnet/testnet toggle · `u` toggle unverified tokens · `g` refresh · `q` quit · `esc` back from any modal

In the tx detail view: `c` copies the hash · `o` opens the explorer · `esc` returns.

## Architecture

**Daemon** (`kura daemon`): Bun.serve over HTTPS on `127.0.0.1:8421`, mkcert-issued cert, X-Kura-Key auth, 19 endpoints (`/balance`, `/portfolio`, `/history`, `/requests`, `/simulate`, `/decode`, `/risk`, `/rpc` (read-only allowlist proxy for `eth_blockNumber`, `eth_call`, `eth_estimateGas`, etc.), ...). Spawns approval popups via `tmux display-popup -E -B`. Never holds keys in memory; reads from Keychain only when an approve fires.

**CSP-strip proxy** (`kura proxy`, port 8422): tiny TLS-MITM that intercepts only the dapps that ship a restrictive `<meta http-equiv="Content-Security-Policy">` (Uniswap, OpenSea). Per-host certs signed by your mkcert root CA. Auto-spawned by qutebrowser's `config.py` on startup, dies cleanly with the browser. Daemon-independent — killing the wallet daemon does not break browsing.

**TUI** (`kura`): opentui+solid renderer, multi-screen router. Subscribes to daemon SSE so events appear without polling.

**Popup** (spawned by daemon): also opentui+solid. Spawns immediately; preprocess (Tenderly + GoPlus + risk + semantic decode) runs in the background and the popup polls `/requests/:id` to refresh as enrichment arrives. Outcome view shows the semantic action ("Approve 0.5 USDC to Permit2", "Swap via Uniswap V4 Universal Router"), contract label + truncated address, spender info, and predicted balance diffs (asset_changes from Tenderly with a Transfer-log fallback when Tenderly's diff extraction misses for opaque routers). Risk badge from a 11-rule engine. `[a]` approve / `[r]` reject / `[tab]` outcome ↔ calldata view / `[q]` cancel. Calldata view shows the raw bytes (or pretty-printed EIP-712 JSON for typed-data signs). Steals focus to your terminal app on spawn (osascript + macOS notification).

**Qutebrowser shim** (`~/.qutebrowser/greasemonkey/kura.user.js`): announces kura via EIP-6963, masquerades as MetaMask, routes JSON-RPC through `GM.xmlHttpRequest` to the daemon. Per-install secret in `X-Kura-Key`.

**Keys**: stored in macOS Keychain at `xyz.<wallet>.kura`. The Swift `kura-signer` binary gates every read through `LAContext.evaluatePolicy(.deviceOwnerAuthentication)`, so each signature pops a Touch ID prompt with a meaningful reason ("kura: Approve 0.5 USDC to Permit2 on Base (main)", "kura: Swap via Uniswap V4 Universal Router on Base (main)", "kura: Permit2: approve unlimited USDC to Uniswap V4 Universal Router (main)"). Description is computed by the semantic tx decoder (`src/core/decode-tx.ts`) before signing. Mac password is the automatic fallback when biometry is hardware-disabled. Brew installs `kura-signer` alongside `kura` (since v0.1.10) so this works out of the box. For dev (`bun run dev`), build the Swift signer once: `cd swift && swift build -c release`. Without it, the runtime falls back to plain `security` CLI with Mac password on every read.

## Chains

Mainnet (tier 1, full risk + sim): Ethereum, Base, Arbitrum, BSC, Monad.
Testnet (tier 2, minimal risk engine): Sepolia, Monad Testnet.

Toggle mainnet/testnet with `n` in the TUI. Add any other EVM chain via the TUI Networks view (`Shift+N` → `a`) or the CLI: `kura chain add <id> <rpc>`. The RPC is validated by calling `eth_chainId`; metadata (name, symbol, explorer, testnet flag) is prompted, then the entry is written to `~/.kura/chains.toml` and reloaded across daemon, TUI, CLI, and popup. Hot chains default to RPC-only capabilities (no HyperSync archive, no Tenderly simulation, no GoPlus risk); native sends and the audit-log activity fallback work out of the box, but inbound transfers and predicted-balance diffs require those services per chain.

## Configuration

`~/.kura/config.toml`:

```toml
default_wallet = "main"
default_chain = 1
safe_threshold_usd = 100      # txs above this get the [REVIEW] risk badge
daemon_port = 8421
daemon_host = "127.0.0.1"
proxy_enabled = true          # spawn the CSP-strip proxy alongside the daemon
proxy_port = 8422
proxy_domains = ["app.uniswap.org", "*.uniswap.org", "opensea.io", "*.opensea.io"]
tenderly_account = "your-account"
tenderly_project = "your-project"
network_mode = "mainnet"      # "mainnet" or "testnet" — drives TUI tab cycle
```

API keys live in macOS Keychain (set during `kura init`):
- `dev.api.alchemy / api-key` — RPC
- `dev.api.envio / hypersync-token` — history
- `dev.api.tenderly / access-key` — simulation

## qutebrowser integration

`kura init` writes the userscript to `~/.qutebrowser/greasemonkey/kura.user.js` and prints the snippet you should add to `~/.qutebrowser/config.py`:

```python
# kura csp-strip proxy: spawned with qb, dies with qb
_kura_proxy_script = os.path.expanduser("~/Documents/kura/src/index.ts")
_kura_proxy_port = 8422
if os.path.exists(_kura_proxy_script) and os.path.exists(_bun) and not _is_port_alive(_kura_proxy_port):
    subprocess.run(["bash", "-c", "pgrep -f 'bun.*src/index\\.ts proxy' | xargs kill 2>/dev/null"], capture_output=True)
    # ... see install-shim output for the full block
if _is_port_alive(_kura_proxy_port):
    c.content.proxy = f'http://127.0.0.1:{_kura_proxy_port}'
else:
    c.content.proxy = 'system'
```

Plus the Chromium PNA disable in `c.qt.args` (see `install-shim` output) so public-origin dapps can reach `127.0.0.1` at all.

## Development

```sh
git clone https://github.com/alkautsarf/kura
cd kura
bun install
bun run dev           # TUI / wizard
bun run daemon        # daemon mode
bun run typecheck
bun run build         # local single-binary at dist/kura
```

CI builds darwin-arm64 + linux-x64 binaries on every `v*` tag. macOS binaries get the bun --compile signature stripped and re-signed adhoc (bun's signature is rejected by macOS Tahoe's mach-o loader).

## License

MIT — see [LICENSE](LICENSE).
