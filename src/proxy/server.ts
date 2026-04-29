import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { getLeafCert } from "./cert.ts";
import { decompress, stripCspResponseHeaders, stripHtmlCsp } from "./csp-strip.ts";
import { logAudit } from "../core/audit-log.ts";

export interface ProxyHandle {
  port: number;
  host: string;
  domains: string[];
  stop: () => Promise<void>;
}

export interface ProxyOptions {
  host: string;
  port: number;
  domains: string[];
}

function hostMatches(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase();
  for (const p of patterns) {
    const pat = p.toLowerCase();
    if (pat.startsWith("*.")) {
      const suffix = pat.slice(1);
      if (h === suffix.slice(1) || h.endsWith(suffix)) return true;
    } else if (h === pat) {
      return true;
    }
  }
  return false;
}

interface InnerServer { server: https.Server; port: number; }
const innerCache = new Map<string, Promise<InnerServer>>();
const allInner: InnerServer[] = [];

async function getInnerServer(host: string): Promise<InnerServer> {
  const cached = innerCache.get(host);
  if (cached) return cached;
  const p = (async () => {
    const leaf = await getLeafCert(host);
    const server = https.createServer({
      ALPNProtocols: ["http/1.1"],
      cert: leaf.cert,
      key: leaf.key,
    });
    server.on("request", (req, res) => handleHttpsRequest(host, 443, req, res));
    server.on("clientError", (err, sock) => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
        console.error(`[kura-proxy] inner(${host}) clientError: ${err.message}`);
      }
      try { (sock as net.Socket).end(); } catch {}
    });
    server.on("tlsClientError", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
        console.error(`[kura-proxy] inner(${host}) tlsClientError: ${err.message}`);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const port = (server.address() as net.AddressInfo).port;
    const info = { server, port };
    allInner.push(info);
    return info;
  })();
  innerCache.set(host, p);
  return p;
}

export async function startProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  const { host, port, domains } = opts;

  const proxy = http.createServer((req, res) => {
    forwardPlainHttp(req, res);
  });

  proxy.on("connect", (req, clientStream, head) => {
    const clientSocket = clientStream as net.Socket;
    const target = req.url ?? "";
    const [targetHost = "", targetPortStr] = target.split(":");
    const targetPort = Number(targetPortStr) || 443;

    if (!targetHost || !hostMatches(targetHost, domains)) {
      tunnelDirect(targetHost, targetPort, clientSocket, head);
      return;
    }

    getInnerServer(targetHost).then((inner) => {
      const upstream = net.connect(inner.port, "127.0.0.1", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: kura-proxy\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      upstream.on("error", (err) => {
        console.error(`[kura-proxy] inner connect failed for ${targetHost}: ${err.message}`);
        try { clientSocket.destroy(); } catch {}
      });
      clientSocket.on("error", () => { try { upstream.destroy(); } catch {} });
    }).catch((err) => {
      console.error(`[kura-proxy] cannot prepare inner server for ${targetHost}: ${err.message}`);
      try { clientSocket.destroy(); } catch {}
    });
  });

  proxy.on("clientError", (err, socket) => {
    try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {}
  });

  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(port, host, () => {
      proxy.removeListener("error", reject);
      resolve();
    });
  });

  await logAudit("proxy_start", { host, port, domains });

  return {
    host,
    port,
    domains,
    stop: async () => {
      proxy.closeAllConnections?.();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      for (const i of allInner) {
        i.server.closeAllConnections?.();
        await new Promise<void>((resolve) => i.server.close(() => resolve()));
      }
      innerCache.clear();
      allInner.length = 0;
      await logAudit("proxy_stop", {});
    },
  };
}

function tunnelDirect(host: string, port: number, clientSocket: net.Socket, head: Buffer): void {
  const upstream = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: kura-proxy\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
  upstream.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstream.destroy());
}

function forwardPlainHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? "";
  if (!url.startsWith("http://")) {
    // Bare relative request (no absolute URL, no CONNECT). Treat as a health
    // probe and respond 200 so service-detection callers (e.g. qutebrowser
    // config.py's `_is_port_alive` using urllib.urlopen) can confirm the
    // proxy is up. urllib treats 4xx as HTTPError → would falsely report
    // the proxy as down → qb falls back to `c.content.proxy = 'system'`
    // and bypasses the proxy entirely. 200 keeps the detection working.
    res.writeHead(200, {
      "Content-Type": "text/plain",
      "X-Kura-Proxy": "ok",
      "Cache-Control": "no-store",
    });
    res.end("kura csp-strip proxy ok\n");
    return;
  }
  let parsed: URL;
  try { parsed = new URL(url); }
  catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("kura proxy: bad URL");
    return;
  }
  const reqHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
  delete reqHeaders["proxy-connection"];
  const upstream = http.request({
    host: parsed.hostname,
    port: Number(parsed.port) || 80,
    method: req.method,
    path: parsed.pathname + parsed.search,
    headers: reqHeaders,
  }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`kura proxy upstream error: ${err.message}`);
    } else {
      res.destroy(err);
    }
  });
  req.pipe(upstream);
}

function handleHttpsRequest(host: string, port: number, req: http.IncomingMessage, res: http.ServerResponse): void {
  const reqHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
  reqHeaders.host = host;
  reqHeaders["accept-encoding"] = "identity";
  delete reqHeaders["proxy-connection"];

  const upstream = https.request({
    host,
    port,
    method: req.method,
    path: req.url,
    headers: reqHeaders,
    servername: host,
  });

  upstream.on("error", (err) => {
    console.error(`[kura-proxy] upstream error ${host}${req.url}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`kura proxy upstream error: ${err.message}`);
    } else {
      res.destroy(err);
    }
  });

  upstream.on("response", (upRes) => {
    void forwardResponse(host, req.url ?? "/", upRes, res).catch((err) => {
      console.error(`[kura-proxy] forward error ${host}${req.url}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`kura proxy forward error: ${err.message}`);
      } else {
        res.destroy(err);
      }
    });
  });

  req.pipe(upstream);
}

async function forwardResponse(
  host: string,
  path: string,
  upRes: http.IncomingMessage,
  clientRes: http.ServerResponse,
): Promise<void> {
  const ct = String(upRes.headers["content-type"] ?? "").toLowerCase();
  const isHtml = ct.includes("text/html") || ct.includes("application/xhtml");
  const { headers: stripped, removed } = stripCspResponseHeaders(upRes.headers as Record<string, string | string[] | undefined>);

  if (!isHtml) {
    clientRes.writeHead(upRes.statusCode ?? 200, upRes.statusMessage, stripped as http.OutgoingHttpHeaders);
    upRes.pipe(clientRes);
    if (removed.length > 0) {
      void logAudit("proxy_csp_header_strip", { host, path, removed }).catch(() => {});
    }
    return;
  }

  const chunks: Buffer[] = [];
  for await (const c of upRes) chunks.push(c as Buffer);
  let body: Buffer = Buffer.concat(chunks as Uint8Array[]);
  body = await decompress(body, String(upRes.headers["content-encoding"] ?? "")).catch(() => body);

  const { body: modBody, modified } = stripHtmlCsp(body);
  delete stripped["content-encoding"];
  delete stripped["transfer-encoding"];
  delete stripped["content-length"];
  stripped["content-length"] = String(modBody.length);

  clientRes.writeHead(upRes.statusCode ?? 200, upRes.statusMessage, stripped as http.OutgoingHttpHeaders);
  clientRes.end(modBody);

  if (modified || removed.length > 0) {
    void logAudit("proxy_html_csp_strip", { host, path, metaStripped: modified, headersStripped: removed }).catch(() => {});
  }
}
