import { formatUnits } from "viem";
import type { Address, Portfolio, PortfolioToken } from "./types.ts";
import { getKnownChain } from "./chains.ts";
import { nativeBalance, tokenBalances, getSpamContracts } from "./balance.ts";
import { priceByAddress, priceBySymbol } from "./prices.ts";

export async function buildPortfolio(walletName: string, chainId: number, address: Address): Promise<Portfolio> {
  const chain = getKnownChain(chainId);
  if (!chain) throw new Error(`unknown chain ${chainId}`);
  const [nativeBal, tokens, spam] = await Promise.all([
    nativeBalance(chainId, address),
    tokenBalances(chainId, address).catch(() => [] as PortfolioToken[]),
    getSpamContracts(chainId),
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
      const isSpam = spam.has(t.token.toLowerCase());
      // Skip the price fetch entirely for known-spam contracts to save round-trips.
      const p = isSpam ? null : await priceByAddress(chainId, t.token);
      const decimal = Number(formatUnits(BigInt(t.balance), t.decimals));
      return {
        ...t,
        usd: p ? decimal * p : undefined,
        spam: isSpam,
        // No-USD tokens that aren't on the spam list still get an "unverified"
        // tag so they're visible but visually de-prioritized in the TUI.
        unverified: !isSpam && !p,
      };
    }),
  );
  const all = [native, ...enriched];
  const totalUsd = all.reduce((sum, t) => sum + (t.usd ?? 0), 0);
  for (const t of all) {
    t.pct = totalUsd > 0 && t.usd ? (t.usd / totalUsd) * 100 : 0;
  }
  all.sort((a, b) => {
    // Priced tokens first (descending USD), then unverified, then spam last.
    const score = (x: PortfolioToken) => (x.spam ? -2 : x.unverified ? -1 : x.usd ?? 0);
    return score(b) - score(a);
  });
  return {
    walletName,
    address,
    chainId,
    totalUsd,
    tokens: all,
  };
}
