import { formatUnits } from "viem";
import type { Address, Portfolio, PortfolioToken } from "./types.ts";
import { getKnownChain } from "./chains.ts";
import { nativeBalance, tokenBalances } from "./balance.ts";
import { priceByAddress, priceBySymbol } from "./prices.ts";

export async function buildPortfolio(walletName: string, chainId: number, address: Address): Promise<Portfolio> {
  const chain = getKnownChain(chainId);
  if (!chain) throw new Error(`unknown chain ${chainId}`);
  const [nativeBal, tokens] = await Promise.all([
    nativeBalance(chainId, address),
    tokenBalances(chainId, address).catch(() => [] as PortfolioToken[]),
  ]);
  const nativePrice = await priceBySymbol(chain.symbol);
  const native: PortfolioToken = {
    token: "native",
    symbol: chain.symbol,
    decimals: 18,
    balance: nativeBal.toString(),
    usd: nativePrice ? Number(formatUnits(nativeBal, 18)) * nativePrice : undefined,
  };
  const enriched = await Promise.all(
    tokens.map(async (t) => {
      if (t.token === "native") return t;
      const p = await priceByAddress(chainId, t.token);
      const decimal = Number(formatUnits(BigInt(t.balance), t.decimals));
      return { ...t, usd: p ? decimal * p : undefined };
    }),
  );
  const all = [native, ...enriched];
  const totalUsd = all.reduce((sum, t) => sum + (t.usd ?? 0), 0);
  for (const t of all) {
    t.pct = totalUsd > 0 && t.usd ? (t.usd / totalUsd) * 100 : 0;
  }
  all.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  return {
    walletName,
    address,
    chainId,
    totalUsd,
    tokens: all,
  };
}
