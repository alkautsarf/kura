import type { Address, PendingRequest, RequestKind } from "../core/types.ts";
import { getConfig, listSessions, listWallets, removeSession, getWallet } from "../core/config.ts";
import { loadAllChains, getKnownChain } from "../core/chains.ts";
import { decide, enqueue, get, list as listPending } from "./requests.ts";
import { recentEvents, sseStream } from "./events.ts";
import { readAudit } from "../core/audit-log.ts";
import { buildPortfolio } from "../core/portfolio.ts";
import { fetchActivity } from "../core/history.ts";
import { decodeCalldata } from "../core/decode.ts";
import { simulate } from "../core/sim.ts";
import { resolve as resolveName } from "../core/resolve.ts";
import { tokenSecurity, addressSecurity } from "../core/goplus.ts";
import { getClient } from "../core/rpc.ts";
import { assess } from "../core/risk/index.ts";
import { signAndSend, signPersonalMessage, signTypedDataV4 } from "../core/signer.ts";

export type JsonHandler = (req: Request, url: URL) => Promise<Response> | Response;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function badRequest(msg: string): Response {
  return json({ error: msg }, { status: 400 });
}

function notFound(): Response {
  return json({ error: "not found" }, { status: 404 });
}

export const handleHealth: JsonHandler = async () => {
  return json({ ok: true, version: "0.1.4", ts: Date.now() });
};

export const handleChains: JsonHandler = async (_req, url) => {
  const all = await loadAllChains();
  const mode = url.searchParams.get("mode");
  let chains = all;
  if (mode === "mainnet") chains = all.filter((c) => !c.testnet);
  else if (mode === "testnet") chains = all.filter((c) => !!c.testnet);
  return json({ chains });
};

export const handleWallets: JsonHandler = async () => {
  const wallets = await listWallets();
  const cfg = await getConfig();
  return json({ wallets, defaultWallet: cfg.defaultWallet });
};

export const handleEvents: JsonHandler = (_req, url) => {
  if (url.searchParams.get("stream") === "1") {
    return sseStream();
  }
  const limit = Number(url.searchParams.get("limit") ?? "50");
  return json({ events: recentEvents(Number.isFinite(limit) ? limit : 50) });
};

export const handleConnections: JsonHandler = async () => {
  const sessions = await listSessions();
  return json({ sessions });
};

export const handleConnectionsRevoke: JsonHandler = async (req) => {
  if (req.method !== "DELETE") return badRequest("DELETE only");
  const url = new URL(req.url);
  const origin = url.searchParams.get("origin");
  if (!origin) return badRequest("origin required");
  await removeSession(origin);
  return json({ ok: true });
};

export const handleAudit: JsonHandler = async (_req, url) => {
  const limit = Number(url.searchParams.get("limit") ?? "200");
  const since = url.searchParams.get("since");
  const events = await readAudit({
    limit: Number.isFinite(limit) ? limit : 200,
    since: since ? Date.parse(since) : undefined,
  });
  return json({ events });
};

export const handleRequestsList: JsonHandler = async () => {
  return json({
    pending: listPending().map((e) => ({
      request: e.request,
      simulation: e.simulation,
      risk: e.risk,
    })),
  });
};

export const handleRequestGet: JsonHandler = async (_req, url) => {
  const id = url.pathname.split("/").pop()!;
  const entry = get(id);
  if (!entry) return notFound();
  return json({ request: entry.request, simulation: entry.simulation, risk: entry.risk });
};

interface IncomingRequest {
  kind: RequestKind;
  chainId: number;
  source: string;
  origin?: string;
  payload: {
    from?: Address;
    to?: Address | null;
    data?: `0x${string}`;
    value?: string;
    gas?: string;
    [k: string]: unknown;
  };
}

export const handleRequestsCreate: JsonHandler = async (req) => {
  if (req.method !== "POST") return badRequest("POST only");
  let body: IncomingRequest;
  try {
    body = (await req.json()) as IncomingRequest;
  } catch {
    return badRequest("invalid JSON body");
  }
  if (!body.kind || !body.chainId || !body.source) {
    return badRequest("kind, chainId, source required");
  }
  if (!getKnownChain(body.chainId) && !(await chainHotloaded(body.chainId))) {
    return badRequest(`unknown chain ${body.chainId}`);
  }
  const pending: PendingRequest = {
    id: crypto.randomUUID(),
    kind: body.kind,
    chainId: body.chainId,
    source: body.source,
    payload: { ...body.payload, origin: body.origin },
    createdAt: Date.now(),
  };
  const meta = await preprocess(body, pending);
  const result = await enqueue(pending, meta);
  if (result.decision === "approve" && body.kind === "eth_sendTransaction") {
    try {
      const cfg = await getConfig();
      const walletName = (body.payload as { walletName?: string }).walletName ?? cfg.defaultWallet;
      const { txHash } = await signAndSend({
        walletName,
        chainId: body.chainId,
        to: body.payload.to ?? null,
        data: body.payload.data ?? "0x",
        value: body.payload.value,
        gas: body.payload.gas,
      });
      return json({ ...result, txHash });
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[daemon] sign failed: ${msg}`);
      return json({ decision: "approve" as const, error: msg });
    }
  }
  if (result.decision === "approve" && body.kind === "connect") {
    const cfg = await getConfig();
    const walletName = (body.payload as { walletName?: string }).walletName ?? cfg.defaultWallet;
    const w = await import("../core/config.ts").then((m) => m.getWallet(walletName));
    return json({ ...result, accounts: w?.address ? [w.address] : [] });
  }
  if (result.decision === "approve" && body.kind === "personal_sign") {
    try {
      const cfg = await getConfig();
      const walletName = (body.payload as { walletName?: string }).walletName ?? cfg.defaultWallet;
      const params = (body.payload as { params?: unknown[] }).params ?? [];
      const msgHex = params[0] as `0x${string}` | undefined;
      if (!msgHex) return json({ decision: "approve" as const, error: "no message" });
      const { signature } = await signPersonalMessage(walletName, msgHex);
      return json({ ...result, signature });
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[daemon] sign message failed: ${msg}`);
      return json({ decision: "approve" as const, error: msg });
    }
  }
  if (result.decision === "approve" && body.kind === "eth_signTypedData_v4") {
    try {
      const cfg = await getConfig();
      const walletName = (body.payload as { walletName?: string }).walletName ?? cfg.defaultWallet;
      const params = (body.payload as { params?: unknown[] }).params ?? [];
      const j = params[1];
      const jsonStr = typeof j === "string" ? j : JSON.stringify(j);
      const { signature } = await signTypedDataV4(walletName, jsonStr);
      return json({ ...result, signature });
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[daemon] sign typed-data failed: ${msg}`);
      return json({ decision: "approve" as const, error: msg });
    }
  }
  return json(result);
};

async function preprocess(body: IncomingRequest, _pending: PendingRequest) {
  const cfg = await getConfig();
  const from = body.payload.from ?? ("0x0000000000000000000000000000000000000000" as Address);
  const to = body.payload.to ?? null;
  const data = body.payload.data ?? "0x";
  const value = body.payload.value ?? "0";
  const isWrite = body.kind === "eth_sendTransaction" || body.kind === "batch";
  const sim = isWrite
    ? await simulate({ chainId: body.chainId, from, to, data, value, gas: body.payload.gas })
    : undefined;
  const riskKind = mapRiskKind(body.kind, data);
  const risk = await assess({
    kind: riskKind,
    chainId: body.chainId,
    from,
    to,
    data,
    value,
    origin: body.origin ?? sourceToOrigin(body.source),
    simulation: sim,
    config: { safeThresholdUsd: cfg.safeThresholdUsd },
  });
  return { simulation: sim, risk };
}

function mapRiskKind(kind: RequestKind, data: `0x${string}`): "send" | "swap" | "approve" | "connect" | "sign" | "switch_chain" | "batch" | "other" {
  if (kind === "connect") return "connect";
  if (kind === "switch_chain") return "switch_chain";
  if (kind === "personal_sign" || kind === "eth_signTypedData_v4") return "sign";
  if (kind === "batch") return "batch";
  if (kind === "eth_sendTransaction") {
    const sel = data.slice(0, 10).toLowerCase();
    if (sel === "0x095ea7b3") return "approve";
    if (data === "0x" || data.length <= 2) return "send";
    return "swap";
  }
  return "other";
}

function sourceToOrigin(source: string): string | undefined {
  if (source.startsWith("shim:")) return source.slice(5);
  return undefined;
}

async function chainHotloaded(id: number): Promise<boolean> {
  const all = await loadAllChains();
  return all.some((c) => c.id === id);
}

export const handleRequestDecide: JsonHandler = async (req) => {
  if (req.method !== "POST") return badRequest("POST only");
  const url = new URL(req.url);
  const parts = url.pathname.split("/");
  const id = parts[parts.length - 2];
  if (!id) return badRequest("missing id");
  let body: { decision: "approve" | "reject"; txHash?: string; error?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest("invalid JSON body");
  }
  if (body.decision !== "approve" && body.decision !== "reject") {
    return badRequest("decision must be approve|reject");
  }
  const ok = decide(id, body.decision, { txHash: body.txHash, error: body.error });
  if (!ok) return notFound();
  return json({ ok: true });
};

export const handleNotImplemented: JsonHandler = (_req, url) => {
  return json({ error: "not implemented yet", path: url.pathname }, { status: 501 });
};

async function resolveAddress(walletParam: string | null): Promise<Address | null> {
  if (walletParam && walletParam.startsWith("0x")) return walletParam as Address;
  const cfg = await getConfig();
  const name = walletParam ?? cfg.defaultWallet;
  const w = await getWallet(name);
  return w?.address ?? null;
}

export const handleBalance: JsonHandler = async (_req, url) => {
  const chainId = Number(url.searchParams.get("chain"));
  const address = await resolveAddress(url.searchParams.get("address") ?? url.searchParams.get("wallet"));
  if (!chainId || !address) return badRequest("chain and address/wallet required");
  const client = await getClient(chainId);
  const balance = await client.getBalance({ address });
  return json({ chainId, address, balance: balance.toString() });
};

export const handlePortfolio: JsonHandler = async (_req, url) => {
  const cfg = await getConfig();
  const chainId = Number(url.searchParams.get("chain") ?? cfg.defaultChain);
  const wallet = url.searchParams.get("wallet") ?? cfg.defaultWallet;
  const address = await resolveAddress(url.searchParams.get("address") ?? wallet);
  if (!chainId || !address) return badRequest("chain and address/wallet required");
  const portfolio = await buildPortfolio(wallet, chainId, address);
  return json(portfolio);
};

export const handleHistory: JsonHandler = async (_req, url) => {
  const cfg = await getConfig();
  const chainId = Number(url.searchParams.get("chain") ?? cfg.defaultChain);
  const wallet = url.searchParams.get("wallet") ?? cfg.defaultWallet;
  const address = await resolveAddress(url.searchParams.get("address") ?? wallet);
  if (!chainId || !address) return badRequest("chain and address/wallet required");
  const limit = Number(url.searchParams.get("limit") ?? "25");
  const items = await fetchActivity({ chainId, address, limit });
  return json({ items });
};

export const handleGas: JsonHandler = async (_req, url) => {
  const chainId = Number(url.searchParams.get("chain"));
  if (!chainId) return badRequest("chain required");
  const client = await getClient(chainId);
  const fees = await client.estimateFeesPerGas().catch(() => null);
  const gasPrice = fees ? null : await client.getGasPrice().catch(() => 0n);
  return json({
    chainId,
    maxFeePerGas: fees?.maxFeePerGas?.toString(),
    maxPriorityFeePerGas: fees?.maxPriorityFeePerGas?.toString(),
    gasPrice: gasPrice?.toString(),
  });
};

export const handleResolve: JsonHandler = async (_req, url) => {
  const name = url.searchParams.get("name");
  if (!name) return badRequest("name required");
  const r = await resolveName(name);
  return json(r);
};

interface SimReq {
  chainId: number;
  from: string;
  to: string | null;
  data: string;
  value?: string;
  gas?: string;
}

export const handleSimulate: JsonHandler = async (req) => {
  if (req.method !== "POST") return badRequest("POST only");
  let body: SimReq;
  try {
    body = (await req.json()) as SimReq;
  } catch {
    return badRequest("invalid JSON body");
  }
  const result = await simulate(body);
  return json(result);
};

interface DecodeReq {
  to: Address | null;
  data: `0x${string}`;
}

export const handleDecode: JsonHandler = async (req) => {
  if (req.method !== "POST") return badRequest("POST only");
  let body: DecodeReq;
  try {
    body = (await req.json()) as DecodeReq;
  } catch {
    return badRequest("invalid JSON body");
  }
  const decoded = await decodeCalldata(body.to, body.data);
  return json(decoded);
};

interface RiskReq {
  chainId: number;
  contract?: string;
  address?: string;
}

export const handleRisk: JsonHandler = async (req) => {
  if (req.method !== "POST") return badRequest("POST only");
  let body: RiskReq;
  try {
    body = (await req.json()) as RiskReq;
  } catch {
    return badRequest("invalid JSON body");
  }
  const out: Record<string, unknown> = {};
  if (body.contract) out.token = await tokenSecurity(body.chainId, body.contract);
  if (body.address) out.address = await addressSecurity(body.address, body.chainId);
  return json(out);
};
