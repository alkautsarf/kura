import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "bun";
import { render, useKeyboard, useRenderer } from "@opentui/solid";
import { createSignal, createResource, createEffect, createMemo, Show, For, onCleanup, onMount } from "solid-js";
import { formatUnits, parseUnits, isAddress } from "viem";
// @ts-expect-error qrcode-terminal has no types
import qrcode from "qrcode-terminal";
import { KURA_HOME } from "../core/paths.ts";
import { fmtAddr } from "../cli/format.ts";
import { copyToClipboard } from "../core/clipboard.ts";
import { getConfig, getWallet, isBiometryMigrated, listWallets, setDefaultWallet, writeConfig } from "../core/config.ts";
import { getOrCreateSecret } from "../core/secret.ts";
import type { Address, ActivityItem, KuraChainConfig, NetworkMode, Portfolio, WalletProfile } from "../core/types.ts";
import { getKnownChain, reloadHotChains, validateRpc, writeHotChains, listHotChains, getBundledChain, mergeChains, DEFAULT_HOT_CAPABILITIES } from "../core/chains.ts";
import { resolve as resolveName } from "../core/resolve.ts";
import { encodeErc20Transfer } from "../core/decode-tx.ts";
import { attachRestoreHandlers, disableTerminalNotifications, quit, setActiveRenderer } from "../core/terminal.ts";
import {
  createGeneratedWallet,
  createImportedWallet,
  createWatchOnlyWallet,
  deleteWallet,
  isValidWalletName,
  removeWalletWithFallback,
  walletPresence,
} from "../core/wallet.ts";
import { requireBiometry } from "../core/keychain.ts";
import { confirm as cliConfirm } from "../cli/prompt.ts";

interface ApiClient {
  base: string;
  secret: string;
}

let api: ApiClient | null = null;

async function client(): Promise<ApiClient> {
  if (!api) {
    const cfg = await getConfig();
    api = {
      base: `https://${cfg.daemonHost}:${cfg.daemonPort}`,
      secret: await getOrCreateSecret(),
    };
  }
  return api;
}

const tlsOpts = { tls: { rejectUnauthorized: false } } as RequestInit & { tls?: { rejectUnauthorized: boolean } };

async function get<T>(path: string): Promise<T> {
  const c = await client();
  const resp = await fetch(`${c.base}${path}`, { ...tlsOpts, headers: { "X-Kura-Key": c.secret } });
  if (!resp.ok) throw new Error(`${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json() as Promise<T>;
}

async function getSignal<T>(path: string, signal: AbortSignal): Promise<T> {
  const c = await client();
  const resp = await fetch(`${c.base}${path}`, { ...tlsOpts, headers: { "X-Kura-Key": c.secret }, signal });
  if (!resp.ok) throw new Error(`${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const c = await client();
  const resp = await fetch(`${c.base}${path}`, {
    ...tlsOpts,
    method: "POST",
    headers: { "X-Kura-Key": c.secret, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const c = await client();
  const resp = await fetch(`${c.base}${path}`, { ...tlsOpts, method: "DELETE", headers: { "X-Kura-Key": c.secret } });
  if (!resp.ok) throw new Error(`${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json() as Promise<T>;
}

// Prefer qutebrowser (kura's primary target browser) over the system default,
// which on this user's machine is Chrome. Resolved once at module load so we
// don't re-stat 6 paths on every [o] keypress.
const QB_PATH: string | null = (() => {
  const candidates = [
    Bun.which("qutebrowser"),
    `${homedir()}/Library/Python/3.14/bin/qutebrowser`,
    `${homedir()}/Library/Python/3.13/bin/qutebrowser`,
    `${homedir()}/Library/Python/3.12/bin/qutebrowser`,
    "/opt/homebrew/bin/qutebrowser",
    "/usr/local/bin/qutebrowser",
  ].filter((p): p is string => !!p);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
})();

function openUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const cmd = QB_PATH ? [QB_PATH, url] : ["open", url];
      const p = spawn({ cmd, stdout: "ignore", stderr: "ignore" });
      p.exited.then((code) => resolve(code === 0)).catch(() => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

function fmtUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function fmtTok(raw: string, decimals: number): string {
  const n = Number(formatUnits(BigInt(raw), decimals));
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 1) {
    // Show 4 decimals so small sends (0.001 OG, gas costs) are visible.
    // Trim trailing zeros for clean output: 5.0000 -> 5, 4.9989 stays.
    return n.toFixed(4).replace(/\.?0+$/, "");
  }
  if (Math.abs(n) >= 1e-4) return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return n.toFixed(4);
}

// Activity-row amount: tight, single-line, never wraps. Spam tokens (huge raw
// values + missing/zero decimals) get a "[spam]" tag so the row stays scannable
// instead of dumping a 200-char number.
function fmtActivityAmount(raw: string, decimals: number | undefined, symbol: string): string {
  let big: bigint;
  try { big = BigInt(raw); } catch { return `? ${symbol}`; }
  if (big === 0n) return `0 ${symbol}`;
  const dec = decimals ?? 18;
  // Spam: raw value > 10^36 (1 trillion units even at 24 decimals) is almost
  // always airdrop spam, not real value.
  if (big > 10n ** 36n) return `[spam] ${symbol}`;
  // Native EVM amounts (18 decimals): sub-microether values render as wei/gwei
  // so 1 wei displays as "1 wei" instead of "1.000e-18 ETH" (unreadable). Use
  // decimal ETH only once the amount is >= 1 milliether where the decimal
  // representation has fewer than 4 leading zeros after the dot.
  if (dec === 18) {
    const abs = big < 0n ? -big : big;
    const sign = big < 0n ? "-" : "";
    if (abs < 1_000_000_000n) {
      // sub-gwei: render as raw wei (single integer, no decimals)
      return `${sign}${abs.toString()} wei`;
    }
    if (abs < 1_000_000_000_000_000n) {
      // 1 gwei to 1 milliether: render as gwei
      const gweiNum = Number(abs) / 1e9;
      const gweiStr = (gweiNum >= 1 ? gweiNum.toFixed(2) : gweiNum.toFixed(4))
        .replace(/0+$/, "").replace(/\.$/, "");
      return `${sign}${gweiStr} gwei`;
    }
  }
  const text = formatUnits(big, dec);
  const num = Number(text);
  if (!Number.isFinite(num)) return `[huge] ${symbol}`;
  // Pick precision by magnitude so small ETH amounts stay human-readable.
  let formatted: string;
  const abs = Math.abs(num);
  if (abs === 0) formatted = "0";
  else if (abs < 1e-9) {
    // Avoid scientific notation entirely. Tiny ERC20 amounts that aren't
    // worth showing precisely get a "<0.0000001" placeholder; matches the
    // way most wallets show dust.
    formatted = num < 0 ? "-<0.0000001" : "<0.0000001";
  }
  else if (abs < 1e-4) formatted = num.toFixed(8);
  else if (abs < 1) formatted = num.toFixed(6);
  else if (abs < 1000) formatted = num.toFixed(4);
  else if (abs < 1e9) formatted = num.toFixed(2);
  else formatted = num.toExponential(3);
  // Trim trailing zeros after decimal, then orphan dot.
  if (formatted.includes(".") && !formatted.includes("e")) {
    formatted = formatted.replace(/0+$/, "").replace(/\.$/, "");
  }
  return `${formatted} ${symbol}`;
}

// Activity row palette: muted base for the bulk of the row, blue accent for
// amounts + token symbols so they pop without the whole line shouting in red
// or green. Direction signal moved to a small leading symbol instead of the
// row color, which the user found visually noisy.
const ROW_COLORS = {
  text: "#a5adba",      // base text
  amount: "#88c0d0",    // amount + symbol highlight (cyan)
  venue: "#b48ead",     // contract label / "on Router" suffix (purple)
  age: "#888",
  dim: "#666",          // counter address, hash
  outArrow: "#c87a4a",  // muted orange (was bright #ff8c66)
  inArrow: "#88a070",   // muted green (was bright #a3be8c)
  // tx detail extras (data field values, success/fail status)
  value: "#e0e0e0",
  ok: "#a3be8c",
  bad: "#ff8c66",
} as const;

// Split a daemon description like "Swap 0.5 USDC for 0.0002 ETH on Relay Router"
// into typed segments so we can render amounts (cyan) and the venue suffix
// (purple) in distinct colors while the connective verbs stay muted.
type DescSegment = { text: string; kind: "text" | "amount" | "venue" };
function colorizeDescription(desc: string): DescSegment[] {
  const segments: DescSegment[] = [];
  // First peel off " on <Venue>" / " via <Venue>" / " to <Venue>" suffix.
  let body = desc;
  let venueTail: string | null = null;
  const venueMatch = /\s+(?:on|via|to|from)\s+(.+)$/.exec(desc);
  if (venueMatch) {
    body = desc.slice(0, venueMatch.index);
    venueTail = venueMatch[0];
  }
  // Then highlight amount+symbol pairs in the body.
  const amountRe = /(\d+(?:\.\d+)?\s+[A-Z][\w._-]*)/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = amountRe.exec(body)) !== null) {
    if (m.index > lastIdx) segments.push({ text: body.slice(lastIdx, m.index), kind: "text" });
    segments.push({ text: m[1]!, kind: "amount" });
    lastIdx = m.index + m[1]!.length;
  }
  if (lastIdx < body.length) segments.push({ text: body.slice(lastIdx), kind: "text" });
  if (venueTail) segments.push({ text: venueTail, kind: "venue" });
  return segments;
}

function fmtAge(ts: number): string {
  if (!ts) return "?";
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// Toggle debug keystroke / lifecycle logging by setting KURA_TUI_DEBUG=1. Writes
// to /tmp/kura-tui-keys.log. Used for diagnosing input pipeline bugs (e.g. the
// DEC 997 flood that drowned out ESC keystrokes pre-v0.1.19); off by default
// because the appendFileSync per byte adds measurable overhead.
const DEBUG_LOG = process.env.KURA_TUI_DEBUG === "1";
function dbglog(msg: string): void {
  if (!DEBUG_LOG) return;
  try {
    const t = process.hrtime.bigint();
    const ts = `${(Number(t) / 1e6).toFixed(3)}`;
    require("node:fs").appendFileSync("/tmp/kura-tui-keys.log", `${ts}ms ${msg}\n`);
  } catch { /* best effort */ }
}

function qrLines(text: string): Promise<string[]> {
  return new Promise((resolve) => {
    qrcode.generate(text, { small: true }, (out: string) => {
      resolve(out.split("\n"));
    });
  });
}

const nameCache = new Map<string, string | null>();
async function reverseLookup(addr: string): Promise<string | null> {
  const key = addr.toLowerCase();
  if (nameCache.has(key)) return nameCache.get(key)!;
  try {
    const r = await get<{ input: string; address: string | null; source: string }>(`/resolve?name=${addr}`);
    if (r.source === "address") {
      nameCache.set(key, null);
      return null;
    }
  } catch {
    // ignore
  }
  nameCache.set(key, null);
  return null;
}

type View = "home" | "send" | "receive" | "history" | "connections" | "watch" | "wallets" | "chains" | "tx";

interface AppProps {
  wallet: WalletProfile;
  walletList: WalletProfile[];
  initialChainId: number;
  initialMode: NetworkMode;
}

function App(props: AppProps) {
  const [view, setView] = createSignal<View>("home");
  const [chainId, setChainId] = createSignal(props.initialChainId);
  const [tick, setTick] = createSignal(0);
  const [mode, setModeSignal] = createSignal<NetworkMode>(props.initialMode);
  const [chains, setChains] = createSignal<KuraChainConfig[]>([]);
  const [wallet, setWallet] = createSignal<WalletProfile>(props.wallet);
  const [wallets, setWallets] = createSignal<WalletProfile[]>(props.walletList);
  // Hide unverified (no-USD-price) tokens by default; user toggles with [u].
  // Lives in App so it persists when navigating between views.
  const [showUnverified, setShowUnverified] = createSignal(false);
  // Vim-style cursor for activity rows in home + history. Reset when view or
  // wallet changes; clamped to visible items at render time.
  const [cursor, setCursor] = createSignal(0);
  const [txItem, setTxItem] = createSignal<ActivityItem | null>(null);
  const [txReturnView, setTxReturnView] = createSignal<View>("home");
  const [txDetailMode, setTxDetailMode] = createSignal<"overview" | "data">("overview");
  const [copyToast, setCopyToast] = createSignal("");
  let copyToastTimer: ReturnType<typeof setTimeout> | null = null;
  function showCopyToast(msg: string): void {
    if (copyToastTimer) clearTimeout(copyToastTimer);
    setCopyToast(msg);
    copyToastTimer = setTimeout(() => setCopyToast(""), 2000);
  }
  onCleanup(() => { if (copyToastTimer) clearTimeout(copyToastTimer); });
  const renderer = useRenderer();

  // Hand the live renderer to terminal.ts so the centralized quit() (which
  // is what attachRestoreHandlers' SIGINT/SIGTERM/SIGHUP routes through) can
  // call destroy() before process.exit. Without this, signal-driven exits
  // would skip the native render pipeline's flush and pending writes would
  // leak into the parent shell after the process is gone.
  onMount(() => {
    setActiveRenderer(renderer ?? null);
    onCleanup(() => setActiveRenderer(null));
  });

  // Subscribe to the daemon's SSE event stream so we can refresh portfolio +
  // history within ~1s of a tx being signed, instead of waiting for the next
  // 30s tick. Only listens for `request:resolved` with decision=approve; the
  // 30s polling fallback still catches incoming txs the daemon doesn't know
  // about. Falls through silently if the stream can't connect (TUI keeps
  // working on the polling fallback alone).
  let sseCtrl: AbortController | null = null;
  onMount(() => {
    void (async () => {
      try {
        const c = await client();
        sseCtrl = new AbortController();
        const resp = await fetch(`${c.base}/events?stream=1`, {
          ...tlsOpts,
          headers: { "X-Kura-Key": c.secret },
          signal: sseCtrl.signal,
        });
        if (!resp.ok || !resp.body) return;
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const ev = JSON.parse(dataLine.slice(6)) as { type?: string; payload?: { decision?: string } };
              if (ev.type === "request:resolved" && ev.payload?.decision === "approve") {
                setTick((t) => t + 1);
              }
            } catch { /* skip malformed */ }
          }
        }
      } catch {
        // ignore: poll fallback still works
      }
    })();
  });
  onCleanup(() => sseCtrl?.abort());

  const [chainsTick, setChainsTick] = createSignal(0);
  const [chainList] = createResource(
    () => [mode(), chainsTick()] as const,
    async ([m]) => {
      const r = await get<{ chains: KuraChainConfig[] }>(`/chains?mode=${m}`).catch(() => ({ chains: [] }));
      return r.chains;
    },
  );
  createEffect(() => {
    const cs = chainList();
    if (cs && cs.length > 0) {
      setChains(cs);
      // If current chain doesn't belong to the selected mode, jump to first chain in this mode
      if (!cs.some((c) => c.id === chainId())) setChainId(cs[0]!.id);
    }
  });

  // Persist mode + jump-to-first-chain when toggling
  async function toggleMode(): Promise<void> {
    const next: NetworkMode = mode() === "mainnet" ? "testnet" : "mainnet";
    setModeSignal(next);
    try {
      const cfg = await getConfig();
      await writeConfig({ ...cfg, networkMode: next });
    } catch {
      // non-fatal: TUI keeps mode in memory even if persistence fails
    }
  }

  // Cycle to the next wallet (insertion order from state.json) and persist
  // as the default. Reload the wallet list from disk first so an `add` from
  // another pane is reflected without restarting the TUI.
  async function cycleWallet(): Promise<void> {
    let list: WalletProfile[];
    try {
      list = await listWallets();
    } catch {
      list = wallets();
    }
    if (list.length <= 1) return;
    setWallets(list);
    const idx = list.findIndex((w) => w.name === wallet().name);
    const next = list[(idx + 1) % list.length]!;
    setWallet(next);
    try {
      await setDefaultWallet(next.name);
    } catch {
      // non-fatal: in-memory switch still works for the session
    }
  }

  // Debounced chain id: when the user spams `tab` to cycle visually, we don't
  // want to fire portfolio/history fetches on every press. Wait 200ms after the
  // last tab settled, then commit the new id so the heavy fetchers fire once.
  const [committedChainId, setCommittedChainId] = createSignal(props.initialChainId);
  let chainCommitTimer: ReturnType<typeof setTimeout> | null = null;
  createEffect(() => {
    const id = chainId();
    if (chainCommitTimer) clearTimeout(chainCommitTimer);
    chainCommitTimer = setTimeout(() => setCommittedChainId(id), 200);
  });
  onCleanup(() => { if (chainCommitTimer) clearTimeout(chainCommitTimer); });

  // Per-fetcher AbortController so a chain change cancels the in-flight request
  // on the daemon side instead of waiting for it to complete and discarding it.
  let portfolioCtrl: AbortController | null = null;
  let historyCtrl: AbortController | null = null;
  const [portfolio] = createResource(
    () => [committedChainId(), tick(), wallet().address] as const,
    async ([cid, _t, addr]) => {
      portfolioCtrl?.abort();
      portfolioCtrl = new AbortController();
      try {
        return await getSignal<Portfolio>(`/portfolio?chain=${cid}&address=${addr}`, portfolioCtrl.signal);
      } catch {
        return null;
      }
    },
  );
  const [history] = createResource(
    () => [committedChainId(), tick(), wallet().address] as const,
    async ([cid, _t, addr]) => {
      historyCtrl?.abort();
      historyCtrl = new AbortController();
      try {
        return await getSignal<{ items: ActivityItem[] }>(`/history?chain=${cid}&address=${addr}&limit=50`, historyCtrl.signal);
      } catch {
        return { items: [] as ActivityItem[] };
      }
    },
  );

  // Only tick when the user can actually see the data , avoids racking up
  // background daemon roundtrips while they're managing wallets or sessions.
  const interval = setInterval(() => {
    if (view() === "home" || view() === "history") setTick((t) => t + 1);
  }, 30_000);
  onCleanup(() => {
    clearInterval(interval);
    portfolioCtrl?.abort();
    historyCtrl?.abort();
  });

  // Reset cursor when wallet or chain changes (the underlying activity list is
  // different so old cursor is meaningless). Keep cursor when toggling between
  // home and history (same data shape) and across tx-detail in/out so the user
  // can drill down on a row, esc, and continue browsing from where they were.
  createEffect(() => {
    void wallet().address;
    void committedChainId();
    setCursor(0);
  });

  // Visible activity items used for cursor navigation in home/history.
  // Keep in sync with the slicing inside HomeView/HistoryView.
  const visibleHomeItems = () => (history()?.items ?? []).filter((it) => !it.isDust).slice(0, 10);
  const visibleHistoryItems = () => (history()?.items ?? []).slice(0, 50);
  const cursorList = () => view() === "history" ? visibleHistoryItems() : visibleHomeItems();
  function moveCursor(delta: number): void {
    const max = Math.max(0, cursorList().length - 1);
    setCursor((c) => Math.max(0, Math.min(max, c + delta)));
  }
  function openCurrentTx(): void {
    const list = cursorList();
    const it = list[cursor()];
    if (!it) return;
    setTxItem(it);
    setTxReturnView(view() as View);
    setTxDetailMode("overview");
    setView("tx");
  }

  // Kill opentui's theme-mode handler and re-disable color-scheme notifications.
  // Why: Ghostty (and likely other modern terminals) fires `\x1B[?997;1n` at
  // ~11k events/sec when DEC 996/2031 are enabled. opentui's themeModeHandler
  // responds to each by querying OSC 10/11, terminal replies, and the flood
  // drowns out user keystrokes (ESC, etc) until the parser drains on focus
  // loss. Disabling the modes once at startup is not enough because opentui's
  // native setup re-enables them; writing directly to stdout sidesteps the
  // renderer pipeline and the input handler removal kills the query loop.
  onMount(() => {
    try {
      const r = renderer as unknown as {
        removeInputHandler?: (h: unknown) => void;
        themeModeHandler?: unknown;
      };
      if (r.themeModeHandler && r.removeInputHandler) {
        r.removeInputHandler(r.themeModeHandler);
      }
    } catch { /* private API, best-effort */ }
    try {
      process.stdout.write("\x1b[?996l\x1b[?2031l\x1b[?2048l");
    } catch { /* best-effort */ }
  });
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      quit(0);
    }
    if (view() === "home") {
      if (key.name === "q") quit(0);
      else if (key.name === "s") setView("send");
      else if (key.name === "r") setView("receive");
      else if (key.name === "h") setView("history");
      else if (key.name === "c") setView("connections");
      else if (key.name === "w") setView("wallets");
      else if (key.name === "e") setView("watch");
      else if (key.name === "g") setTick((t) => t + 1);
      else if (key.name === "u") setShowUnverified((v) => !v);
      else if (key.name === "n" && key.shift) setView("chains");
      else if (key.name === "n") void toggleMode();
      else if (key.name === "j" || key.name === "down") moveCursor(1);
      else if (key.name === "k" || key.name === "up") moveCursor(-1);
      else if (key.name === "return") openCurrentTx();
      else if (key.name === "y") {
        const addr = wallet().address;
        copyToClipboard(addr).then((ok) => {
          showCopyToast(ok ? `copied ${fmtAddr(addr)}` : "copy failed");
        });
      }
      else if (key.name === "tab") {
        if (key.shift) {
          void cycleWallet();
          return;
        }
        // Defensive: ensure current chainId is always in the rotation, even if
        // the daemon's /chains list excludes it (e.g., user has a testnet as
        // default but the daemon doesn't return it). This way `tab` never
        // strands the user on a chain they can't get back to.
        let ids = chains().map((c) => c.id);
        if (!ids.includes(chainId())) ids = [chainId(), ...ids];
        if (ids.length === 0) return;
        const idx = ids.indexOf(chainId());
        const next = ids[(idx + 1) % ids.length]!;
        setChainId(next);
      }
      return;
    }
    if (view() === "history") {
      if (key.name === "j" || key.name === "down") { moveCursor(1); return; }
      if (key.name === "k" || key.name === "up") { moveCursor(-1); return; }
      if (key.name === "return") { openCurrentTx(); return; }
      if (key.name === "escape") { setView("home"); return; }
      return;
    }
    if (view() === "tx") {
      // tab / c / o / j / k are owned by TxDetailView's own useKeyboard so
      // sub-view state (overview vs data, scroll offset) stays local.
      if (key.name === "escape") {
        setView(txReturnView());
        setTxItem(null);
      }
      return;
    }
    // Non-home views: only Esc returns home. Lets text input handlers see all other keys.
    // wallets owns its escape so sub-modes (name input, add-choose, etc) can pop one level.
    if (view() === "wallets") return;
    if (view() === "chains") return;
    if (key.name === "escape") {
      setView("home");
    }
  });

  const chain = () => chains().find((c) => c.id === chainId()) ?? getKnownChain(chainId());
  // Derive native USD-per-token from the portfolio so detail view can show the
  // gas USD equivalent without a separate price fetch.
  const nativePriceUsd = (): number | null => {
    const native = portfolio()?.tokens.find((t) => t.token === "native");
    if (!native?.usd || !native?.balance) return null;
    try {
      const eth = Number(formatUnits(BigInt(native.balance), 18));
      if (eth === 0) return null;
      return native.usd / eth;
    } catch { return null; }
  };

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={0} width="100%" height="100%">
      <box flexDirection="row" justifyContent="space-between" border={["bottom"]} borderColor="#333">
        <text attributes={1}>kura</text>
        <box flexDirection="row">
          <text fg={ROW_COLORS.amount}>{fmtAddr(wallet().address)}</text>
          <text fg={ROW_COLORS.dim}> · </text>
          <text>{wallet().name}</text>
          <text fg={ROW_COLORS.dim}> · </text>
          <text>{chain()?.name ?? `chain ${chainId()}`}</text>
          <text fg={ROW_COLORS.dim}> · </text>
          <text fg={mode() === "testnet" ? "#f9a825" : "#a3be8c"}>{mode()}</text>
        </box>
      </box>

      <Show when={view() === "home"}>
        <HomeView
          portfolio={portfolio()}
          portfolioLoading={portfolio.loading}
          history={history()}
          historyLoading={history.loading}
          chain={chain()}
          showUnverified={showUnverified()}
          cursor={cursor()}
        />
      </Show>
      <Show when={view() === "send"}>
        <SendModal wallet={wallet()} chainId={chainId()} chain={chain()} portfolio={portfolio()} onDone={() => setView("home")} />
      </Show>
      <Show when={view() === "receive"}>
        <ReceiveModal wallet={wallet()} chain={chain()} />
      </Show>
      <Show when={view() === "history"}>
        <HistoryView items={(history()?.items ?? []).slice(0, 50)} chain={chain()} cursor={cursor()} loading={history.loading} loaded={history() !== undefined} />
      </Show>
      <Show when={view() === "tx"}>
        <TxDetailView
          item={txItem()}
          chain={chain()}
          chainId={chainId()}
          nativePrice={nativePriceUsd()}
          mode={txDetailMode()}
          onModeChange={setTxDetailMode}
          onCopyToast={showCopyToast}
          onClose={() => { setView(txReturnView()); setTxItem(null); }}
        />
      </Show>
      <Show when={view() === "connections"}>
        <ConnectionsView />
      </Show>
      <Show when={view() === "watch"}>
        <WatchView />
      </Show>
      <Show when={view() === "wallets"}>
        <WalletView
          current={wallet()}
          onSelect={(w) => setWallet(w)}
          onListChange={(list) => setWallets(list)}
          onClose={() => setView("home")}
          renderer={renderer}
        />
      </Show>
      <Show when={view() === "chains"}>
        <ChainView
          mode={mode()}
          currentChainId={chainId()}
          onSelect={async (c) => {
            const wantMode: NetworkMode = c.testnet ? "testnet" : "mainnet";
            if (mode() !== wantMode) {
              await toggleMode();
              // Wait for chainList resource to refetch so the createEffect
              // doesn't snap chainId back to the new mode's first entry.
              await new Promise((r) => setTimeout(r, 250));
            }
            setChainId(c.id);
          }}
          onChange={() => setChainsTick((t) => t + 1)}
          onClose={() => setView("home")}
        />
      </Show>

      {/* spacer pushes footer to absolute bottom of pane */}
      <box flexGrow={1} />
      <Show when={copyToast()}>
        <text fg={ROW_COLORS.amount}>{`  ${copyToast()}`}</text>
      </Show>
      <FooterHints view={view()} mode={txDetailMode()} />
    </box>
  );
}

// Single activity row with segmented colors. Reused by both HomeView and
// HistoryView. `extras` adds optional trailing columns (block#, hash) for the
// fuller history layout. `selected` flips the leading ` ` to `>` and brightens
// the age column for vim-style cursor navigation.
function ActivityRow(props: {
  it: ActivityItem;
  resolved: Record<string, string | null>;
  chain: KuraChainConfig | undefined;
  extras?: "history";
  selected?: boolean;
}) {
  const it = props.it;
  const isSelf = it.direction === "self";
  const counter = it.direction === "out" ? it.to : it.from;
  const name = counter ? props.resolved[counter.toLowerCase()] : null;
  // Self-transfers: counter party is the wallet itself; showing the address
  // again is noise. Use the tx hash for the right column instead so the row
  // surfaces something useful (and matches history view's hash column).
  const counterDisplay = isSelf ? fmtAddr(it.hash, 4) : (name ?? fmtAddr(counter));
  const arrowChar = it.direction === "out" ? "-" : it.direction === "in" ? "+" : isSelf ? "↻" : " ";
  const arrowColor = it.direction === "out" ? ROW_COLORS.outArrow : it.direction === "in" ? ROW_COLORS.inArrow : isSelf ? ROW_COLORS.amount : ROW_COLORS.dim;
  // Build the description (or fall back for raw native/erc20 rows that the
  // daemon couldn't enrich with semantics). Self-transfers don't go through the
  // daemon enrichment path because there's no useful semantic to decode (no
  // counter party transfer), so format here with a friendlier "Self transfer"
  // label instead of the raw amount which renders as "1.000e-18 ETH" for 1 wei.
  const description = it.description ?? (() => {
    const symbol = it.kind === "erc20" ? (it.symbol ?? fmtAddr(it.token, 4)) : (props.chain?.symbol ?? "ETH");
    const dec = it.kind === "erc20" ? it.decimals : 18;
    if (isSelf) {
      const amt = fmtActivityAmount(it.value, dec, symbol);
      return `Self transfer ${amt}`;
    }
    return fmtActivityAmount(it.value, dec, symbol);
  })();
  const segments = colorizeDescription(description);
  const dustTag = it.isDust ? "[dust] " : "";
  // Width budgets so amount/venue colors line up across rows. Description is
  // hard-clipped to keep one line per tx; counter and hash get fixed slots.
  const descWidth = props.extras === "history" ? 50 : 56;
  const fullText = dustTag + segments.map((s) => s.text).join("");
  const truncated = fullText.length > descWidth;
  const visible = truncated ? fullText.slice(0, descWidth - 1) + "…" : fullText.padEnd(descWidth);
  // Re-walk segments aligned to the truncated string so colors stay correct.
  const colored: DescSegment[] = [];
  let cursor = 0;
  if (dustTag) {
    colored.push({ text: dustTag, kind: "text" });
    cursor = dustTag.length;
  }
  for (const seg of segments) {
    if (cursor >= visible.length) break;
    const remaining = visible.length - cursor;
    const slice = seg.text.slice(0, remaining);
    if (slice.length > 0) colored.push({ text: slice, kind: seg.kind });
    cursor += slice.length;
  }
  // Pad the colored chunks out to descWidth so the next column lines up.
  if (cursor < descWidth) colored.push({ text: " ".repeat(descWidth - cursor), kind: "text" });
  const segColor = (k: DescSegment["kind"]) => {
    if (it.isDust) return ROW_COLORS.dim;
    return k === "amount" ? ROW_COLORS.amount : k === "venue" ? ROW_COLORS.venue : ROW_COLORS.text;
  };
  return (
    <box flexDirection="row" marginBottom={props.extras === "history" ? 0 : 1}>
      <text fg={props.selected ? ROW_COLORS.amount : ROW_COLORS.age}>{`${props.selected ? "> " : "  "}${fmtAge(it.timestamp).padEnd(5)} `}</text>
      <text fg={arrowColor}>{`${arrowChar} `}</text>
      <For each={colored}>
        {(seg) => <text fg={segColor(seg.kind)}>{seg.text}</text>}
      </For>
      <text fg={ROW_COLORS.dim}>{`  ${counterDisplay.padEnd(props.extras === "history" ? 28 : 22).slice(0, props.extras === "history" ? 28 : 22)}`}</text>
      <Show when={props.extras === "history"}>
        <text fg={ROW_COLORS.dim}>{`  #${it.blockNumber.toString().padEnd(10)} ${fmtAddr(it.hash, 4)}`}</text>
      </Show>
    </box>
  );
}

function HomeView(props: {
  portfolio: Portfolio | null | undefined;
  portfolioLoading: boolean;
  history: { items: ActivityItem[] } | undefined;
  historyLoading: boolean;
  chain: KuraChainConfig | undefined;
  showUnverified: boolean;
  cursor: number;
}) {
  // Hide isDust spam from the home view (kura history shows them separately).
  // Cap at 10 rows; with marginBottom=1 each row takes 2 lines so 20 lines fits
  // comfortably alongside the portfolio + header on a 36-line terminal.
  const items = () => (props.history?.items ?? []).filter((it) => !it.isDust).slice(0, 10);
  const [resolved, setResolved] = createSignal<Record<string, string | null>>({});
  createEffect(() => {
    const list = items();
    Promise.all(
      list.map(async (it) => {
        const counter = it.direction === "out" ? it.to : it.from;
        if (!counter) return null;
        const name = await reverseLookup(counter);
        return [counter.toLowerCase(), name] as const;
      }),
    ).then((entries) => {
      const next: Record<string, string | null> = {};
      for (const e of entries) if (e) next[e[0]] = e[1];
      setResolved((prev) => ({ ...prev, ...next }));
    });
  });
  // Visible portfolio: priced tokens always; unverified gated behind toggle;
  // spam never shown here (only counted in the hidden line).
  const visibleTokens = () => {
    const all = (props.portfolio?.tokens ?? []).filter((t) => !t.spam);
    const filtered = props.showUnverified ? all : all.filter((t) => !t.unverified);
    return filtered.slice(0, 8);
  };
  const spamCount = () => (props.portfolio?.tokens ?? []).filter((t) => t.spam).length;
  const unverifiedCount = () => (props.portfolio?.tokens ?? []).filter((t) => t.unverified && !t.spam).length;
  const dustCount = () => (props.history?.items ?? []).filter((it) => it.isDust).length;
  return (
    <box flexDirection="column">
      <box marginTop={1} flexDirection="column">
        <box flexDirection="row">
          <text attributes={1}>Portfolio  </text>
          <text attributes={1} fg={props.portfolio ? "#a3be8c" : "#888"}>
            {props.portfolio ? fmtUsd(props.portfolio.totalUsd) : "loading..."}
          </text>
          <Show when={props.portfolio && props.portfolioLoading}>
            <text fg="#666">  (refreshing)</text>
          </Show>
        </box>
        <Show when={props.portfolio}>
          <box marginTop={1} flexDirection="column">
            <For each={visibleTokens()}>
              {(t) => {
                const tag = t.unverified ? "  [unverified]" : "";
                const dim = t.unverified;
                const symColor = dim ? "#666" : ROW_COLORS.amount;
                const restColor = dim ? "#666" : undefined;
                return (
                  <box flexDirection="row">
                    <text fg={symColor}>{`  ${t.symbol.padEnd(8)} `}</text>
                    <text fg={restColor}>{`${fmtTok(t.balance, t.decimals).padStart(14)}  ${fmtUsd(t.usd).padStart(10)}  ${(t.pct ?? 0).toFixed(1)}%${tag}`}</text>
                  </box>
                );
              }}
            </For>
            <Show when={!props.showUnverified && unverifiedCount() > 0}>
              <text fg="#666">{`  + ${unverifiedCount()} unverified token${unverifiedCount() === 1 ? "" : "s"} hidden  ([u] to show)`}</text>
            </Show>
            <Show when={spamCount() > 0}>
              <text fg="#666">{`  + ${spamCount()} spam token${spamCount() === 1 ? "" : "s"} hidden`}</text>
            </Show>
          </box>
        </Show>
      </box>
      <box marginTop={1} flexDirection="column">
        <box flexDirection="row">
          <text attributes={1}>Recent Activity</text>
          <Show when={props.historyLoading && props.history}>
            <text fg="#666">  (refreshing)</text>
          </Show>
        </box>
        <box marginTop={1} flexDirection="column">
          <Show when={items().length > 0} fallback={
            <text fg={ROW_COLORS.dim}>{props.historyLoading || !props.history ? "  loading recent activity..." : "  no recent activity"}</text>
          }>
            <For each={items()}>
              {(it, idx) => (
                <ActivityRow
                  it={it}
                  resolved={resolved()}
                  chain={props.chain}
                  selected={idx() === props.cursor}
                />
              )}
            </For>
            <Show when={dustCount() > 0}>
              <text fg={ROW_COLORS.dim}>{`  + ${dustCount()} dust/spam tx${dustCount() === 1 ? "" : "s"} hidden`}</text>
            </Show>
          </Show>
        </box>
      </box>
    </box>
  );
}

function SendModal(props: {
  wallet: WalletProfile;
  chainId: number;
  chain: KuraChainConfig | undefined;
  portfolio: Portfolio | null | undefined;
  onDone: () => void;
}) {
  const [field, setField] = createSignal<"to" | "amount" | "token" | "submit">("none" as never);
  const [to, setTo] = createSignal("");
  const [amount, setAmount] = createSignal("");
  const [token, setToken] = createSignal(props.chain?.symbol ?? "ETH");
  const [status, setStatus] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const [ready, setReady] = createSignal(false);
  const [mountKey, setMountKey] = createSignal(0);
  // Delay rendering inputs so the keystroke that opened this modal does not leak into the input
  onMount(() => {
    setTimeout(() => {
      setField("to");
      setReady(true);
      // After a beat, force remount to discard any leaked first char
      setTimeout(() => {
        setReady(false);
        setTo("");
        setAmount("");
        setToken(props.chain?.symbol ?? "ETH");
        setTimeout(() => {
          setMountKey((k) => k + 1);
          setReady(true);
        }, 30);
      }, 100);
    }, 150);
  });

  useKeyboard((key) => {
    if (busy()) return;
    if (key.name === "tab") {
      const order: ("to" | "amount" | "token" | "submit")[] = ["to", "amount", "token", "submit"];
      const idx = order.indexOf(field() as "to" | "amount" | "token" | "submit");
      setField(order[Math.max(0, (idx + 1)) % order.length]!);
    } else if (key.name === "return" && field() === "submit") {
      submit();
    }
  });

  async function submit() {
    // Strip the leaked entry character (e.g., "s") that opentui buffers from the modal-open keystroke
    let toRaw = to().trim();
    if (toRaw && !/^(0x|[a-z0-9-]+\.)/.test(toRaw)) toRaw = toRaw.slice(1);
    if (!toRaw || !amount()) {
      setStatus("to and amount required");
      return;
    }
    setBusy(true);
    setStatus("resolving...");
    try {
      const resolved = await resolveName(toRaw);
      const dest = resolved.address;
      if (!dest) throw new Error(`could not resolve ${to()}`);
      const symbol = token().toUpperCase();
      const isNative = symbol === (props.chain?.symbol ?? "ETH").toUpperCase();
      let value = "0";
      let dataField: `0x${string}` = "0x";
      let target: Address = dest;
      const rawAmount = amount().trim();
      if (isNative) {
        value = parseUnits(rawAmount.replace(/^\$/, ""), 18).toString();
      } else {
        const tokens = props.portfolio?.tokens ?? [];
        const tok = tokens.find(
          (t) => t.token !== "native" && t.symbol.toUpperCase() === symbol,
        );
        if (!tok) {
          setStatus(`no ${symbol} balance on this chain`);
          setBusy(false);
          return;
        }
        const tokenAddr = tok.token as Address;
        const dec = tok.decimals;
        let amt: bigint;
        if (rawAmount.startsWith("$")) {
          const usd = Number(rawAmount.slice(1));
          if (!Number.isFinite(usd) || usd <= 0) {
            setStatus("bad $ amount");
            setBusy(false);
            return;
          }
          const balDec = Number(formatUnits(BigInt(tok.balance), dec));
          const unitPrice = balDec > 0 && tok.usd ? tok.usd / balDec : null;
          if (!unitPrice) {
            setStatus(`no price for ${symbol}, can't convert $`);
            setBusy(false);
            return;
          }
          amt = parseUnits((usd / unitPrice).toFixed(dec), dec);
        } else {
          try {
            amt = parseUnits(rawAmount, dec);
          } catch {
            setStatus(`bad amount: ${rawAmount}`);
            setBusy(false);
            return;
          }
        }
        target = tokenAddr;
        value = "0";
        dataField = encodeErc20Transfer(dest, amt);
      }
      setStatus("submitting to daemon...");
      const result = await post<{ decision: string; txHash?: string; error?: string }>("/requests", {
        kind: "eth_sendTransaction",
        chainId: props.chainId,
        source: "tui:send",
        payload: { from: props.wallet.address, to: target, data: dataField, value },
      });
      if (result.decision === "approve") {
        setStatus(`approved ${result.txHash ?? ""}`);
      } else {
        setStatus(`${result.decision} ${result.error ?? ""}`);
      }
      setTimeout(() => props.onDone(), 2000);
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
      setBusy(false);
    }
  }

  return (
    <box marginTop={1} flexDirection="column">
      <text attributes={1}>send</text>
      <FormRow label="to" value={to()} active={field() === "to"} ready={ready()} onChange={setTo} mountKey={mountKey()} />
      <FormRow label="amount" value={amount()} active={field() === "amount"} ready={ready()} onChange={setAmount} hint="raw or $usd" mountKey={mountKey()} />
      <FormRow label="token" value={token()} active={field() === "token"} ready={ready()} onChange={setToken} hint="default native; symbol like USDC" mountKey={mountKey()} />
      <text fg={field() === "submit" ? "#3ddc84" : "#888"}>{`  [submit]  ${field() === "submit" ? "<- press Enter" : ""}`}</text>
      <text fg={busy() ? "#ffc857" : "#666"} marginTop={1}>{status()}</text>
    </box>
  );
}

function FormRow(props: {
  label: string;
  value: string;
  active: boolean;
  ready: boolean;
  mountKey: number;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <box flexDirection="row" marginTop={1}>
      <text fg={props.active ? "#3ddc84" : "#888"}>{`  ${props.label.padEnd(8)} `}</text>
      <box width={70} flexDirection="column">
        <Show
          when={props.ready}
          fallback={<text fg="#666">{props.value || props.hint || "(typing locked)"}</text>}
        >
          <Show when={props.mountKey >= 0} keyed>
            {(_k) => (
              <input
                focused={props.active}
                value={props.value}
                onInput={(v: string) => props.onChange(v)}
                placeholder={props.hint ?? ""}
                cursorStyle={{ style: "block", blinking: false }}
              />
            )}
          </Show>
        </Show>
      </box>
    </box>
  );
}

function ReceiveModal(props: { wallet: WalletProfile; chain: KuraChainConfig | undefined }) {
  const [qr, setQr] = createSignal<string[]>([]);
  onMount(async () => {
    const lines = await qrLines(props.wallet.address);
    setQr(lines);
  });
  return (
    <box marginTop={1} flexDirection="column">
      <text attributes={1}>receive</text>
      <text fg="#88c0d0">{props.wallet.address}</text>
      <text fg="#666">{`on ${props.chain?.name ?? "current chain"} (${props.chain?.symbol ?? "?"})`}</text>
      <box marginTop={1} flexDirection="column">
        <For each={qr()}>{(line) => <text>{line}</text>}</For>
      </box>
    </box>
  );
}

interface RpcResult<T> { result?: T; error?: { message: string } }
async function rpcCall<T>(chainId: number, method: string, params: unknown[]): Promise<T | null> {
  try {
    const r = await post<RpcResult<T>>(`/rpc?chain=${chainId}`, { method, params });
    return (r.result ?? null) as T | null;
  } catch {
    return null;
  }
}

interface TxReceipt {
  status?: string; // hex "0x1" success
  gasUsed?: string;
  effectiveGasPrice?: string;
}
interface TxFull {
  nonce?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  input?: string;
}
interface SemanticTxLite {
  kind: string;
  description: string;
  selector: string;
  fnSignature?: string;
  contract?: { address: string; label?: string };
}

function fmtGwei(weiHex: string | undefined): string {
  if (!weiHex) return "?";
  try {
    const wei = BigInt(weiHex);
    const gwei = Number(wei) / 1e9;
    if (gwei >= 1) return gwei.toFixed(2);
    return gwei.toFixed(4);
  } catch { return "?"; }
}

function fmtEthFromWei(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  if (eth >= 1) return eth.toFixed(4);
  if (eth >= 1e-4) return eth.toFixed(6);
  // Sub-millicent on L2: use enough decimals to keep all sig figs, then trim
  // trailing zeros so 0.000000927 ETH stays readable (vs 9.27e-7 scientific).
  if (eth >= 1e-12) return eth.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  return eth.toExponential(3);
}

function fmtAbsTime(ts: number): string {
  if (!ts) return "?";
  const d = new Date(ts);
  const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${month} ${day} ${hh}:${mm}`;
}

function TxRow(props: { label: string; children: any }) {
  return (
    <box flexDirection="row">
      <text fg={ROW_COLORS.age}>{`  ${props.label.padEnd(10)} `}</text>
      <box flexDirection="row">{props.children}</box>
    </box>
  );
}

function TxDetailView(props: {
  item: ActivityItem | null;
  chain: KuraChainConfig | undefined;
  chainId: number;
  nativePrice: number | null;
  mode: "overview" | "data";
  onModeChange: (mode: "overview" | "data") => void;
  onCopyToast?: (msg: string) => void;
  onClose: () => void;
}) {
  const item = () => props.item;
  const mode = () => props.mode;
  const setMode = (m: "overview" | "data") => props.onModeChange(m);
  const [scroll, setScroll] = createSignal(0);
  const fetchHash = () => item()?.hash ?? null;
  const [receipt] = createResource(
    fetchHash,
    async (hash) => {
      if (!hash) return null;
      return rpcCall<TxReceipt>(props.chainId, "eth_getTransactionReceipt", [hash]);
    },
  );
  const [tx] = createResource(
    fetchHash,
    async (hash) => {
      if (!hash) return null;
      return rpcCall<TxFull>(props.chainId, "eth_getTransactionByHash", [hash]);
    },
  );
  // Stable string key so createResource's identity diff doesn't refire on every
  // re-render: any non-(hash,inputLen) signal change in App used to return a new
  // object reference and trigger a redundant POST /describe-tx.
  const semanticKey = (): string | null => {
    const it = item();
    const t = tx();
    if (!it || !t?.input) return null;
    return `${it.hash}:${t.input.length}`;
  };
  const [semantic] = createResource(
    semanticKey,
    async () => {
      const it = item();
      const t = tx();
      if (!it || !t?.input) return null;
      try {
        const r = await post<{ semantic: SemanticTxLite | null }>(`/describe-tx`, {
          chainId: props.chainId,
          to: it.to,
          data: t.input as `0x${string}`,
          value: it.value,
        });
        return r.semantic;
      } catch { return null; }
    },
  );
  // Reset scroll when item changes; mode reset is owned by App.openCurrentTx.
  createEffect(() => {
    void item()?.hash;
    setScroll(0);
  });
  function copyHash(): void {
    const it = item();
    if (!it) return;
    void copyToClipboard(it.hash).then((ok) => {
      props.onCopyToast?.(ok ? `copied ${fmtAddr(it.hash)}` : "copy failed");
    });
  }
  function copyBytes(): void {
    const t = tx();
    const data = t?.input ?? "";
    if (!data) return;
    void copyToClipboard(data).then((ok) => {
      props.onCopyToast?.(ok ? `copied ${data.length} chars of calldata` : "copy failed");
    });
  }
  function openInExplorer(): void {
    const it = item();
    const explorer = props.chain?.explorer;
    if (!it || !explorer) return;
    void openUrl(`${explorer.replace(/\/$/, "")}/tx/${it.hash}`);
  }
  useKeyboard((key) => {
    // Owns escape so we can reset data-mode scroll back to overview before
    // unmounting, rather than leaving the next tx-detail open in data mode.
    if (key.name === "escape") {
      if (mode() === "data") setMode("overview");
      props.onClose();
      return;
    }
    if (mode() === "overview") {
      if (key.name === "tab" && item()?.hash) { setMode("data"); setScroll(0); return; }
      if (key.name === "c") { copyHash(); return; }
      if (key.name === "o") { openInExplorer(); return; }
      return;
    }
    // data mode
    if (key.name === "tab") { setMode("overview"); setScroll(0); return; }
    if (key.name === "j" || key.name === "down") { setScroll((s) => s + 1); return; }
    if (key.name === "k" || key.name === "up") { setScroll((s) => Math.max(0, s - 1)); return; }
    if (key.name === "c") { copyBytes(); return; }
    if (key.name === "o") { openInExplorer(); return; }
  });
  const [resolved, setResolved] = createSignal<Record<string, string | null>>({});
  createEffect(() => {
    const it = item();
    if (!it) return;
    const targets: string[] = [it.from];
    if (it.to) targets.push(it.to);
    Promise.all(targets.map(async (a) => [a.toLowerCase(), await reverseLookup(a)] as const)).then((entries) => {
      const next: Record<string, string | null> = {};
      for (const [k, v] of entries) next[k] = v;
      setResolved(next);
    });
  });
  const status = () => {
    const r = receipt();
    if (receipt.loading) return { text: "loading...", color: ROW_COLORS.dim };
    if (!r) return { text: "?", color: ROW_COLORS.dim };
    return r.status === "0x1"
      ? { text: "success", color: ROW_COLORS.ok }
      : { text: "failed", color: ROW_COLORS.bad };
  };
  const gasLine = () => {
    const r = receipt();
    if (receipt.loading) return "loading...";
    if (!r?.gasUsed) return "?";
    try {
      const used = BigInt(r.gasUsed);
      const price = r.effectiveGasPrice ? BigInt(r.effectiveGasPrice) : 0n;
      const cost = used * price;
      const usedStr = used.toLocaleString("en-US");
      const sym = props.chain?.symbol ?? "ETH";
      let usdStr = "";
      if (props.nativePrice) {
        const usd = (Number(cost) / 1e18) * props.nativePrice;
        // Sub-cent gas (typical L2) keeps 4 decimals; otherwise 2.
        usdStr = ` · ~$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
      }
      return `${usedStr} · ${fmtGwei(r.effectiveGasPrice)} gwei · ~${fmtEthFromWei(cost)} ${sym}${usdStr}`;
    } catch { return "?"; }
  };
  const nonce = () => {
    const t = tx();
    if (tx.loading) return "loading...";
    if (!t?.nonce) return "?";
    try { return BigInt(t.nonce).toString(); } catch { return "?"; }
  };
  const description = () => item()?.description ?? "(no description)";
  const segments = () => colorizeDescription(description());
  // Memoized so the JSX can read the array length, slice it, and check empty
  // without re-slicing the whole input on every render.
  const calldataLines = createMemo<string[]>(() => {
    const data = tx()?.input ?? "0x";
    if (!data || data === "0x") return [];
    const body = data.startsWith("0x") ? data.slice(2) : data;
    const lines: string[] = [];
    const width = 76;
    for (let i = 0; i < body.length; i += width) lines.push(body.slice(i, i + width));
    return lines;
  });
  const VISIBLE_LINES = 18;
  const visibleCalldata = () => {
    const all = calldataLines();
    if (all.length === 0) return [];
    const start = Math.min(scroll(), Math.max(0, all.length - VISIBLE_LINES));
    return all.slice(start, start + VISIBLE_LINES);
  };
  return (
    <box marginTop={1} flexDirection="column">
      <text attributes={1}>{mode() === "data" ? "kura · transaction · data" : "kura · transaction"}</text>
      <Show when={item()} fallback={<text fg={ROW_COLORS.dim} marginTop={1}>  no item</text>}>
        <Show when={mode() === "overview"}>
          <box marginTop={1} flexDirection="column">
            <TxRow label="hash">
              <text fg={ROW_COLORS.value}>{item()!.hash}</text>
            </TxRow>
            <TxRow label="chain">
              <text fg={ROW_COLORS.value}>{props.chain?.name ?? `chain ${props.chainId}`}</text>
            </TxRow>
            <TxRow label="block">
              <text fg={ROW_COLORS.value}>{item()!.blockNumber.toString()}</text>
            </TxRow>
            <TxRow label="age">
              <text fg={ROW_COLORS.value}>{`${fmtAge(item()!.timestamp)}`}</text>
              <text fg={ROW_COLORS.dim}>{` · ${fmtAbsTime(item()!.timestamp)}`}</text>
            </TxRow>
            <TxRow label="status">
              <text fg={status().color}>{status().text}</text>
            </TxRow>
            <TxRow label="nonce">
              <text fg={ROW_COLORS.value}>{nonce()}</text>
            </TxRow>
          </box>
          <box marginTop={1} flexDirection="column">
            <TxRow label="from">
              <text fg={ROW_COLORS.amount}>{fmtAddr(item()!.from)}</text>
              <Show when={resolved()[item()!.from.toLowerCase()]}>
                {(name) => <text fg={ROW_COLORS.dim}>{`  · ${name()}`}</text>}
              </Show>
            </TxRow>
            <TxRow label="to">
              <text fg={ROW_COLORS.amount}>{item()!.to ? fmtAddr(item()!.to) : "(create)"}</text>
              <Show when={item()!.to && resolved()[item()!.to!.toLowerCase()]}>
                {(name) => <text fg={ROW_COLORS.dim}>{`  · ${name()}`}</text>}
              </Show>
              <Show when={semantic()?.contract?.label}>
                {(label) => <text fg={ROW_COLORS.dim}>{`  · ${label()}`}</text>}
              </Show>
            </TxRow>
            <TxRow label="function">
              <Show when={semantic()} fallback={<text fg={ROW_COLORS.dim}>{semantic.loading ? "loading..." : "—"}</text>}>
                <text fg={ROW_COLORS.value}>{semantic()!.fnSignature ?? semantic()!.selector}</text>
                <Show when={semantic()!.fnSignature}>
                  <text fg={ROW_COLORS.dim}>{`  · ${semantic()!.selector}`}</text>
                </Show>
              </Show>
            </TxRow>
          </box>
          <box marginTop={1} flexDirection="column">
            <box flexDirection="row">
              <text fg={ROW_COLORS.age}>{`  `}</text>
              <For each={segments()}>
                {(seg) => {
                  const c = seg.kind === "amount" ? ROW_COLORS.amount : seg.kind === "venue" ? ROW_COLORS.venue : ROW_COLORS.text;
                  return <text fg={c}>{seg.text}</text>;
                }}
              </For>
            </box>
          </box>
          <box marginTop={1} flexDirection="column">
            <TxRow label="gas">
              <text fg={ROW_COLORS.value}>{gasLine()}</text>
            </TxRow>
          </box>
        </Show>
        <Show when={mode() === "data"}>
          <box marginTop={1} flexDirection="column">
            <TxRow label="function">
              <Show when={semantic()} fallback={<text fg={ROW_COLORS.dim}>{semantic.loading ? "loading..." : "—"}</text>}>
                <text fg={ROW_COLORS.value}>{semantic()!.fnSignature ?? semantic()!.selector}</text>
              </Show>
            </TxRow>
            <TxRow label="bytes">
              <text fg={ROW_COLORS.value}>{`${calldataLines().length === 0 ? 0 : (tx()?.input?.length ?? 2) - 2} chars`}</text>
              <Show when={calldataLines().length > VISIBLE_LINES}>
                <text fg={ROW_COLORS.dim}>{`  · line ${Math.min(scroll(), Math.max(0, calldataLines().length - VISIBLE_LINES)) + 1}-${Math.min(scroll() + VISIBLE_LINES, calldataLines().length)} of ${calldataLines().length}`}</text>
              </Show>
            </TxRow>
          </box>
          <box marginTop={1} flexDirection="column">
            <Show when={calldataLines().length > 0} fallback={<text fg={ROW_COLORS.dim}>  (empty calldata)</text>}>
              <For each={visibleCalldata()}>
                {(line) => <text fg={ROW_COLORS.value}>{`  ${line}`}</text>}
              </For>
            </Show>
          </box>
        </Show>
      </Show>
    </box>
  );
}

function HistoryView(props: { items: ActivityItem[]; chain: KuraChainConfig | undefined; cursor: number; loading: boolean; loaded: boolean }) {
  const [resolved, setResolved] = createSignal<Record<string, string | null>>({});
  // History view shows everything including dust (with a [dust] tag) so the
  // user can audit; only HomeView hides them outright.
  createEffect(() => {
    const list = props.items;
    Promise.all(
      list.map(async (it) => {
        const counter = it.direction === "out" ? it.to : it.from;
        if (!counter) return null;
        const name = await reverseLookup(counter);
        return [counter.toLowerCase(), name] as const;
      }),
    ).then((entries) => {
      const next: Record<string, string | null> = {};
      for (const e of entries) if (e) next[e[0]] = e[1];
      setResolved((prev) => ({ ...prev, ...next }));
    });
  });
  // Cap rendered rows to fit typical terminal heights. With marginBottom=1 each
  // row takes 2 lines, so 50 rows = ~100 lines. Use `kura history` CLI for the
  // full feed; this view shows the most recent.
  const MAX_ROWS = 50;
  const visible = () => props.items.slice(0, MAX_ROWS);
  const overflow = () => Math.max(0, props.items.length - MAX_ROWS);
  return (
    <box marginTop={1} flexDirection="column">
      <box flexDirection="row">
        <text attributes={1}>history</text>
        <Show when={props.loading && props.loaded}>
          <text fg="#666">  (refreshing)</text>
        </Show>
      </box>
      <box marginTop={1} flexDirection="column">
        <Show when={visible().length > 0} fallback={
          <text fg={ROW_COLORS.dim}>{props.loading || !props.loaded ? "  loading activity..." : "  no activity"}</text>
        }>
          <For each={visible()}>
            {(it, idx) => (
              <ActivityRow
                it={it}
                resolved={resolved()}
                chain={props.chain}
                extras="history"
                selected={idx() === props.cursor}
              />
            )}
          </For>
          <Show when={overflow() > 0}>
            <text fg={ROW_COLORS.dim}>{`  +${overflow()} more  ·  use \`kura history\` CLI for full feed`}</text>
          </Show>
        </Show>
      </box>
    </box>
  );
}

interface ConnectionRecord {
  walletName: string;
  address: string;
  chainId: number;
  connectedAt: number;
}

function ConnectionsView() {
  const [data, { refetch }] = createResource(async () => {
    return get<{ sessions: Record<string, ConnectionRecord> }>("/connections").catch(() => ({ sessions: {} as Record<string, ConnectionRecord> }));
  });
  const [selected, setSelected] = createSignal(0);
  const [status, setStatus] = createSignal("");

  useKeyboard((key) => {
    const sessions = Object.entries(data()?.sessions ?? {});
    if (sessions.length === 0) return;
    if (key.name === "j" || key.name === "down") {
      setSelected((s) => Math.min(sessions.length - 1, s + 1));
    } else if (key.name === "k" || key.name === "up") {
      setSelected((s) => Math.max(0, s - 1));
    } else if (key.name === "d") {
      const [origin] = sessions[selected()]!;
      setStatus(`revoking ${origin}...`);
      del(`/connections?origin=${encodeURIComponent(origin)}`).then(() => {
        setStatus(`revoked ${origin}`);
        refetch();
      }).catch((e) => setStatus(`error: ${e.message}`));
    }
  });

  return (
    <box marginTop={1} flexDirection="column">
      <text attributes={1}>connections</text>
      <Show
        when={Object.keys(data()?.sessions ?? {}).length > 0}
        fallback={<text fg="#666">  no active connections</text>}
      >
        <For each={Object.entries(data()!.sessions)}>
          {([origin, s], idx) => (
            <text fg={idx() === selected() ? "#3ddc84" : undefined}>
              {`  ${idx() === selected() ? "> " : "  "}${origin.padEnd(40)} ${s.walletName} ${fmtAddr(s.address)} chain ${s.chainId} ${fmtAge(s.connectedAt)} ago`}
            </text>
          )}
        </For>
      </Show>
      <text fg={status() ? "#ffc857" : "#666"} marginTop={1}>{status()}</text>
    </box>
  );
}

interface SseEvent {
  type: string;
  payload: Record<string, unknown>;
  ts: number;
}

function WatchView() {
  const [events, setEvents] = createSignal<SseEvent[]>([]);
  const [status, setStatus] = createSignal("connecting...");
  let ctrl: AbortController | null = null;
  onMount(() => {
    void (async () => {
      try {
        const c = await client();
        ctrl = new AbortController();
        setStatus("opening stream...");
        const resp = await fetch(`${c.base}/events?stream=1`, {
          ...tlsOpts,
          headers: { "X-Kura-Key": c.secret },
          signal: ctrl.signal,
        });
        if (!resp.ok || !resp.body) {
          setStatus(`connect failed ${resp.status}`);
          return;
        }
        setStatus("streaming");
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            setStatus("stream ended");
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            const raw = dataLine.slice(6);
            try {
              const parsed = JSON.parse(raw);
              if (typeof parsed === "object" && parsed && "type" in parsed) {
                setEvents((prev) => [...prev, parsed as SseEvent].slice(-30));
              }
            } catch {
              // skip
            }
          }
        }
      } catch (err) {
        setStatus(`error: ${(err as Error).message}`);
      }
    })();
  });
  onCleanup(() => ctrl?.abort());
  const statusColor = () => {
    const s = status();
    if (s === "streaming") return "#a3be8c";
    if (s.startsWith("connect failed") || s.startsWith("error")) return "#ff8c66";
    return "#ffc857";
  };
  return (
    <box marginTop={1} flexDirection="column">
      <text attributes={1}>watch (live SSE)</text>
      <box flexDirection="row">
        <text fg="#888">status: </text>
        <text fg={statusColor()}>{status()}</text>
        <text fg="#888">{`  events: ${events().length}`}</text>
      </box>
      <box marginTop={1} flexDirection="column">
        <Show when={events().length > 0} fallback={<text fg="#666">  no events yet</text>}>
          <For each={events()}>
            {(e) => (
              <text>
                {`  ${new Date(e.ts).toISOString().slice(11, 19)} ${(e.type ?? "?").padEnd(22)} ${JSON.stringify(e.payload ?? {}).slice(0, 80)}`}
              </text>
            )}
          </For>
        </Show>
      </box>
    </box>
  );
}

type WalletMode = "list" | "name-add" | "add-choose" | "add-import" | "add-watch" | "confirm-remove";
type AddChoice = "generate" | "import" | "watch";
const ADD_CHOICES: { value: AddChoice; label: string }[] = [
  { value: "generate", label: "generate new (random)" },
  { value: "import", label: "import private key (paste)" },
  { value: "watch", label: "watch-only address" },
];

function WalletView(props: {
  current: WalletProfile;
  onSelect: (w: WalletProfile) => void;
  onListChange: (list: WalletProfile[]) => void;
  onClose: () => void;
  renderer: unknown;
}) {
  const [rows, setRows] = createSignal<WalletProfile[]>([]);
  const [defaultName, setDefaultName] = createSignal<string>("");
  const [selected, setSelected] = createSignal(0);
  const [mode, setMode] = createSignal<WalletMode>("list");
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [purgeOnRemove, setPurgeOnRemove] = createSignal(false);

  // pendingName carries the validated wallet name through the multi-step add flow
  // (name-add -> add-choose -> add-import|add-watch|generate); nameInput is the
  // unvalidated text the user is currently typing.
  const [pendingName, setPendingName] = createSignal("");
  const [nameInput, setNameInput] = createSignal("");
  const [addChoice, setAddChoice] = createSignal<AddChoice>("generate");
  const [secretInput, setSecretInput] = createSignal("");
  const [addrInput, setAddrInput] = createSignal("");

  // Triple-timeout gate that swallows the keystroke that opened the form so it
  // doesn't bleed into the input. Same pattern SendModal uses on `s`.
  const [inputReady, setInputReady] = createSignal(false);
  const [mountKey, setMountKey] = createSignal(0);
  const armTimers: ReturnType<typeof setTimeout>[] = [];

  async function reload(): Promise<WalletProfile[]> {
    const [list, cfg] = await Promise.all([listWallets(), getConfig()]);
    setRows(list);
    setDefaultName(cfg.defaultWallet);
    props.onListChange(list);
    return list;
  }

  onMount(() => {
    void reload().then((list) => {
      const idx = list.findIndex((w) => w.name === props.current.name);
      setSelected(idx >= 0 ? idx : 0);
    });
  });

  onCleanup(() => {
    for (const t of armTimers) clearTimeout(t);
    armTimers.length = 0;
  });

  function armInput() {
    for (const t of armTimers) clearTimeout(t);
    armTimers.length = 0;
    setInputReady(false);
    setSecretInput("");
    setAddrInput("");
    setNameInput("");
    armTimers.push(setTimeout(() => {
      setInputReady(true);
      armTimers.push(setTimeout(() => {
        setInputReady(false);
        setSecretInput("");
        setAddrInput("");
        setNameInput("");
        armTimers.push(setTimeout(() => {
          setMountKey((k) => k + 1);
          setInputReady(true);
        }, 30));
      }, 100));
    }, 150));
  }

  async function handleSelectDefault(): Promise<void> {
    const w = rows()[selected()];
    if (!w) return;
    if (w.name === defaultName()) return;
    setBusy(true);
    setStatus(`switching to ${w.name}...`);
    try {
      await setDefaultWallet(w.name);
      setDefaultName(w.name);
      props.onSelect(w);
      setStatus(`default = ${w.name}`);
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function startRemove(purge: boolean): Promise<void> {
    if (rows().length <= 1) {
      setStatus("can't remove last wallet, add another first");
      return;
    }
    setPurgeOnRemove(purge);
    setMode("confirm-remove");
  }

  async function performRemove(): Promise<void> {
    const w = rows()[selected()];
    if (!w) return;
    setBusy(true);
    setStatus(`removing ${w.name}${purgeOnRemove() ? " + keychain" : ""}...`);
    try {
      const result = await removeWalletWithFallback(w.name, { purgeKey: purgeOnRemove() });
      const updated = await reload();
      if (result.wasDefault && result.newDefault) {
        const next = updated.find((x) => x.name === result.newDefault);
        if (next) props.onSelect(next);
      }
      setSelected((s) => Math.max(0, Math.min(updated.length - 1, s)));
      setStatus(`removed ${w.name}`);
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
      setMode("list");
    }
  }

  async function startAdd(): Promise<void> {
    setStatus("");
    setPendingName("");
    armInput();
    setMode("name-add");
  }

  async function commitName(): Promise<void> {
    const name = nameInput().trim();
    if (!name) {
      setStatus("name required");
      return;
    }
    if (!isValidWalletName(name)) {
      setStatus("name must be alphanumeric, _ or -");
      return;
    }
    const presence = await walletPresence(name);
    if (presence.inState) {
      setStatus(`wallet ${name} already exists`);
      return;
    }
    setPendingName(name);
    setStatus("");
    setAddChoice("generate");
    setMode("add-choose");
  }

  async function pickAddChoice(): Promise<void> {
    const choice = addChoice();
    if (choice === "generate") {
      await runGenerate();
    } else if (choice === "import") {
      armInput();
      setMode("add-import");
    } else {
      armInput();
      setMode("add-watch");
    }
  }

  async function runGenerate(): Promise<void> {
    const name = pendingName();
    setBusy(true);
    setStatus(`waiting for Touch ID...`);
    const r = props.renderer as { suspend?: () => void; resume?: () => void } | null;
    let createdName: string | null = null;
    try {
      // Gate the export-to-screen first so an attacker can't trigger this flow
      // headlessly (e.g., via MCP) and have the key dumped to scrollback.
      const okBio = await requireBiometry(`kura: reveal new private key for ${name}`);
      if (!okBio) {
        setStatus("biometry cancelled");
        setMode("list");
        return;
      }
      setStatus(`generating ${name}...`);
      const result = await createGeneratedWallet(name);
      createdName = result.profile.name;
      r?.suspend?.();
      try {
        process.stdout.write("\n");
        process.stdout.write(`IMPORTANT  new wallet generated. address: ${result.profile.address}\n`);
        process.stdout.write(`IMPORTANT  private key WILL be stored in macOS Keychain only.\n`);
        process.stdout.write(`IMPORTANT  Keychain is NOT a backup. Write down the key NOW:\n`);
        process.stdout.write(`  ${result.privateKey}\n\n`);
        const ok = await cliConfirm("backed up?", false);
        if (!ok) {
          await deleteWallet(name, { purgeKey: true });
          createdName = null;
        }
        // Erase exactly the 7 lines we wrote (leading \n, 3 IMPORTANT lines,
        // key line, blank, "backed up? (y/N) y") so they don't reappear in the
        // main screen buffer when the user later quits and alt-screen exits.
        // \x1b[7F = cursor previous line 7 times; \x1b[J = erase to end of screen.
        process.stdout.write("\x1b[7F\x1b[J");
        process.stdout.write(createdName ? `kura: saved ${name}\n` : `kura: generation aborted\n`);
      } finally {
        r?.resume?.();
      }
      const list = await reload();
      const idx = createdName ? list.findIndex((w) => w.name === createdName) : -1;
      if (idx >= 0) setSelected(idx);
      setStatus(createdName ? `added ${createdName}` : "aborted");
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
      setMode("list");
    }
  }

  async function commitCreate(label: string, create: () => Promise<unknown>): Promise<void> {
    const name = pendingName();
    setBusy(true);
    setStatus(`${label} ${name}...`);
    try {
      await create();
      const list = await reload();
      const idx = list.findIndex((w) => w.name === name);
      if (idx >= 0) setSelected(idx);
      setStatus(`added ${name}`);
      setMode("list");
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function commitImport(): Promise<void> {
    const raw = secretInput().trim();
    if (!raw) {
      setStatus("private key required");
      return;
    }
    await commitCreate("importing", () => createImportedWallet(pendingName(), raw));
  }

  async function commitWatch(): Promise<void> {
    const raw = addrInput().trim();
    if (!isAddress(raw)) {
      setStatus("invalid address");
      return;
    }
    await commitCreate("adding watch-only", () => createWatchOnlyWallet(pendingName(), raw as Address));
  }

  useKeyboard((key) => {
    if (busy()) return;
    const m = mode();
    if (m === "list") {
      if (key.name === "escape") {
        props.onClose();
        return;
      }
      const list = rows();
      if (list.length === 0) return;
      if (key.name === "j" || key.name === "down") {
        setSelected((s) => Math.min(list.length - 1, s + 1));
      } else if (key.name === "k" || key.name === "up") {
        setSelected((s) => Math.max(0, s - 1));
      } else if (key.name === "return") {
        void handleSelectDefault();
      } else if (key.name === "a") {
        void startAdd();
      } else if (key.name === "d" && !key.shift) {
        void startRemove(false);
      } else if (key.name === "d" && key.shift) {
        void startRemove(true);
      }
      return;
    }
    if (m === "name-add") {
      if (key.name === "return") void commitName();
      else if (key.name === "escape") {
        setMode("list");
        setStatus("");
      }
      return;
    }
    if (m === "add-choose") {
      const cur = ADD_CHOICES.findIndex((c) => c.value === addChoice());
      if (key.name === "j" || key.name === "down") {
        setAddChoice(ADD_CHOICES[Math.min(ADD_CHOICES.length - 1, cur + 1)]!.value);
      } else if (key.name === "k" || key.name === "up") {
        setAddChoice(ADD_CHOICES[Math.max(0, cur - 1)]!.value);
      } else if (key.name === "return") void pickAddChoice();
      else if (key.name === "escape") setMode("list");
      return;
    }
    if (m === "add-import") {
      if (key.name === "return") void commitImport();
      else if (key.name === "escape") setMode("add-choose");
      return;
    }
    if (m === "add-watch") {
      if (key.name === "return") void commitWatch();
      else if (key.name === "escape") setMode("add-choose");
      return;
    }
    if (m === "confirm-remove") {
      if (key.name === "y") void performRemove();
      else if (key.name === "n" || key.name === "escape") {
        setMode("list");
        setStatus("");
      }
      return;
    }
  });

  return (
    <box marginTop={1} flexDirection="column">
      <text attributes={1}>wallets</text>
      <Show when={mode() === "list"}>
        <Show
          when={rows().length > 0}
          fallback={<text fg="#666">  no wallets configured</text>}
        >
          <For each={rows()}>
            {(w, idx) => {
              const tag = w.watchOnly ? "watch" : w.source === "keychain-shared" ? "shared" : w.source === "imported-private-key" ? "imported" : "generated";
              return (
                <text fg={idx() === selected() ? "#3ddc84" : undefined}>
                  {`  ${idx() === selected() ? ">" : " "} ${w.name === defaultName() ? "*" : " "} ${w.name.padEnd(20)} ${fmtAddr(w.address)}  ${tag}`}
                </text>
              );
            }}
          </For>
        </Show>
      </Show>
      <Show when={mode() === "name-add"}>
        <box marginTop={1} flexDirection="column">
          <text>  new wallet name</text>
          <FormRow
            label="name"
            value={nameInput()}
            active={true}
            ready={inputReady()}
            onChange={setNameInput}
            mountKey={mountKey()}
            hint="alphanumeric, _ or -"
          />
          <text fg="#888" marginTop={1}>{`  enter to continue, esc to cancel`}</text>
        </box>
      </Show>
      <Show when={mode() === "add-choose"}>
        <box marginTop={1} flexDirection="column">
          <text>{`  add wallet "${pendingName()}"`}</text>
          <For each={ADD_CHOICES}>
            {(c) => (
              <text fg={c.value === addChoice() ? "#3ddc84" : undefined}>
                {`  ${c.value === addChoice() ? ">" : " "} ${c.label}`}
              </text>
            )}
          </For>
          <text fg="#888" marginTop={1}>{`  j/k move  enter pick  esc cancel`}</text>
        </box>
      </Show>
      <Show when={mode() === "add-import"}>
        <box marginTop={1} flexDirection="column">
          <text>{`  import key for "${pendingName()}"`}</text>
          <FormRow
            label="key"
            value={secretInput()}
            active={true}
            ready={inputReady()}
            onChange={setSecretInput}
            mountKey={mountKey()}
            hint="0x..."
          />
          <text fg="#888" marginTop={1}>{`  enter to import, esc back`}</text>
        </box>
      </Show>
      <Show when={mode() === "add-watch"}>
        <box marginTop={1} flexDirection="column">
          <text>{`  watch address for "${pendingName()}"`}</text>
          <FormRow
            label="addr"
            value={addrInput()}
            active={true}
            ready={inputReady()}
            onChange={setAddrInput}
            mountKey={mountKey()}
            hint="0x..."
          />
          <text fg="#888" marginTop={1}>{`  enter to save, esc back`}</text>
        </box>
      </Show>
      <Show when={mode() === "confirm-remove"}>
        <box marginTop={1} flexDirection="column">
          <text fg="#ff8c66">{`  remove ${rows()[selected()]?.name ?? "?"}${purgeOnRemove() ? " + purge keychain" : ""}? [y/n]`}</text>
        </box>
      </Show>
      <text fg={status() ? "#ffc857" : "#666"} marginTop={1}>{status()}</text>
    </box>
  );
}

type ChainMode = "list" | "add-id" | "add-rpc" | "add-meta" | "confirm-remove";
type AddMetaField = "name" | "symbol" | "explorer" | "testnet" | "submit";

function ChainView(props: {
  mode: NetworkMode;
  currentChainId: number;
  onSelect: (chain: KuraChainConfig) => void;
  onChange: () => void;
  onClose: () => void;
}) {
  const [rows, setRows] = createSignal<KuraChainConfig[]>([]);
  const [hotIds, setHotIds] = createSignal<Set<number>>(new Set());
  const [selected, setSelected] = createSignal(0);
  const [view, setViewMode] = createSignal<ChainMode>("list");
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal("");

  const [idInput, setIdInput] = createSignal("");
  const [rpcInput, setRpcInput] = createSignal("");
  const [pendingId, setPendingId] = createSignal(0);
  const [pendingRpc, setPendingRpc] = createSignal("");

  const [nameInput, setNameInput] = createSignal("");
  const [symbolInput, setSymbolInput] = createSignal("ETH");
  const [explorerInput, setExplorerInput] = createSignal("");
  const [isTestnet, setIsTestnet] = createSignal(false);
  const [metaField, setMetaField] = createSignal<AddMetaField>("name");

  const [inputReady, setInputReady] = createSignal(false);
  const [mountKey, setMountKey] = createSignal(0);
  const armTimers: ReturnType<typeof setTimeout>[] = [];

  function armInput(): void {
    for (const t of armTimers) clearTimeout(t);
    armTimers.length = 0;
    setInputReady(false);
    armTimers.push(setTimeout(() => {
      setInputReady(true);
      armTimers.push(setTimeout(() => {
        setInputReady(false);
        setIdInput("");
        setRpcInput("");
        armTimers.push(setTimeout(() => {
          setMountKey((k) => k + 1);
          setInputReady(true);
        }, 30));
      }, 100));
    }, 150));
  }

  async function reload(): Promise<KuraChainConfig[]> {
    const hot = await reloadHotChains();
    const all = mergeChains(hot);
    setRows(all.sort((a, b) => a.id - b.id));
    setHotIds(new Set(hot.map((c) => c.id)));
    return all;
  }

  onMount(() => {
    void reload().then((all) => {
      const idx = all.findIndex((c) => c.id === props.currentChainId);
      setSelected(idx >= 0 ? idx : 0);
    });
  });
  onCleanup(() => { for (const t of armTimers) clearTimeout(t); });

  function startAdd(): void {
    setStatus("");
    setIdInput("");
    setRpcInput("");
    setPendingId(0);
    setPendingRpc("");
    armInput();
    setViewMode("add-id");
  }

  async function commitId(): Promise<void> {
    const idStr = idInput().trim();
    const id = Number(idStr);
    if (!Number.isFinite(id) || id <= 0) {
      setStatus("bad chain id");
      return;
    }
    if (getBundledChain(id)) {
      setStatus(`${id} is bundled (cannot override)`);
      return;
    }
    setPendingId(id);
    setStatus("");
    armInput();
    setViewMode("add-rpc");
  }

  async function commitRpc(): Promise<void> {
    const rpc = rpcInput().trim();
    if (!rpc.startsWith("http")) {
      setStatus("bad rpc url");
      return;
    }
    setBusy(true);
    setStatus(`validating ${rpc}...`);
    try {
      await validateRpc(rpc, pendingId());
      setPendingRpc(rpc);
      setStatus("");
      setNameInput(`Chain ${pendingId()}`);
      setSymbolInput("ETH");
      setExplorerInput("");
      setIsTestnet(props.mode === "testnet");
      setMetaField("name");
      armInput();
      setViewMode("add-meta");
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function commitAdd(): Promise<void> {
    const id = pendingId();
    const name = nameInput().trim() || `Chain ${id}`;
    const symbol = (symbolInput().trim() || "ETH").toUpperCase();
    const explorer = explorerInput().trim();
    const testnet = isTestnet();
    setBusy(true);
    setStatus(`writing chains.toml...`);
    try {
      const existing = listHotChains().filter((c) => c.id !== id);
      const chain: KuraChainConfig = {
        id,
        name,
        symbol,
        tier: 2,
        testnet: testnet || undefined,
        rpcUrl: pendingRpc(),
        explorer,
        capabilities: { ...DEFAULT_HOT_CAPABILITIES },
      };
      await writeHotChains([...existing, chain]);
      props.onChange();
      const all = await reload();
      const idx = all.findIndex((c) => c.id === id);
      if (idx >= 0) setSelected(idx);
      setStatus(`added ${name}`);
      setViewMode("list");
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function performRemove(): Promise<void> {
    const c = rows()[selected()];
    if (!c) return;
    if (!hotIds().has(c.id)) {
      setStatus("can't remove bundled chain");
      setViewMode("list");
      return;
    }
    setBusy(true);
    setStatus(`removing ${c.name}...`);
    try {
      const remaining = listHotChains().filter((x) => x.id !== c.id);
      await writeHotChains(remaining);
      props.onChange();
      const all = await reload();
      setSelected((s) => Math.max(0, Math.min(all.length - 1, s)));
      setStatus(`removed ${c.name}`);
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
      setViewMode("list");
    }
  }

  useKeyboard((key) => {
    if (busy()) return;
    const v = view();
    if (v === "list") {
      if (key.name === "escape") { props.onClose(); return; }
      const list = rows();
      if (list.length === 0) {
        if (key.name === "a") startAdd();
        return;
      }
      if (key.name === "j" || key.name === "down") setSelected((s) => Math.min(list.length - 1, s + 1));
      else if (key.name === "k" || key.name === "up") setSelected((s) => Math.max(0, s - 1));
      else if (key.name === "return") {
        const c = list[selected()];
        if (c) { props.onSelect(c); setStatus(`selected ${c.name}`); }
      }
      else if (key.name === "a") startAdd();
      else if (key.name === "d") {
        const c = list[selected()];
        if (c && hotIds().has(c.id)) setViewMode("confirm-remove");
        else setStatus("can't remove bundled chain");
      }
      return;
    }
    if (v === "add-id") {
      if (key.name === "return") void commitId();
      else if (key.name === "escape") { setViewMode("list"); setStatus(""); }
      return;
    }
    if (v === "add-rpc") {
      if (key.name === "return") void commitRpc();
      else if (key.name === "escape") { setViewMode("add-id"); setStatus(""); armInput(); }
      return;
    }
    if (v === "add-meta") {
      const order: AddMetaField[] = ["name", "symbol", "explorer", "testnet", "submit"];
      if (key.name === "tab") {
        const idx = order.indexOf(metaField());
        setMetaField(order[(idx + 1) % order.length]!);
      } else if (key.name === "return") {
        if (metaField() === "submit") void commitAdd();
        else {
          const idx = order.indexOf(metaField());
          setMetaField(order[Math.min(order.length - 1, idx + 1)]!);
        }
      } else if (key.name === "escape") {
        setViewMode("add-rpc"); setStatus(""); armInput();
      } else if (metaField() === "testnet" && (key.name === "y" || key.name === "n")) {
        setIsTestnet(key.name === "y");
      }
      return;
    }
    if (v === "confirm-remove") {
      if (key.name === "y") void performRemove();
      else if (key.name === "n" || key.name === "escape") { setViewMode("list"); setStatus(""); }
      return;
    }
  });

  return (
    <box marginTop={1} flexDirection="column">
      <text attributes={1}>networks</text>
      <Show when={view() === "list"}>
        <Show
          when={rows().length > 0}
          fallback={<text fg="#666">  no chains configured. press [a] to add.</text>}
        >
          <For each={rows()}>
            {(c, idx) => {
              const tnet = c.testnet ? " · testnet" : "";
              return (
                <text fg={idx() === selected() ? "#3ddc84" : undefined}>
                  {`  ${idx() === selected() ? ">" : " "} ${c.id === props.currentChainId ? "*" : " "} ${String(c.id).padEnd(6)} ${c.name.padEnd(20)} ${c.symbol.padEnd(5)} ${hotIds().has(c.id) ? "hot" : "bundled"}${tnet}`}
                </text>
              );
            }}
          </For>
        </Show>
        <text fg="#888" marginTop={1}>{`  j/k move  enter select  a add  d remove (hot only)  esc back`}</text>
      </Show>
      <Show when={view() === "add-id"}>
        <box marginTop={1} flexDirection="column">
          <text>  new network: chain id</text>
          <FormRow
            label="id"
            value={idInput()}
            active={true}
            ready={inputReady()}
            onChange={setIdInput}
            mountKey={mountKey()}
            hint="numeric, e.g. 16602"
          />
          <text fg="#888" marginTop={1}>{`  enter to continue, esc to cancel`}</text>
        </box>
      </Show>
      <Show when={view() === "add-rpc"}>
        <box marginTop={1} flexDirection="column">
          <text>{`  chain ${pendingId()}: rpc url`}</text>
          <FormRow
            label="rpc"
            value={rpcInput()}
            active={true}
            ready={inputReady()}
            onChange={setRpcInput}
            mountKey={mountKey()}
            hint="https://..."
          />
          <text fg="#888" marginTop={1}>{`  enter validates by calling eth_chainId, esc back`}</text>
        </box>
      </Show>
      <Show when={view() === "add-meta"}>
        <box marginTop={1} flexDirection="column">
          <text>{`  chain ${pendingId()} metadata`}</text>
          <FormRow label="name" value={nameInput()} active={metaField() === "name"} ready={inputReady()} onChange={setNameInput} mountKey={mountKey()} hint="display name" />
          <FormRow label="symbol" value={symbolInput()} active={metaField() === "symbol"} ready={inputReady()} onChange={setSymbolInput} mountKey={mountKey()} hint="native token symbol" />
          <FormRow label="explorer" value={explorerInput()} active={metaField() === "explorer"} ready={inputReady()} onChange={setExplorerInput} mountKey={mountKey()} hint="https://... (optional)" />
          <box flexDirection="row" marginTop={1}>
            <text fg={metaField() === "testnet" ? "#3ddc84" : "#888"}>{`  testnet  `}</text>
            <text>{isTestnet() ? "yes" : "no"}</text>
            <text fg="#666">{`   (y/n while focused)`}</text>
          </box>
          <text fg={metaField() === "submit" ? "#3ddc84" : "#888"}>{`  [submit]  ${metaField() === "submit" ? "<- press Enter" : ""}`}</text>
          <text fg="#888" marginTop={1}>{`  tab cycles  enter advances/submits  esc back`}</text>
        </box>
      </Show>
      <Show when={view() === "confirm-remove"}>
        <box marginTop={1} flexDirection="column">
          <text fg="#ff8c66">{`  remove ${rows()[selected()]?.name ?? "?"}? [y/n]`}</text>
        </box>
      </Show>
      <text fg={status() ? "#ffc857" : "#666"} marginTop={1}>{status()}</text>
    </box>
  );
}

function FooterHints(props: { view: View; mode?: "overview" | "data" }) {
  const hint = () => {
    switch (props.view) {
      case "home":
        return "[j/k] move  [enter] detail  [y] copy addr  [s] send  [r] receive  [h] history  [c] connections  [w] wallets  [N] networks  [e] watch  [tab] chain  [shift+tab] wallet  [n] mode  [u] unverified  [g] refresh  [q] quit";
      case "send":
        return "tab cycles fields, type to fill, esc back";
      case "receive":
        return "esc back";
      case "history":
        return "[j/k] move  [enter] detail  esc back";
      case "connections":
        return "j/k to move, d to revoke, esc back";
      case "watch":
        return "esc back";
      case "wallets":
        return "j/k move  enter set default  a add  d remove  D remove+purge  esc back";
      case "chains":
        return "j/k move  enter select  a add  d remove (hot only)  esc back";
      case "tx":
        return props.mode === "data"
          ? "[j/k] scroll  [c] copy bytes  [o] open explorer  [tab] back to overview  [esc] back"
          : "[tab] data  [c] copy hash  [o] open explorer  [esc] back";
    }
  };
  return (
    <box flexDirection="row">
      <text fg="#888">{hint()}</text>
    </box>
  );
}

// quit / restoreTerminal / signal wiring all live in core/terminal.ts.
// Shared with popup.

export async function run(): Promise<void> {
  if (!existsSync(KURA_HOME)) {
    const { run: runInit } = await import("../cli/commands/init.ts");
    await runInit({});
    return;
  }
  await reloadHotChains();
  const cfg = await getConfig();
  const all = await listWallets();
  if (all.length === 0) {
    console.error(`no wallets configured. run 'kura init' first.`);
    process.exit(1);
  }
  const wallet = (await getWallet(cfg.defaultWallet)) ?? all[0]!;
  const hotWallets = all.filter((w) => !w.watchOnly && w.source !== "keychain-shared");
  if (hotWallets.length > 0 && !(await isBiometryMigrated())) {
    process.stderr.write("note: run 'kura wallet migrate' to enable Touch ID on existing wallets\n");
  }
  // Pre-disable async notification modes BEFORE opentui starts touching the
  // terminal. If a prior unclean exit (e.g., kill -9) left mode 996/2031
  // enabled, opentui's own startup writes (color detection queries, alt-screen
  // entry, cursor positioning) would trigger ?997;1n floods immediately.
  disableTerminalNotifications();
  // attachRestoreHandlers must be installed BEFORE render so a SIGINT during
  // opentui startup (before App.onMount has a chance to wire setActiveRenderer)
  // still routes through quit(), which is a no-op on the renderer in that
  // window but still disables modes and drains stdin via the 'exit' handler.
  attachRestoreHandlers();
  if (DEBUG_LOG) {
    try { require("node:fs").writeFileSync("/tmp/kura-tui-keys.log", `=== TUI started ${new Date().toISOString()} ===\n`); } catch {}
    // Mirror raw stdin bytes when KURA_TUI_DEBUG=1 so we can diagnose input
    // pipeline issues. Removed on process exit so a hot-reload doesn't double
    // the listener.
    const stdinListener = (chunk: Buffer) => {
      try {
        const hex = Array.from(chunk).map((b) => b.toString(16).padStart(2, "0")).join(" ");
        dbglog(`[stdin] ${chunk.length}B raw=${hex}`);
      } catch {}
    };
    process.stdin.on("data", stdinListener);
    process.once("exit", () => process.stdin.removeListener("data", stdinListener));
  }
  // exitSignals: [] tells opentui's CliRenderer NOT to register its own
  // SIGINT/SIGTERM/etc. listeners. We own all signal handling so the
  // disable -> destroy -> drain ordering is preserved. Without this, opentui
  // would call destroy() from its own SIGINT handler BEFORE our disable runs,
  // and destroy()'s color-reset writes would re-trigger ?997 floods.
  // exitOnCtrlC: false stops opentui's keypress handler from auto-destroying
  // on Ctrl+C; the App's useKeyboard handler routes Ctrl+C through quit()
  // explicitly so we keep one canonical shutdown path.
  render(
    () => <App wallet={wallet} walletList={all} initialChainId={cfg.defaultChain} initialMode={cfg.networkMode} />,
    { exitSignals: [], exitOnCtrlC: false },
  );
}
