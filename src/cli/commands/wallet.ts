import { isAddress } from "viem";
import { COLOR, fmtAddr } from "../format.ts";
import { ask, askSecret, choose, confirm, readStdin } from "../prompt.ts";
import {
  getConfig,
  getWallet,
  isBiometryMigrated,
  listWallets,
  markBiometryMigrated,
  setDefaultWallet,
} from "../../core/config.ts";
import {
  createGeneratedWallet,
  createImportedWallet,
  createSharedKeychainWallet,
  createWatchOnlyWallet,
  deleteWallet,
  removeWalletWithFallback,
  walletPresence,
} from "../../core/wallet.ts";
import {
  WALLET_ACCOUNT,
  deletePassword,
  gateBiometryOrThrow,
  readPassword,
  signerAvailable,
  walletService,
  writeWalletKey,
} from "../../core/keychain.ts";
import type { Address, WalletProfile } from "../../core/types.ts";

interface WalletArgs {
  _: string[];
  generate?: boolean;
  importKey?: string;
  watchOnly?: string;
  default?: boolean;
  purgeKey?: boolean;
  yes?: boolean;
}

export async function run(args: WalletArgs): Promise<void> {
  const sub = args._[0] ?? "list";
  switch (sub) {
    case "list":
    case "ls":
      return listCmd();
    case "add":
      return addCmd(args);
    case "use":
    case "switch":
      return useCmd(args);
    case "remove":
    case "rm":
      return removeCmd(args);
    case "show":
      return showCmd(args);
    case "migrate":
      return migrateCmd();
    default:
      throw new Error(`unknown wallet subcommand: ${sub}\nusage: kura wallet [list|add|use|remove|show|migrate]`);
  }
}

async function migrateCmd(): Promise<void> {
  if (!signerAvailable()) {
    console.log(`${COLOR.yellow}WARN${COLOR.reset} kura-signer not built; nothing to migrate.`);
    console.log(`${COLOR.dim}build with: cd swift && swift build -c release${COLOR.reset}`);
    return;
  }
  if (await isBiometryMigrated()) {
    console.log("already migrated. all wallets use Touch ID via kura-signer.");
    return;
  }
  const wallets = (await listWallets()).filter((w) => !w.watchOnly && w.source !== "keychain-shared");
  if (wallets.length === 0) {
    console.log("no hot wallets to migrate.");
    await markBiometryMigrated();
    return;
  }
  console.log(`migrating ${wallets.length} wallet${wallets.length === 1 ? "" : "s"} to Touch ID...`);
  console.log(`${COLOR.dim}each wallet pops one Mac password prompt (read old entry); after that all reads use Touch ID.${COLOR.reset}\n`);
  let migrated = 0;
  let failed = 0;
  for (const w of wallets) {
    process.stdout.write(`  ${w.name.padEnd(24)} `);
    try {
      const key = await readPassword(walletService(w.name), WALLET_ACCOUNT);
      if (!key) {
        console.log(`${COLOR.yellow}skip${COLOR.reset} (no key in keychain)`);
        continue;
      }
      // Use raw deletePassword (not deleteWalletKey) so the OLD entry's password-ACL
      // is the only thing we satisfy. deleteWalletKey would route through kura-signer
      // which calls LAContext.evaluatePolicy — but the new biometry-gated entry doesn't
      // exist yet, so that call would fail or pop a prompt for a non-existent entry.
      await deletePassword(walletService(w.name), WALLET_ACCOUNT);
      await writeWalletKey(w.name, key);
      console.log(`${COLOR.green}ok${COLOR.reset}`);
      migrated++;
    } catch (err) {
      console.log(`${COLOR.red}error${COLOR.reset}: ${(err as Error).message}`);
      failed++;
    }
  }
  if (failed === 0) {
    await markBiometryMigrated();
    console.log(`\n${COLOR.green}OK${COLOR.reset} migrated ${migrated}/${wallets.length}. future signs will Touch ID.`);
  } else {
    console.log(`\n${COLOR.yellow}WARN${COLOR.reset} migrated ${migrated}/${wallets.length} (${failed} failed). Re-run after fixing errors.`);
  }
}

async function listCmd(): Promise<void> {
  const [wallets, cfg] = await Promise.all([listWallets(), getConfig()]);
  if (wallets.length === 0) {
    console.log("no wallets configured. add one with: kura wallet add <name>");
    return;
  }
  const defaultName = cfg.defaultWallet;
  const nameWidth = Math.max(8, ...wallets.map((w) => w.name.length));
  console.log(
    `${COLOR.dim}default  ${"name".padEnd(nameWidth)}  address                                         source${COLOR.reset}`,
  );
  for (const w of wallets) {
    const star = w.name === defaultName ? `${COLOR.green}  *    ${COLOR.reset}` : "       ";
    const name = w.name === defaultName ? `${COLOR.bold}${w.name.padEnd(nameWidth)}${COLOR.reset}` : w.name.padEnd(nameWidth);
    const addr = w.address.padEnd(44);
    console.log(`${star} ${name}  ${addr}  ${COLOR.dim}${w.source}${COLOR.reset}`);
  }
}

async function addCmd(args: WalletArgs): Promise<void> {
  const name = args._[1];
  if (!name) throw new Error("usage: kura wallet add <name> [--generate | --import-key <key|-> | --watch-only <addr>] [--default]");
  const presence = await walletPresence(name);
  if (presence.inState) throw new Error(`wallet ${name} already exists. remove it first or pick a different name`);
  if (presence.inKeychain) {
    console.log(`${COLOR.yellow}WARN${COLOR.reset} keychain entry ${walletService(name)} exists; will be overwritten`);
  }
  if (!signerAvailable()) {
    console.log(`${COLOR.dim}note: kura-signer not built; key will use plain Keychain (password prompt instead of Touch ID)${COLOR.reset}`);
  }

  let result;
  if (args.generate) {
    await gateBiometryOrThrow(`kura: reveal new private key for ${name}`);
    result = await createGeneratedWallet(name);
    console.log(`${COLOR.yellow}IMPORTANT${COLOR.reset} new wallet generated. address: ${result.profile.address}`);
    console.log(`${COLOR.yellow}IMPORTANT${COLOR.reset} private key WILL be stored in macOS Keychain only.`);
    console.log(`${COLOR.yellow}IMPORTANT${COLOR.reset} Keychain is NOT a backup. Write down the key NOW:`);
    console.log(`  ${COLOR.bold}${result.privateKey}${COLOR.reset}`);
    if (!args.yes) {
      const ack = await confirm("backed up?", false);
      if (!ack) {
        await deleteWallet(name, { purgeKey: true });
        throw new Error("backup not confirmed; aborted (wallet removed)");
      }
    }
  } else if (args.importKey !== undefined) {
    const hex = args.importKey === "-" ? await readStdin() : args.importKey;
    if (!hex) throw new Error("empty private key");
    result = await createImportedWallet(name, hex);
  } else if (args.watchOnly !== undefined) {
    if (!isAddress(args.watchOnly)) {
      throw new Error(`invalid address: ${args.watchOnly}`);
    }
    result = await createWatchOnlyWallet(name, args.watchOnly);
  } else {
    const choice = await choose("how do you want to set up the wallet?", [
      { label: "generate new (random)", value: "generate" },
      { label: "import private key (paste)", value: "key" },
      { label: "watch-only address", value: "watch" },
      { label: "use existing keychain item", value: "keychain" },
    ]);
    if (choice === "generate") {
      await gateBiometryOrThrow(`kura: reveal new private key for ${name}`);
      result = await createGeneratedWallet(name);
      console.log(`${COLOR.yellow}IMPORTANT${COLOR.reset} new wallet generated. address: ${result.profile.address}`);
      console.log(`${COLOR.yellow}IMPORTANT${COLOR.reset} private key WILL be stored in macOS Keychain only.`);
      console.log(`${COLOR.yellow}IMPORTANT${COLOR.reset} Keychain is NOT a backup. Write down the key NOW:`);
      console.log(`  ${COLOR.bold}${result.privateKey}${COLOR.reset}`);
      const ack = await confirm("backed up?", false);
      if (!ack) {
        await deleteWallet(name, { purgeKey: true });
        throw new Error("backup not confirmed; aborted (wallet removed)");
      }
    } else if (choice === "key") {
      const hex = (await askSecret("private key (0x...)")).trim();
      if (!hex) throw new Error("empty private key");
      result = await createImportedWallet(name, hex);
    } else if (choice === "watch") {
      const addr = await ask("address (0x...)");
      if (!isAddress(addr)) throw new Error(`invalid address: ${addr}`);
      result = await createWatchOnlyWallet(name, addr);
    } else {
      const svc = await ask("keychain service (e.g., xyz.pragma.kura)");
      const acct = await ask("account", "key");
      result = await createSharedKeychainWallet(name, svc, acct);
    }
  }

  console.log(`${COLOR.green}OK${COLOR.reset} wallet ${COLOR.bold}${name}${COLOR.reset}: ${result.profile.address} (${result.profile.source})`);

  if (args.default) {
    await setDefaultWallet(name);
    console.log(`${COLOR.green}OK${COLOR.reset} default wallet -> ${name}`);
  } else {
    const cfg = await getConfig();
    if (cfg.defaultWallet === name) {
      // The added name was already the default in config (not unusual on first
      // setup when default_wallet defaults to "main"). Reflect that.
      console.log(`${COLOR.dim}(this name matches the configured default_wallet)${COLOR.reset}`);
    } else {
      console.log(`${COLOR.dim}set as default with: kura wallet use ${name}${COLOR.reset}`);
    }
  }
}

async function useCmd(args: WalletArgs): Promise<void> {
  const name = args._[1];
  if (!name) throw new Error("usage: kura wallet use <name>");
  const profile = await getWallet(name);
  if (!profile) throw new Error(`wallet ${name} not found. list wallets with: kura wallet list`);
  await setDefaultWallet(name);
  console.log(`${COLOR.green}OK${COLOR.reset} default wallet -> ${name} (${fmtAddr(profile.address)})`);
}

async function removeCmd(args: WalletArgs): Promise<void> {
  const name = args._[1];
  if (!name) throw new Error("usage: kura wallet remove <name> [--purge-key]");
  const profile = await getWallet(name);
  if (!profile) throw new Error(`wallet ${name} not found`);

  if (!args.yes) {
    const purge = args.purgeKey ? " AND delete its keychain entry" : "";
    const ok = await confirm(`remove wallet ${COLOR.bold}${name}${COLOR.reset} (${profile.address})${purge}?`, false);
    if (!ok) {
      console.log("cancelled");
      return;
    }
  }
  const result = await removeWalletWithFallback(name, { purgeKey: args.purgeKey });
  console.log(`${COLOR.green}OK${COLOR.reset} removed wallet ${name}`);
  if (args.purgeKey && !profile.watchOnly && profile.source !== "keychain-shared") {
    console.log(`${COLOR.green}OK${COLOR.reset} keychain entry ${walletService(name)} deleted`);
  }
  if (result.wasDefault) {
    if (result.newDefault) {
      console.log(`${COLOR.dim}default wallet -> ${result.newDefault}${COLOR.reset}`);
    } else {
      console.log(`${COLOR.yellow}WARN${COLOR.reset} that was the only wallet; default_wallet still points at ${name}. Add a new wallet with: kura wallet add <name>`);
    }
  }
}

async function showCmd(args: WalletArgs): Promise<void> {
  const name = args._[1];
  if (!name) throw new Error("usage: kura wallet show <name>");
  const [profile, cfg] = await Promise.all([getWallet(name), getConfig()]);
  if (!profile) throw new Error(`wallet ${name} not found`);
  printWallet(profile, cfg.defaultWallet === name);
}

function printWallet(w: WalletProfile, isDefault: boolean): void {
  console.log(`${COLOR.bold}${w.name}${COLOR.reset}${isDefault ? `  ${COLOR.green}(default)${COLOR.reset}` : ""}`);
  console.log(`  address      ${w.address}`);
  console.log(`  source       ${w.source}`);
  console.log(`  watch-only   ${w.watchOnly}`);
  if (w.keychainService) console.log(`  keychain     ${w.keychainService}`);
  console.log(`  created      ${w.createdAt}`);
  if (!w.watchOnly && w.source !== "keychain-shared") {
    console.log(`  key location ${walletService(w.name)} / key`);
  }
}

