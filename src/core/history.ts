import type { ActivityItem, Address, Hex } from "./types.ts";
import { getKnownChain } from "./chains.ts";
import { readEnvioToken } from "./keychain.ts";
import { getTokenMeta, getContractLabel } from "./token-meta.ts";
import { describeTx } from "./decode-tx.ts";

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

interface QueryPage {
  blocks?: { number: number; timestamp?: string }[];
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
  const fromBlock = q.fromBlock ?? Math.max(0, await archiveHead(chain.hyperSyncUrl) - 200_000);
  const body = {
    from_block: fromBlock,
    to_block: q.toBlock,
    transactions: [
      { from: [q.address.toLowerCase()] },
      { to: [q.address.toLowerCase()] },
    ],
    logs: [
      { topics: [[TRANSFER_TOPIC], [padded]] },
      { topics: [[TRANSFER_TOPIC], [], [padded]] },
    ],
    field_selection: {
      transaction: ["hash", "block_number", "from", "to", "value", "input"],
      log: ["address", "topic0", "topic1", "topic2", "topic3", "data", "block_number", "transaction_hash", "log_index"],
    },
    join_mode: "JoinAll",
  };
  const resp = await fetch(`${chain.hyperSyncUrl}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`hypersync ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const json = (await resp.json()) as QueryResponse;
  const items: ActivityItem[] = [];
  const me = q.address.toLowerCase();
  const txs: RawTx[] = [];
  const logs: RawLog[] = [];
  for (const page of json.data ?? []) {
    if (page.transactions) txs.push(...page.transactions);
    if (page.logs) logs.push(...page.logs);
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
      timestamp: 0,
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
    const value = BigInt(log.data && log.data !== "0x" ? log.data : "0").toString();
    const direction: ActivityItem["direction"] =
      fromAddr.toLowerCase() === me ? "out" : "in";
    items.push({
      hash: (log.transaction_hash ?? "0x") as `0x${string}`,
      blockNumber: log.block_number ?? 0,
      timestamp: 0,
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
  // avoid blowing latency on long histories — anything beyond N renders raw.
  const sliced = items.slice(0, limit);
  await enrichItems(q.chainId, sliced, txs);
  return sliced;
}

async function enrichItems(chainId: number, items: ActivityItem[], txs: RawTx[]): Promise<void> {
  const txByHash = new Map<string, RawTx>();
  for (const tx of txs) {
    if (tx.hash) txByHash.set(tx.hash.toLowerCase(), tx);
  }
  await Promise.all(items.map(async (it) => {
    if (it.kind === "erc20" && it.token) {
      const meta = await getTokenMeta(chainId, it.token as Address).catch(() => null);
      if (meta) {
        it.symbol = meta.symbol;
        it.decimals = meta.decimals;
      }
      // Spam dust heuristic: incoming ERC20 with no resolvable metadata or
      // microscopic value (< 1 unit at the resolved decimals) is almost
      // always airdrop spam. Outgoing dust is the user's own tx, keep.
      if (it.direction === "in") {
        const dec = meta?.decimals ?? 18;
        const minUnit = 10n ** BigInt(Math.max(dec - 6, 0));
        try {
          if (BigInt(it.value) < minUnit) it.isDust = true;
        } catch {
          it.isDust = true;
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
        if (sem.token?.symbol) it.symbol = sem.token.symbol;
        if (sem.token?.decimals) it.decimals = sem.token.decimals;
      } else if (it.to) {
        const label = getContractLabel(chainId, it.to);
        if (label) it.description = `Call ${label}`;
      }
    }
  }));
}
