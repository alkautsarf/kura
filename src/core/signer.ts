import { createWalletClient, http, hexToString, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getKnownChain, resolveRpcUrl } from "./chains.ts";
import { readWalletKey, readAlchemyKey } from "./keychain.ts";
import { logAudit } from "./audit-log.ts";

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
}

export async function signAndSend(input: SignSendInput): Promise<{ txHash: Hex }> {
  const chain = getKnownChain(input.chainId);
  if (!chain) throw new Error(`unknown chain ${input.chainId}`);
  const key = await readWalletKey(input.walletName);
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
  const key = await readWalletKey(walletName);
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
  const key = await readWalletKey(walletName);
  if (!key) throw new Error(`wallet ${walletName} not in keychain`);
  const normalized = (key.startsWith("0x") ? key : "0x" + key) as Hex;
  const account = privateKeyToAccount(normalized);
  const parsed = JSON.parse(json);
  const signature = await account.signTypedData(parsed);
  await logAudit("message_signed", { walletName, kind: "eth_signTypedData_v4" });
  return { signature };
}
