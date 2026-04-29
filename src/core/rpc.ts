import { createPublicClient, http, defineChain, type Chain, type PublicClient } from "viem";
import {
  mainnet,
  base,
  arbitrum,
  bsc,
  sepolia,
} from "viem/chains";
import type { KuraChainConfig } from "./types.ts";
import { resolveRpcUrl, getKnownChain } from "./chains.ts";
import { readAlchemyKey } from "./keychain.ts";

const VIEM_BUILTIN: Record<number, Chain> = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
  56: bsc,
  11155111: sepolia,
};

function chainToViem(chain: KuraChainConfig, rpcUrl: string): Chain {
  const builtin = VIEM_BUILTIN[chain.id];
  if (builtin) {
    return {
      ...builtin,
      rpcUrls: { default: { http: [rpcUrl] }, public: { http: [rpcUrl] } },
    };
  }
  return defineChain({
    id: chain.id,
    name: chain.name,
    nativeCurrency: { name: chain.symbol, symbol: chain.symbol, decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] }, public: { http: [rpcUrl] } },
    blockExplorers: chain.explorer ? { default: { name: chain.name, url: chain.explorer } } : undefined,
  });
}

const clientCache = new Map<number, PublicClient>();
let alchemyKeyCache: string | null = null;

async function getAlchemyKey(): Promise<string> {
  if (!alchemyKeyCache) alchemyKeyCache = await readAlchemyKey();
  return alchemyKeyCache;
}

export async function getClient(chainId: number): Promise<PublicClient> {
  const cached = clientCache.get(chainId);
  if (cached) return cached;
  const chain = getKnownChain(chainId);
  if (!chain) throw new Error(`unknown chain ${chainId}`);
  const key = await getAlchemyKey();
  const url = resolveRpcUrl(chain, key);
  const viemChain = chainToViem(chain, url);
  const client = createPublicClient({ chain: viemChain, transport: http(url) }) as PublicClient;
  clientCache.set(chainId, client);
  return client;
}

export function clearClientCache(): void {
  clientCache.clear();
  alchemyKeyCache = null;
}
