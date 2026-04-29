import type { Rule } from "./engine.ts";

export const ruleSimulationFails: Rule = (ctx) => {
  if (!ctx.simulation) return null;
  if (ctx.simulation.ok) return null;
  return {
    id: "sim-failed",
    level: "danger",
    message: `simulation failed${ctx.simulation.reason ? `: ${ctx.simulation.reason}` : ""}`,
    detail: { reason: ctx.simulation.reason },
  };
};

export const rulePhishingBlocked: Rule = (ctx) => {
  const v = ctx.external?.phishing;
  if (v === "blocked") {
    return {
      id: "phishing-blocked",
      level: "danger",
      message: `origin ${ctx.origin ?? "?"} on phishing blocklist`,
    };
  }
  if (v === "fuzzy") {
    return {
      id: "phishing-fuzzy",
      level: "review",
      message: `origin ${ctx.origin ?? "?"} matches phishing fuzzy list`,
    };
  }
  return null;
};

export const ruleAddressFlags: Rule = (ctx) => {
  const flags = ctx.external?.addressFlags;
  if (!flags || flags.length === 0) return null;
  return {
    id: "address-flagged",
    level: "danger",
    message: `recipient flagged: ${flags.join(", ")}`,
    detail: { flags },
  };
};

export const ruleTokenFlags: Rule = (ctx) => {
  const flags = ctx.external?.tokenFlags;
  if (!flags || flags.length === 0) return null;
  const dangerKeys = ["honeypot", "blacklisted", "fakeToken", "cannotSellAll"];
  const isDanger = flags.some((f) => dangerKeys.includes(f));
  return {
    id: "token-flagged",
    level: isDanger ? "danger" : "review",
    message: `token flagged: ${flags.join(", ")}`,
    detail: { flags },
  };
};

export const ruleSpenderFlags: Rule = (ctx) => {
  const flags = ctx.external?.spenderFlags;
  if (!flags || flags.length === 0) return null;
  return {
    id: "spender-flagged",
    level: "danger",
    message: `spender flagged: ${flags.join(", ")}`,
    detail: { flags },
  };
};

export const ruleApproveToEOA: Rule = (ctx) => {
  if (ctx.kind !== "approve") return null;
  if (ctx.external?.contractIsEoa) {
    return {
      id: "approve-to-eoa",
      level: "danger",
      message: "approving an EOA, not a contract",
    };
  }
  return null;
};

export const ruleUnlimitedApproval: Rule = (ctx) => {
  if (ctx.kind !== "approve") return null;
  if (!ctx.external?.isUnlimitedApproval) return null;
  return {
    id: "unlimited-approval",
    level: "review",
    message: "unlimited approval (max uint256)",
  };
};

export const ruleAmountAboveThreshold: Rule = (ctx) => {
  const usd = ctx.amountUsd;
  if (usd === undefined) return null;
  if (usd <= ctx.config.safeThresholdUsd) return null;
  return {
    id: "amount-above-threshold",
    level: "review",
    message: `amount $${usd.toFixed(2)} above safe threshold $${ctx.config.safeThresholdUsd}`,
  };
};

export const ruleNewRecipient: Rule = (ctx) => {
  if (ctx.kind !== "send") return null;
  if (!ctx.to) return null;
  if (ctx.config.knownRecipients?.has(ctx.to.toLowerCase())) return null;
  return {
    id: "new-recipient",
    level: "review",
    message: "first time sending to this address",
  };
};

export const ruleContractUnverified: Rule = (ctx) => {
  if (ctx.kind === "send") return null;
  if (ctx.external?.contractVerified === false) {
    return {
      id: "contract-unverified",
      level: "review",
      message: "contract source not verified",
    };
  }
  return null;
};

export const ruleDappNotVerified: Rule = (ctx) => {
  if (ctx.kind !== "connect") return null;
  if (ctx.external?.dappVerified) return null;
  return {
    id: "dapp-not-verified",
    level: "review",
    message: `${ctx.origin ?? "origin"} not in DefiLlama verified set`,
  };
};

export const DEFAULT_RULES: Rule[] = [
  ruleSimulationFails,
  rulePhishingBlocked,
  ruleAddressFlags,
  ruleTokenFlags,
  ruleSpenderFlags,
  ruleApproveToEOA,
  ruleUnlimitedApproval,
  ruleAmountAboveThreshold,
  ruleNewRecipient,
  ruleContractUnverified,
  ruleDappNotVerified,
];
