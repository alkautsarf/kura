import type { BalanceDiff, SimulationResult, Address } from "./types.ts";
import { readTenderlyKey } from "./keychain.ts";
import { withTimeout } from "./promise.ts";
import { getTokenMeta } from "./token-meta.ts";

export interface SimInput {
  chainId: number;
  from: string;
  to: string | null;
  data: string;
  value?: string;
  gas?: string;
}

export interface SimConfig {
  account?: string;
  project?: string;
}

let creds: { account: string; project: string; key: string } | null = null;

async function loadCreds(cfg: SimConfig = {}): Promise<typeof creds> {
  if (creds) return creds;
  let account = cfg.account ?? process.env.TENDERLY_USER ?? process.env.TENDERLY_ACCOUNT;
  let project = cfg.project ?? process.env.TENDERLY_PROJECT;
  if (!account || !project) {
    const { getConfig } = await import("./config.ts");
    const k = await getConfig();
    account = account ?? k.tenderlyAccount;
    project = project ?? k.tenderlyProject;
  }
  if (!account || !project) return null;
  const key = await readTenderlyKey();
  creds = { account, project, key };
  return creds;
}

export async function simulate(input: SimInput, cfg: SimConfig = {}): Promise<SimulationResult> {
  const c = await loadCreds(cfg);
  if (!c) {
    return {
      ok: false,
      reason: "tenderly account/project not configured",
      diffs: [],
    };
  }
  const url = `https://api.tenderly.co/api/v1/account/${c.account}/project/${c.project}/simulate`;
  const body = {
    network_id: String(input.chainId),
    from: input.from,
    to: input.to,
    input: input.data,
    value: input.value ?? "0",
    gas: input.gas ? Number(input.gas) : 8_000_000,
    gas_price: "0",
    save: false,
    save_if_fails: false,
    // "full" mode populates asset_changes (predicted balance diffs in/out per
    // token) which is what makes opaque router calls (Uniswap Universal Router
    // execute(), 1inch swap, etc.) actually readable in the popup. "quick"
    // mode skips asset_changes entirely, leaving "no balance diffs predicted"
    // for the very calls that need them most.
    simulation_type: "full",
  };
  let resp: Response;
  try {
    resp = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Access-Key": c.key,
        },
        body: JSON.stringify(body),
      }),
      // Full simulation_type is slow — Uniswap V4 Universal Router swaps can
      // take 10-12s for Tenderly to fully trace. 15s caps the wait while still
      // being responsive enough for the popup to land in time.
      15000,
      "tenderly timeout",
    );
  } catch (err) {
    return { ok: false, reason: (err as Error).message, diffs: [] };
  }
  if (!resp.ok) {
    return {
      ok: false,
      reason: `tenderly ${resp.status} ${resp.statusText}`,
      diffs: [],
    };
  }
  const json = (await resp.json()) as TenderlyResponse;
  const tx = json.transaction;
  const ok = tx?.status === true && (json.simulation?.status ?? true);
  let diffs: BalanceDiff[] = (json.asset_changes ?? []).map((ac) => ({
    token: ac.token_info?.contract_address ?? "native",
    symbol: ac.token_info?.symbol ?? "?",
    decimals: ac.token_info?.decimals ?? 18,
    delta: ac.raw_amount ?? ac.amount ?? "0",
    usd: ac.dollar_value ? Number(ac.dollar_value) : undefined,
  }));
  // Tenderly's asset_changes is empty for many opaque router calls (Uniswap
  // V4 Universal Router, custom Permit2 flows, etc.) even in "full" mode.
  // Fall back to parsing ERC20 Transfer events from the simulation logs and
  // aggregating per-token deltas where the user is sender or recipient.
  if (ok && diffs.length === 0) {
    diffs = await diffsFromLogs(input.chainId, input.from as Address, json);
  }
  return {
    ok,
    reason: tx?.error_message,
    gasUsed: tx?.gas_used !== undefined ? String(tx.gas_used) : undefined,
    diffs,
    raw: json,
  };
}

interface TenderlyLog {
  raw?: { address?: string; topics?: string[]; data?: string };
  name?: string;
}

interface TenderlyBalanceDiff {
  address?: string;
  original?: string;
  dirty?: string;
  is_miner?: boolean;
}

interface TenderlyResponse {
  transaction?: {
    status?: boolean;
    gas_used?: number;
    error_message?: string;
    transaction_info?: { logs?: TenderlyLog[]; balance_diff?: TenderlyBalanceDiff[] };
  };
  simulation?: { status?: boolean };
  asset_changes?: Array<{
    token_info?: { contract_address?: string; symbol?: string; decimals?: number };
    raw_amount?: string;
    amount?: string;
    type?: string;
    dollar_value?: string;
  }>;
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function diffsFromLogs(chainId: number, user: Address, json: TenderlyResponse): Promise<BalanceDiff[]> {
  const logs = json.transaction?.transaction_info?.logs ?? [];
  const me = user.toLowerCase();
  // Aggregate per-token signed delta (positive = received, negative = sent).
  const perToken = new Map<string, bigint>();
  for (const log of logs) {
    const raw = log.raw;
    if (!raw?.topics || raw.topics.length < 3) continue;
    if (raw.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const token = raw.address?.toLowerCase();
    if (!token) continue;
    const fromAddr = "0x" + raw.topics[1]!.slice(-40).toLowerCase();
    const toAddr = "0x" + raw.topics[2]!.slice(-40).toLowerCase();
    const amount = raw.data && raw.data !== "0x" ? BigInt(raw.data) : 0n;
    let delta = 0n;
    if (fromAddr === me) delta -= amount;
    if (toAddr === me) delta += amount;
    if (delta === 0n) continue;
    perToken.set(token, (perToken.get(token) ?? 0n) + delta);
  }
  // Resolve token meta in parallel
  const tokenDiffs: BalanceDiff[] = await Promise.all(
    Array.from(perToken.entries()).map(async ([token, delta]) => {
      const meta = await getTokenMeta(chainId, token as Address).catch(() => null);
      return {
        token,
        symbol: meta?.symbol ?? "?",
        decimals: meta?.decimals ?? 18,
        delta: delta.toString(),
      };
    }),
  );
  // Native ETH balance change. ETH receipts via low-level transfer don't emit
  // Transfer logs, so the only way to know if a swap delivered ETH to the user
  // is Tenderly's `balance_diff[]`. Subtract gas cost is NOT done here because
  // sim runs at gas_price=0 (no fees deducted), so the diff is pure value flow.
  const balanceDiffs = json.transaction?.transaction_info?.balance_diff ?? [];
  for (const bd of balanceDiffs) {
    if (!bd.address || bd.is_miner) continue;
    if (bd.address.toLowerCase() !== me) continue;
    try {
      const orig = BigInt(bd.original ?? "0");
      const dirty = BigInt(bd.dirty ?? "0");
      const delta = dirty - orig;
      if (delta === 0n) continue;
      const meta = await getTokenMeta(chainId, "native").catch(() => null);
      tokenDiffs.push({
        token: "native",
        symbol: meta?.symbol ?? "ETH",
        decimals: 18,
        delta: delta.toString(),
      });
    } catch {
      // skip malformed
    }
  }
  return tokenDiffs;
}
