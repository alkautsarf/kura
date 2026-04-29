import type { Address, RiskFinding, RiskLevel, RiskResult, SimulationResult } from "../types.ts";

export interface RiskContext {
  kind: "send" | "swap" | "approve" | "connect" | "sign" | "switch_chain" | "batch" | "other";
  chainId: number;
  from: Address;
  to: Address | null;
  data?: `0x${string}`;
  value?: string;
  origin?: string;
  amountUsd?: number;
  simulation?: SimulationResult;
  external?: {
    phishing?: "safe" | "blocked" | "fuzzy";
    dappVerified?: boolean;
    addressFlags?: string[];
    tokenFlags?: string[];
    spenderFlags?: string[];
    isUnlimitedApproval?: boolean;
    contractIsEoa?: boolean;
    contractVerified?: boolean;
  };
  config: {
    safeThresholdUsd: number;
    knownRecipients?: Set<string>;
  };
}

export type Rule = (ctx: RiskContext) => RiskFinding | null;

const LEVEL_RANK: Record<RiskLevel, number> = { safe: 0, review: 1, danger: 2 };

export function combine(findings: RiskFinding[]): RiskResult {
  let max: RiskLevel = "safe";
  for (const f of findings) {
    if (LEVEL_RANK[f.level] > LEVEL_RANK[max]) max = f.level;
  }
  return { level: max, findings };
}

export function evaluate(ctx: RiskContext, rules: Rule[]): RiskResult {
  const findings: RiskFinding[] = [];
  for (const rule of rules) {
    try {
      const f = rule(ctx);
      if (f) findings.push(f);
    } catch (err) {
      findings.push({
        id: "engine-error",
        level: "review",
        message: `rule failed: ${(err as Error).message}`,
      });
    }
  }
  return combine(findings);
}
