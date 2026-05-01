import { readAlchemyKey } from "./keychain.ts";
import { getKnownChain } from "./chains.ts";

let key: string | null = null;
async function getKey(): Promise<string> {
  if (!key) key = await readAlchemyKey();
  return key;
}

interface PriceItem {
  symbol?: string;
  address?: string;
  network?: string;
  prices?: { value?: string; currency?: string }[];
}

interface PricesResp {
  data?: PriceItem[];
}

// Cache stores both hits (number) and misses (null) so we don't re-hit
// Alchemy for spam tokens with no price every refresh. Hits use a short TTL
// (prices move); misses use a longer TTL (no point asking again soon).
const cache = new Map<string, { usd: number | null; ts: number; ttl: number }>();
const HIT_TTL_MS = 5 * 60_000;   // 5 min, prices change but not by much
const MISS_TTL_MS = 30 * 60_000; // 30 min, no-price tokens stay no-price

function cacheGet(key: string): number | null | undefined {
  const v = cache.get(key);
  if (!v) return undefined;
  if (Date.now() - v.ts > v.ttl) {
    cache.delete(key);
    return undefined;
  }
  return v.usd;
}

function cachePut(key: string, usd: number | null): void {
  cache.set(key, { usd, ts: Date.now(), ttl: usd === null ? MISS_TTL_MS : HIT_TTL_MS });
}

export async function priceBySymbol(symbol: string): Promise<number | null> {
  const k = `sym:${symbol}`;
  const cached = cacheGet(k);
  if (cached !== undefined) return cached;
  try {
    const apiKey = await getKey();
    const resp = await fetch(`https://api.g.alchemy.com/prices/v1/${apiKey}/tokens/by-symbol?symbols=${encodeURIComponent(symbol)}`);
    if (!resp.ok) {
      // Cache the miss too so we don't hammer on rate-limit responses.
      cachePut(k, null);
      return null;
    }
    const j = (await resp.json()) as PricesResp;
    const usd = extractUsd(j);
    cachePut(k, usd);
    return usd;
  } catch {
    cachePut(k, null);
    return null;
  }
}

export async function priceByAddress(chainId: number, address: string): Promise<number | null> {
  const map = await priceByAddressBatch(chainId, [address]);
  return map.get(address.toLowerCase()) ?? null;
}

// Batch up to 25 addresses per Alchemy request. Caller can pass any number;
// we de-dup, split into chunks, run them in parallel, and merge results.
// Cached entries (hit or miss) are returned without an API call.
const MAX_BATCH = 25;
export async function priceByAddressBatch(chainId: number, addresses: string[]): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  const chain = getKnownChain(chainId);
  if (!chain?.alchemyNetwork) {
    for (const a of addresses) result.set(a.toLowerCase(), null);
    return result;
  }
  const network = chain.alchemyNetwork;
  // De-dup; serve cached first; collect remaining for batch fetch.
  const need: string[] = [];
  const seen = new Set<string>();
  for (const a of addresses) {
    const lc = a.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    const cached = cacheGet(`${chainId}:${lc}`);
    if (cached !== undefined) {
      result.set(lc, cached);
    } else {
      need.push(lc);
    }
  }
  if (need.length === 0) return result;
  const apiKey = await getKey();
  // Chunk into batches of 25 (Alchemy's documented limit).
  const chunks: string[][] = [];
  for (let i = 0; i < need.length; i += MAX_BATCH) chunks.push(need.slice(i, i + MAX_BATCH));
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const resp = await fetch(`https://api.g.alchemy.com/prices/v1/${apiKey}/tokens/by-address`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          addresses: chunk.map((address) => ({ network, address })),
        }),
      });
      if (!resp.ok) {
        // Negative-cache the whole chunk so we don't re-fetch under rate-limit.
        for (const lc of chunk) {
          cachePut(`${chainId}:${lc}`, null);
          result.set(lc, null);
        }
        return;
      }
      const j = (await resp.json()) as PricesResp;
      const byAddr = new Map<string, number | null>();
      for (const item of j.data ?? []) {
        if (!item.address) continue;
        const lc = item.address.toLowerCase();
        const usd = item.prices?.find((p) => (p.currency ?? "").toLowerCase() === "usd")?.value;
        const n = usd ? Number(usd) : NaN;
        byAddr.set(lc, Number.isFinite(n) ? n : null);
      }
      for (const lc of chunk) {
        const usd = byAddr.get(lc) ?? null;
        cachePut(`${chainId}:${lc}`, usd);
        result.set(lc, usd);
      }
    } catch {
      for (const lc of chunk) {
        cachePut(`${chainId}:${lc}`, null);
        result.set(lc, null);
      }
    }
  }));
  return result;
}

function extractUsd(j: PricesResp): number | null {
  const item = j.data?.[0];
  if (!item) return null;
  const usd = item.prices?.find((p) => (p.currency ?? "").toLowerCase() === "usd")?.value;
  if (!usd) return null;
  const n = Number(usd);
  return Number.isFinite(n) ? n : null;
}
