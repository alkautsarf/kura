import type { Address, RiskResult, SimulationResult } from "../types.ts";
import { evaluate, type RiskContext } from "./engine.ts";
import { DEFAULT_RULES } from "./rules.ts";
import { tokenSecurity, addressSecurity } from "../goplus.ts";
import { checkOrigin } from "../phishing.ts";
import { lookupDapp } from "../dapps.ts";
import { getClient } from "../rpc.ts";
import { withTimeout } from "../promise.ts";

const MAX_UINT = 2n ** 256n - 1n;

interface AssessInput {
  kind: RiskContext["kind"];
  chainId: number;
  from: Address;
  to: Address | null;
  data?: `0x${string}`;
  value?: string;
  origin?: string;
  amountUsd?: number;
  simulation?: SimulationResult;
  config?: { safeThresholdUsd?: number; knownRecipients?: Set<string> };
}

export async function assess(input: AssessInput): Promise<RiskResult> {
  const external = await enrich(input);
  const ctx: RiskContext = {
    kind: input.kind,
    chainId: input.chainId,
    from: input.from,
    to: input.to,
    data: input.data,
    value: input.value,
    origin: input.origin,
    amountUsd: input.amountUsd,
    simulation: input.simulation,
    external,
    config: {
      safeThresholdUsd: input.config?.safeThresholdUsd ?? 100,
      knownRecipients: input.config?.knownRecipients,
    },
  };
  return evaluate(ctx, DEFAULT_RULES);
}

async function enrich(input: AssessInput): Promise<RiskContext["external"]> {
  const out: NonNullable<RiskContext["external"]> = {};
  if (input.origin) {
    try {
      out.phishing = await checkOrigin(new URL(input.origin.startsWith("http") ? input.origin : `https://${input.origin}`).hostname);
    } catch {
      out.phishing = "safe";
    }
    if (input.kind === "connect") {
      const dapp = await lookupDapp(input.origin);
      out.dappVerified = !!dapp;
    }
  }

  if (input.kind === "send" && input.to) {
    try {
      const sec = await addressSecurity(input.to, input.chainId);
      if (sec) {
        const flags = collectAddressFlags(sec);
        if (flags.length) out.addressFlags = flags;
      }
    } catch {
      // best effort
    }
  }

  if ((input.kind === "swap" || input.kind === "approve") && input.to) {
    try {
      const tok = await tokenSecurity(input.chainId, input.to);
      if (tok) {
        const flags = collectTokenFlags(tok);
        if (flags.length) out.tokenFlags = flags;
      }
    } catch {
      // best effort
    }
  }

  if (input.kind === "approve" && input.data) {
    out.isUnlimitedApproval = isMaxApproval(input.data);
  }

  if (input.kind === "approve" && input.to) {
    try {
      const client = await getClient(input.chainId);
      const code = await withTimeout(client.getCode({ address: input.to }), 1500, "getCode timeout");
      out.contractIsEoa = !code || code === "0x";
    } catch {
      // best effort
    }
  }

  return out;
}

function collectAddressFlags(sec: Awaited<ReturnType<typeof addressSecurity>>): string[] {
  if (!sec) return [];
  const out: string[] = [];
  if (sec.cybercrime) out.push("cybercrime");
  if (sec.moneyLaundering) out.push("money-laundering");
  if (sec.phishingActivities) out.push("phishing");
  if (sec.blackmail) out.push("blackmail");
  if (sec.stealingAttack) out.push("stealing");
  if (sec.sanctioned) out.push("sanctioned");
  if (sec.honeypotRelated) out.push("honeypot-related");
  return out;
}

function collectTokenFlags(tok: Awaited<ReturnType<typeof tokenSecurity>>): string[] {
  if (!tok) return [];
  const out: string[] = [];
  if (tok.honeypot) out.push("honeypot");
  if (tok.blacklisted) out.push("blacklisted");
  if (tok.fakeToken) out.push("fakeToken");
  if (tok.cannotSellAll) out.push("cannotSellAll");
  if (tok.cannotBuy) out.push("cannotBuy");
  if (!tok.openSource) out.push("not-open-source");
  if (tok.proxy) out.push("proxy");
  if ((tok.buyTax ?? 0) > 0.1) out.push(`buy-tax-${(tok.buyTax! * 100).toFixed(1)}%`);
  if ((tok.sellTax ?? 0) > 0.1) out.push(`sell-tax-${(tok.sellTax! * 100).toFixed(1)}%`);
  return out;
}

function isMaxApproval(data: `0x${string}`): boolean {
  if (!data || data.length < 138) return false;
  const amountHex = data.slice(74, 138);
  try {
    const amount = BigInt("0x" + amountHex);
    return amount === MAX_UINT;
  } catch {
    return false;
  }
}
