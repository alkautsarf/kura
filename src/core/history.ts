import type { ActivityItem, Address, Hex } from "./types.ts";
import { getKnownChain } from "./chains.ts";
import { readEnvioToken } from "./keychain.ts";
import { getTokenMeta, getContractLabel } from "./token-meta.ts";
import { describeTx } from "./decode-tx.ts";
import { fmtCompact } from "./format-amount.ts";
import { getSpamContracts } from "./balance.ts";
import { priceByAddressBatch } from "./prices.ts";
import { getClient } from "./rpc.ts";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface RawLog {
  address?: string;
  topic0?: string;
  topic1?: string;
  topic2?: string;
  topic3?: string;
  data?: string;
  block_number?: number;
  transaction_hash?: string;
  log_index?: number;
}

interface RawTx {
  hash?: string;
  block_number?: number;
  from?: string;
  to?: string;
  value?: string;
  input?: string;
}

interface RawBlock {
  number?: number;
  timestamp?: string;
}

interface QueryPage {
  blocks?: RawBlock[];
  logs?: RawLog[];
  transactions?: RawTx[];
}

interface QueryResponse {
  data?: QueryPage[];
  next_block?: number;
  archive_height?: number;
}

let cachedToken: string | null = null;
async function getToken(): Promise<string> {
  if (!cachedToken) cachedToken = await readEnvioToken();
  return cachedToken;
}

async function archiveHead(baseUrl: string): Promise<number> {
  try {
    const resp = await fetch(`${baseUrl}/height`);
    if (!resp.ok) return 0;
    const j = (await resp.json()) as { height?: number };
    return j.height ?? 0;
  } catch {
    return 0;
  }
}

function pad(addr: string): string {
  const a = addr.toLowerCase().replace(/^0x/, "");
  return "0x" + a.padStart(64, "0");
}

export interface HistoryQuery {
  chainId: number;
  address: Address;
  limit?: number;
  fromBlock?: number;
  toBlock?: number;
}

export async function fetchActivity(q: HistoryQuery): Promise<ActivityItem[]> {
  const chain = getKnownChain(q.chainId);
  if (!chain?.hyperSyncUrl) {
    throw new Error(`HyperSync URL not configured for chain ${q.chainId}`);
  }
  const token = await getToken();
  const limit = q.limit ?? 25;
  const padded = pad(q.address);
  // Default lookback: ~6 months on Base (2s blocks → 5M blocks ≈ 116 days),
  // ~6 months on Ethereum (12s blocks → 5M blocks ≈ 1.9 years). HyperSync
  // handles wide windows efficiently because it's index-based, not scan-based.
  const fromBlock = q.fromBlock ?? Math.max(0, await archiveHead(chain.hyperSyncUrl) - 5_000_000);
  const baseBody = {
    transactions: [
      { from: [q.address.toLowerCase()] },
      { to: [q.address.toLowerCase()] },
    ],
    logs: [
      { topics: [[TRANSFER_TOPIC], [padded]] },
      { topics: [[TRANSFER_TOPIC], [], [padded]] },
    ],
    field_selection: {
      block: ["number", "timestamp"],
      transaction: ["hash", "block_number", "from", "to", "value", "input"],
      log: ["address", "topic0", "topic1", "topic2", "topic3", "data", "block_number", "transaction_hash", "log_index"],
    },
    join_mode: "JoinAll",
  };

  const items: ActivityItem[] = [];
  const me = q.address.toLowerCase();
  const txs: RawTx[] = [];
  const logs: RawLog[] = [];
  const blockTs = new Map<number, number>();

  // HyperSync caps each response at ~5000 items. Universal Router swaps emit
  // hundreds of internal Transfer logs joined via JoinAll, so we need to
  // paginate by following next_block to capture all of the user's txs in the
  // window. Bound by MAX_PAGES so a super-active wallet can't blow latency.
  const MAX_PAGES = 12;
  let cursor = fromBlock;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = { ...baseBody, from_block: cursor, to_block: q.toBlock };
    const resp = await fetch(`${chain.hyperSyncUrl}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      if (page === 0) throw new Error(`hypersync ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      break; // partial result better than failing
    }
    const json = (await resp.json()) as QueryResponse;
    for (const p of json.data ?? []) {
      if (p.transactions) txs.push(...p.transactions);
      if (p.logs) logs.push(...p.logs);
      if (p.blocks) {
        for (const b of p.blocks) {
          if (b.number == null || !b.timestamp) continue;
          try { blockTs.set(b.number, Number(BigInt(b.timestamp)) * 1000); } catch { /* skip malformed */ }
        }
      }
    }
    const nextBlock = json.next_block;
    const archiveHeight = json.archive_height ?? 0;
    // Stop when next_block hasn't advanced (no more data in window) or has
    // caught up to the archive head (covered the chain).
    if (typeof nextBlock !== "number" || nextBlock <= cursor || nextBlock > archiveHeight) break;
    cursor = nextBlock;
  }
  // Track tx hashes that produced ERC20 logs so we can suppress the matching
  // raw `kind:contract` placeholder (the contract call IS the ERC20 transfer).
  const txWithErc20Logs = new Set<string>();
  for (const log of logs) {
    if (log.transaction_hash) txWithErc20Logs.add(log.transaction_hash.toLowerCase());
  }
  for (const tx of txs) {
    const from = (tx.from ?? "").toLowerCase();
    const to = (tx.to ?? "").toLowerCase();
    const direction: ActivityItem["direction"] =
      from === me && to === me ? "self" : from === me ? "out" : "in";
    const isContract = tx.input && tx.input.length > 2;
    // For incoming contract txs that produced an ERC20 transfer log to us,
    // the log row already represents the meaningful event. Skip the raw row.
    if (isContract && direction === "in" && tx.hash && txWithErc20Logs.has(tx.hash.toLowerCase())) {
      continue;
    }
    items.push({
      hash: (tx.hash ?? "0x") as `0x${string}`,
      blockNumber: tx.block_number ?? 0,
      timestamp: blockTs.get(tx.block_number ?? -1) ?? 0,
      from: (tx.from ?? "0x") as Address,
      to: tx.to ? (tx.to as Address) : null,
      value: tx.value ?? "0",
      direction,
      kind: isContract ? "contract" : "native",
    });
  }
  for (const log of logs) {
    if (!log.topic0 || !log.topic1 || !log.topic2) continue;
    const fromAddr = ("0x" + log.topic1.slice(-40)) as Address;
    const toAddr = ("0x" + log.topic2.slice(-40)) as Address;
    // HyperSync's join_mode:JoinAll returns ALL logs in any matched tx,
    // including ones where neither side is the user. Filter to user-related
    // transfers only , the rest are byproducts of router internals (Permit2
    // unlock, internal hop liquidity moves, etc) that the user shouldn't see.
    const fromIsMe = fromAddr.toLowerCase() === me;
    const toIsMe = toAddr.toLowerCase() === me;
    if (!fromIsMe && !toIsMe) continue;
    let value: string;
    try {
      const big = BigInt(log.data && log.data !== "0x" ? log.data : "0");
      // Reject obviously fake/scam Transfer events: V4 hooks and other
      // malicious contracts can emit Transfer to the user with absurd values
      // (10^300+) to spoof the in/out side of a swap. Anything > 10^36 raw
      // (1 trillion units even at 24 decimals) is not a real balance.
      if (big > 10n ** 36n) continue;
      value = big.toString();
    } catch { continue; }
    const direction: ActivityItem["direction"] = fromIsMe ? "out" : "in";
    items.push({
      hash: (log.transaction_hash ?? "0x") as `0x${string}`,
      blockNumber: log.block_number ?? 0,
      timestamp: blockTs.get(log.block_number ?? -1) ?? 0,
      from: fromAddr,
      to: toAddr,
      value,
      token: log.address,
      direction,
      kind: "erc20",
    });
  }
  items.sort((a, b) => b.blockNumber - a.blockNumber);
  // Enrich the top N items with semantic descriptions + token meta so the TUI
  // can show "approve USDC -> Permit2" instead of "0 ETH" / "tok". Capped to
  // avoid blowing latency on long histories , anything beyond N renders raw.
  const sliced = items.slice(0, limit);
  await enrichItems(q.chainId, sliced, txs);
  // Final pass: fold ERC20 log rows into outgoing contract rows so the user
  // sees one consolidated "Swap X for Y on Router" line instead of contract +
  // N transfer logs. Runs AFTER enrichItems so contract rows already have
  // their semantic baseline; we just upgrade the description with real diffs.
  return groupAndEnrich(q.chainId, sliced, me);
}

async function enrichItems(chainId: number, items: ActivityItem[], txs: RawTx[]): Promise<void> {
  const txByHash = new Map<string, RawTx>();
  for (const tx of txs) {
    if (tx.hash) txByHash.set(tx.hash.toLowerCase(), tx);
  }
  // Pre-collect incoming ERC20 tokens that are candidates for the no-price
  // spam check. Tokens on the Alchemy spam list and self-mints are already
  // obviously spam, no need to spend a price call on them.
  const candidateTokens = new Set<string>();
  for (const it of items) {
    if (it.kind === "erc20" && it.direction === "in" && it.token) {
      candidateTokens.add(it.token.toLowerCase());
    }
  }
  // Spam list + price batch are independent: kick them off in parallel. The
  // price batch may include tokens we'll later discover are on the spam list,
  // but priceByAddressBatch's miss-cache absorbs the extra cost.
  const [spam, priceMap] = await Promise.all([
    getSpamContracts(chainId).catch(() => new Set<string>()),
    candidateTokens.size > 0
      ? priceByAddressBatch(chainId, [...candidateTokens]).catch(() => new Map<string, number | null>())
      : Promise.resolve(new Map<string, number | null>()),
  ]);
  await Promise.all(items.map(async (it) => {
    if (it.kind === "erc20" && it.token) {
      const meta = await getTokenMeta(chainId, it.token as Address).catch(() => null);
      if (meta) {
        it.symbol = meta.symbol;
        it.decimals = meta.decimals;
      }
      // Spam filtering for incoming ERC20s. Four heuristics layered:
      //   1) Alchemy-known spam contract → isDust (airdrop spam)
      //   2) Token contract self-mints to user (from === token) → isDust
      //      (canonical spam pattern: scam tokens mint directly to victims)
      //   3) No USD price + has metadata → isDust (legit airdrops have prices,
      //      scams that go through the trouble of looking real don't trade)
      //   4) Microscopic value (< 1 unit at resolved decimals) → isDust
      // Outgoing transfers are the user's own tx , keep regardless.
      if (it.direction === "in") {
        const tokenLc = it.token.toLowerCase();
        if (spam.has(tokenLc)) {
          it.isDust = true;
        } else if (it.from.toLowerCase() === tokenLc) {
          it.isDust = true;
        } else {
          const dec = meta?.decimals ?? 18;
          const minUnit = 10n ** BigInt(Math.max(dec - 6, 0));
          try {
            if (BigInt(it.value) < minUnit) {
              it.isDust = true;
            } else if (meta) {
              // Has metadata but no USD price → likely spam airdrop wearing
              // a real-looking symbol. Lookup served from the pre-batched
              // priceMap above (one HTTP call covers all tokens).
              const px = priceMap.get(it.token.toLowerCase());
              if (px === null || px === undefined) it.isDust = true;
            }
          } catch {
            it.isDust = true;
          }
        }
      }
      return;
    }
    if (it.kind === "contract") {
      const tx = txByHash.get(it.hash.toLowerCase());
      const data = (tx?.input ?? "0x") as Hex;
      const sem = await describeTx({ chainId, to: it.to, data, value: it.value }).catch(() => null);
      if (sem) {
        it.description = sem.description;
        it.semanticKind = sem.kind;
        if (sem.token?.symbol) it.symbol = sem.token.symbol;
        if (sem.token?.decimals) it.decimals = sem.token.decimals;
      } else if (it.to) {
        const label = getContractLabel(chainId, it.to);
        if (label) it.description = `Call ${label}`;
        it.semanticKind = "contract";
      }
    }
  }));
}

// Fold ERC20 log rows into the outgoing contract row in the same tx so the
// user sees a single consolidated "Swap X TOKEN for Y TOKEN on Router" line.
// HyperSync gives us the on-chain Transfer logs after the fact, which we treat
// as the ground-truth balance diff (Tenderly equivalent at signing time, but
// retroactive). Skips:
//   - incoming contract rows (already deduped earlier; ERC20 log is the row)
//   - rows where describeTx already gave a specific description
//     (approve/transfer/etc , overwriting would hide the recipient/spender)
//   - native-only contract calls (no logs to fold)
//   - txs where both sides resolve to the same delta (self-transfers etc)
const GENERIC_KINDS = new Set(["execute", "multicall", "contract"]);
async function groupAndEnrich(chainId: number, items: ActivityItem[], me: string): Promise<ActivityItem[]> {
  // Group ERC20 log items by tx hash for fast lookup.
  const logsByTx = new Map<string, ActivityItem[]>();
  for (const it of items) {
    if (it.kind !== "erc20") continue;
    const k = it.hash.toLowerCase();
    const arr = logsByTx.get(k) ?? [];
    arr.push(it);
    logsByTx.set(k, arr);
  }
  const dropped = new Set<ActivityItem>();
  // Parallelize per-row processing so the per-tx balance-diff RPC calls
  // overlap. Each iteration only mutates its own `it` and adds to the shared
  // `dropped` Set; Set.add is sync and JS is single-threaded, so concurrent
  // adds are safe.
  await Promise.all(items.map(async (it) => {
    if (it.kind !== "contract" || it.direction !== "out") return;
    // For specific descriptions like "Transfer 0.5 USDC to 0xabc" or
    // "Approve unlimited USDC to Permit2", keep the description as-is but
    // STILL drop matching ERC20 log rows from the same tx, since they're
    // already represented in the description. Without this dedup, USDC.permit
    // and similar combo calls show as "Approve" + a duplicate raw log row.
    if (it.semanticKind && !GENERIC_KINDS.has(it.semanticKind)) {
      const sameTxLogs = logsByTx.get(it.hash.toLowerCase()) ?? [];
      for (const log of sameTxLogs) dropped.add(log);
      return;
    }
    const logs = logsByTx.get(it.hash.toLowerCase());
    if (!logs || logs.length === 0) return;
    // Aggregate signed delta per token from the user's perspective.
    const perToken = new Map<string, bigint>();
    for (const log of logs) {
      const fromMe = log.from.toLowerCase() === me;
      const toMe = (log.to ?? "").toLowerCase() === me;
      if (!fromMe && !toMe) continue;
      let delta = 0n;
      try {
        const v = BigInt(log.value);
        if (fromMe) delta -= v;
        if (toMe) delta += v;
      } catch { continue; }
      if (delta === 0n) continue;
      const key = (log.token ?? "").toLowerCase();
      perToken.set(key, (perToken.get(key) ?? 0n) + delta);
    }
    // Native ETH outflow attached to the contract call (eg ETH-to-token swap)
    // doesn't appear in Transfer logs but lives in tx.value. Treat it as a
    // synthetic OUT side so V4 ETH->token swaps render as "Swap" not "Receive".
    let nativeOut = 0n;
    try {
      const v = it.value && it.value !== "0x" ? BigInt(it.value) : 0n;
      if (v > 0n) nativeOut = v;
    } catch { /* skip */ }
    if (perToken.size === 0 && nativeOut === 0n) return;
    // Pre-fetch token meta for all involved tokens so we can prefer tokens
    // WITH known metadata when picking the OUT/IN side. This defends against
    // V4 hook scams that inject Transfer events for a fake "token" (no meta)
    // alongside the real token (USDC etc). Picking the largest-delta token
    // would otherwise label a real swap as "Swap X for HUGE_SCAM".
    const metaByToken = new Map<string, { symbol: string; decimals: number } | null>();
    await Promise.all([...perToken.keys()].map(async (k) => {
      const m = await getTokenMeta(chainId, k as Address).catch(() => null);
      metaByToken.set(k, m ? { symbol: m.symbol, decimals: m.decimals } : null);
    }));
    const isReal = (k: string) => metaByToken.get(k) !== null;
    // Find the largest-magnitude OUT and IN side, preferring known tokens.
    let outKey: string | null = null, outDelta = 0n;
    let inKey: string | null = null, inDelta = 0n;
    for (const [k, d] of perToken) {
      if (d < 0n) {
        const better = outKey === null
          || (isReal(k) && !isReal(outKey))
          || (isReal(k) === isReal(outKey) && d < outDelta);
        if (better) { outKey = k; outDelta = d; }
      }
      if (d > 0n) {
        const better = inKey === null
          || (isReal(k) && !isReal(inKey))
          || (isReal(k) === isReal(inKey) && d > inDelta);
        if (better) { inKey = k; inDelta = d; }
      }
    }
    // If the chosen side is unknown (no meta), drop it , better to fall back
    // to a one-sided "Swap X via Router" than show a meaningless huge number.
    if (outKey && !isReal(outKey)) { outKey = null; outDelta = 0n; }
    if (inKey && !isReal(inKey)) { inKey = null; inDelta = 0n; }
    const venue = getContractLabel(chainId, it.to!) ?? null;
    const venueSuffix = venue ? ` on ${venue}` : "";
    // A router-labeled venue means the user's intent was a swap, even if we
    // can only see one side of the trade in logs (the receipt may have come
    // back via internal call , common for Relay, 1inch with native ETH, etc.).
    // Label outflow-only as "Swap" instead of "Send" in that case.
    const isRouterVenue = !!venue && /router|swap|aggregator/i.test(venue);
    const chain = getKnownChain(chainId);
    const nativeSym = chain?.symbol ?? "ETH";
    // V4 router USDC→ETH (and similar) unwraps WETH and sends ETH to the user
    // via internal call , no Transfer log we can see. To recover the receipt
    // amount, query the user's native balance at blockN vs blockN-1. Only do
    // this when we have a clear "missing IN side on a router swap" pattern
    // to avoid extra RPC for non-swap calls.
    let nativeIn = 0n;
    if (outKey && !inKey && nativeOut === 0n && isRouterVenue) {
      try {
        const client = await getClient(chainId);
        const blockNum = BigInt(it.blockNumber);
        const [before, after] = await Promise.all([
          client.getBalance({ address: me as Address, blockNumber: blockNum - 1n }),
          client.getBalance({ address: me as Address, blockNumber: blockNum }),
        ]);
        const diff = after - before;
        // Positive diff = received ETH (gas paid is small on L2, accept the
        // few-thousand-wei skew rather than spending a getTransactionReceipt
        // call to subtract it precisely).
        if (diff > 0n) nativeIn = diff;
      } catch { /* historical state unavailable; fall through */ }
    }
    const nativeInStr = nativeIn > 0n ? `${fmtCompact(nativeIn.toString(), 18)} ${nativeSym}` : null;
    const fmtSide = (key: string, raw: bigint): string => {
      const meta = metaByToken.get(key);
      const symbol = meta?.symbol ?? "?";
      const decimals = meta?.decimals ?? 18;
      const abs = raw < 0n ? -raw : raw;
      return `${fmtCompact(abs.toString(), decimals)} ${symbol}`;
    };
    const nativeStr = nativeOut > 0n ? `${fmtCompact(nativeOut.toString(), 18)} ${nativeSym}` : null;
    if (outKey && inKey) {
      it.description = `Swap ${fmtSide(outKey, outDelta)} for ${fmtSide(inKey, inDelta)}${venueSuffix}`;
      for (const log of logs) {
        const key = (log.token ?? "").toLowerCase();
        if (key === outKey || key === inKey) dropped.add(log);
      }
    } else if (nativeStr && inKey) {
      // Native ETH -> ERC20 (V4 router style)
      it.description = `Swap ${nativeStr} for ${fmtSide(inKey, inDelta)}${venueSuffix}`;
      for (const log of logs) if ((log.token ?? "").toLowerCase() === inKey) dropped.add(log);
    } else if (outKey && nativeStr) {
      // Unusual: user sent both ERC20 + ETH to the contract; surface both.
      it.description = `Send ${fmtSide(outKey, outDelta)} + ${nativeStr}${venueSuffix}`;
      for (const log of logs) if ((log.token ?? "").toLowerCase() === outKey) dropped.add(log);
    } else if (outKey && nativeInStr) {
      // Common V4 case: swap USDC->ETH where the receipt is via internal call,
      // recovered via the balance-diff query above.
      it.description = `Swap ${fmtSide(outKey, outDelta)} for ${nativeInStr}${venueSuffix}`;
      for (const log of logs) if ((log.token ?? "").toLowerCase() === outKey) dropped.add(log);
    } else if (outKey) {
      const outStr = fmtSide(outKey, outDelta);
      it.description = isRouterVenue
        ? `Swap ${outStr}${venueSuffix}`
        : `Send ${outStr}${venueSuffix}`;
      for (const log of logs) if ((log.token ?? "").toLowerCase() === outKey) dropped.add(log);
    } else if (inKey) {
      // ERC20 inflow only (no outflow we can see), likely a withdraw/claim.
      const inStr = fmtSide(inKey, inDelta);
      it.description = isRouterVenue
        ? `Swap for ${inStr}${venueSuffix}`
        : `Receive ${inStr}${venueSuffix}`;
      for (const log of logs) if ((log.token ?? "").toLowerCase() === inKey) dropped.add(log);
    } else if (nativeStr) {
      // Plain native send to a contract (no logs)
      it.description = isRouterVenue
        ? `Swap ${nativeStr}${venueSuffix}`
        : `Send ${nativeStr}${venueSuffix}`;
    }
  }));
  return dropped.size === 0 ? items : items.filter((it) => !dropped.has(it));
}
