import type { Address, PortfolioToken } from "./types.ts";
import { getKnownChain } from "./chains.ts";
import { getClient } from "./rpc.ts";
import { readAlchemyKey } from "./keychain.ts";

let alchemyKey: string | null = null;
async function getKey(): Promise<string> {
  if (!alchemyKey) alchemyKey = await readAlchemyKey();
  return alchemyKey;
}

interface AlchemyBalance {
  contractAddress: string;
  tokenBalance: string;
  error?: string | null;
}

interface AlchemyMetadata {
  name?: string;
  symbol?: string;
  decimals?: number;
  logo?: string;
}

async function alchemyRpc<T>(chainId: number, method: string, params: unknown[]): Promise<T> {
  const chain = getKnownChain(chainId);
  if (!chain?.alchemyNetwork) throw new Error(`no alchemy network for chain ${chainId}`);
  const key = await getKey();
  const isTestnet = chain.alchemyNetwork.includes("sepolia") || chain.alchemyNetwork.includes("testnet");
  const url = isTestnet
    ? `https://${chain.alchemyNetwork}.g.alchemy.com/v2/${key}`
    : `https://${chain.alchemyNetwork}.g.alchemy.com/v2/${key}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!resp.ok) throw new Error(`alchemy ${method} ${resp.status}`);
  const json = (await resp.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`alchemy ${method}: ${json.error.message}`);
  return json.result as T;
}

// Cached per-chain spam contract set. Alchemy maintains a curated list of
// known spam tokens (airdrop scams, fake-USDC, etc.). We fetch once per
// process and use it to filter portfolio + activity rows.
const spamCache = new Map<number, Set<string>>();
export async function getSpamContracts(chainId: number): Promise<Set<string>> {
  const cached = spamCache.get(chainId);
  if (cached) return cached;
  try {
    const result = await alchemyRpc<string[]>(chainId, "alchemy_getSpamContracts", []);
    const set = new Set(result.map((a) => a.toLowerCase()));
    spamCache.set(chainId, set);
    return set;
  } catch {
    spamCache.set(chainId, new Set());
    return new Set();
  }
}

export async function nativeBalance(chainId: number, address: Address): Promise<bigint> {
  const client = await getClient(chainId);
  return client.getBalance({ address });
}

const MAX_TOKENS_WITH_METADATA = 30;

export async function tokenBalances(chainId: number, address: Address): Promise<PortfolioToken[]> {
  const result = await alchemyRpc<{ tokenBalances: AlchemyBalance[] }>(chainId, "alchemy_getTokenBalances", [address, "erc20"]);
  const nonZero = result.tokenBalances.filter((b) => b.tokenBalance && BigInt(b.tokenBalance) > 0n);
  nonZero.sort((a, b) => {
    const da = BigInt(a.tokenBalance);
    const db = BigInt(b.tokenBalance);
    return da > db ? -1 : da < db ? 1 : 0;
  });
  const top = nonZero.slice(0, MAX_TOKENS_WITH_METADATA);
  const tail = nonZero.slice(MAX_TOKENS_WITH_METADATA);
  const out: PortfolioToken[] = [];
  const concurrency = 3;
  for (let i = 0; i < top.length; i += concurrency) {
    const batch = top.slice(i, i + concurrency);
    const metas = await Promise.all(
      batch.map((b) =>
        alchemyRpc<AlchemyMetadata>(chainId, "alchemy_getTokenMetadata", [b.contractAddress]).catch(() => ({} as AlchemyMetadata)),
      ),
    );
    for (let j = 0; j < batch.length; j++) {
      const b = batch[j]!;
      const m = metas[j]!;
      out.push({
        token: b.contractAddress as Address,
        symbol: m.symbol ?? "?",
        decimals: m.decimals ?? 18,
        balance: BigInt(b.tokenBalance).toString(),
      });
    }
  }
  for (const b of tail) {
    out.push({ token: b.contractAddress as Address, symbol: "?", decimals: 18, balance: BigInt(b.tokenBalance).toString() });
  }
  return out;
}
