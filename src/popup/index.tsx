import { render, useKeyboard } from "@opentui/solid";
import { createSignal, Show, For } from "solid-js";
import { decodeFunctionData, parseAbi, hexToString } from "viem";
import type { PendingRequest, RiskFinding, RiskLevel, RiskResult, SimulationResult } from "../core/types.ts";
import { getConfig } from "../core/config.ts";
import { getOrCreateSecret } from "../core/secret.ts";
import { decodeCalldata } from "../core/decode.ts";

interface PendingDetail {
  request: PendingRequest;
  simulation?: SimulationResult;
  risk?: RiskResult;
}

const LEVEL_COLORS: Record<RiskLevel, string> = {
  safe: "#3ddc84",
  review: "#ffc857",
  danger: "#ff5252",
};

const LEVEL_LABEL: Record<RiskLevel, string> = {
  safe: "OK",
  review: "REVIEW",
  danger: "DANGER",
};

const COMMON_ABI = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))",
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum))",
  "function deposit()",
  "function withdraw(uint256 wad)",
  "function multicall(bytes[] data)",
]);

interface DecodedArgs {
  fnName?: string;
  args?: unknown[];
  signature?: string;
  selector: string;
}

function decodeArgs(data: `0x${string}`, parityFn: string | undefined): DecodedArgs {
  const selector = data.slice(0, 10);
  if (data === "0x" || data.length < 10) return { selector };
  try {
    const decoded = decodeFunctionData({ abi: COMMON_ABI, data });
    return {
      fnName: decoded.functionName,
      args: decoded.args as unknown as unknown[],
      signature: parityFn,
      selector,
    };
  } catch {
    return { selector, signature: parityFn };
  }
}

function fmtArg(arg: unknown): string {
  if (arg === null || arg === undefined) return "(null)";
  if (typeof arg === "bigint") return arg.toString();
  if (typeof arg === "string") return arg.length > 80 ? `${arg.slice(0, 60)}…` : arg;
  if (Array.isArray(arg)) return `[${arg.map(fmtArg).join(", ")}]`;
  if (typeof arg === "object") {
    return JSON.stringify(arg, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  }
  return String(arg);
}

interface PopupProps {
  detail: PendingDetail;
  decoded: DecodedArgs;
  onDecide: (decision: "approve" | "reject") => Promise<void>;
}

function Popup(props: PopupProps) {
  const [view, setView] = createSignal<"outcome" | "calldata">("outcome");
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal<string>("");

  useKeyboard((key) => {
    if (busy()) return;
    if (key.name === "tab") {
      setView(view() === "outcome" ? "calldata" : "outcome");
    } else if (key.name === "a") {
      setBusy(true);
      setStatus("approving (Touch ID)...");
      props.onDecide("approve").catch((e) => setStatus(`error: ${e.message}`));
    } else if (key.name === "r" || key.name === "q" || key.name === "escape") {
      setBusy(true);
      setStatus("rejected");
      props.onDecide("reject").catch((e) => setStatus(`error: ${e.message}`));
    }
  });

  const risk = (): RiskResult => props.detail.risk ?? { level: "review", findings: [] };
  const sim = (): SimulationResult | undefined => props.detail.simulation;
  const kind = () => props.detail.request.kind;
  const payload = () => (props.detail.request.payload ?? {}) as Record<string, unknown>;

  const kindLabel = () => {
    const k = kind();
    if (k === "connect") return "connect";
    if (k === "personal_sign") return "sign message";
    if (k === "eth_signTypedData_v4") return "sign typed data";
    if (k === "eth_sendTransaction") return "send transaction";
    if (k === "batch") return "batch";
    return k;
  };
  return (
    <box flexDirection="column" padding={1} width="100%" height="100%">
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row">
          <text attributes={1}>kura</text>
          <text fg="#666"> · </text>
          <text fg="#88c0d0" attributes={1}>{kindLabel()}</text>
        </box>
        <text fg="#666">{`[tab] view: ${view()}`}</text>
      </box>
      <box flexDirection="row" marginTop={1}>
        <text fg="#666">request </text>
        <text fg="#888">{props.detail.request.id.slice(0, 8)}</text>
        <text fg="#666">  ·  chain </text>
        <text fg="#888">{String(props.detail.request.chainId)}</text>
      </box>
      <box flexDirection="row">
        <text fg="#666">source </text>
        <text fg="#88c0d0">{props.detail.request.source}</text>
      </box>

      <Show when={view() === "outcome"}>
        <OutcomeView kind={kind()} payload={payload()} sim={sim()} decoded={props.decoded} />
      </Show>
      <Show when={view() === "calldata"}>
        <CalldataView decoded={props.decoded} payload={payload()} />
      </Show>

      <box marginTop={1} flexDirection="column">
        <box flexDirection="row">
          <text fg="#666">risk </text>
          <text fg={LEVEL_COLORS[risk().level]} attributes={1}>{`[${LEVEL_LABEL[risk().level]}]`}</text>
        </box>
        <For each={risk().findings}>
          {(f: RiskFinding) => (
            <text fg={LEVEL_COLORS[f.level]}>{`  · ${f.id}  ${f.message}`}</text>
          )}
        </For>
      </box>

      <box marginTop={1} flexDirection="row" justifyContent="space-between">
        <box flexDirection="row">
          <text fg="#a3be8c">[a]</text><text fg="#888"> approve  </text>
          <text fg="#ff8c66">[r]</text><text fg="#888"> reject  </text>
          <text fg="#88c0d0">[tab]</text><text fg="#888"> toggle  </text>
          <text fg="#888">[q] cancel</text>
        </box>
        <text fg={busy() ? "#ffc857" : "#666"}>{status()}</text>
      </box>
    </box>
  );
}

function OutcomeView(props: {
  kind: string;
  payload: Record<string, unknown>;
  sim: SimulationResult | undefined;
  decoded: DecodedArgs;
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
        <SignOutcome kind={props.kind} payload={props.payload} />
      </Show>
      <Show when={isBatch}>
        <BatchOutcome payload={props.payload} />
      </Show>
      <Show when={isTx}>
        <TxOutcome decoded={props.decoded} sim={props.sim} payload={props.payload} />
      </Show>
    </box>
  );
}

function ConnectOutcome(props: { payload: Record<string, unknown> }) {
  const origin = (props.payload.origin as string) ?? "(unknown origin)";
  return (
    <box flexDirection="column">
      <text>{`dapp wants to connect: ${origin}`}</text>
      <text fg="#666">approve to share your wallet address with this site</text>
    </box>
  );
}

function SignOutcome(props: { kind: string; payload: Record<string, unknown> }) {
  const params = (props.payload.params as unknown[]) ?? [];
  let pretty = "";
  try {
    if (props.kind === "personal_sign") {
      const msgHex = params[0] as string | undefined;
      if (typeof msgHex === "string" && msgHex.startsWith("0x")) {
        try {
          pretty = hexToString(msgHex as `0x${string}`);
        } catch {
          pretty = msgHex;
        }
      } else {
        pretty = String(msgHex ?? "");
      }
    } else {
      const data = params[1];
      pretty = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    }
  } catch {
    pretty = JSON.stringify(params);
  }
  return (
    <box flexDirection="column">
      <text>sign request:</text>
      <text fg="#88c0d0">{pretty.slice(0, 600)}</text>
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
      <text fg="#666">approve all at once. step-by-step approval not yet wired.</text>
    </box>
  );
}

function TxOutcome(props: {
  decoded: DecodedArgs;
  sim: SimulationResult | undefined;
  payload: Record<string, unknown>;
}) {
  return (
    <box flexDirection="column">
      <Show when={props.decoded.fnName}>
        <text>{`fn: ${props.decoded.fnName}`}</text>
        <Show when={props.decoded.args && props.decoded.args.length > 0}>
          <For each={props.decoded.args!}>
            {(arg, idx) => <text>{`    arg${idx()}: ${fmtArg(arg)}`}</text>}
          </For>
        </Show>
      </Show>
      <Show when={!props.decoded.fnName && props.decoded.signature}>
        <text>{`fn: ${props.decoded.signature}`}</text>
      </Show>
      <Show when={!props.decoded.fnName && !props.decoded.signature}>
        <text fg="#666">{`unknown selector ${props.decoded.selector}`}</text>
      </Show>
      <Show
        when={props.sim?.diffs && props.sim!.diffs.length > 0}
        fallback={<text fg="#666">no balance diffs predicted</text>}
      >
        <text fg="#888">predicted balance changes:</text>
        <For each={props.sim!.diffs}>
          {(d) => (
            <text>{`  ${d.delta.startsWith("-") ? "-" : "+"} ${d.symbol} ${d.delta} ${d.usd ? `($${d.usd.toFixed(2)})` : ""}`}</text>
          )}
        </For>
      </Show>
      <Show when={props.sim && !props.sim!.ok}>
        <text fg="#ff5252">{`simulation failed: ${props.sim!.reason}`}</text>
      </Show>
      <Show when={props.sim?.gasUsed}>
        <text fg="#666">{`gas used: ${props.sim!.gasUsed}`}</text>
      </Show>
      <Show when={typeof props.payload.value === "string" && props.payload.value !== "0"}>
        <text fg="#666">{`value: ${props.payload.value as string} wei`}</text>
      </Show>
    </box>
  );
}

function CalldataView(props: { decoded: DecodedArgs; payload: Record<string, unknown> }) {
  const data = (props.payload.data as string) ?? "0x";
  const chunks = (() => {
    const out: string[] = [];
    for (let i = 0; i < data.length; i += 80) out.push(data.slice(i, i + 80));
    return out;
  })();
  return (
    <box marginTop={1} flexDirection="column">
      <text fg="#666">{`selector: ${props.decoded.selector}`}</text>
      <Show when={props.decoded.signature}>
        <text fg="#88c0d0">{`fn: ${props.decoded.signature}`}</text>
      </Show>
      <text fg="#666">raw calldata:</text>
      <For each={chunks.slice(0, 12)}>{(c) => <text>{c}</text>}</For>
      <Show when={chunks.length > 12}>
        <text fg="#666">{`...${chunks.length - 12} more lines`}</text>
      </Show>
    </box>
  );
}

export async function run(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error("usage: kura popup <id>");
    process.exit(1);
  }
  const cfg = await getConfig();
  const secret = await getOrCreateSecret();
  const base = `https://${cfg.daemonHost}:${cfg.daemonPort}`;
  const fetchOpts: RequestInit & { tls?: { rejectUnauthorized: boolean } } = { headers: { "X-Kura-Key": secret }, tls: { rejectUnauthorized: false } };

  const resp = await fetch(`${base}/requests/${id}`, fetchOpts);
  if (!resp.ok) {
    console.error(`request ${id} not found`);
    process.exit(1);
  }
  const detail = (await resp.json()) as PendingDetail;
  const data = (detail.request.payload as { data?: `0x${string}` })?.data ?? "0x";
  const to = (detail.request.payload as { to?: `0x${string}` })?.to ?? null;
  const parity = await decodeCalldata(to, data as `0x${string}`).catch(() => ({ selector: "0x", signature: undefined as string | undefined }));
  const decoded = decodeArgs(data as `0x${string}`, parity.signature);
  decoded.selector = parity.selector || decoded.selector;

  function restoreTerminal(): void {
    try {
      // Disable mouse tracking, focus tracking, alternate screen, sync mode; show cursor; reset attrs.
      const seq = [
        "\x1b[?1000l", "\x1b[?1002l", "\x1b[?1003l", "\x1b[?1006l", "\x1b[?1015l",
        "\x1b[?1004l", "\x1b[?2026l", "\x1b[?1049l", "\x1b[?25h", "\x1b[0m",
      ].join("");
      process.stdout.write(seq);
    } catch {
      // best-effort
    }
  }

  // Catch-all in case process exits via signal or unhandled error
  process.on("exit", restoreTerminal);
  process.on("SIGINT", () => { restoreTerminal(); process.exit(130); });
  process.on("SIGTERM", () => { restoreTerminal(); process.exit(143); });

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
    setTimeout(() => {
      restoreTerminal();
      process.exit(0);
    }, 200);
  };

  render(() => <Popup detail={detail} decoded={decoded} onDecide={onDecide} />);
}
