import { getConfig } from "../core/config.ts";
import { getOrCreateSecret } from "../core/secret.ts";

let baseUrl: string | null = null;
let secret: string | null = null;

export async function client(): Promise<{ base: string; secret: string }> {
  if (!baseUrl || !secret) {
    const cfg = await getConfig();
    baseUrl = `https://${cfg.daemonHost}:${cfg.daemonPort}`;
    secret = await getOrCreateSecret();
  }
  return { base: baseUrl, secret };
}

// Self-signed local cert: skip verification for 127.0.0.1
const fetchOpts: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
  tls: { rejectUnauthorized: false },
};

export async function get(path: string): Promise<unknown> {
  const { base, secret } = await client();
  const resp = await fetch(`${base}${path}`, {
    ...fetchOpts,
    headers: { "X-Kura-Key": secret },
  });
  if (!resp.ok) throw new Error(`${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

export async function getSignal<T = unknown>(path: string, signal: AbortSignal): Promise<T> {
  const { base, secret } = await client();
  const resp = await fetch(`${base}${path}`, {
    ...fetchOpts,
    headers: { "X-Kura-Key": secret },
    signal,
  });
  if (!resp.ok) throw new Error(`${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json() as Promise<T>;
}

export async function post(path: string, body: unknown): Promise<unknown> {
  const { base, secret } = await client();
  const resp = await fetch(`${base}${path}`, {
    ...fetchOpts,
    method: "POST",
    headers: { "X-Kura-Key": secret, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

export async function del(path: string): Promise<unknown> {
  const { base, secret } = await client();
  const resp = await fetch(`${base}${path}`, {
    ...fetchOpts,
    method: "DELETE",
    headers: { "X-Kura-Key": secret },
  });
  if (!resp.ok) throw new Error(`${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

export async function checkDaemon(): Promise<boolean> {
  try {
    const { base } = await client();
    const resp = await fetch(`${base}/health`, fetchOpts);
    return resp.ok;
  } catch {
    return false;
  }
}
