import { existsSync } from "node:fs";
import { readFile, chmod } from "node:fs/promises";
import { spawn } from "bun";
import { PATH_TLS_CERT, PATH_TLS_KEY, KURA_HOME } from "./paths.ts";
import { ensureKuraHome } from "./config.ts";

export interface TlsMaterial {
  cert: string;
  key: string;
}

async function generate(): Promise<void> {
  await ensureKuraHome();
  const subj = "/CN=kura-localhost/O=kura/OU=daemon";
  const args = [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", PATH_TLS_KEY,
    "-out", PATH_TLS_CERT,
    "-days", "3650",
    "-subj", subj,
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ];
  const proc = spawn({ cmd: ["openssl", ...args], stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`openssl req failed: ${err.slice(0, 200)}`);
  }
  await chmod(PATH_TLS_KEY, 0o600);
  await chmod(PATH_TLS_CERT, 0o600);
}

export async function ensureTls(): Promise<TlsMaterial> {
  if (!existsSync(PATH_TLS_CERT) || !existsSync(PATH_TLS_KEY)) {
    await generate();
  }
  const cert = await readFile(PATH_TLS_CERT, "utf8");
  const key = await readFile(PATH_TLS_KEY, "utf8");
  return { cert, key };
}

export function tlsAvailable(): boolean {
  return existsSync(PATH_TLS_CERT) && existsSync(PATH_TLS_KEY);
}

export const KURA_TLS_DIR = KURA_HOME;
