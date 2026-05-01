import { erc20Abi } from "viem";
import type { Address } from "./types.ts";
import { getKnownChain } from "./chains.ts";
import { getClient } from "./rpc.ts";
import { readAlchemyKey } from "./keychain.ts";
import { withTimeout } from "./promise.ts";

export interface TokenMeta {
  symbol: string;
  decimals: number;
  name?: string;
}

const NATIVE_PLACEHOLDER = "0x0000000000000000000000000000000000000000";
const META_CACHE = new Map<string, TokenMeta | null>();
const META_INFLIGHT = new Map<string, Promise<TokenMeta | null>>();

export async function getTokenMeta(
  chainId: number,
  address: Address | "native",
): Promise<TokenMeta | null> {
  if (address === "native" || address.toLowerCase() === NATIVE_PLACEHOLDER) {
    const chain = getKnownChain(chainId);
    if (!chain) return null;
    return { symbol: chain.symbol, decimals: 18, name: chain.name };
  }
  const key = `${chainId}:${address.toLowerCase()}`;
  if (META_CACHE.has(key)) return META_CACHE.get(key)!;
  const inflight = META_INFLIGHT.get(key);
  if (inflight) return inflight;
  const promise = (async () => {
    try {
      const result = (await alchemyMeta(chainId, address)) ?? (await onchainMeta(chainId, address));
      META_CACHE.set(key, result);
      return result;
    } finally {
      META_INFLIGHT.delete(key);
    }
  })();
  META_INFLIGHT.set(key, promise);
  return promise;
}

async function alchemyMeta(chainId: number, address: Address): Promise<TokenMeta | null> {
  const chain = getKnownChain(chainId);
  if (!chain?.alchemyNetwork) return null;
  try {
    const key = await readAlchemyKey();
    const url = `https://${chain.alchemyNetwork}.g.alchemy.com/v2/${key}`;
    const resp = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getTokenMetadata", params: [address] }),
      }),
      2000,
      "alchemy meta timeout",
    );
    if (!resp.ok) return null;
    const j = (await resp.json()) as { result?: { name?: string; symbol?: string; decimals?: number } };
    const r = j.result;
    if (!r || (r.symbol === undefined && r.decimals === undefined)) return null;
    return { symbol: r.symbol ?? "?", decimals: r.decimals ?? 18, name: r.name };
  } catch {
    return null;
  }
}

async function onchainMeta(chainId: number, address: Address): Promise<TokenMeta | null> {
  try {
    const client = await getClient(chainId);
    const [symbol, decimals] = await Promise.all([
      withTimeout(client.readContract({ address, abi: erc20Abi, functionName: "symbol" }), 1500, "symbol() timeout"),
      withTimeout(client.readContract({ address, abi: erc20Abi, functionName: "decimals" }), 1500, "decimals() timeout"),
    ]);
    return { symbol: String(symbol), decimals: Number(decimals) };
  } catch {
    return null;
  }
}

// Well-known contract labels. Address keys MUST be lowercase.
const SAME_ON_ALL_CHAINS: Record<string, string> = {
  "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2",
  "0x111111125421ca6dc452d289314280a0f8842a65": "1inch v6 Router",
  "0x1111111254eeb25477b68fb85ed929f73a960582": "1inch v5 Router",
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff": "0x ExchangeProxy",
  "0xdef171fe48cf0115b1d80b88dc8eab59176fee57": "Paraswap v5 Router",
};

const PER_CHAIN_LABELS: Record<number, Record<string, string>> = {
  1: {
    "0x66a9893cc07d91d95644aedd05d03f95e1dba8af": "Uniswap V4 Universal Router",
    "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": "Uniswap V3 Universal Router",
    "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap V3 SwapRouter",
    "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": "Uniswap V3 SwapRouter02",
    "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": "Uniswap V2 Router",
    "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": "Aave V3 Pool",
  },
  8453: {
    "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7": "Uniswap V4 Universal Router",
    "0x6ff5693b99212da76ad316178a184ab56d299b43": "Uniswap V3 Universal Router",
    "0x2626664c2603336e57b271c5c0b26f421741e481": "Uniswap V3 SwapRouter",
    "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be": "Relay Router",
    "0xa238dd80c259a72e81d7e4664a9801593f98d1c5": "Aave V3 Pool",
    "0x2dc7976dba4d9d6049f2e6dde2db1b8c19ebb5db": "Across SpokePool",
  },
  42161: {
    "0xa51afafe0263b40edaef0df8781ea9aa03e381a3": "Uniswap V4 Universal Router",
    "0x5e325eda8064b456f4781070c0738d849c824258": "Uniswap V3 Universal Router",
    "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap V3 SwapRouter",
    "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": "Uniswap V3 SwapRouter02",
    "0x794a61358d6845594f94dc1db02a252b5b4814ad": "Aave V3 Pool",
  },
  56: {
    "0x1906c1d672b88cd1b9ac7593301ca990f94eae07": "Uniswap V4 Universal Router",
    "0x4dae2f939acf50408e13d58534ff8c2776d45265": "Uniswap V3 Universal Router",
    "0x10ed43c718714eb63d5aa57b78b54704e256024e": "PancakeSwap V2 Router",
  },
};

export function getContractLabel(chainId: number, address: Address): string | null {
  const lower = address.toLowerCase();
  return SAME_ON_ALL_CHAINS[lower] ?? PER_CHAIN_LABELS[chainId]?.[lower] ?? null;
}

export function isPermit2(address: Address): boolean {
  return address.toLowerCase() === "0x000000000022d473030f116ddee9f6b43ac78ba3";
}

// Many "approve max" callers use whichever uint width matches the slot they're
// writing into: uint256 for ERC20.approve, uint160 for Permit2 PermitDetails,
// uint128/uint96 in some custom permit shapes. Treat any of these as
// "unlimited" so the popup + Touch ID don't render a 40-digit number.
const MAX_APPROVAL_WIDTHS = [256n, 160n, 128n, 96n].map((w) => 2n ** w - 1n);
export function isMaxApproval(amount: bigint): boolean {
  return MAX_APPROVAL_WIDTHS.includes(amount);
}
