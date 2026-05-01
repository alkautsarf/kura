export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export type Tier = 1 | 2;

export interface ChainCapabilities {
  history: "hypersync" | "alchemy" | "rpc-only";
  simulation: "tenderly" | "rpc-only";
  risk: "goplus-full" | "goplus-partial" | "minimal";
  contractSource: "etherscan" | "none";
}

export interface KuraChainConfig {
  id: number;
  name: string;
  symbol: string;
  tier: Tier;
  rpcUrl: string;
  explorer: string;
  capabilities: ChainCapabilities;
  hyperSyncUrl?: string;
  alchemyNetwork?: string;
  testnet?: boolean;
}

export type NetworkMode = "mainnet" | "testnet";

export type RequestKind =
  | "eth_sendTransaction"
  | "personal_sign"
  | "eth_signTypedData_v4"
  | "connect"
  | "switch_chain"
  | "batch";

export type RiskLevel = "safe" | "review" | "danger";

export interface PendingRequest {
  id: string;
  kind: RequestKind;
  source: string;
  chainId: number;
  payload: unknown;
  createdAt: number;
}

export interface AuditEvent {
  ts: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface DappSession {
  origin: string;
  walletName: string;
  address: Address;
  chainId: number;
  connectedAt: number;
}

export type WalletSource =
  | "generated"
  | "imported-seed"
  | "imported-private-key"
  | "watch-only"
  | "keychain-shared";

export interface WalletProfile {
  name: string;
  address: Address;
  createdAt: string;
  watchOnly: boolean;
  source: WalletSource;
  keychainService?: string;
}

export interface KuraConfig {
  defaultWallet: string;
  defaultChain: number;
  safeThresholdUsd: number;
  daemonPort: number;
  daemonHost: string;
  proxyEnabled: boolean;
  proxyPort: number;
  proxyDomains: string[];
  tenderlyAccount?: string;
  tenderlyProject?: string;
  networkMode: NetworkMode;
}

export interface RiskFinding {
  id: string;
  level: RiskLevel;
  message: string;
  detail?: Record<string, unknown>;
}

export interface RiskResult {
  level: RiskLevel;
  findings: RiskFinding[];
}

export interface BalanceDiff {
  token: string;
  symbol: string;
  decimals: number;
  delta: string;
  usd?: number;
}

export interface SimulationResult {
  ok: boolean;
  reason?: string;
  gasUsed?: string;
  diffs: BalanceDiff[];
  raw?: unknown;
}

export interface ActivityItem {
  hash: Hex;
  blockNumber: number;
  timestamp: number;
  from: Address;
  to: Address | null;
  value: string;
  token?: string;
  symbol?: string;
  decimals?: number;
  direction: "in" | "out" | "self";
  kind: "native" | "erc20" | "contract";
  // Human-readable summary of what the tx does, populated by history.ts via
  // describeTx for contract calls and getTokenMeta for ERC20 transfers.
  // Falls back to `${arrow} ${amount} ${symbol}` rendering when absent.
  description?: string;
  // True when the row is filtered out by spam/dust heuristics. Kept on the
  // item so callers can opt-in to showing them (e.g., `kura history --all`).
  isDust?: boolean;
}


export interface DecodedCall {
  selector: Hex;
  signature?: string;
  contract?: Address;
  args?: unknown[];
}

export interface DappRecord {
  origin: string;
  name: string;
  category?: string;
  url?: string;
  audits?: number;
  auditLinks?: string[];
}

export interface PortfolioToken {
  token: Address | "native";
  symbol: string;
  decimals: number;
  balance: string;
  usd?: number;
  pct?: number;
  // Tokens flagged as spam by Alchemy or with no USD price + small balance
  // get marked here so the TUI can de-prioritize / hide them.
  unverified?: boolean;
  spam?: boolean;
}

export interface Portfolio {
  walletName: string;
  address: Address;
  chainId: number;
  totalUsd: number;
  change24hPct?: number;
  tokens: PortfolioToken[];
}
