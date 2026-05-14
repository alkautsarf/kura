import net from "node:net";
import { getConfig } from "../core/config.ts";
import { ensureKuraHome } from "../core/config.ts";
import { getOrCreateSecret } from "../core/secret.ts";
import { logAudit } from "../core/audit-log.ts";
import { ensureTls } from "../core/tls.ts";
import { checkAuth } from "./auth.ts";
import {
  handleHealth,
  handleChains,
  handleWallets,
  handleEvents,
  handleConnections,
  handleConnectionsRevoke,
  handleAudit,
  handleRequestsList,
  handleRequestGet,
  handleRequestsCreate,
  handleRequestDecide,
  handleRequestsReset,
  handleBalance,
  handlePortfolio,
  handlePortfolioAll,
  handleHistory,
  handleGas,
  handleResolve,
  handleSimulate,
  handleDecode,
  handleDescribeTx,
  handleRisk,
  handleRpcProxy,
} from "./handlers.ts";

interface Route {
  method: string;
  pattern: RegExp;
  handler: (req: Request, url: URL) => Promise<Response> | Response;
  authRequired: boolean;
}

const ROUTES: Route[] = [
  { method: "GET", pattern: /^\/health$/, handler: handleHealth, authRequired: false },
  { method: "GET", pattern: /^\/chains$/, handler: handleChains, authRequired: true },
  { method: "GET", pattern: /^\/wallets$/, handler: handleWallets, authRequired: true },
  { method: "GET", pattern: /^\/events$/, handler: handleEvents, authRequired: true },
  { method: "GET", pattern: /^\/connections$/, handler: handleConnections, authRequired: true },
  { method: "DELETE", pattern: /^\/connections$/, handler: handleConnectionsRevoke, authRequired: true },
  { method: "GET", pattern: /^\/audit$/, handler: handleAudit, authRequired: true },
  { method: "GET", pattern: /^\/requests$/, handler: handleRequestsList, authRequired: true },
  { method: "GET", pattern: /^\/requests\/[a-zA-Z0-9-]+$/, handler: handleRequestGet, authRequired: true },
  { method: "POST", pattern: /^\/requests$/, handler: handleRequestsCreate, authRequired: true },
  { method: "POST", pattern: /^\/requests\/reset$/, handler: handleRequestsReset, authRequired: true },
  { method: "POST", pattern: /^\/requests\/[a-zA-Z0-9-]+\/decision$/, handler: handleRequestDecide, authRequired: true },
  { method: "GET", pattern: /^\/balance$/, handler: handleBalance, authRequired: true },
  { method: "GET", pattern: /^\/portfolio$/, handler: handlePortfolio, authRequired: true },
  { method: "GET", pattern: /^\/portfolio\/all$/, handler: handlePortfolioAll, authRequired: true },
  { method: "GET", pattern: /^\/history$/, handler: handleHistory, authRequired: true },
  { method: "GET", pattern: /^\/gas$/, handler: handleGas, authRequired: true },
  { method: "GET", pattern: /^\/resolve$/, handler: handleResolve, authRequired: true },
  { method: "POST", pattern: /^\/simulate$/, handler: handleSimulate, authRequired: true },
  { method: "POST", pattern: /^\/decode$/, handler: handleDecode, authRequired: true },
  { method: "POST", pattern: /^\/describe-tx$/, handler: handleDescribeTx, authRequired: true },
  { method: "POST", pattern: /^\/risk$/, handler: handleRisk, authRequired: true },
  // /rpc proxies allowlisted read-only eth_* methods to the chain's RPC.
  // The shim's catch-all hits this for eth_blockNumber, eth_call, etc.
  // Write methods (eth_sendTransaction) are NOT allowed here — they go
  // through /requests so they hit the approval + signing flow.
  { method: "POST", pattern: /^\/rpc$/, handler: handleRpcProxy, authRequired: true },
];

export interface DaemonHandle {
  port: number;
  host: string;
  scheme: string;
  proxy?: { host: string; port: number; domains: string[]; pacPath?: string };
  stop: () => Promise<void>;
}

export async function start(): Promise<DaemonHandle> {
  await ensureKuraHome();
  await getOrCreateSecret();
  const cfg = await getConfig();

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Kura-Key",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
  };
  const withCors = (resp: Response): Response => {
    for (const [k, v] of Object.entries(corsHeaders)) resp.headers.set(k, v);
    return resp;
  };

  const tlsDisabled = process.env.KURA_NO_TLS === "1";
  const tls = tlsDisabled ? null : await ensureTls().catch((err) => {
    console.warn(`[daemon] TLS setup failed (${err.message}); falling back to HTTP. Mixed-content sites (https dapps) will be blocked.`);
    return null;
  });
  const server = Bun.serve({
    hostname: cfg.daemonHost,
    port: cfg.daemonPort,
    idleTimeout: 0,
    tls: tls ? { cert: tls.cert, key: tls.key } : undefined,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      const route = ROUTES.find(
        (r) => r.method === req.method && r.pattern.test(url.pathname),
      );
      if (!route) {
        return withCors(new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }));
      }
      if (route.authRequired) {
        const ok = await checkAuth(req);
        if (!ok) {
          return withCors(new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }));
        }
      }
      try {
        return withCors(await route.handler(req, url));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return withCors(new Response(JSON.stringify({ error: msg }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }));
      }
    },
  });

  const scheme = tls ? "https" : "http";
  await logAudit("daemon_start", { host: cfg.daemonHost, port: cfg.daemonPort, tls: !!tls });

  let proxyInfo: DaemonHandle["proxy"];
  if (cfg.proxyEnabled) {
    const alive = await portInUse(cfg.daemonHost, cfg.proxyPort);
    proxyInfo = { host: cfg.daemonHost, port: cfg.proxyPort, domains: cfg.proxyDomains };
    if (alive) {
      console.log(`[daemon] csp-strip proxy detected on http://${cfg.daemonHost}:${cfg.proxyPort}`);
    } else {
      console.warn(`[daemon] csp-strip proxy is enabled in config but not running on ${cfg.proxyPort}. Browser-side CSP-restricted dapps (Uniswap/OpenSea) will not work until the proxy is started. The proxy is normally spawned by qutebrowser config.py at qb startup, or you can run \`kura proxy\` standalone.`);
    }
  }

  return {
    port: server.port ?? cfg.daemonPort,
    host: cfg.daemonHost,
    scheme,
    proxy: proxyInfo,
    stop: async () => {
      server.stop(true);
      await logAudit("daemon_stop", {});
    },
  };
}

async function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
  });
}
