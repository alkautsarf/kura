import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { KURA_HOME } from "../core/paths.ts";

export interface LeafCert {
  cert: string;
  key: string;
}

const CERT_DIR = join(KURA_HOME, "proxy-certs");

let cachedCaroot: string | null = null;
function mkcertCaroot(): string {
  if (cachedCaroot) return cachedCaroot;
  const r = spawnSync("mkcert", ["-CAROOT"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("mkcert -CAROOT failed; is mkcert installed?");
  cachedCaroot = r.stdout.trim();
  return cachedCaroot;
}

export function caInstalled(): boolean {
  try {
    const root = mkcertCaroot();
    return existsSync(join(root, "rootCA.pem")) && existsSync(join(root, "rootCA-key.pem"));
  } catch {
    return false;
  }
}

const inflight = new Map<string, Promise<LeafCert>>();
const memCache = new Map<string, LeafCert>();

export async function getLeafCert(host: string): Promise<LeafCert> {
  const cached = memCache.get(host);
  if (cached) return cached;
  const ip = inflight.get(host);
  if (ip) return ip;
  const p = generateLeaf(host).then((c) => {
    memCache.set(host, c);
    inflight.delete(host);
    return c;
  });
  inflight.set(host, p);
  return p;
}

async function generateLeaf(host: string): Promise<LeafCert> {
  await mkdir(CERT_DIR, { recursive: true, mode: 0o700 });
  const safe = host.replace(/[^a-zA-Z0-9._-]/g, "_");
  const certPath = join(CERT_DIR, `${safe}.crt`);
  const keyPath = join(CERT_DIR, `${safe}.key`);

  if (existsSync(certPath) && existsSync(keyPath)) {
    const [cert, key] = await Promise.all([readFile(certPath, "utf8"), readFile(keyPath, "utf8")]);
    return { cert, key };
  }

  const root = mkcertCaroot();
  const caCert = join(root, "rootCA.pem");
  const caKey = join(root, "rootCA-key.pem");

  const csrPath = join(CERT_DIR, `${safe}.csr`);
  const extPath = join(CERT_DIR, `${safe}.ext`);
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const san = isIp ? `IP:${host}` : `DNS:${host}`;
  await writeFile(extPath, `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`);

  await runOpenssl(["genrsa", "-out", keyPath, "2048"]);
  await chmod(keyPath, 0o600);
  await runOpenssl(["req", "-new", "-key", keyPath, "-out", csrPath, "-subj", `/CN=${host}`]);
  await runOpenssl([
    "x509", "-req",
    "-in", csrPath,
    "-CA", caCert,
    "-CAkey", caKey,
    "-CAcreateserial",
    "-out", certPath,
    "-days", "397",
    "-sha256",
    "-extfile", extPath,
  ]);
  await chmod(certPath, 0o600);

  const [cert, key] = await Promise.all([readFile(certPath, "utf8"), readFile(keyPath, "utf8")]);
  return { cert, key };
}

function runOpenssl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (c) => (err += c.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`openssl ${args[0]} failed (${code}): ${err.slice(0, 200)}`));
    });
  });
}
