import { formatUnits } from "viem";
import type { Address, Portfolio, PortfolioToken } from "./types.ts";
import { getKnownChain, isTestnet, listHotChains, mergeChains } from "./chains.ts";
import { nativeBalance, tokenBalances, getSpamContracts } from "./balance.ts";
import { priceByAddressBatch, priceBySymbol } from "./prices.ts";

export async function buildPortfolio(walletName: string, chainId: number, address: Address): Promise<Portfolio> {
  const chain = getKnownChain(chainId);
  if (!chain) throw new Error(`unknown chain ${chainId}`);
  const [nativeBal, tokens, spam, nativePrice] = await Promise.all([
    nativeBalance(chainId, address),
    tokenBalances(chainId, address).catch(() => [] as PortfolioToken[]),
    getSpamContracts(chainId),
    priceBySymbol(chain.symbol),
  ]);
  const native: PortfolioToken = {
    token: "native",
    symbol: chain.symbol,
    decimals: 18,
    balance: nativeBal.toString(),
    usd: nativePrice ? Number(formatUnits(nativeBal, 18)) * nativePrice : undefined,
  };
  // Single batched price call for all non-spam tokens (max 25 per HTTP request,
  // chunked internally) instead of one HTTP call per token. Spam contracts are
  // skipped entirely since we know they have no price.
  const priceTargets = tokens
    .filter((t): t is PortfolioToken & { token: Address } => t.token !== "native" && !spam.has(t.token.toLowerCase()))
    .map((t) => t.token);
  const priceMap = await priceByAddressBatch(chainId, priceTargets);
  const enriched = tokens.map((t) => {
    if (t.token === "native") return t;
    const isSpam = spam.has(t.token.toLowerCase());
    const p = isSpam ? null : priceMap.get(t.token.toLowerCase()) ?? null;
    const decimal = Number(formatUnits(BigInt(t.balance), t.decimals));
    return {
      ...t,
      usd: p ? decimal * p : undefined,
      spam: isSpam,
      // No-USD tokens that aren't on the spam list still get an "unverified"
      // tag so they're visible but visually de-prioritized in the TUI.
      unverified: !isSpam && !p,
    };
  });
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

export interface AllChainsPortfolioError {
  chainId: number;
  name: string;
  error: string;
}

export interface AllChainsPortfolio {
  walletName: string;
  address: Address;
  mainnetTotalUsd: number;
  chains: Portfolio[];
  testnets: Portfolio[];
  errors: AllChainsPortfolioError[];
}

export async function buildPortfolioAll(walletName: string, address: Address): Promise<AllChainsPortfolio> {
  const chains = mergeChains(listHotChains());

  const settled = await Promise.allSettled(
    chains.map((c) => buildPortfolio(walletName, c.id, address)),
  );

  const okMainnet: Portfolio[] = [];
  const okTestnet: Portfolio[] = [];
  const errors: AllChainsPortfolioError[] = [];

  settled.forEach((res, i) => {
    const chain = chains[i]!;
    if (res.status === "fulfilled") {
      const p = res.value;
      if (isTestnet(chain)) {
        // Strip native USD on testnets: priceBySymbol returns real ETH price for
        // Sepolia ETH (and similar), which would inflate a balance with no real
        // monetary value. Token prices are already null on testnets via Alchemy.
        const stripped: Portfolio = {
          ...p,
          tokens: p.tokens.map((t) =>
            t.token === "native" ? { ...t, usd: undefined, pct: 0 } : t,
          ),
          totalUsd: 0,
        };
        okTestnet.push(stripped);
      } else {
        okMainnet.push(p);
      }
    } else {
      const reason = res.reason instanceof Error ? res.reason.message : String(res.reason);
      errors.push({ chainId: chain.id, name: chain.name, error: reason });
    }
  });

  okMainnet.sort((a, b) => b.totalUsd - a.totalUsd);
  const nameByChainId = new Map(chains.map((c) => [c.id, c.name]));
  okTestnet.sort((a, b) =>
    (nameByChainId.get(a.chainId) ?? "").localeCompare(nameByChainId.get(b.chainId) ?? ""),
  );

  const mainnetTotalUsd = okMainnet.reduce((sum, p) => sum + p.totalUsd, 0);

  return {
    walletName,
    address,
    mainnetTotalUsd,
    chains: okMainnet,
    testnets: okTestnet,
    errors,
  };
}
