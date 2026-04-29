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
  prices?: { value?: string; currency?: string }[];
}

interface PricesResp {
  data?: PriceItem[];
}

const cache = new Map<string, { usd: number; ts: number }>();
const TTL_MS = 60_000;

export async function priceBySymbol(symbol: string): Promise<number | null> {
  const cached = cache.get(`sym:${symbol}`);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.usd;
  try {
    const k = await getKey();
    const resp = await fetch(`https://api.g.alchemy.com/prices/v1/${k}/tokens/by-symbol?symbols=${encodeURIComponent(symbol)}`);
    if (!resp.ok) return null;
    const j = (await resp.json()) as PricesResp;
    const usd = extractUsd(j);
    if (usd !== null) cache.set(`sym:${symbol}`, { usd, ts: Date.now() });
    return usd;
  } catch {
    return null;
  }
}

export async function priceByAddress(chainId: number, address: string): Promise<number | null> {
  const cached = cache.get(`${chainId}:${address.toLowerCase()}`);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.usd;
  const chain = getKnownChain(chainId);
  if (!chain?.alchemyNetwork) return null;
  try {
    const k = await getKey();
    const resp = await fetch(`https://api.g.alchemy.com/prices/v1/${k}/tokens/by-address`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        addresses: [{ network: chain.alchemyNetwork, address }],
      }),
    });
    if (!resp.ok) return null;
    const j = (await resp.json()) as PricesResp;
    const usd = extractUsd(j);
    if (usd !== null) cache.set(`${chainId}:${address.toLowerCase()}`, { usd, ts: Date.now() });
    return usd;
  } catch {
    return null;
  }
}

function extractUsd(j: PricesResp): number | null {
  const item = j.data?.[0];
  if (!item) return null;
  const usd = item.prices?.find((p) => (p.currency ?? "").toLowerCase() === "usd")?.value;
  if (!usd) return null;
  const n = Number(usd);
  return Number.isFinite(n) ? n : null;
}
