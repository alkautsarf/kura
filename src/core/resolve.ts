import { isAddress, namehash } from "viem";
import type { Address, Hex } from "./types.ts";
import { getClient } from "./rpc.ts";

const ENS_UNIVERSAL_RESOLVER: Address = "0xce01f8eee7E479C928F8919abD53E553a36CeF67";
const BASENAME_REGISTRY: Address = "0xB94704422c2a1E396835A571837Aa5AE53285a95";

export interface ResolvedName {
  input: string;
  address: Address | null;
  source: "address" | "ens" | "basename" | "attn" | "none";
}

export async function resolve(input: string): Promise<ResolvedName> {
  const trimmed = input.trim();
  if (isAddress(trimmed)) {
    return { input, address: trimmed as Address, source: "address" };
  }
  if (trimmed.endsWith(".attn")) {
    const a = await resolveAttn(trimmed);
    return { input, address: a, source: a ? "attn" : "none" };
  }
  if (trimmed.endsWith(".base.eth") || trimmed.endsWith(".basetest.eth")) {
    const a = await resolveBase(trimmed);
    if (a) return { input, address: a, source: "basename" };
  }
  if (trimmed.endsWith(".eth") || trimmed.includes(".")) {
    const a = await resolveEns(trimmed);
    if (a) return { input, address: a, source: "ens" };
  }
  return { input, address: null, source: "none" };
}

async function resolveEns(name: string): Promise<Address | null> {
  try {
    const client = await getClient(1);
    const node = namehash(name);
    const result = await client.readContract({
      address: ENS_UNIVERSAL_RESOLVER,
      abi: [{
        name: "resolve",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "name", type: "bytes" }, { name: "data", type: "bytes" }],
        outputs: [{ type: "bytes" }, { type: "address" }],
      }],
      functionName: "resolve",
      args: [encodeDnsName(name), encodeAddrCall(node)],
    }) as readonly [Hex, Address];
    const addr = decodeAddrReturn(result[0]);
    return addr && addr !== "0x0000000000000000000000000000000000000000" ? addr : null;
  } catch {
    return null;
  }
}

async function resolveBase(name: string): Promise<Address | null> {
  try {
    const client = await getClient(8453);
    const node = namehash(name);
    const resolverAddr = await client.readContract({
      address: BASENAME_REGISTRY,
      abi: [{
        name: "resolver",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "node", type: "bytes32" }],
        outputs: [{ type: "address" }],
      }],
      functionName: "resolver",
      args: [node],
    }) as Address;
    if (!resolverAddr || resolverAddr === "0x0000000000000000000000000000000000000000") return null;
    const addr = await client.readContract({
      address: resolverAddr,
      abi: [{
        name: "addr",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "node", type: "bytes32" }],
        outputs: [{ type: "address" }],
      }],
      functionName: "addr",
      args: [node],
    }) as Address;
    return addr && addr !== "0x0000000000000000000000000000000000000000" ? addr : null;
  } catch {
    return null;
  }
}

async function resolveAttn(_name: string): Promise<Address | null> {
  return null;
}

function encodeDnsName(name: string): Hex {
  const labels = name.split(".");
  const bytes: number[] = [];
  for (const label of labels) {
    bytes.push(label.length);
    for (const ch of label) bytes.push(ch.charCodeAt(0));
  }
  bytes.push(0);
  return ("0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
}

function encodeAddrCall(node: Hex): Hex {
  return ("0x3b3b57de" + node.slice(2)) as Hex;
}

function decodeAddrReturn(hex: Hex): Address | null {
  if (!hex || hex.length < 66) return null;
  return ("0x" + hex.slice(-40)) as Address;
}
