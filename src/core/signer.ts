import { createWalletClient, formatUnits, http, hexToString, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getKnownChain, resolveRpcUrl } from "./chains.ts";
import { readWalletKey, readAlchemyKey } from "./keychain.ts";
import { logAudit } from "./audit-log.ts";
import { describeTypedData } from "./decode-tx.ts";

function fmtValueFor(reason: string, valueWei: string | undefined, symbol: string): string {
  if (!valueWei || valueWei === "0") return reason;
  try {
    const eth = formatUnits(BigInt(valueWei), 18);
    // Trim trailing zeros so "0.10000000000000000" → "0.1".
    const clean = eth.includes(".") ? eth.replace(/0+$/, "").replace(/\.$/, "") : eth;
    return `${reason} ${clean} ${symbol}`;
  } catch {
    return reason;
  }
}

export interface SignSendInput {
  walletName: string;
  chainId: number;
  to: Address | null;
  data?: Hex;
  value?: string;
  gas?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: number;
  description?: string;
}

export async function signAndSend(input: SignSendInput): Promise<{ txHash: Hex }> {
  const chain = getKnownChain(input.chainId);
  if (!chain) throw new Error(`unknown chain ${input.chainId}`);
  // LAContext renders this after "kura-signer is trying to <reason>" — keep
  // it as a clean verb phrase without redundant "kura:" prefix.
  const action = input.description ?? fmtValueFor(`Send`, input.value, chain.symbol);
  const reason = `${action} (${chain.name}, ${input.walletName})`;
  const key = await readWalletKey(input.walletName, reason);
  if (!key) throw new Error(`wallet ${input.walletName} not in keychain`);
  const normalized = (key.startsWith("0x") ? key : "0x" + key) as Hex;
  const account = privateKeyToAccount(normalized);
  const alchemy = await readAlchemyKey();
  const url = resolveRpcUrl(chain, alchemy);
  const walletClient = createWalletClient({
    account,
    chain: { id: chain.id, name: chain.name, nativeCurrency: { name: chain.symbol, symbol: chain.symbol, decimals: 18 }, rpcUrls: { default: { http: [url] } } },
    transport: http(url),
  });
  const txHash = await walletClient.sendTransaction({
    to: input.to ?? undefined,
    data: input.data ?? "0x",
    value: input.value ? BigInt(input.value) : 0n,
    gas: input.gas ? BigInt(input.gas) : undefined,
    maxFeePerGas: input.maxFeePerGas ? BigInt(input.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas ? BigInt(input.maxPriorityFeePerGas) : undefined,
    nonce: input.nonce,
  } as never);
  await logAudit("tx_signed", {
    chainId: input.chainId,
    walletName: input.walletName,
    txHash,
    to: input.to,
  });
  return { txHash };
}

export async function signPersonalMessage(walletName: string, messageHex: Hex): Promise<{ signature: Hex }> {
  const key = await readWalletKey(walletName, `Sign message (${walletName})`);
  if (!key) throw new Error(`wallet ${walletName} not in keychain`);
  const normalized = (key.startsWith("0x") ? key : "0x" + key) as Hex;
  const account = privateKeyToAccount(normalized);
  // viem signMessage handles personal_sign EIP-191 framing automatically
  let raw: string;
  try {
    raw = hexToString(messageHex);
  } catch {
    raw = messageHex;
  }
  const signature = await account.signMessage({ message: raw });
  await logAudit("message_signed", { walletName, kind: "personal_sign" });
  return { signature };
}

export async function signTypedDataV4(walletName: string, json: string): Promise<{ signature: Hex }> {
  const parsed = JSON.parse(json);
  const chainId = Number(parsed?.domain?.chainId ?? 0);
  const chain = chainId ? getKnownChain(chainId) : undefined;
  const semantic = await describeTypedData(parsed, chainId || undefined).catch(() => null);
  const verb = semantic?.description ?? `Sign ${(parsed?.domain?.name as string | undefined) ?? "typed data"}`;
  // Capitalize first letter so it reads naturally after "is trying to".
  const action = verb.length > 0 ? verb[0]!.toUpperCase() + verb.slice(1) : verb;
  const ctx = chain ? `(${chain.name}, ${walletName})` : `(${walletName})`;
  const reason = `${action} ${ctx}`;
  const key = await readWalletKey(walletName, reason);
  if (!key) throw new Error(`wallet ${walletName} not in keychain`);
  const normalized = (key.startsWith("0x") ? key : "0x" + key) as Hex;
  const account = privateKeyToAccount(normalized);
  const signature = await account.signTypedData(parsed);
  await logAudit("message_signed", { walletName, kind: "eth_signTypedData_v4" });
  return { signature };
}
