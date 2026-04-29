import { existsSync } from "node:fs";
import { render, useKeyboard } from "@opentui/solid";
import { createSignal, createResource, createEffect, Show, For, onCleanup, onMount } from "solid-js";
import { formatUnits, parseUnits, isAddress } from "viem";
// @ts-expect-error qrcode-terminal has no types
import qrcode from "qrcode-terminal";
import { KURA_HOME } from "../core/paths.ts";
import { getConfig, getWallet, listWallets, writeConfig } from "../core/config.ts";
import { getOrCreateSecret } from "../core/secret.ts";
import type { Address, ActivityItem, KuraChainConfig, NetworkMode, Portfolio, WalletProfile } from "../core/types.ts";
import { getKnownChain } from "../core/chains.ts";
import { resolve as resolveName } from "../core/resolve.ts";

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

function fmtUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function fmtTok(raw: string, decimals: number): string {
  const n = Number(formatUnits(BigInt(raw), decimals));
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(2);
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
  const text = formatUnits(big, dec);
  const num = Number(text);
  if (!Number.isFinite(num)) return `[huge] ${symbol}`;
  // Pick precision by magnitude so small ETH amounts stay human-readable.
  let formatted: string;
  const abs = Math.abs(num);
  if (abs === 0) formatted = "0";
  else if (abs < 1e-9) formatted = num.toExponential(3);
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

function fmtAge(ts: number): string {
  if (!ts) return "?";
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function fmtAddr(a?: string | null, len = 6): string {
  if (!a) return "-";
  if (a.length <= len * 2 + 2) return a;
  return `${a.slice(0, len + 2)}...${a.slice(-len)}`;
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

type View = "home" | "send" | "receive" | "history" | "connections" | "watch";

interface AppProps {
  wallet: WalletProfile;
  initialChainId: number;
  initialMode: NetworkMode;
}

function App(props: AppProps) {
  const [view, setView] = createSignal<View>("home");
  const [chainId, setChainId] = createSignal(props.initialChainId);
  const [tick, setTick] = createSignal(0);
  const [mode, setModeSignal] = createSignal<NetworkMode>(props.initialMode);
  const [chains, setChains] = createSignal<KuraChainConfig[]>([]);

  const [chainList] = createResource(
    () => mode(),
    async (m) => {
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
    () => [committedChainId(), tick()] as const,
    async ([cid]) => {
      portfolioCtrl?.abort();
      portfolioCtrl = new AbortController();
      try {
        return await getSignal<Portfolio>(`/portfolio?chain=${cid}&address=${props.wallet.address}`, portfolioCtrl.signal);
      } catch {
        return null;
      }
    },
  );
  const [history] = createResource(
    () => [committedChainId(), tick()] as const,
    async ([cid]) => {
      historyCtrl?.abort();
      historyCtrl = new AbortController();
      try {
        return await getSignal<{ items: ActivityItem[] }>(`/history?chain=${cid}&address=${props.wallet.address}&limit=50`, historyCtrl.signal);
      } catch {
        return { items: [] as ActivityItem[] };
      }
    },
  );

  const interval = setInterval(() => setTick((t) => t + 1), 30_000);
  onCleanup(() => {
    clearInterval(interval);
    portfolioCtrl?.abort();
    historyCtrl?.abort();
  });

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      process.exit(0);
    }
    if (view() === "home") {
      if (key.name === "q") process.exit(0);
      else if (key.name === "s") setView("send");
      else if (key.name === "r") setView("receive");
      else if (key.name === "h") setView("history");
      else if (key.name === "c") setView("connections");
      else if (key.name === "w") setView("watch");
      else if (key.name === "g") setTick((t) => t + 1);
      else if (key.name === "n") void toggleMode();
      else if (key.name === "tab") {
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
    // Non-home views: only Esc returns home. Lets text input handlers see all other keys.
    if (key.name === "escape") {
      setView("home");
    }
  });

  const chain = () => chains().find((c) => c.id === chainId()) ?? getKnownChain(chainId());

  return (
    <box flexDirection="column" padding={1} width="100%" height="100%">
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row">
          <text attributes={1}>{`kura . ${view()}   `}</text>
          <text fg={mode() === "testnet" ? "#f9a825" : "#a3be8c"} attributes={1}>{mode() === "testnet" ? "[TESTNET]" : "[MAINNET]"}</text>
        </box>
        <text fg="#88c0d0">{`${fmtAddr(props.wallet.address)} . ${props.wallet.name} . ${chain()?.name ?? `chain ${chainId()}`}`}</text>
      </box>

      {/* Content area takes all available vertical space so the footer below
          stays anchored at the bottom of the box, even when content is empty
          or still loading. */}
      <box flexGrow={1} flexDirection="column">
        <Show when={view() === "home"}>
          <HomeView
            portfolio={portfolio()}
            history={history()}
            chain={chain()}
          />
        </Show>
        <Show when={view() === "send"}>
          <SendModal wallet={props.wallet} chainId={chainId()} chain={chain()} onDone={() => setView("home")} />
        </Show>
        <Show when={view() === "receive"}>
          <ReceiveModal wallet={props.wallet} chain={chain()} />
        </Show>
        <Show when={view() === "history"}>
          <HistoryView items={history()?.items ?? []} chain={chain()} />
        </Show>
        <Show when={view() === "connections"}>
          <ConnectionsView />
        </Show>
        <Show when={view() === "watch"}>
          <WatchView />
        </Show>
      </box>

      <FooterHints view={view()} />
    </box>
  );
}

function HomeView(props: {
  portfolio: Portfolio | null | undefined;
  history: { items: ActivityItem[] } | undefined;
  chain: KuraChainConfig | undefined;
}) {
  const items = () => props.history?.items?.slice(0, 8) ?? [];
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
  return (
    <box flexDirection="column">
      <box marginTop={1} flexDirection="column">
        <box flexDirection="row">
          <text attributes={1}>Portfolio  </text>
          <text attributes={1} fg={props.portfolio ? "#a3be8c" : "#888"}>
            {props.portfolio ? fmtUsd(props.portfolio.totalUsd) : "loading..."}
          </text>
        </box>
        <Show when={props.portfolio}>
          <box marginTop={1} flexDirection="column">
            <For each={props.portfolio!.tokens.slice(0, 8)}>
              {(t) => (
                <text>{`  ${t.symbol.padEnd(8)} ${fmtTok(t.balance, t.decimals).padStart(14)}  ${fmtUsd(t.usd).padStart(10)}  ${(t.pct ?? 0).toFixed(1)}%`}</text>
              )}
            </For>
          </box>
        </Show>
      </box>
      <box marginTop={1} flexDirection="column">
        <text attributes={1}>Recent Activity</text>
        <box marginTop={1} flexDirection="column">
          <Show when={items().length > 0} fallback={<text fg="#666">  no recent activity</text>}>
            <For each={items()}>
              {(it) => {
                const arrow = it.direction === "out" ? "<-" : it.direction === "in" ? "->" : "<>";
                const rowColor = it.direction === "out" ? "#ff8c66" : it.direction === "in" ? "#a3be8c" : "#888";
                const symbol = it.kind === "erc20" ? (it.symbol ?? "tok") : (props.chain?.symbol ?? "ETH");
                const dec = it.kind === "erc20" ? it.decimals : 18;
                const amount = fmtActivityAmount(it.value, dec, symbol);
                const counter = it.direction === "out" ? it.to : it.from;
                const name = counter ? resolved()[counter.toLowerCase()] : null;
                const counterDisplay = name ?? fmtAddr(counter);
                const line = `  #${it.blockNumber.toString().padEnd(10)} ${arrow} ${amount.padEnd(28).slice(0, 28)}  ${counterDisplay}`.padEnd(100).slice(0, 100);
                return <text fg={rowColor}>{line}</text>;
              }}
            </For>
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
      const isNative = token().toUpperCase() === (props.chain?.symbol ?? "ETH").toUpperCase();
      let value = "0";
      let dataField = "0x";
      let target: Address = dest;
      if (isNative) {
        value = parseUnits(amount().replace(/^\$/, ""), 18).toString();
      } else {
        setStatus("token sends from TUI not yet wired to balance lookup; use CLI");
        setBusy(false);
        return;
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

function HistoryView(props: { items: ActivityItem[]; chain: KuraChainConfig | undefined }) {
  const [resolved, setResolved] = createSignal<Record<string, string | null>>({});
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
  // Cap rendered rows. opentui-solid (0.2.0) corrupts cells when many mutating
  // rows re-render under <For>; capping to ~15 keeps the visual stable.
  // Full feed available via `kura history` CLI which has no opentui.
  const MAX_ROWS = 15;
  const visible = () => props.items.slice(0, MAX_ROWS);
  const overflow = () => Math.max(0, props.items.length - MAX_ROWS);
  return (
    <box marginTop={1} flexDirection="column">
      <text attributes={1}>history</text>
      <box marginTop={1} flexDirection="column">
        <Show when={visible().length > 0} fallback={<text fg="#666">  no activity</text>}>
          <For each={visible()}>
            {(it) => {
              const arrow = it.direction === "out" ? "<-" : it.direction === "in" ? "->" : "<>";
              const rowColor = it.direction === "out" ? "#ff8c66" : it.direction === "in" ? "#a3be8c" : "#888";
              const symbol = it.kind === "erc20" ? (it.symbol ?? "tok") : (props.chain?.symbol ?? "ETH");
              const dec = it.kind === "erc20" ? it.decimals : 18;
              const amount = fmtActivityAmount(it.value, dec, symbol);
              const counter = it.direction === "out" ? it.to : it.from;
              const name = counter ? resolved()[counter.toLowerCase()] : null;
              const counterDisplay = name ?? fmtAddr(counter);
              const line = `  #${it.blockNumber.toString().padEnd(10)} ${arrow} ${amount.padEnd(28).slice(0, 28)}  ${counterDisplay.padEnd(28).slice(0, 28)}  ${fmtAddr(it.hash, 4)}`.padEnd(120).slice(0, 120);
              return <text fg={rowColor}>{line}</text>;
            }}
          </For>
          <Show when={overflow() > 0}>
            <text fg="#666">{`  +${overflow()} more  ·  use \`kura history\` CLI for full feed`}</text>
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

function FooterHints(props: { view: View }) {
  const hint = () => {
    switch (props.view) {
      case "home":
        return "[s] send  [r] receive  [h] history  [c] connections  [w] watch  [tab] chain  [n] mainnet/testnet  [g] refresh  [q] quit";
      case "send":
        return "tab cycles fields, type to fill, esc back";
      case "receive":
        return "esc back";
      case "history":
        return "esc back";
      case "connections":
        return "j/k to move, d to revoke, esc back";
      case "watch":
        return "esc back";
    }
  };
  return (
    <box marginTop={1} flexDirection="row">
      <text fg="#888">{hint()}</text>
    </box>
  );
}

let restored = false;
function restoreTerminal(): void {
  if (restored) return;
  restored = true;
  try {
    // Order matters: disable terminal *notification* modes FIRST so the terminal
    // stops sending us async responses (e.g., DEC 997 color-scheme reports) that
    // would otherwise arrive after we've exited and leak to the parent shell as
    // garbage like `^[[?997;1n`.
    const disableNotifications = [
      "\x1b[?996l",   // light/dark mode change notifications (DEC 996/997)
      "\x1b[?2031l",  // color scheme change notifications (newer DEC 2031)
      "\x1b[?2048l",  // in-band resize notifications
      "\x1b[?1000l", "\x1b[?1002l", "\x1b[?1003l", "\x1b[?1006l", "\x1b[?1015l", "\x1b[?1016l", // mouse tracking variants
      "\x1b[?1004l",  // focus tracking
      "\x1b[?2026l",  // synchronized output
    ].join("");
    process.stdout.write(disableNotifications);

    // OSC color queries (foreground `\x1b]10;?\x07`, background `\x1b]11;?\x07`)
    // that opentui sends on startup don't have a "stop" sequence: the terminal
    // already queued the response when we asked. We need to actually wait for
    // those bytes to arrive at our stdin before we exit, otherwise they leak
    // to the parent shell as `^[]10;rgb:.../...^G`. Sleep ~40ms (terminals
    // typically respond in <10ms) and then drain.
    try { (Bun as unknown as { sleepSync?: (ms: number) => void }).sleepSync?.(40); } catch {}

    if (process.stdin.isTTY && process.stdin.readable) {
      try {
        process.stdin.setRawMode?.(true);
        for (let i = 0; i < 100; i++) {
          const chunk = (process.stdin as NodeJS.ReadStream).read?.();
          if (!chunk) break;
        }
        process.stdin.setRawMode?.(false);
      } catch {
        // best effort, never block on stdin
      }
    }

    // Now exit the alt screen, show the cursor, reset attributes.
    process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[0m");
  } catch {
    // best effort
  }
}

export async function run(): Promise<void> {
  if (!existsSync(KURA_HOME)) {
    const { run: runInit } = await import("../cli/commands/init.ts");
    await runInit({});
    return;
  }
  const cfg = await getConfig();
  let wallet = await getWallet(cfg.defaultWallet);
  if (!wallet) {
    const all = await listWallets();
    if (all.length === 0) {
      console.error(`no wallets configured. run 'kura init' first.`);
      process.exit(1);
    }
    wallet = all[0]!;
  }
  process.on("exit", restoreTerminal);
  process.on("SIGINT", () => { restoreTerminal(); process.exit(130); });
  process.on("SIGTERM", () => { restoreTerminal(); process.exit(143); });
  render(() => <App wallet={wallet!} initialChainId={cfg.defaultChain} initialMode={cfg.networkMode} />);
}
