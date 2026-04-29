interface TokenSecurityRaw {
  is_honeypot?: string;
  honeypot_with_same_creator?: string;
  is_blacklisted?: string;
  is_whitelisted?: string;
  trust_list?: string;
  is_proxy?: string;
  is_open_source?: string;
  cannot_buy?: string;
  cannot_sell_all?: string;
  buy_tax?: string;
  sell_tax?: string;
  fake_token?: { value?: number };
}

export interface TokenSecurity {
  honeypot: boolean;
  blacklisted: boolean;
  trusted: boolean;
  proxy: boolean;
  openSource: boolean;
  cannotBuy: boolean;
  cannotSellAll: boolean;
  buyTax: number | null;
  sellTax: number | null;
  fakeToken: boolean;
}

function flag(v?: string): boolean {
  return v === "1";
}

function num(v?: string): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function tokenSecurity(chainId: number, contract: string): Promise<TokenSecurity | null> {
  const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${contract.toLowerCase()}`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const json = (await resp.json()) as { result?: Record<string, TokenSecurityRaw> };
  const entry = json.result?.[contract.toLowerCase()];
  if (!entry) return null;
  return {
    honeypot: flag(entry.is_honeypot),
    blacklisted: flag(entry.is_blacklisted),
    trusted: flag(entry.trust_list),
    proxy: flag(entry.is_proxy),
    openSource: flag(entry.is_open_source),
    cannotBuy: flag(entry.cannot_buy),
    cannotSellAll: flag(entry.cannot_sell_all),
    buyTax: num(entry.buy_tax),
    sellTax: num(entry.sell_tax),
    fakeToken: (entry.fake_token?.value ?? 0) > 0,
  };
}

export interface AddressSecurity {
  cybercrime: boolean;
  moneyLaundering: boolean;
  phishingActivities: boolean;
  blackmail: boolean;
  stealingAttack: boolean;
  sanctioned: boolean;
  honeypotRelated: boolean;
}

export async function addressSecurity(address: string, chainId = 1): Promise<AddressSecurity | null> {
  const url = `https://api.gopluslabs.io/api/v1/address_security/${address.toLowerCase()}?chain_id=${chainId}`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const json = (await resp.json()) as { result?: Record<string, string> };
  const r = json.result;
  if (!r) return null;
  const f = (k: string) => r[k] === "1";
  return {
    cybercrime: f("cybercrime"),
    moneyLaundering: f("money_laundering"),
    phishingActivities: f("phishing_activities"),
    blackmail: f("blackmail_activities"),
    stealingAttack: f("stealing_attack"),
    sanctioned: f("sanctioned"),
    honeypotRelated: f("honeypot_related_address"),
  };
}
