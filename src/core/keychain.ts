import { spawn } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";

export class KeychainError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message);
    this.name = "KeychainError";
  }
}

function findSignerBinary(): string | null {
  // Honour KURA_SIGNER explicitly: empty string or "0" disables it entirely.
  const explicit = process.env.KURA_SIGNER;
  if (explicit !== undefined) {
    if (explicit === "" || explicit === "0") return null;
    return existsSync(explicit) ? explicit : null;
  }
  const candidates = [
    join(process.cwd(), "swift", ".build", "release", "kura-signer"),
    join(process.cwd(), "swift", ".build", "arm64-apple-macosx", "release", "kura-signer"),
    "/usr/local/bin/kura-signer",
    "/opt/homebrew/bin/kura-signer",
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const signerBin = findSignerBinary();

export interface KeychainItem {
  service: string;
  account: string;
  password: string;
  label?: string;
  comment?: string;
  biometryGated?: boolean;
}

async function runSecurity(args: string[], stdin?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = spawn({
    cmd: ["security", ...args],
    stdin: stdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin && proc.stdin) {
    proc.stdin.write(stdin);
    await proc.stdin.end();
  }
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

export async function readPassword(service: string, account: string): Promise<string | null> {
  const { stdout, stderr, code } = await runSecurity([
    "find-generic-password",
    "-s", service,
    "-a", account,
    "-w",
  ]);
  if (code !== 0) {
    if (stderr.includes("could not be found")) return null;
    throw new KeychainError(`security read failed: ${stderr.trim()}`, code);
  }
  return stdout.replace(/\n$/, "");
}

export async function writePassword(item: KeychainItem): Promise<void> {
  const args = [
    "add-generic-password",
    "-s", item.service,
    "-a", item.account,
    "-w", item.password,
    "-U",
  ];
  if (item.label) args.push("-l", item.label);
  if (item.comment) args.push("-j", item.comment);
  if (item.biometryGated) args.push("-T", "");
  const { stderr, code } = await runSecurity(args);
  if (code !== 0) {
    throw new KeychainError(`security write failed: ${stderr.trim()}`, code);
  }
}

export async function deletePassword(service: string, account: string): Promise<void> {
  const { stderr, code } = await runSecurity([
    "delete-generic-password",
    "-s", service,
    "-a", account,
  ]);
  if (code !== 0 && !stderr.includes("could not be found")) {
    throw new KeychainError(`security delete failed: ${stderr.trim()}`, code);
  }
}

export async function exists(service: string, account: string): Promise<boolean> {
  const { code } = await runSecurity([
    "find-generic-password",
    "-s", service,
    "-a", account,
  ]);
  return code === 0;
}

export const SVC_ALCHEMY = "dev.api.alchemy";
export const SVC_ALCHEMY_RPC = "dev.rpc.alchemy";
export const SVC_ENVIO = "dev.api.envio";
export const SVC_TENDERLY = "dev.api.tenderly";
export const SVC_ANKR_RPC = "dev.rpc.ankr";

export function walletService(name: string): string {
  return `xyz.${name}.kura`;
}
export const WALLET_ACCOUNT = "key";

async function runSigner(args: string[], stdin?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  if (!signerBin) throw new KeychainError("kura-signer binary not found; build with `cd swift && swift build -c release`");
  const proc = spawn({
    cmd: [signerBin, ...args],
    stdin: stdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin && proc.stdin) {
    proc.stdin.write(stdin);
    await proc.stdin.end();
  }
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

export function signerAvailable(): boolean {
  return signerBin !== null;
}

export async function readWalletKey(name: string): Promise<string | null> {
  if (signerBin) {
    const has = await runSigner(["has", name]);
    if (has.code !== 0) return null;
    const { stdout, stderr, code } = await runSigner(["get", name]);
    if (code !== 0) {
      throw new KeychainError(`kura-signer get failed: ${stderr.trim()}`, code);
    }
    return stdout.replace(/\n$/, "");
  }
  return readPassword(walletService(name), WALLET_ACCOUNT);
}

export async function writeWalletKey(name: string, hexKey: string): Promise<void> {
  const normalized = hexKey.startsWith("0x") ? hexKey : "0x" + hexKey;
  if (signerBin) {
    const { stderr, code } = await runSigner(["store", name], normalized);
    if (code !== 0) {
      throw new KeychainError(`kura-signer store failed: ${stderr.trim()}`, code);
    }
    return;
  }
  await writePassword({
    service: walletService(name),
    account: WALLET_ACCOUNT,
    password: normalized,
    label: `kura wallet ${name}`,
    biometryGated: true,
  });
}

export async function walletExists(name: string): Promise<boolean> {
  if (signerBin) {
    const { code } = await runSigner(["has", name]);
    return code === 0;
  }
  return exists(walletService(name), WALLET_ACCOUNT);
}

export async function deleteWalletKey(name: string): Promise<void> {
  if (signerBin) {
    const { stderr, code } = await runSigner(["delete", name]);
    if (code !== 0) throw new KeychainError(`kura-signer delete failed: ${stderr.trim()}`, code);
    return;
  }
  await deletePassword(walletService(name), WALLET_ACCOUNT);
}

export async function readAlchemyKey(): Promise<string> {
  const direct = await readPassword(SVC_ALCHEMY, "api-key");
  if (direct) return direct;
  const rpcUrl = await readPassword(SVC_ALCHEMY_RPC, "rpc-url");
  if (!rpcUrl) {
    throw new KeychainError(`no Alchemy key in keychain (need ${SVC_ALCHEMY} or ${SVC_ALCHEMY_RPC})`);
  }
  const match = rpcUrl.match(/\/v2\/([A-Za-z0-9_-]{20,})/);
  if (!match) {
    throw new KeychainError(`could not extract API key from rpc-url`);
  }
  return match[1]!;
}

export async function readEnvioToken(): Promise<string> {
  const v = await readPassword(SVC_ENVIO, "hypersync-token");
  if (!v) throw new KeychainError(`no HyperSync token in keychain (${SVC_ENVIO})`);
  return v;
}

export async function readTenderlyKey(): Promise<string> {
  const v = await readPassword(SVC_TENDERLY, "access-key");
  if (!v) throw new KeychainError(`no Tenderly key in keychain (${SVC_TENDERLY})`);
  return v;
}
