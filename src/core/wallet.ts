import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, WalletProfile } from "./types.ts";
import {
  walletService,
  writeWalletKey,
  walletExists,
  deleteWalletKey,
  readPassword,
} from "./keychain.ts";
import { getConfig, getWallet, listWallets, removeWallet, setDefaultWallet, upsertWallet } from "./config.ts";

export interface NewWalletResult {
  profile: WalletProfile;
  privateKey?: string;
}

function normalizeKey(hex: string): `0x${string}` {
  const trimmed = hex.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

export async function createGeneratedWallet(name: string): Promise<NewWalletResult> {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  await writeWalletKey(name, privateKey);
  const profile: WalletProfile = {
    name,
    address,
    createdAt: new Date().toISOString(),
    watchOnly: false,
    source: "generated",
  };
  await upsertWallet(profile);
  return { profile, privateKey };
}

export async function createImportedWallet(name: string, hexKey: string): Promise<NewWalletResult> {
  const privateKey = normalizeKey(hexKey);
  const address = privateKeyToAccount(privateKey).address;
  await writeWalletKey(name, privateKey);
  const profile: WalletProfile = {
    name,
    address,
    createdAt: new Date().toISOString(),
    watchOnly: false,
    source: "imported-private-key",
  };
  await upsertWallet(profile);
  return { profile };
}

export async function createWatchOnlyWallet(name: string, address: Address): Promise<NewWalletResult> {
  const profile: WalletProfile = {
    name,
    address,
    createdAt: new Date().toISOString(),
    watchOnly: true,
    source: "watch-only",
  };
  await upsertWallet(profile);
  return { profile };
}

export async function createSharedKeychainWallet(
  name: string,
  service: string,
  account: string,
): Promise<NewWalletResult> {
  const key = await readPassword(service, account);
  if (!key) throw new Error(`keychain entry ${service}/${account} not found`);
  const address = privateKeyToAccount(normalizeKey(key)).address;
  const profile: WalletProfile = {
    name,
    address,
    createdAt: new Date().toISOString(),
    watchOnly: false,
    source: "keychain-shared",
    keychainService: service,
  };
  await upsertWallet(profile);
  return { profile };
}

export interface DeleteWalletOptions {
  purgeKey?: boolean;
}

export async function deleteWallet(name: string, opts: DeleteWalletOptions = {}): Promise<void> {
  const profile = await getWallet(name);
  if (!profile) throw new Error(`wallet ${name} not found`);
  await removeWallet(name);
  if (opts.purgeKey && !profile.watchOnly && profile.source !== "keychain-shared") {
    if (await walletExists(name)) {
      await deleteWalletKey(name, `kura: purge ${name} keychain entry`);
    }
  }
}

export interface WalletExistsResult {
  inState: boolean;
  inKeychain: boolean;
}

export async function walletPresence(name: string): Promise<WalletExistsResult> {
  const inState = (await getWallet(name)) !== null;
  const inKeychain = await walletExists(name);
  return { inState, inKeychain };
}

// Pick a sensible new default when the current default is being deleted: first
// remaining wallet by insertion order, or null if none left.
export async function pickFallbackDefault(removingName: string): Promise<string | null> {
  const wallets = await listWallets();
  const remaining = wallets.filter((w) => w.name !== removingName);
  return remaining[0]?.name ?? null;
}

const VALID_WALLET_NAME = /^[a-z0-9_-]+$/i;

export function isValidWalletName(name: string): boolean {
  return VALID_WALLET_NAME.test(name);
}

export interface RemoveWalletResult {
  newDefault: string | null;
  wasDefault: boolean;
}

export async function removeWalletWithFallback(
  name: string,
  opts: DeleteWalletOptions = {},
): Promise<RemoveWalletResult> {
  const cfg = await getConfig();
  const wasDefault = cfg.defaultWallet === name;
  await deleteWallet(name, opts);
  if (!wasDefault) return { newDefault: cfg.defaultWallet, wasDefault: false };
  const fallback = await pickFallbackDefault(name);
  if (fallback) await setDefaultWallet(fallback);
  return { newDefault: fallback, wasDefault: true };
}
