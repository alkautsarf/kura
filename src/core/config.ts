import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { KuraConfig, WalletProfile } from "./types.ts";
import { KURA_HOME, PATH_CONFIG, PATH_STATE } from "./paths.ts";

export const DEFAULT_CONFIG: KuraConfig = {
  defaultWallet: "main",
  defaultChain: 8453,
  safeThresholdUsd: 100,
  daemonPort: 8421,
  daemonHost: "127.0.0.1",
  proxyEnabled: false,
  proxyPort: 8422,
  proxyDomains: ["app.uniswap.org", "*.uniswap.org", "opensea.io", "*.opensea.io"],
  networkMode: "mainnet",
};

interface RawConfig {
  default_wallet?: string;
  default_chain?: number;
  safe_threshold_usd?: number;
  daemon_port?: number;
  daemon_host?: string;
  proxy_enabled?: boolean;
  proxy_port?: number;
  proxy_domains?: string[];
  tenderly_account?: string;
  tenderly_project?: string;
  network_mode?: "mainnet" | "testnet";
}

export async function ensureKuraHome(): Promise<void> {
  if (!existsSync(KURA_HOME)) {
    await mkdir(KURA_HOME, { recursive: true, mode: 0o700 });
  }
}

export async function readConfig(path: string = PATH_CONFIG): Promise<KuraConfig | null> {
  if (!existsSync(path)) return null;
  const text = await readFile(path, "utf8");
  const raw = Bun.TOML.parse(text) as RawConfig;
  return {
    defaultWallet: raw.default_wallet ?? DEFAULT_CONFIG.defaultWallet,
    defaultChain: raw.default_chain ?? DEFAULT_CONFIG.defaultChain,
    safeThresholdUsd: raw.safe_threshold_usd ?? DEFAULT_CONFIG.safeThresholdUsd,
    daemonPort: raw.daemon_port ?? DEFAULT_CONFIG.daemonPort,
    daemonHost: raw.daemon_host ?? DEFAULT_CONFIG.daemonHost,
    proxyEnabled: raw.proxy_enabled ?? DEFAULT_CONFIG.proxyEnabled,
    proxyPort: raw.proxy_port ?? DEFAULT_CONFIG.proxyPort,
    proxyDomains: raw.proxy_domains ?? DEFAULT_CONFIG.proxyDomains,
    tenderlyAccount: raw.tenderly_account,
    tenderlyProject: raw.tenderly_project,
    networkMode: raw.network_mode ?? inferModeFromChain(raw.default_chain ?? DEFAULT_CONFIG.defaultChain),
  };
}

function inferModeFromChain(chainId: number): "mainnet" | "testnet" {
  // Heuristic for legacy configs without explicit network_mode: derive from
  // the default chain. Known testnet ids → testnet, otherwise mainnet.
  const TESTNET_IDS = new Set<number>([11155111, 10143, 5, 17000, 84532, 421614, 80002]);
  return TESTNET_IDS.has(chainId) ? "testnet" : "mainnet";
}

export async function getConfig(): Promise<KuraConfig> {
  return (await readConfig()) ?? DEFAULT_CONFIG;
}

function tomlStringify(cfg: KuraConfig): string {
  return [
    `default_wallet = ${JSON.stringify(cfg.defaultWallet)}`,
    `default_chain = ${cfg.defaultChain}`,
    `safe_threshold_usd = ${cfg.safeThresholdUsd}`,
    `daemon_port = ${cfg.daemonPort}`,
    `daemon_host = ${JSON.stringify(cfg.daemonHost)}`,
    `proxy_enabled = ${cfg.proxyEnabled}`,
    `proxy_port = ${cfg.proxyPort}`,
    `proxy_domains = [${cfg.proxyDomains.map((d) => JSON.stringify(d)).join(", ")}]`,
    cfg.tenderlyAccount ? `tenderly_account = ${JSON.stringify(cfg.tenderlyAccount)}` : "",
    cfg.tenderlyProject ? `tenderly_project = ${JSON.stringify(cfg.tenderlyProject)}` : "",
    `network_mode = ${JSON.stringify(cfg.networkMode)}`,
    "",
  ].filter((l) => l !== "" || true).join("\n");
}

export async function writeConfig(cfg: KuraConfig, path: string = PATH_CONFIG): Promise<void> {
  await ensureKuraHome();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, tomlStringify(cfg), { mode: 0o600 });
}

export async function setDefaultWallet(name: string): Promise<void> {
  const cfg = await getConfig();
  if (cfg.defaultWallet === name) return;
  await writeConfig({ ...cfg, defaultWallet: name });
}

interface StateFile {
  wallets: Record<string, WalletProfile>;
  sessions: Record<string, { walletName: string; address: string; chainId: number; connectedAt: number }>;
  lastUpdated: string;
  // Set true once `kura wallet migrate` has rotated all hot wallets onto the new
  // LAContext-gated keychain entries. Pre-migration entries were stored via plain
  // `security` CLI with -T "" ACL (Mac password on read); post-migration entries
  // are stored by kura-signer (Touch ID via LAContext, Mac password fallback).
  biometryMigrated?: boolean;
}

const EMPTY_STATE: StateFile = {
  wallets: {},
  sessions: {},
  lastUpdated: new Date(0).toISOString(),
};

export async function readState(path: string = PATH_STATE): Promise<StateFile> {
  if (!existsSync(path)) return { ...EMPTY_STATE };
  const text = await readFile(path, "utf8");
  try {
    const parsed = JSON.parse(text) as StateFile;
    return {
      wallets: parsed.wallets ?? {},
      sessions: parsed.sessions ?? {},
      lastUpdated: parsed.lastUpdated ?? new Date(0).toISOString(),
      biometryMigrated: parsed.biometryMigrated ?? false,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export async function writeState(state: StateFile, path: string = PATH_STATE): Promise<void> {
  await ensureKuraHome();
  state.lastUpdated = new Date().toISOString();
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export async function listWallets(): Promise<WalletProfile[]> {
  const state = await readState();
  return Object.values(state.wallets);
}

export async function isBiometryMigrated(): Promise<boolean> {
  const state = await readState();
  return state.biometryMigrated === true;
}

export async function markBiometryMigrated(): Promise<void> {
  const state = await readState();
  if (state.biometryMigrated === true) return;
  state.biometryMigrated = true;
  await writeState(state);
}

export async function getWallet(name: string): Promise<WalletProfile | null> {
  const state = await readState();
  return state.wallets[name] ?? null;
}

export async function upsertWallet(profile: WalletProfile): Promise<void> {
  const state = await readState();
  state.wallets[profile.name] = profile;
  await writeState(state);
}

export async function removeWallet(name: string): Promise<void> {
  const state = await readState();
  delete state.wallets[name];
  await writeState(state);
}

export async function listSessions(): Promise<StateFile["sessions"]> {
  const state = await readState();
  return state.sessions;
}

export async function upsertSession(
  origin: string,
  session: StateFile["sessions"][string],
): Promise<void> {
  const state = await readState();
  state.sessions[origin] = session;
  await writeState(state);
}

export async function removeSession(origin: string): Promise<void> {
  const state = await readState();
  delete state.sessions[origin];
  await writeState(state);
}
