import pkg from "../../package.json" with { type: "json" };
import type { Address, PendingRequest, RequestKind } from "../core/types.ts";
import { getConfig, listSessions, listWallets, removeSession, getWallet } from "../core/config.ts";
import { loadAllChains, getKnownChain } from "../core/chains.ts";
import { decide, enqueue, enrich, get, list as listPending, reset as resetPending } from "./requests.ts";
import { recentEvents, sseStream, subscribe } from "./events.ts";
import { readAudit } from "../core/audit-log.ts";
import { buildPortfolio, buildPortfolioAll } from "../core/portfolio.ts";
import { fetchActivity, archiveHead } from "../core/history.ts";
import { decodeCalldata } from "../core/decode.ts";
import { describeTx, type SemanticTx } from "../core/decode-tx.ts";
import { simulate } from "../core/sim.ts";
import { fmtCompact } from "../core/format-amount.ts";
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
  return json({ ok: true, version: pkg.version, ts: Date.now() });
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
      semantic: e.semantic,
      enriched: e.enriched,
    })),
  });
};

export const handleRequestGet: JsonHandler = async (_req, url) => {
  const id = url.pathname.split("/").pop()!;
  const entry = get(id);
  if (!entry) return notFound();
  return json({
    request: entry.request,
    simulation: entry.simulation,
    risk: entry.risk,
    semantic: entry.semantic,
    enriched: entry.enriched,
  });
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
  if (!getKnownChain(body.chainId)) {
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
  // Spawn the popup IMMEDIATELY (empty meta) so the user sees something within
  // ~500ms. Enrichment runs in the background and pushes results in stages so
  // each piece appears as soon as it's ready instead of waiting for the slowest:
  //   1) semantic (fast: ABI decode + token meta lookup, ~500ms)
  //   2) sim (slow: Tenderly full mode, up to 15s for V4 swaps)
  //   3) risk (depends on sim for sim-failure rule, so chained after sim)
  // The popup polls /requests/:id and re-renders as each enrich() lands.
  const enqueuePromise = enqueue(pending);
  const isWrite = body.kind === "eth_sendTransaction" || body.kind === "batch";
  const from = body.payload.from ?? ("0x0000000000000000000000000000000000000000" as Address);
  const to = body.payload.to ?? null;
  const data = body.payload.data ?? "0x";
  const value = body.payload.value ?? "0";

  const semanticPromise = isWrite
    ? describeTx({ chainId: body.chainId, to, data, value }).catch(() => undefined as SemanticTx | undefined)
    : Promise.resolve(undefined as SemanticTx | undefined);
  semanticPromise.then((semantic) => {
    if (semantic) enrich(pending.id, { semantic });
  });

  const simPromise = isWrite
    ? simulate({ chainId: body.chainId, from, to, data, value, gas: body.payload.gas }).catch(() => undefined)
    : Promise.resolve(undefined);
  simPromise.then((simulation) => {
    if (simulation) enrich(pending.id, { simulation });
  });

  const preprocessPromise = (async () => {
    const cfg = await getConfig();
    const [simulation, semantic] = await Promise.all([simPromise, semanticPromise]);
    const riskKind = mapRiskKind(body.kind, data);
    const risk = await assess({
      kind: riskKind,
      chainId: body.chainId,
      from,
      to,
      data,
      value,
      origin: body.origin ?? sourceToOrigin(body.source),
      simulation,
      config: { safeThresholdUsd: cfg.safeThresholdUsd },
    }).catch(() => ({ level: "review" as const, findings: [] }));
    enrich(pending.id, { risk });
    return { simulation, risk, semantic };
  })();
  preprocessPromise.catch((err) => {
    console.warn(`[daemon] preprocess failed for ${pending.id.slice(0, 8)}: ${(err as Error).message}`);
  });
  const result = await enqueuePromise;
  if (result.decision === "approve" && body.kind === "eth_sendTransaction") {
    try {
      const cfg = await getConfig();
      const walletName = (body.payload as { walletName?: string }).walletName ?? cfg.defaultWallet;
      // Wait for preprocess so we have the human-readable description for the
      // Touch ID prompt. Typically preprocess completes well before the user
      // approves, so this is a no-op await.
      const meta = await preprocessPromise;
      const description = enrichedDescription(meta.semantic, meta.simulation);
      const { txHash } = await signAndSend({
        walletName,
        chainId: body.chainId,
        to: body.payload.to ?? null,
        data: body.payload.data ?? "0x",
        value: body.payload.value,
        gas: body.payload.gas,
        description,
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

// Compose a Touch ID reason that's specific even for opaque router calls.
// `describeTx` produces "Swap via Uniswap V4 Universal Router" because it
// can't decode V4 commands bytes. Once the simulation lands with predicted
// balance diffs (OUT/IN), we can upgrade the description to
// "Swap 0.1 USDC for ~0.0000437 ETH" so the user sees real amounts on the
// Touch ID prompt.
function enrichedDescription(
  semantic: SemanticTx | undefined,
  simulation: import("../core/types.ts").SimulationResult | undefined,
): string | undefined {
  if (!semantic) return undefined;
  // For decoders that already know amounts (approve/transfer/swapExact*), the
  // existing description is already specific.
  if (
    semantic.kind === "approve" ||
    semantic.kind === "transfer" ||
    semantic.kind === "transferFrom" ||
    semantic.kind === "swap" ||
    semantic.kind === "permit" ||
    semantic.kind === "deposit" ||
    semantic.kind === "withdraw" ||
    semantic.kind === "native_send"
  ) {
    return semantic.description;
  }
  // For execute/multicall/contract on routers, infer amounts from sim diffs.
  if (!simulation?.ok || !simulation.diffs || simulation.diffs.length < 2) {
    return semantic.description;
  }
  const out = simulation.diffs.find((d) => d.delta.startsWith("-"));
  const inn = simulation.diffs.find((d) => !d.delta.startsWith("-") && d.delta !== "0");
  if (!out || !inn) return semantic.description;
  const venue = semantic.contract?.label ? ` on ${semantic.contract.label}` : "";
  return `Swap ${fmtCompact(out.delta, out.decimals)} ${out.symbol} for ~${fmtCompact(inn.delta, inn.decimals)} ${inn.symbol}${venue}`;
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

export const handleRequestsReset: JsonHandler = async (req) => {
  if (req.method !== "POST") return badRequest("POST only");
  const result = resetPending();
  return json({ ok: true, ...result });
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

// In-memory response cache for the read-heavy /portfolio + /activity routes.
// Both endpoints aggregate multi-step Alchemy + HyperSync work that costs
// ~1-3s on a cold call. The TUI refetches every 30s plus on every chain/wallet
// switch, so without a cache the user pays the full latency on every tick.
// Invalidation: any approved tx clears both caches (SSE wakeup below). Manual
// [g] refresh in the TUI sends ?fresh=1 to bypass.
const TTL_MS = 15_000;
const STALE_MS = 60_000;
interface PortfolioCacheEntry { data: unknown; ts: number; }
interface ActivityCacheEntry { items: unknown; ts: number; archiveHeight: number; }
const portfolioCache = new Map<string, PortfolioCacheEntry>();
const activityCache = new Map<string, ActivityCacheEntry>();
const portfolioAllCache = new Map<string, PortfolioCacheEntry>();

subscribe((event) => {
  // Any tx the user just signed will change balances + activity. Clear both
  // caches so the next read returns fresh data within ~1s of the signature.
  if (event.type === "request:resolved" && event.payload.decision === "approve") {
    portfolioCache.clear();
    activityCache.clear();
    portfolioAllCache.clear();
  }
});

export const handlePortfolio: JsonHandler = async (_req, url) => {
  const cfg = await getConfig();
  const chainId = Number(url.searchParams.get("chain") ?? cfg.defaultChain);
  const wallet = url.searchParams.get("wallet") ?? cfg.defaultWallet;
  const address = await resolveAddress(url.searchParams.get("address") ?? wallet);
  if (!chainId || !address) return badRequest("chain and address/wallet required");
  const fresh = url.searchParams.get("fresh") === "1";
  const key = `${chainId}:${address.toLowerCase()}:${wallet}`;
  if (!fresh) {
    const cached = portfolioCache.get(key);
    if (cached && Date.now() - cached.ts < TTL_MS) return json(cached.data);
  }
  const portfolio = await buildPortfolio(wallet, chainId, address);
  portfolioCache.set(key, { data: portfolio, ts: Date.now() });
  return json(portfolio);
};

export const handlePortfolioAll: JsonHandler = async (_req, url) => {
  const cfg = await getConfig();
  const wallet = url.searchParams.get("wallet") ?? cfg.defaultWallet;
  const address = await resolveAddress(url.searchParams.get("address") ?? wallet);
  if (!address) return badRequest("address/wallet required");
  const fresh = url.searchParams.get("fresh") === "1";
  const key = `${address.toLowerCase()}:${wallet}`;
  if (!fresh) {
    const cached = portfolioAllCache.get(key);
    if (cached && Date.now() - cached.ts < TTL_MS) return json(cached.data);
  }
  const aggregate = await buildPortfolioAll(wallet, address);
  portfolioAllCache.set(key, { data: aggregate, ts: Date.now() });
  return json(aggregate);
};

export const handleHistory: JsonHandler = async (_req, url) => {
  const cfg = await getConfig();
  const chainId = Number(url.searchParams.get("chain") ?? cfg.defaultChain);
  const wallet = url.searchParams.get("wallet") ?? cfg.defaultWallet;
  const address = await resolveAddress(url.searchParams.get("address") ?? wallet);
  if (!chainId || !address) return badRequest("chain and address/wallet required");
  const limit = Number(url.searchParams.get("limit") ?? "25");
  const fresh = url.searchParams.get("fresh") === "1";
  const key = `${chainId}:${address.toLowerCase()}:${limit}`;
  if (!fresh) {
    const cached = activityCache.get(key);
    const age = cached ? Date.now() - cached.ts : Infinity;
    if (cached && age < TTL_MS) return json({ items: cached.items });
    if (cached && age < STALE_MS) {
      // Stale but recent. One cheap GET /height tells us if anything new even
      // landed; if not, refresh ts and return the cached items rather than
      // paying the full pagination cost.
      const chain = getKnownChain(chainId);
      if (chain?.hyperSyncUrl) {
        const head = await archiveHead(chain.hyperSyncUrl);
        if (head > 0 && head === cached.archiveHeight) {
          cached.ts = Date.now();
          return json({ items: cached.items });
        }
      }
    }
  }
  const items = await fetchActivity({ chainId, address, limit });
  const chain = getKnownChain(chainId);
  const head = chain?.hyperSyncUrl ? await archiveHead(chain.hyperSyncUrl) : 0;
  activityCache.set(key, { items, ts: Date.now(), archiveHeight: head });
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

interface DescribeReq {
  chainId: number;
  to: Address | null;
  data: `0x${string}`;
  value?: string;
}

export const handleDescribeTx: JsonHandler = async (req) => {
  if (req.method !== "POST") return badRequest("POST only");
  let body: DescribeReq;
  try {
    body = (await req.json()) as DescribeReq;
  } catch {
    return badRequest("invalid JSON body");
  }
  if (!body.chainId) return badRequest("chainId required");
  const sem = await describeTx({
    chainId: body.chainId,
    to: body.to,
    data: body.data,
    value: body.value,
  }).catch(() => null);
  return json({ semantic: sem });
};

// Allowlisted RPC methods that the shim's eth_* catch-all may proxy through
// /rpc. Read-only only , write methods (eth_sendTransaction, etc.) MUST go
// through /requests so they hit the approval flow and signing logic. Anything
// not on this list is rejected with -32601.
const ALLOWED_RPC_METHODS: Set<string> = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_feeHistory",
  "eth_maxPriorityFeePerGas",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
  "eth_syncing",
  "eth_protocolVersion",
  "eth_subscribe",
  "eth_unsubscribe",
  "net_version",
  "net_listening",
  "web3_clientVersion",
]);

interface RpcProxyBody {
  method: string;
  params?: unknown[];
  id?: number | string;
}

export const handleRpcProxy: JsonHandler = async (req, url) => {
  if (req.method !== "POST") return badRequest("POST only");
  const chainParam = url.searchParams.get("chain");
  const chainId = chainParam ? Number(chainParam) : NaN;
  if (!Number.isFinite(chainId) || chainId <= 0) return badRequest("chain query param required");
  let body: RpcProxyBody;
  try {
    body = (await req.json()) as RpcProxyBody;
  } catch {
    return badRequest("invalid JSON body");
  }
  const method = body.method;
  if (!method || typeof method !== "string") {
    return json({ error: { code: -32600, message: "method required" } });
  }
  if (!ALLOWED_RPC_METHODS.has(method)) {
    return json({ error: { code: -32601, message: `kura: method ${method} not allowed via /rpc` } });
  }
  if (!getKnownChain(chainId)) {
    return json({ error: { code: -32602, message: `unknown chain ${chainId}` } });
  }
  try {
    const client = await getClient(chainId);
    // viem's client.request takes { method, params } and returns the raw RPC result
    const result = await client.request({ method, params: body.params } as never);
    return json({ result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: { code: -32603, message: msg } });
  }
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
