import { readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ChainCapabilities, KuraChainConfig } from "./types.ts";
import { PATH_CHAINS } from "./paths.ts";

export const DEFAULT_HOT_CAPABILITIES: ChainCapabilities = {
  history: "rpc-only",
  simulation: "rpc-only",
  risk: "minimal",
  contractSource: "none",
};

const ALCHEMY_PLACEHOLDER = "${ALCHEMY}";

function alchemyUrl(network: string): string {
  return `https://${network}-mainnet.g.alchemy.com/v2/${ALCHEMY_PLACEHOLDER}`;
}

function alchemyTestnetUrl(network: string): string {
  return `https://${network}.g.alchemy.com/v2/${ALCHEMY_PLACEHOLDER}`;
}

export const BUNDLED_CHAINS: KuraChainConfig[] = [
  {
    id: 1,
    name: "Ethereum",
    symbol: "ETH",
    tier: 1,
    rpcUrl: alchemyUrl("eth"),
    explorer: "https://etherscan.io",
    alchemyNetwork: "eth-mainnet",
    hyperSyncUrl: "https://eth.hypersync.xyz",
    capabilities: {
      history: "hypersync",
      simulation: "tenderly",
      risk: "goplus-full",
      contractSource: "etherscan",
    },
  },
  {
    id: 8453,
    name: "Base",
    symbol: "ETH",
    tier: 1,
    rpcUrl: alchemyUrl("base"),
    explorer: "https://basescan.org",
    alchemyNetwork: "base-mainnet",
    hyperSyncUrl: "https://base.hypersync.xyz",
    capabilities: {
      history: "hypersync",
      simulation: "tenderly",
      risk: "goplus-full",
      contractSource: "none",
    },
  },
  {
    id: 42161,
    name: "Arbitrum",
    symbol: "ETH",
    tier: 1,
    rpcUrl: alchemyUrl("arb"),
    explorer: "https://arbiscan.io",
    alchemyNetwork: "arb-mainnet",
    hyperSyncUrl: "https://arbitrum.hypersync.xyz",
    capabilities: {
      history: "hypersync",
      simulation: "tenderly",
      risk: "goplus-full",
      contractSource: "etherscan",
    },
  },
  {
    id: 56,
    name: "BSC",
    symbol: "BNB",
    tier: 1,
    rpcUrl: alchemyUrl("bnb"),
    explorer: "https://bscscan.com",
    alchemyNetwork: "bnb-mainnet",
    hyperSyncUrl: "https://bsc.hypersync.xyz",
    capabilities: {
      history: "hypersync",
      simulation: "tenderly",
      risk: "goplus-full",
      contractSource: "none",
    },
  },
  {
    id: 143,
    name: "Monad",
    symbol: "MON",
    tier: 2,
    rpcUrl: alchemyUrl("monad"),
    explorer: "https://monadscan.com",
    alchemyNetwork: "monad-mainnet",
    hyperSyncUrl: "https://monad.hypersync.xyz",
    capabilities: {
      history: "hypersync",
      simulation: "tenderly",
      risk: "goplus-partial",
      contractSource: "none",
    },
  },
];

export const KNOWN_TESTNETS: KuraChainConfig[] = [
  {
    id: 11155111,
    name: "Sepolia",
    symbol: "ETH",
    tier: 2,
    testnet: true,
    rpcUrl: alchemyTestnetUrl("eth-sepolia"),
    explorer: "https://sepolia.etherscan.io",
    alchemyNetwork: "eth-sepolia",
    hyperSyncUrl: "https://sepolia.hypersync.xyz",
    capabilities: {
      history: "hypersync",
      simulation: "tenderly",
      risk: "minimal",
      contractSource: "etherscan",
    },
  },
  {
    id: 10143,
    name: "Monad Testnet",
    symbol: "MON",
    tier: 2,
    testnet: true,
    rpcUrl: alchemyTestnetUrl("monad-testnet"),
    explorer: "https://testnet.monadscan.com",
    alchemyNetwork: "monad-testnet",
    hyperSyncUrl: "https://monad-testnet.hypersync.xyz",
    capabilities: {
      history: "hypersync",
      simulation: "tenderly",
      risk: "minimal",
      contractSource: "none",
    },
  },
];

export function isTestnet(chain: KuraChainConfig | undefined): boolean {
  return !!chain?.testnet;
}

const KNOWN_BY_ID = new Map<number, KuraChainConfig>(
  [...BUNDLED_CHAINS, ...KNOWN_TESTNETS].map((c) => [c.id, c]),
);

// Hot chains live on disk in chains.toml. Sync callers (rpc.ts, signer.ts,
// balance.ts, etc.) need them visible without an await, so we mirror the file
// in-memory. Each entry point (daemon, TUI, CLI, popup) calls reloadHotChains
// once at startup to populate it; writeHotChains refreshes it after a write.
const hotCache = new Map<number, KuraChainConfig>();

export function getKnownChain(id: number): KuraChainConfig | undefined {
  return KNOWN_BY_ID.get(id) ?? hotCache.get(id);
}

export function getBundledChain(id: number): KuraChainConfig | undefined {
  return KNOWN_BY_ID.get(id);
}

export function resolveRpcUrl(chain: KuraChainConfig, alchemyKey: string): string {
  return chain.rpcUrl.replace(ALCHEMY_PLACEHOLDER, alchemyKey);
}

interface HotLoadEntry {
  id: number;
  name?: string;
  symbol?: string;
  tier?: 1 | 2;
  testnet?: boolean;
  rpcUrl?: string;
  rpc_url?: string;
  explorer?: string;
  hyperSyncUrl?: string;
  hypersync_url?: string;
  alchemyNetwork?: string;
  alchemy_network?: string;
  capabilities?: Partial<KuraChainConfig["capabilities"]>;
}

interface HotLoadFile {
  chains?: HotLoadEntry[];
}

export async function loadHotChains(path: string = PATH_CHAINS): Promise<KuraChainConfig[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  const parsed = Bun.TOML.parse(text) as HotLoadFile;
  const entries = parsed.chains ?? [];
  return entries.map((e) => normalizeHotEntry(e));
}

function normalizeHotEntry(e: HotLoadEntry): KuraChainConfig {
  const known = KNOWN_BY_ID.get(e.id);
  const base: KuraChainConfig = known ?? {
    id: e.id,
    name: e.name ?? `Chain ${e.id}`,
    symbol: e.symbol ?? "ETH",
    tier: e.tier ?? 2,
    testnet: e.testnet,
    rpcUrl: e.rpcUrl ?? e.rpc_url ?? "",
    explorer: e.explorer ?? "",
    capabilities: {
      ...DEFAULT_HOT_CAPABILITIES,
      ...(e.capabilities ?? {}),
    },
  };
  return {
    ...base,
    name: e.name ?? base.name,
    symbol: e.symbol ?? base.symbol,
    tier: e.tier ?? base.tier,
    testnet: e.testnet ?? base.testnet,
    rpcUrl: e.rpcUrl ?? e.rpc_url ?? base.rpcUrl,
    explorer: e.explorer ?? base.explorer,
    hyperSyncUrl: e.hyperSyncUrl ?? e.hypersync_url ?? base.hyperSyncUrl,
    alchemyNetwork: e.alchemyNetwork ?? e.alchemy_network ?? base.alchemyNetwork,
    capabilities: { ...base.capabilities, ...(e.capabilities ?? {}) },
  };
}

export function mergeChains(hot: KuraChainConfig[]): KuraChainConfig[] {
  const merged = new Map<number, KuraChainConfig>();
  for (const c of BUNDLED_CHAINS) merged.set(c.id, c);
  for (const c of KNOWN_TESTNETS) merged.set(c.id, c);
  for (const c of hot) merged.set(c.id, c);
  return [...merged.values()];
}

export async function loadAllChains(path: string = PATH_CHAINS): Promise<KuraChainConfig[]> {
  return mergeChains(await loadHotChains(path));
}

export async function reloadHotChains(path: string = PATH_CHAINS): Promise<KuraChainConfig[]> {
  const hot = await loadHotChains(path);
  hotCache.clear();
  for (const c of hot) hotCache.set(c.id, c);
  return hot;
}

export function listHotChains(): KuraChainConfig[] {
  return [...hotCache.values()];
}

interface ValidateResult {
  chainId: number;
}

export async function validateRpc(rpcUrl: string, expectedId?: number): Promise<ValidateResult> {
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) throw new Error(`rpc returned http ${resp.status}`);
  const json = (await resp.json()) as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(`rpc error: ${json.error.message}`);
  if (!json.result) throw new Error("rpc returned no result");
  const chainId = parseInt(json.result, 16);
  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error(`bad chain id from rpc: ${json.result}`);
  if (expectedId !== undefined && chainId !== expectedId) {
    throw new Error(`chain id mismatch: rpc says ${chainId}, expected ${expectedId}`);
  }
  return { chainId };
}

function escapeToml(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function writeHotChains(chains: KuraChainConfig[], path: string = PATH_CHAINS): Promise<void> {
  const lines: string[] = [];
  for (const c of chains) {
    lines.push("[[chains]]");
    lines.push(`id = ${c.id}`);
    lines.push(`name = "${escapeToml(c.name)}"`);
    lines.push(`symbol = "${escapeToml(c.symbol)}"`);
    lines.push(`tier = ${c.tier}`);
    if (c.testnet) lines.push("testnet = true");
    lines.push(`rpcUrl = "${escapeToml(c.rpcUrl)}"`);
    if (c.explorer) lines.push(`explorer = "${escapeToml(c.explorer)}"`);
    if (c.hyperSyncUrl) lines.push(`hyperSyncUrl = "${escapeToml(c.hyperSyncUrl)}"`);
    if (c.alchemyNetwork) lines.push(`alchemyNetwork = "${escapeToml(c.alchemyNetwork)}"`);
    lines.push("[chains.capabilities]");
    lines.push(`history = "${c.capabilities.history}"`);
    lines.push(`simulation = "${c.capabilities.simulation}"`);
    lines.push(`risk = "${c.capabilities.risk}"`);
    lines.push(`contractSource = "${c.capabilities.contractSource}"`);
    lines.push("");
  }
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, lines.join("\n"));
  await rename(tmp, path);
  await reloadHotChains(path);
}
