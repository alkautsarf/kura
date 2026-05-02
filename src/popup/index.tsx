import { render, useKeyboard, useRenderer } from "@opentui/solid";
import { createSignal, Show, For, onCleanup, onMount } from "solid-js";
import { hexToString } from "viem";
import type { PendingRequest, RiskFinding, RiskLevel, RiskResult, SimulationResult } from "../core/types.ts";
import type { SemanticTx } from "../core/decode-tx.ts";
import { describeTypedData } from "../core/decode-tx.ts";
import { fmtAddr } from "../cli/format.ts";
import { getKnownChain, reloadHotChains } from "../core/chains.ts";
import { getConfig } from "../core/config.ts";
import { getOrCreateSecret } from "../core/secret.ts";
import { copyToClipboard } from "../core/clipboard.ts";
import { attachRestoreHandlers, disableTerminalNotifications, quit, setActiveRenderer } from "../core/terminal.ts";

interface PendingDetail {
  request: PendingRequest;
  simulation?: SimulationResult;
  risk?: RiskResult;
  semantic?: SemanticTx;
  enriched?: boolean;
}

interface FeeData {
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

const COLORS = {
  label: "#aaaaaa",
  value: "#e0e0e0",
  accent: "#88c0d0",
  ok: "#3ddc84",
  warn: "#ffc857",
  bad: "#ff5252",
  dim: "#888888",
};

const LEVEL_COLORS: Record<RiskLevel, string> = {
  safe: COLORS.ok,
  review: COLORS.warn,
  danger: COLORS.bad,
};

const LEVEL_LABEL: Record<RiskLevel, string> = {
  safe: "OK",
  review: "REVIEW",
  danger: "DANGER",
};

type View = "outcome" | "calldata" | "expanded";

interface PopupProps {
  initial: PendingDetail;
  fetchLatest: () => Promise<PendingDetail | null>;
  fetchFees: (chainId: number) => Promise<FeeData | null>;
  onDecide: (decision: "approve" | "reject") => Promise<void>;
}

function cleanSource(src: string): string {
  // Strip the internal "shim:" / "tui:" / "cli:" prefix; show just the origin.
  return src.replace(/^(shim|tui|cli|mcp):/, "").replace(/^https?:\/\//, "");
}

function fmtAmt(raw: string | undefined, decimals: number): string {
  if (!raw) return "?";
  try {
    // BigInt division truncates toward zero and `%` carries the sign of the
    // dividend, so naively splitting -100000 / 10^6 produces "0" + "-1" = "0.-1".
    // Pull the sign first, format the absolute value, then prepend.
    const big = BigInt(raw);
    const sign = big < 0n ? "-" : "";
    const abs = big < 0n ? -big : big;
    const div = 10n ** BigInt(decimals);
    const whole = abs / div;
    const frac = abs % div;
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    return fracStr.length > 0 ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`;
  } catch {
    return "?";
  }
}

function Popup(props: PopupProps) {
  const [view, setView] = createSignal<View>("outcome");
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal<string>("");
  const [detail, setDetail] = createSignal<PendingDetail>(props.initial);
  const [typedSummary, setTypedSummary] = createSignal<string>("");
  const [calldataScroll, setCalldataScroll] = createSignal(0);
  const [fees, setFees] = createSignal<FeeData | null>(null);
  const renderer = useRenderer();

  // Fetch current network fee data (gas price + EIP-1559 fields) so we can
  // display gas cost in ETH alongside the gas units. One-shot fetch on mount.
  onMount(() => {
    props.fetchFees(props.initial.request.chainId).then((f) => {
      if (f) setFees(f);
    }).catch(() => {});
  });

  onMount(() => {
    setActiveRenderer(renderer ?? null);
    onCleanup(() => setActiveRenderer(null));
  });

  // Poll daemon for enrichment updates (sim/risk/semantic land async, in
  // stages). Each piece arrives separately:
  //   - semantic: ~500ms (ABI decode + token meta)
  //   - simulation: 5-15s (Tenderly full-mode is slow on V4 swaps)
  //   - risk: depends on sim result
  // Stop polling once all three are present, OR after 60 attempts (~18s).
  onMount(() => {
    let attempts = 0;
    const isComplete = (d: PendingDetail): boolean => {
      const isWrite = d.request.kind === "eth_sendTransaction" || d.request.kind === "batch";
      if (!isWrite) return d.risk !== undefined;
      return d.semantic !== undefined && d.simulation !== undefined && d.risk !== undefined;
    };
    if (isComplete(props.initial)) return;
    const tick = async () => {
      if (attempts > 60) return;
      attempts += 1;
      const next = await props.fetchLatest().catch(() => null);
      if (next) {
        setDetail(next);
        if (isComplete(next)) return;
      }
      setTimeout(tick, 300);
    };
    setTimeout(tick, 250);
  });

  // Decode typed-data sign requests asynchronously (semantic decode involves
  // RPC + token meta lookups), then surface the result above the raw JSON dump.
  onMount(() => {
    const d = detail();
    if (d.request.kind !== "eth_signTypedData_v4") return;
    const params = ((d.request.payload as { params?: unknown[] }).params ?? []) as unknown[];
    const j = params[1];
    if (j === undefined) return;
    describeTypedData(j, d.request.chainId).then((s) => {
      if (s?.description) setTypedSummary(s.description);
    }).catch(() => {});
  });

  const calldataText = (): string => {
    const d = detail();
    if (d.request.kind === "eth_signTypedData_v4") {
      const params = ((d.request.payload as { params?: unknown[] }).params ?? []) as unknown[];
      const data = params[1];
      try {
        const parsed = typeof data === "string" ? JSON.parse(data) : data;
        return JSON.stringify(parsed, null, 2);
      } catch {
        return String(data ?? "");
      }
    }
    return ((d.request.payload as { data?: string }).data ?? "0x");
  };

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      quit(0);
      return;
    }
    if (busy()) return;
    const v = view();
    const inCalldata = v === "calldata" || v === "expanded";
    if (key.name === "tab") {
      // tab cycles outcome <-> calldata; from expanded, returns to outcome.
      setView(v === "outcome" ? "calldata" : "outcome");
      setCalldataScroll(0);
    } else if (inCalldata && key.name === "e") {
      setView(v === "expanded" ? "calldata" : "expanded");
    } else if (inCalldata && (key.name === "j" || key.name === "down")) {
      setCalldataScroll((s) => s + 1);
    } else if (inCalldata && (key.name === "k" || key.name === "up")) {
      setCalldataScroll((s) => Math.max(0, s - 1));
    } else if (inCalldata && key.name === "g") {
      setCalldataScroll(0);
    } else if (inCalldata && key.name === "c") {
      const text = calldataText();
      copyToClipboard(text).then((ok) => {
        setStatus(ok ? `copied ${text.length} chars` : "copy failed");
        setTimeout(() => setStatus(""), 2000);
      });
    } else if (key.name === "a") {
      setBusy(true);
      setStatus("awaiting Touch ID...");
      props.onDecide("approve").catch((e) => setStatus(`error: ${e.message}`));
    } else if (key.name === "r" || (v === "outcome" && key.name === "q") || key.name === "escape") {
      setBusy(true);
      setStatus("rejected");
      props.onDecide("reject").catch((e) => setStatus(`error: ${e.message}`));
    }
  });

  const risk = (): RiskResult => detail().risk ?? { level: "review", findings: [] };
  const sim = (): SimulationResult | undefined => detail().simulation;
  const semantic = (): SemanticTx | undefined => detail().semantic;
  const kind = () => detail().request.kind;
  const payload = () => (detail().request.payload ?? {}) as Record<string, unknown>;
  const enriched = () => detail().enriched ?? false;
  const source = () => cleanSource(detail().request.source);

  const kindLabel = () => {
    const k = kind();
    if (k === "connect") return "connect";
    if (k === "personal_sign") return "sign message";
    if (k === "eth_signTypedData_v4") return "sign typed data";
    if (k === "eth_sendTransaction") {
      const s = semantic();
      if (s) return s.kind;
      return "send";
    }
    if (k === "batch") return "batch";
    return k;
  };

  const chainInfo = () => {
    const cid = detail().request.chainId;
    const c = getKnownChain(cid);
    return {
      label: c ? `${c.name} (${cid})` : String(cid),
      symbol: c?.symbol ?? "ETH",
      noSim: c?.capabilities.simulation === "rpc-only",
    };
  };

  return (
    <Show when={view() === "expanded"} fallback={<NormalView
      view={view()}
      kindLabel={kindLabel()}
      detail={detail()}
      semantic={semantic()}
      sim={sim()}
      risk={risk()}
      kind={kind()}
      payload={payload()}
      enriched={enriched()}
      source={source()}
      chainLabel={chainInfo().label}
      chainSymbol={chainInfo().symbol}
      chainNoSim={chainInfo().noSim}
      fees={fees()}
      typedSummary={typedSummary()}
      calldataScroll={calldataScroll()}
      busy={busy()}
      status={status()}
    />}>
      <ExpandedCalldata
        kindLabel={kindLabel()}
        kind={kind()}
        payload={payload()}
        semantic={semantic()}
        scroll={calldataScroll()}
        busy={busy()}
        status={status()}
      />
    </Show>
  );
}

interface NormalViewProps {
  view: View;
  kindLabel: string;
  detail: PendingDetail;
  semantic: SemanticTx | undefined;
  sim: SimulationResult | undefined;
  risk: RiskResult;
  kind: string;
  payload: Record<string, unknown>;
  enriched: boolean;
  source: string;
  chainLabel: string;
  chainSymbol: string;
  chainNoSim: boolean;
  fees: FeeData | null;
  typedSummary: string;
  calldataScroll: number;
  busy: boolean;
  status: string;
}

function NormalView(props: NormalViewProps) {
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1} width="100%" height="100%">
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row">
          <text attributes={1}>kura</text>
          <text fg={COLORS.dim}> · </text>
          <text fg={COLORS.accent} attributes={1}>{props.kindLabel}</text>
        </box>
        <text fg={COLORS.dim}>{`[tab] view: ${props.view}`}</text>
      </box>
      <box flexDirection="row" marginTop={1}>
        <text fg={COLORS.label}>request </text>
        <text fg={COLORS.value}>{props.detail.request.id.slice(0, 8)}</text>
        <text fg={COLORS.label}>  ·  chain </text>
        <text fg={COLORS.value}>{props.chainLabel}</text>
      </box>
      <box flexDirection="row">
        <text fg={COLORS.label}>source  </text>
        <text fg={COLORS.accent}>{props.source}</text>
      </box>

      <Show when={props.view === "outcome"}>
        <OutcomeView
          kind={props.kind}
          payload={props.payload}
          sim={props.sim}
          semantic={props.semantic}
          typedSummary={props.typedSummary}
          enriched={props.enriched}
          fees={props.fees}
          chainSymbol={props.chainSymbol}
          chainNoSim={props.chainNoSim}
        />
      </Show>
      <Show when={props.view === "calldata"}>
        <CalldataView
          semantic={props.semantic}
          payload={props.payload}
          kind={props.kind}
          scroll={props.calldataScroll}
        />
      </Show>

      <Show when={props.view === "outcome"}>
        <box marginTop={1} flexDirection="column">
          <box flexDirection="row">
            <text fg={COLORS.label}>risk    </text>
            <text fg={LEVEL_COLORS[props.risk.level]} attributes={1}>{`[${LEVEL_LABEL[props.risk.level]}]`}</text>
            <Show when={!props.enriched}>
              <text fg={COLORS.dim}>  loading...</text>
            </Show>
          </box>
          <For each={props.risk.findings}>
            {(f: RiskFinding) => (
              <box flexDirection="row">
                <text fg={COLORS.label}>          · </text>
                <text fg={LEVEL_COLORS[f.level]}>{f.id}</text>
                <text fg={COLORS.label}>  </text>
                <text fg={COLORS.value}>{f.message}</text>
              </box>
            )}
          </For>
        </box>
      </Show>

      {/* spacer pushes footer to absolute bottom */}
      <box flexGrow={1} />

      <FooterHints view={props.view} busy={props.busy} status={props.status} />
    </box>
  );
}

function FooterHints(props: { view: View; busy: boolean; status: string }) {
  return (
    <box flexDirection="row" justifyContent="space-between">
      <box flexDirection="row">
        <text fg={COLORS.ok}>[a]</text><text fg={COLORS.dim}> approve (Touch ID)  </text>
        <text fg={COLORS.bad}>[r]</text><text fg={COLORS.dim}> reject  </text>
        <text fg={COLORS.accent}>[tab]</text><text fg={COLORS.dim}> toggle  </text>
        <Show when={props.view === "calldata"}>
          <text fg={COLORS.accent}>[j/k]</text><text fg={COLORS.dim}> scroll  </text>
          <text fg={COLORS.accent}>[e]</text><text fg={COLORS.dim}> expand  </text>
          <text fg={COLORS.accent}>[c]</text><text fg={COLORS.dim}> copy</text>
        </Show>
        <Show when={props.view === "outcome"}>
          <text fg={COLORS.dim}>[q] cancel</text>
        </Show>
      </box>
      <text fg={props.busy ? COLORS.warn : COLORS.dim}>{props.status}</text>
    </box>
  );
}

function OutcomeView(props: {
  kind: string;
  payload: Record<string, unknown>;
  sim: SimulationResult | undefined;
  semantic: SemanticTx | undefined;
  typedSummary: string;
  enriched: boolean;
  fees: FeeData | null;
  chainSymbol: string;
  chainNoSim: boolean;
}) {
  const isConnect = props.kind === "connect";
  const isSign = props.kind === "personal_sign" || props.kind === "eth_signTypedData_v4";
  const isBatch = props.kind === "batch";
  const isTx = props.kind === "eth_sendTransaction";
  return (
    <box marginTop={1} flexDirection="column">
      <Show when={isConnect}>
        <ConnectOutcome payload={props.payload} />
      </Show>
      <Show when={isSign}>
        <SignOutcome kind={props.kind} payload={props.payload} typedSummary={props.typedSummary} />
      </Show>
      <Show when={isBatch}>
        <BatchOutcome payload={props.payload} />
      </Show>
      <Show when={isTx}>
        <TxOutcome semantic={props.semantic} sim={props.sim} payload={props.payload} enriched={props.enriched} fees={props.fees} chainSymbol={props.chainSymbol} chainNoSim={props.chainNoSim} />
      </Show>
    </box>
  );
}

function ConnectOutcome(props: { payload: Record<string, unknown> }) {
  const origin = (props.payload.origin as string) ?? "(unknown origin)";
  const host = origin.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <box flexDirection="column">
      <text attributes={1}>{`Connect wallet to ${host}`}</text>
      <text fg={COLORS.label} marginTop={1}>This shares your wallet address with the site (read-only).</text>
      <text fg={COLORS.label}>Each transaction or signature will ask for approval separately.</text>
    </box>
  );
}

function SignOutcome(props: { kind: string; payload: Record<string, unknown>; typedSummary: string }) {
  const params = (props.payload.params as unknown[]) ?? [];
  if (props.kind === "personal_sign") {
    const msgHex = params[0];
    let pretty = "";
    try {
      if (typeof msgHex === "string" && msgHex.startsWith("0x")) {
        try {
          pretty = hexToString(msgHex as `0x${string}`);
        } catch {
          pretty = msgHex;
        }
      } else {
        pretty = String(msgHex ?? "");
      }
    } catch {
      pretty = JSON.stringify(params);
    }
    return (
      <box flexDirection="column">
        <text>sign request:</text>
        <text fg={COLORS.accent}>{pretty.slice(0, 600)}</text>
      </box>
    );
  }
  return (
    <box flexDirection="column">
      <Show
        when={props.typedSummary}
        fallback={<text fg={COLORS.dim}>decoding typed data...</text>}
      >
        <text fg={COLORS.ok} attributes={1}>{props.typedSummary}</text>
        <text fg={COLORS.dim} marginTop={1}>press [tab] to inspect raw JSON</text>
      </Show>
    </box>
  );
}

function BatchOutcome(props: { payload: Record<string, unknown> }) {
  const steps = (props.payload.steps as Array<Record<string, unknown>>) ?? [];
  return (
    <box flexDirection="column">
      <text>{`batch (${steps.length} steps)`}</text>
      <For each={steps}>
        {(s, idx) => (
          <text>
            {`  ${idx() + 1}. ${(s.kind as string) ?? "tx"} -> ${(s.to as string) ?? "(no to)"}`}
          </text>
        )}
      </For>
      <text fg={COLORS.dim}>approve all at once. step-by-step approval not yet wired.</text>
    </box>
  );
}

function TxOutcome(props: {
  semantic: SemanticTx | undefined;
  sim: SimulationResult | undefined;
  payload: Record<string, unknown>;
  enriched: boolean;
  fees: FeeData | null;
  chainSymbol: string;
  chainNoSim: boolean;
}) {
  return (
    <box flexDirection="column">
      <Show
        when={props.semantic}
        fallback={
          <Show when={!props.enriched} fallback={<text fg={COLORS.dim}>no decoded summary; see calldata view</text>}>
            <text fg={COLORS.dim}>decoding transaction...</text>
          </Show>
        }
      >
        <text attributes={1}>{props.semantic!.description}</text>

        <Show when={props.semantic!.contract}>
          <box flexDirection="row" marginTop={1}>
            <text fg={COLORS.label}>contract  </text>
            <Show
              when={props.semantic!.contract!.label}
              fallback={
                <Show
                  when={props.semantic!.token?.symbol}
                  fallback={<text fg={COLORS.value}>{fmtAddr(props.semantic!.contract!.address, 4)}</text>}
                >
                  <text fg={COLORS.ok}>{props.semantic!.token!.symbol}</text>
                  <text fg={COLORS.label}> ({fmtAddr(props.semantic!.contract!.address, 4)})</text>
                </Show>
              }
            >
              <text fg={COLORS.ok}>{props.semantic!.contract!.label}</text>
              <text fg={COLORS.label}> ({fmtAddr(props.semantic!.contract!.address, 4)})</text>
            </Show>
          </box>
        </Show>
        <Show when={props.semantic!.fnSignature}>
          <box flexDirection="row">
            <text fg={COLORS.label}>fn        </text>
            <text fg={COLORS.value}>{props.semantic!.fnSignature}</text>
          </box>
        </Show>
        <Show when={props.semantic!.token && (props.semantic!.kind === "approve" || props.semantic!.kind === "transfer" || props.semantic!.kind === "transferFrom" || props.semantic!.kind === "permit")}>
          <box flexDirection="row">
            <text fg={COLORS.label}>amount    </text>
            <text fg={COLORS.value} attributes={1}>
              {props.semantic!.unlimited ? "unlimited" : props.semantic!.token!.amount}
            </text>
            <text fg={COLORS.label}> {props.semantic!.token!.symbol}</text>
          </box>
        </Show>
        <Show when={props.semantic!.spender}>
          <box flexDirection="row">
            <text fg={COLORS.label}>spender   </text>
            <text fg={COLORS.accent}>{props.semantic!.spender!.label ?? fmtAddr(props.semantic!.spender!.address, 4)}</text>
            <Show when={props.semantic!.spender!.label}>
              <text fg={COLORS.label}> ({fmtAddr(props.semantic!.spender!.address, 4)})</text>
            </Show>
          </box>
        </Show>
        <Show when={props.semantic!.recipient && props.semantic!.kind !== "transferFrom"}>
          <box flexDirection="row">
            <text fg={COLORS.label}>to        </text>
            <text fg={COLORS.accent}>{props.semantic!.recipient!.label ?? fmtAddr(props.semantic!.recipient!.address, 4)}</text>
          </box>
        </Show>
      </Show>

      <BalanceBox sim={props.sim} semantic={props.semantic} payload={props.payload} enriched={props.enriched} chainNoSim={props.chainNoSim} />

      <Show when={props.sim?.gasUsed}>
        <GasLine gasUsed={props.sim!.gasUsed!} fees={props.fees} chainSymbol={props.chainSymbol} />
      </Show>
    </box>
  );
}

function GasLine(props: { gasUsed: string; fees: FeeData | null; chainSymbol: string }) {
  // Compose: gas units · gas price (gwei) · estimated cost (ETH)
  const formatted = () => {
    const gasUsed = BigInt(props.gasUsed);
    const gasUsedFmt = gasUsed.toLocaleString("en-US");
    const f = props.fees;
    if (!f) return { line: gasUsedFmt };
    const priceWei = BigInt(f.maxFeePerGas ?? f.gasPrice ?? "0");
    if (priceWei === 0n) return { line: gasUsedFmt };
    // gwei = wei / 1e9, format with 2 decimals
    const gweiNum = Number(priceWei) / 1e9;
    const gweiFmt = gweiNum >= 1 ? gweiNum.toFixed(2) : gweiNum.toFixed(4);
    // cost in wei = gasUsed * priceWei
    const costWei = gasUsed * priceWei;
    // ETH = wei / 1e18
    const ethStr = (() => {
      const div = 10n ** 18n;
      const whole = costWei / div;
      const frac = costWei % div;
      const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
      return fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
    })();
    return { line: gasUsedFmt, gwei: gweiFmt, eth: ethStr };
  };
  const f = formatted();
  return (
    <box flexDirection="row" marginTop={1}>
      <text fg={COLORS.label}>gas       </text>
      <text fg={COLORS.value}>{f.line}</text>
      <Show when={f.gwei}>
        <text fg={COLORS.label}>  ·  </text>
        <text fg={COLORS.value}>{f.gwei}</text>
        <text fg={COLORS.label}> gwei</text>
        <Show when={f.eth}>
          <text fg={COLORS.label}>  ·  ~</text>
          <text fg={COLORS.value}>{f.eth}</text>
          <text fg={COLORS.label}> {props.chainSymbol}</text>
        </Show>
      </Show>
    </box>
  );
}

function BalanceBox(props: {
  sim: SimulationResult | undefined;
  semantic: SemanticTx | undefined;
  payload: Record<string, unknown>;
  enriched: boolean;
  chainNoSim: boolean;
}) {
  const diffs = () => props.sim?.diffs ?? [];
  const outDiffs = () => diffs().filter((d) => d.delta.startsWith("-"));
  const inDiffs = () => diffs().filter((d) => !d.delta.startsWith("-") && d.delta !== "0");
  const hasDiffs = () => outDiffs().length > 0 || inDiffs().length > 0;
  return (
    <box marginTop={1} flexDirection="column">
      <text fg={COLORS.label}>predicted balance</text>
      <Show
        when={hasDiffs()}
        fallback={
          <Show
            when={props.sim}
            fallback={<text fg={COLORS.dim}>  simulating...</text>}
          >
            <Show
              when={props.sim!.ok}
              fallback={
                <text fg={COLORS.dim}>
                  {props.chainNoSim ? "  no simulation available for this chain" : `  simulation failed: ${props.sim!.reason}`}
                </text>
              }
            >
              <NoDiffsMessage semantic={props.semantic} />
            </Show>
          </Show>
        }
      >
        <For each={outDiffs()}>
          {(d) => (
            <box flexDirection="row">
              <text fg={COLORS.bad}>  OUT  </text>
              <text fg={COLORS.bad}>{fmtAmt(d.delta, d.decimals)} {d.symbol}</text>
              <Show when={d.usd}>
                <text fg={COLORS.label}>  ($-{Math.abs(d.usd!).toFixed(2)})</text>
              </Show>
            </box>
          )}
        </For>
        <For each={inDiffs()}>
          {(d) => (
            <box flexDirection="row">
              <text fg={COLORS.ok}>  IN   </text>
              <text fg={COLORS.ok}>+{fmtAmt(d.delta, d.decimals)} {d.symbol}</text>
              <Show when={d.usd}>
                <text fg={COLORS.label}>  (${d.usd!.toFixed(2)})</text>
              </Show>
            </box>
          )}
        </For>
      </Show>
    </box>
  );
}

// Sim succeeded but produced no balance diffs. Branch on semantic kind so the
// copy is accurate: approve/permit really are allowance-only; everything else
// (self-transfer, opaque router calls Tenderly couldn't trace) shows the
// generic "no net balance change" line.
function NoDiffsMessage(props: { semantic: SemanticTx | undefined }) {
  const k = props.semantic?.kind;
  if (k === "approve" || k === "permit") {
    return <text fg={COLORS.dim}>  no balance change (allowance only)</text>;
  }
  return <text fg={COLORS.dim}>  no net balance change</text>;
}

function CalldataView(props: { semantic: SemanticTx | undefined; payload: Record<string, unknown>; kind: string; scroll: number }) {
  if (props.kind === "eth_signTypedData_v4") {
    const params = (props.payload.params as unknown[]) ?? [];
    const data = params[1];
    let pretty = "";
    try {
      const parsed = typeof data === "string" ? JSON.parse(data) : data;
      pretty = JSON.stringify(parsed, null, 2);
    } catch {
      pretty = String(data ?? "");
    }
    const allLines = pretty.split("\n");
    const VIEWPORT = 10;
    const offset = Math.max(0, Math.min(props.scroll, Math.max(0, allLines.length - VIEWPORT)));
    const visible = allLines.slice(offset, offset + VIEWPORT);
    return (
      <box marginTop={1} flexDirection="column">
        <text fg={COLORS.label}>{`typed data (EIP-712)  ·  ${offset + 1}-${offset + visible.length} / ${allLines.length}`}</text>
        <For each={visible}>{(c) => <text fg={COLORS.accent}>{c.slice(0, 100)}</text>}</For>
      </box>
    );
  }
  const data = (props.payload.data as string) ?? "0x";
  const CHUNK_WIDTH = 80;
  const allChunks = (() => {
    const out: string[] = [];
    for (let i = 0; i < data.length; i += CHUNK_WIDTH) out.push(data.slice(i, i + CHUNK_WIDTH));
    return out;
  })();
  const VIEWPORT = 8;
  const offset = Math.max(0, Math.min(props.scroll, Math.max(0, allChunks.length - VIEWPORT)));
  const visible = allChunks.slice(offset, offset + VIEWPORT);
  const selector = props.semantic?.selector ?? data.slice(0, 10);
  return (
    <box marginTop={1} flexDirection="column">
      <box flexDirection="row">
        <text fg={COLORS.label}>selector  </text>
        <text fg={COLORS.value}>{selector}</text>
      </box>
      <Show when={props.semantic?.fnSignature}>
        <box flexDirection="row">
          <text fg={COLORS.label}>fn        </text>
          <text fg={COLORS.accent}>{props.semantic!.fnSignature}</text>
        </box>
      </Show>
      <Show when={props.semantic?.contract?.address}>
        <box flexDirection="row">
          <text fg={COLORS.label}>to        </text>
          <text fg={COLORS.value}>{props.semantic!.contract!.address}</text>
          <Show when={props.semantic!.contract!.label}>
            <text fg={COLORS.label}> ({props.semantic!.contract!.label})</text>
          </Show>
        </box>
      </Show>
      <text fg={COLORS.label} marginTop={1}>{`raw  ·  ${data.length} chars  ·  lines ${offset + 1}-${offset + visible.length} / ${allChunks.length}  ·  [e] expand`}</text>
      <For each={visible}>{(c) => <text>{c}</text>}</For>
    </box>
  );
}

function ExpandedCalldata(props: {
  kindLabel: string;
  kind: string;
  payload: Record<string, unknown>;
  semantic: SemanticTx | undefined;
  scroll: number;
  busy: boolean;
  status: string;
}) {
  // Same flush-top padding as NormalView for visual consistency.
  const isTypedData = props.kind === "eth_signTypedData_v4";
  const fullText = (() => {
    if (isTypedData) {
      const params = (props.payload.params as unknown[]) ?? [];
      const data = params[1];
      try {
        const parsed = typeof data === "string" ? JSON.parse(data) : data;
        return JSON.stringify(parsed, null, 2);
      } catch {
        return String(data ?? "");
      }
    }
    return (props.payload.data as string) ?? "0x";
  })();
  const lines = (() => {
    if (isTypedData) return fullText.split("\n").map((l) => l.slice(0, 200));
    const out: string[] = [];
    for (let i = 0; i < fullText.length; i += 100) out.push(fullText.slice(i, i + 100));
    return out;
  })();
  // Reserve 2 rows: 1 for top header, 1 for footer. Body fills the rest.
  // Conservative VIEWPORT — opentui doesn't expose pane height to children.
  // Use a generous default (28); user can scroll.
  const VIEWPORT = 28;
  const offset = Math.max(0, Math.min(props.scroll, Math.max(0, lines.length - VIEWPORT)));
  const visible = lines.slice(offset, offset + VIEWPORT);
  const tag = isTypedData ? "typed-data" : "calldata";
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1} width="100%" height="100%">
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row">
          <text attributes={1}>kura</text>
          <text fg={COLORS.dim}> · </text>
          <text fg={COLORS.accent} attributes={1}>{props.kindLabel}</text>
          <text fg={COLORS.dim}> · </text>
          <text fg={COLORS.label}>{tag}</text>
        </box>
        <text fg={COLORS.label}>{`lines ${offset + 1}-${offset + visible.length} / ${lines.length}  ·  [j/k] scroll`}</text>
      </box>
      <For each={visible}>{(c) => <text fg={isTypedData ? COLORS.accent : COLORS.value}>{c}</text>}</For>
      <box flexGrow={1} />
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row">
          <text fg={COLORS.ok}>[a]</text><text fg={COLORS.dim}> approve  </text>
          <text fg={COLORS.bad}>[r]</text><text fg={COLORS.dim}> reject  </text>
          <text fg={COLORS.accent}>[tab]</text><text fg={COLORS.dim}> back  </text>
          <text fg={COLORS.accent}>[e]</text><text fg={COLORS.dim}> collapse  </text>
          <text fg={COLORS.accent}>[c]</text><text fg={COLORS.dim}> copy</text>
        </box>
        <text fg={props.busy ? COLORS.warn : COLORS.dim}>{props.status}</text>
      </box>
    </box>
  );
}

export async function run(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error("usage: kura popup <id>");
    process.exit(1);
  }
  await reloadHotChains();
  const cfg = await getConfig();
  const secret = await getOrCreateSecret();
  const base = `https://${cfg.daemonHost}:${cfg.daemonPort}`;
  const fetchOpts: RequestInit & { tls?: { rejectUnauthorized: boolean } } = { headers: { "X-Kura-Key": secret }, tls: { rejectUnauthorized: false } };

  const fetchDetail = async (): Promise<PendingDetail | null> => {
    try {
      const resp = await fetch(`${base}/requests/${id}`, fetchOpts);
      if (!resp.ok) return null;
      return (await resp.json()) as PendingDetail;
    } catch {
      return null;
    }
  };

  const fetchFees = async (chainId: number): Promise<FeeData | null> => {
    try {
      const resp = await fetch(`${base}/gas?chain=${chainId}`, fetchOpts);
      if (!resp.ok) return null;
      return (await resp.json()) as FeeData;
    } catch {
      return null;
    }
  };

  const initial = await fetchDetail();
  if (!initial) {
    console.error(`request ${id} not found`);
    process.exit(1);
  }

  // Pre-disable async notification modes BEFORE opentui starts touching
  // the terminal, then install signal handlers that route through quit()
  // so SIGINT/SIGTERM never bypass renderer.destroy().
  disableTerminalNotifications();
  attachRestoreHandlers();

  let resolved = false;
  const onDecide = async (decision: "approve" | "reject") => {
    if (resolved) return;
    resolved = true;
    await fetch(`${base}/requests/${id}/decision`, {
      method: "POST",
      headers: { "X-Kura-Key": secret, "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    setTimeout(() => quit(0), 200);
  };

  render(
    () => <Popup initial={initial} fetchLatest={fetchDetail} fetchFees={fetchFees} onDecide={onDecide} />,
    { exitSignals: [], exitOnCtrlC: false },
  );
}
