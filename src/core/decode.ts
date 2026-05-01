import type { Address, DecodedCall, Hex } from "./types.ts";
import { getClient } from "./rpc.ts";
import { withTimeout } from "./promise.ts";

const REGISTRY: Address = "0x44691B39d1a75dC4E0A0346CBB15E310e6ED1E86";
const ENTRIES_SELECTOR: Hex = "0x019b417a";
const OPENCHAIN_LOOKUP = "https://api.openchain.xyz/signature-database/v1/lookup";

const cache = new Map<string, string>();

export function selectorOf(calldata: Hex): Hex {
  return calldata.slice(0, 10) as Hex;
}

export async function lookupSignature(selector: Hex): Promise<string | null> {
  if (cache.has(selector)) return cache.get(selector)!;
  const oc = await lookupOpenchain(selector);
  if (oc) {
    cache.set(selector, oc);
    return oc;
  }
  const parity = await lookupParity(selector);
  if (parity) cache.set(selector, parity);
  return parity;
}

async function lookupOpenchain(selector: Hex): Promise<string | null> {
  try {
    const resp = await withTimeout(fetch(`${OPENCHAIN_LOOKUP}?function=${selector}`), 1000, "openchain timeout");
    if (!resp.ok) return null;
    const j = (await resp.json()) as {
      ok?: boolean;
      result?: { function?: Record<string, { name: string }[]> };
    };
    const matches = j.result?.function?.[selector];
    if (!matches || matches.length === 0) return null;
    return matches[0]!.name;
  } catch {
    return null;
  }
}

async function lookupParity(selector: Hex): Promise<string | null> {
  try {
    const client = await getClient(1);
    const padded = selector.slice(2).padEnd(64, "0");
    const data = (ENTRIES_SELECTOR + padded) as Hex;
    const ret = await client.call({ to: REGISTRY, data });
    if (!ret.data || ret.data === "0x") return null;
    return decodeStringReturn(ret.data as Hex);
  } catch {
    return null;
  }
}

function decodeStringReturn(hex: Hex): string | null {
  const body = hex.slice(2);
  if (body.length < 128) return null;
  const offset = parseInt(body.slice(0, 64), 16);
  const lenStart = offset * 2;
  const len = parseInt(body.slice(lenStart, lenStart + 64), 16);
  if (!len) return null;
  const dataStart = lenStart + 64;
  const dataHex = body.slice(dataStart, dataStart + len * 2);
  try {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = parseInt(dataHex.slice(i * 2, i * 2 + 2), 16);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export async function decodeCalldata(to: Address | null, data: Hex): Promise<DecodedCall> {
  if (!data || data.length < 10) {
    return { selector: "0x" as Hex, contract: to ?? undefined };
  }
  const selector = selectorOf(data);
  const signature = await lookupSignature(selector);
  return { selector, signature: signature ?? undefined, contract: to ?? undefined };
}
