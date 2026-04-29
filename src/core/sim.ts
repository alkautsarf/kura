import type { BalanceDiff, SimulationResult } from "./types.ts";
import { readTenderlyKey } from "./keychain.ts";

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
    simulation_type: "quick",
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Access-Key": c.key,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    return {
      ok: false,
      reason: `tenderly ${resp.status} ${resp.statusText}`,
      diffs: [],
    };
  }
  const json = (await resp.json()) as {
    transaction?: { status?: boolean; gas_used?: number; error_message?: string };
    simulation?: { status?: boolean };
    asset_changes?: Array<{
      token_info?: { contract_address?: string; symbol?: string; decimals?: number };
      raw_amount?: string;
      amount?: string;
      type?: string;
      dollar_value?: string;
    }>;
  };
  const tx = json.transaction;
  const ok = tx?.status === true && (json.simulation?.status ?? true);
  const diffs: BalanceDiff[] = (json.asset_changes ?? []).map((ac) => ({
    token: ac.token_info?.contract_address ?? "native",
    symbol: ac.token_info?.symbol ?? "?",
    decimals: ac.token_info?.decimals ?? 18,
    delta: ac.raw_amount ?? ac.amount ?? "0",
    usd: ac.dollar_value ? Number(ac.dollar_value) : undefined,
  }));
  return {
    ok,
    reason: tx?.error_message,
    gasUsed: tx?.gas_used !== undefined ? String(tx.gas_used) : undefined,
    diffs,
    raw: json,
  };
}
