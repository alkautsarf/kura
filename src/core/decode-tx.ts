import { decodeFunctionData, formatUnits, parseAbi, type Hex } from "viem";
import type { Address } from "./types.ts";
import { getKnownChain } from "./chains.ts";
import { getTokenMeta, getContractLabel, isMaxApproval } from "./token-meta.ts";
import { lookupSignature } from "./decode.ts";
import { fmtAddr } from "../cli/format.ts";

export const COMMON_ABI = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256)",
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function multicall(bytes[] data) payable returns (bytes[])",
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
  "function execute(bytes commands, bytes[] inputs) payable",
]);

export type SemanticKind =
  | "native_send"
  | "approve"
  | "transfer"
  | "transferFrom"
  | "swap"
  | "permit"
  | "permit2"
  | "deposit"
  | "withdraw"
  | "execute"
  | "multicall"
  | "contract"
  | "unknown";

export interface TokenSummary {
  symbol: string;
  decimals: number;
  address?: Address;
  amount?: string;
  amountRaw?: string;
  usd?: number;
}

export interface SemanticTx {
  kind: SemanticKind;
  description: string;
  selector: Hex;
  fnSignature?: string;
  contract?: { address: Address; label?: string };
  token?: TokenSummary;
  spender?: { address: Address; label?: string };
  recipient?: { address: Address; label?: string };
  tokenIn?: TokenSummary;
  tokenOut?: TokenSummary;
  unlimited?: boolean;
}

export interface DescribeInput {
  chainId: number;
  to: Address | null;
  data: Hex;
  value?: string;
}

export async function describeTx(input: DescribeInput): Promise<SemanticTx> {
  const data = (input.data ?? "0x") as Hex;
  const selector = (data.length >= 10 ? data.slice(0, 10) : "0x") as Hex;
  const valueWei = BigInt(input.value ?? "0");

  // Pure native send: no calldata, value > 0, recipient is an address.
  if ((data === "0x" || data.length < 10) && valueWei > 0n && input.to) {
    const chain = getKnownChain(input.chainId);
    const symbol = chain?.symbol ?? "ETH";
    const amount = formatUnits(valueWei, 18);
    return {
      kind: "native_send",
      description: `Send ${trimNum(amount)} ${symbol} to ${fmtAddr(input.to, 4)}`,
      selector,
      recipient: { address: input.to },
      token: { symbol, decimals: 18, amount: trimNum(amount), amountRaw: valueWei.toString() },
    };
  }

  if (data === "0x" || data.length < 10 || !input.to) {
    return {
      kind: "contract",
      description: input.to ? `Call ${fmtAddr(input.to, 4)}` : "Deploy contract",
      selector,
      contract: input.to ? { address: input.to } : undefined,
    };
  }

  const contractLabel = getContractLabel(input.chainId, input.to) ?? undefined;
  const contract = { address: input.to, label: contractLabel };

  let decoded: ReturnType<typeof decodeFunctionData> | null = null;
  try {
    decoded = decodeFunctionData({ abi: COMMON_ABI, data });
  } catch {
    decoded = null;
  }

  if (decoded) {
    const sem = await fromDecoded(input, decoded, contract, selector);
    if (sem) return sem;
  }

  // Unknown selector: try external sig lookup
  const fnSignature = (await lookupSignature(selector).catch(() => null)) ?? undefined;
  return {
    kind: "contract",
    description: contractLabel
      ? `Call ${fnSignature ? extractFnName(fnSignature) : selector} on ${contractLabel}`
      : `Call ${fnSignature ? extractFnName(fnSignature) : selector} on ${fmtAddr(input.to, 4)}`,
    selector,
    fnSignature,
    contract,
  };
}

async function fromDecoded(
  input: DescribeInput,
  decoded: { functionName: string; args: readonly unknown[] | undefined },
  contract: { address: Address; label?: string },
  selector: Hex,
): Promise<SemanticTx | null> {
  const fn = decoded.functionName;
  const args = (decoded.args ?? []) as unknown[];

  if (fn === "approve" && args.length === 2) {
    const spender = args[0] as Address;
    const amount = args[1] as bigint;
    const meta = await getTokenMeta(input.chainId, input.to!);
    const symbol = meta?.symbol ?? "?";
    const decimals = meta?.decimals ?? 18;
    const unlimited = isMaxApproval(amount);
    const amountStr = unlimited ? "unlimited" : trimNum(formatUnits(amount, decimals));
    const spenderLabel = getContractLabel(input.chainId, spender) ?? undefined;
    return {
      kind: "approve",
      description: `Approve ${amountStr} ${symbol} to ${spenderLabel ?? fmtAddr(spender, 4)}`,
      selector,
      fnSignature: "approve(address,uint256)",
      contract,
      token: { symbol, decimals, address: input.to!, amount: amountStr, amountRaw: amount.toString() },
      spender: { address: spender, label: spenderLabel },
      unlimited,
    };
  }

  if (fn === "transfer" && args.length === 2) {
    const to = args[0] as Address;
    const amount = args[1] as bigint;
    const meta = await getTokenMeta(input.chainId, input.to!);
    const symbol = meta?.symbol ?? "?";
    const decimals = meta?.decimals ?? 18;
    const amountStr = trimNum(formatUnits(amount, decimals));
    return {
      kind: "transfer",
      description: `Transfer ${amountStr} ${symbol} to ${fmtAddr(to, 4)}`,
      selector,
      fnSignature: "transfer(address,uint256)",
      contract,
      token: { symbol, decimals, address: input.to!, amount: amountStr, amountRaw: amount.toString() },
      recipient: { address: to },
    };
  }

  if (fn === "transferFrom" && args.length === 3) {
    const from = args[0] as Address;
    const to = args[1] as Address;
    const amount = args[2] as bigint;
    const meta = await getTokenMeta(input.chainId, input.to!);
    const symbol = meta?.symbol ?? "?";
    const decimals = meta?.decimals ?? 18;
    const amountStr = trimNum(formatUnits(amount, decimals));
    return {
      kind: "transferFrom",
      description: `Transfer ${amountStr} ${symbol} from ${fmtAddr(from, 4)} to ${fmtAddr(to, 4)}`,
      selector,
      fnSignature: "transferFrom(address,address,uint256)",
      contract,
      token: { symbol, decimals, address: input.to!, amount: amountStr, amountRaw: amount.toString() },
      recipient: { address: to },
    };
  }

  if ((fn === "swapExactTokensForTokens" || fn === "swapExactTokensForETH") && args.length === 5) {
    const amountIn = args[0] as bigint;
    const amountOutMin = args[1] as bigint;
    const path = args[2] as Address[];
    if (path.length >= 2) {
      const inAddr = path[0]!;
      const outAddr = path[path.length - 1]!;
      const [inMeta, outMeta] = await Promise.all([
        getTokenMeta(input.chainId, inAddr),
        getTokenMeta(input.chainId, outAddr),
      ]);
      const inSym = inMeta?.symbol ?? "?";
      const outSym = outMeta?.symbol ?? "?";
      const inAmt = trimNum(formatUnits(amountIn, inMeta?.decimals ?? 18));
      const outAmt = trimNum(formatUnits(amountOutMin, outMeta?.decimals ?? 18));
      return {
        kind: "swap",
        description: `Swap ${inAmt} ${inSym} for at least ${outAmt} ${outSym}`,
        selector,
        fnSignature: `${fn}(uint256,uint256,address[],address,uint256)`,
        contract,
        tokenIn: { symbol: inSym, decimals: inMeta?.decimals ?? 18, address: inAddr, amount: inAmt, amountRaw: amountIn.toString() },
        tokenOut: { symbol: outSym, decimals: outMeta?.decimals ?? 18, address: outAddr, amount: outAmt, amountRaw: amountOutMin.toString() },
      };
    }
  }

  if (fn === "swapExactETHForTokens" && args.length === 4) {
    const amountOutMin = args[0] as bigint;
    const path = args[1] as Address[];
    const valueWei = BigInt(input.value ?? "0");
    if (path.length >= 2) {
      const outAddr = path[path.length - 1]!;
      const outMeta = await getTokenMeta(input.chainId, outAddr);
      const chain = getKnownChain(input.chainId);
      const inSym = chain?.symbol ?? "ETH";
      const outSym = outMeta?.symbol ?? "?";
      const inAmt = trimNum(formatUnits(valueWei, 18));
      const outAmt = trimNum(formatUnits(amountOutMin, outMeta?.decimals ?? 18));
      return {
        kind: "swap",
        description: `Swap ${inAmt} ${inSym} for at least ${outAmt} ${outSym}`,
        selector,
        fnSignature: "swapExactETHForTokens(uint256,address[],address,uint256)",
        contract,
        tokenIn: { symbol: inSym, decimals: 18, amount: inAmt, amountRaw: valueWei.toString() },
        tokenOut: { symbol: outSym, decimals: outMeta?.decimals ?? 18, address: outAddr, amount: outAmt, amountRaw: amountOutMin.toString() },
      };
    }
  }

  if (fn === "exactInputSingle" && args.length === 1) {
    const p = args[0] as { tokenIn: Address; tokenOut: Address; amountIn: bigint; amountOutMinimum: bigint };
    const [inMeta, outMeta] = await Promise.all([
      getTokenMeta(input.chainId, p.tokenIn),
      getTokenMeta(input.chainId, p.tokenOut),
    ]);
    const inSym = inMeta?.symbol ?? "?";
    const outSym = outMeta?.symbol ?? "?";
    const inAmt = trimNum(formatUnits(p.amountIn, inMeta?.decimals ?? 18));
    const outAmt = trimNum(formatUnits(p.amountOutMinimum, outMeta?.decimals ?? 18));
    return {
      kind: "swap",
      description: `Swap ${inAmt} ${inSym} for at least ${outAmt} ${outSym}`,
      selector,
      fnSignature: "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
      contract,
      tokenIn: { symbol: inSym, decimals: inMeta?.decimals ?? 18, address: p.tokenIn, amount: inAmt, amountRaw: p.amountIn.toString() },
      tokenOut: { symbol: outSym, decimals: outMeta?.decimals ?? 18, address: p.tokenOut, amount: outAmt, amountRaw: p.amountOutMinimum.toString() },
    };
  }

  if (fn === "deposit") {
    const valueWei = BigInt(input.value ?? "0");
    const chain = getKnownChain(input.chainId);
    const symbol = chain?.symbol ?? "ETH";
    const amount = trimNum(formatUnits(valueWei, 18));
    return {
      kind: "deposit",
      description: `Wrap ${amount} ${symbol} to W${symbol}${contract.label ? ` (${contract.label})` : ""}`,
      selector,
      fnSignature: "deposit()",
      contract,
      token: { symbol, decimals: 18, amount, amountRaw: valueWei.toString() },
    };
  }

  if (fn === "withdraw" && args.length === 1) {
    const amount = args[0] as bigint;
    const meta = await getTokenMeta(input.chainId, input.to!);
    const symbol = meta?.symbol ?? "?";
    const decimals = meta?.decimals ?? 18;
    const amountStr = trimNum(formatUnits(amount, decimals));
    return {
      kind: "withdraw",
      description: `Unwrap ${amountStr} ${symbol}`,
      selector,
      fnSignature: "withdraw(uint256)",
      contract,
      token: { symbol, decimals, address: input.to!, amount: amountStr, amountRaw: amount.toString() },
    };
  }

  if (fn === "permit") {
    const owner = args[0] as Address;
    const spender = args[1] as Address;
    const value = args[2] as bigint;
    const meta = await getTokenMeta(input.chainId, input.to!);
    const symbol = meta?.symbol ?? "?";
    const decimals = meta?.decimals ?? 18;
    const amountStr = isMaxApproval(value) ? "unlimited" : trimNum(formatUnits(value, decimals));
    const spenderLabel = getContractLabel(input.chainId, spender) ?? undefined;
    return {
      kind: "permit",
      description: `Permit ${amountStr} ${symbol} for ${spenderLabel ?? fmtAddr(spender, 4)}`,
      selector,
      fnSignature: "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
      contract,
      token: { symbol, decimals, address: input.to!, amount: amountStr, amountRaw: value.toString() },
      spender: { address: spender, label: spenderLabel },
      recipient: { address: owner },
    };
  }

  if (fn === "execute" || fn === "multicall") {
    // Universal Router's `execute(commands, inputs)` is the canonical Uniswap
    // swap entry point — surface that intent in the description rather than
    // the literal function name. multicall on a swap router is the same idea.
    const isRouter = (contract.label ?? "").toLowerCase().includes("router");
    const verb = isRouter ? "Swap" : capitalize(fn);
    const preposition = isRouter ? "via" : "on";
    return {
      kind: fn,
      description: contract.label
        ? `${verb} ${preposition} ${contract.label}`
        : `${capitalize(fn)} on ${fmtAddr(input.to!, 4)}`,
      selector,
      fnSignature: `${fn}(...)`,
      contract,
    };
  }

  return null;
}

export interface SemanticTypedData {
  kind: "permit2" | "permit" | "generic";
  description: string;
  domain?: string;
  details?: Record<string, unknown>;
}

export async function describeTypedData(json: unknown, chainId?: number): Promise<SemanticTypedData> {
  const obj = (typeof json === "string" ? safeJson(json) : json) as { domain?: { name?: string; verifyingContract?: string; chainId?: number }; primaryType?: string; message?: Record<string, unknown> } | null;
  if (!obj) return { kind: "generic", description: "Sign typed data" };
  const domainName = obj.domain?.name ?? "typed data";
  const domain = obj.domain;
  const message = obj.message ?? {};
  const primary = obj.primaryType;
  const cid = chainId ?? domain?.chainId;

  // Permit2 PermitSingle
  if (domainName === "Permit2" && primary === "PermitSingle") {
    const det = (message.details as { token?: string; amount?: string; expiration?: string | number; nonce?: string | number }) ?? {};
    const spenderAddr = (message.spender as Address | undefined) ?? undefined;
    const tokenAddr = det.token as Address | undefined;
    let symbol = "?", decimals = 18;
    if (tokenAddr && cid) {
      const meta = await getTokenMeta(cid, tokenAddr);
      symbol = meta?.symbol ?? "?";
      decimals = meta?.decimals ?? 18;
    }
    const amount = det.amount ? BigInt(det.amount) : 0n;
    const amountStr = isMaxApproval(amount) ? "unlimited" : trimNum(formatUnits(amount, decimals));
    const spenderLabel = (spenderAddr && cid) ? (getContractLabel(cid, spenderAddr) ?? undefined) : undefined;
    return {
      kind: "permit2",
      description: `Permit2: approve ${amountStr} ${symbol} to ${spenderLabel ?? (spenderAddr ? fmtAddr(spenderAddr, 4) : "?")}`,
      domain: domainName,
      details: { token: tokenAddr, spender: spenderAddr, amount: amount.toString(), expiration: det.expiration, nonce: det.nonce },
    };
  }

  // Permit2 PermitBatch
  if (domainName === "Permit2" && primary === "PermitBatch") {
    const details = (message.details as Array<{ token?: string; amount?: string }>) ?? [];
    return {
      kind: "permit2",
      description: `Permit2 batch: ${details.length} token approvals`,
      domain: domainName,
      details: { count: details.length },
    };
  }

  // EIP-2612 Permit (per-token)
  if (primary === "Permit" && message.spender) {
    const value = message.value ? BigInt(String(message.value)) : 0n;
    const tokenAddr = obj.domain?.verifyingContract as Address | undefined;
    let symbol = domainName, decimals = 18;
    if (tokenAddr && cid) {
      const meta = await getTokenMeta(cid, tokenAddr);
      if (meta) { symbol = meta.symbol; decimals = meta.decimals; }
    }
    const amount = isMaxApproval(value) ? "unlimited" : trimNum(formatUnits(value, decimals));
    const spenderAddr = message.spender as Address;
    const spenderLabel = cid ? (getContractLabel(cid, spenderAddr) ?? undefined) : undefined;
    return {
      kind: "permit",
      description: `${symbol} permit: approve ${amount} to ${spenderLabel ?? fmtAddr(spenderAddr, 4)}`,
      domain: domainName,
      details: { token: tokenAddr, spender: spenderAddr, value: value.toString() },
    };
  }

  return {
    kind: "generic",
    description: `Sign ${domainName}${primary ? ` (${primary})` : ""}`,
    domain: domainName,
  };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

function trimNum(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

function extractFnName(sig: string): string {
  const i = sig.indexOf("(");
  return i > 0 ? sig.slice(0, i) : sig;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
