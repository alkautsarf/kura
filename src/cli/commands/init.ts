import { existsSync } from "node:fs";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { mnemonicToAccount } from "viem/accounts";
import { COLOR } from "../format.ts";
import { ask, askSecret, confirm, choose, readStdin } from "../prompt.ts";
import { KURA_HOME } from "../../core/paths.ts";
import { DEFAULT_CONFIG, ensureKuraHome, writeConfig, getWallet } from "../../core/config.ts";
import { getOrCreateSecret } from "../../core/secret.ts";
import {
  walletService,
  writePassword,
  exists,
  walletExists,
  signerAvailable,
  readAlchemyKey,
  readEnvioToken,
  readTenderlyKey,
  SVC_ALCHEMY,
  SVC_ENVIO,
  SVC_TENDERLY,
} from "../../core/keychain.ts";
import {
  createGeneratedWallet,
  createImportedWallet,
  createWatchOnlyWallet,
  createSharedKeychainWallet,
} from "../../core/wallet.ts";
import { installShim } from "../../shim/install.ts";
import { BUNDLED_CHAINS } from "../../core/chains.ts";
import type { Address, KuraConfig, WalletProfile } from "../../core/types.ts";

interface RunArgs {
  name?: string;
  importSeed?: string;
  importKey?: string;
  watchOnly?: string;
  reuseKeychain?: string;
  skipShim?: boolean;
  skipAutostart?: boolean;
  skipSanity?: boolean;
  defaultChain?: number;
  safeThreshold?: number;
  daemonPort?: number;
}

export async function run(args: RunArgs): Promise<void> {
  console.log(`${COLOR.bold}kura init${COLOR.reset}`);
  console.log(`step 1/8: per-install secret`);
  await ensureKuraHome();
  const secret = await getOrCreateSecret();
  console.log(`${COLOR.green}OK${COLOR.reset} secret ready (${secret.slice(0, 8)}...)`);

  console.log(`\nstep 2/8: daemon auto-start`);
  await setupAutostart(args);

  console.log(`\nstep 3/8: wallet`);
  const walletName = args.name ?? (await ask("wallet name", "main"));
  const profile = await setupWallet(walletName, args);
  console.log(`${COLOR.green}OK${COLOR.reset} wallet ${walletName}: ${profile.address}`);

  console.log(`\nstep 4/8: keychain entry`);
  if (profile.watchOnly) console.log(`${COLOR.dim}skipped (watch-only)${COLOR.reset}`);
  else console.log(`${COLOR.green}OK${COLOR.reset} stored at ${walletService(walletName)}`);

  console.log(`\nstep 5/8: qutebrowser shim`);
  if (!args.skipShim) {
    const ok = await confirm("install qutebrowser shim now?", true);
    if (ok) {
      try {
        const r = await installShim();
        console.log(`${COLOR.green}OK${COLOR.reset} userscript installed at ${r.path}`);
        if (r.note) console.log(`${COLOR.dim}${r.note}${COLOR.reset}`);
      } catch (err) {
        console.log(`${COLOR.yellow}WARN${COLOR.reset} shim install: ${(err as Error).message}`);
      }
    }
  } else {
    console.log(`${COLOR.dim}skipped (--skip-shim)${COLOR.reset}`);
  }

  console.log(`\nstep 6/8: service keys`);
  await ensureServiceKeys();

  console.log(`\nstep 7/8: chains and defaults`);
  const cfg = await confirmChains(args);
  await writeConfig({ ...cfg, defaultWallet: walletName });
  console.log(`${COLOR.green}OK${COLOR.reset} ~/.kura/config.toml written`);

  console.log(`\nstep 8/8: sanity check`);
  if (args.skipSanity) {
    console.log(`${COLOR.dim}skipped (--skip-sanity)${COLOR.reset}`);
  } else {
    await sanityCheck(cfg.defaultChain, profile.address);
  }

  console.log("");
  console.log(`${COLOR.bold}done${COLOR.reset}. start daemon: ${COLOR.cyan}kura daemon${COLOR.reset}`);
  console.log(`open TUI: ${COLOR.cyan}kura${COLOR.reset}`);
}

async function setupAutostart(args: RunArgs): Promise<void> {
  if (args.skipAutostart) {
    console.log(`${COLOR.dim}skipped (--skip-autostart)${COLOR.reset}`);
    return;
  }
  const choice = await choose("how should the daemon start?", [
    { label: "macOS launchd plist (recommended)", value: "launchd" },
    { label: "append to qutebrowser config.py", value: "qutebrowser" },
    { label: "manual (run `kura daemon` yourself)", value: "manual" },
  ]);
  if (choice === "launchd") await writeLaunchdPlist();
  else if (choice === "qutebrowser") await appendQutebrowserAutostart();
  else console.log(`${COLOR.dim}you will need to keep \`kura daemon\` running yourself${COLOR.reset}`);
}

async function writeLaunchdPlist(): Promise<void> {
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  await mkdir(plistDir, { recursive: true });
  const plistPath = join(plistDir, "xyz.kura.daemon.plist");
  const bunBin = process.execPath;
  const entry = process.argv[1] ?? "kura";
  const logDir = join(KURA_HOME, "logs");
  await mkdir(logDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>xyz.kura.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunBin}</string>
    <string>${entry}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(logDir, "daemon.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(logDir, "daemon.err.log")}</string>
  <key>WorkingDirectory</key><string>${process.cwd()}</string>
</dict>
</plist>
`;
  await writeFile(plistPath, plist);
  console.log(`${COLOR.green}OK${COLOR.reset} wrote ${plistPath}`);
  console.log(`${COLOR.dim}load now with: launchctl load -w ${plistPath}${COLOR.reset}`);
}

async function appendQutebrowserAutostart(): Promise<void> {
  const cfgPaths = [
    join(homedir(), ".qutebrowser", "config.py"),
    join(homedir(), ".config", "qutebrowser", "config.py"),
  ];
  const path = cfgPaths.find((p) => existsSync(p));
  if (!path) {
    console.log(`${COLOR.yellow}WARN${COLOR.reset} no qutebrowser config.py found at ~/.qutebrowser or ~/.config/qutebrowser`);
    return;
  }
  const block = `\n# kura daemon autostart\nimport subprocess, os\nsubprocess.Popen(['${process.execPath}', '${process.argv[1] ?? "kura"}', 'daemon'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, cwd=os.path.expanduser('${process.cwd()}'))\n`;
  const text = await Bun.file(path).text();
  if (text.includes("kura daemon autostart")) {
    console.log(`${COLOR.dim}already present in ${path}${COLOR.reset}`);
    return;
  }
  const ok = await confirm(`append autostart block to ${path}?`, true);
  if (!ok) return;
  await writeFile(path, text + block);
  console.log(`${COLOR.green}OK${COLOR.reset} appended to ${path}`);
}

async function setupWallet(name: string, args: RunArgs): Promise<WalletProfile> {
  if (await getWallet(name)) {
    console.log(`${COLOR.yellow}WARN${COLOR.reset} wallet ${name} already exists in state.json (will overwrite)`);
  }
  if (await walletExists(name)) {
    console.log(`${COLOR.yellow}WARN${COLOR.reset} keychain entry ${walletService(name)} exists, will overwrite`);
  }
  if (!signerAvailable()) {
    console.log(`${COLOR.yellow}NOTE${COLOR.reset} kura-signer (Touch ID) not built. Wallet keys will use plain Keychain (password prompt instead of Touch ID). Build with: cd swift && swift build -c release`);
  }

  if (args.importKey) {
    const hex = args.importKey === "-" ? await readStdin() : args.importKey;
    return (await createImportedWallet(name, hex)).profile;
  }
  if (args.importSeed) {
    // Derive address up-front to surface bad seed early; storage path TBD.
    mnemonicToAccount(args.importSeed);
    throw new Error("seed import requires deriving private key, not implemented for stdin yet; use --import-key");
  }
  if (args.watchOnly) {
    return (await createWatchOnlyWallet(name, args.watchOnly as Address)).profile;
  }

  const choice = await choose("how do you want to set up the wallet?", [
    { label: "generate new (random)", value: "generate" },
    { label: "import private key (paste)", value: "key" },
    { label: "import seed phrase (paste)", value: "seed" },
    { label: "watch-only address", value: "watch" },
    { label: "use existing keychain item", value: "keychain" },
  ]);
  if (choice === "watch") {
    const addr = await ask("address (0x...)");
    return (await createWatchOnlyWallet(name, addr as Address)).profile;
  }
  if (choice === "keychain") {
    const svc = await ask("keychain service (e.g., xyz.pragma.kura)");
    const acct = await ask("account", "key");
    return (await createSharedKeychainWallet(name, svc, acct)).profile;
  }
  if (choice === "generate") {
    const result = await createGeneratedWallet(name);
    console.log(`${COLOR.yellow}IMPORTANT${COLOR.reset} new wallet generated. address: ${result.profile.address}`);
    console.log(`${COLOR.yellow}IMPORTANT${COLOR.reset} private key WILL be stored in macOS Keychain only.`);
    console.log(`${COLOR.yellow}IMPORTANT${COLOR.reset} Keychain is NOT a backup. Write down the key NOW:`);
    console.log(`  ${COLOR.bold}${result.privateKey}${COLOR.reset}`);
    const ack = await confirm("backed up?", false);
    if (!ack) throw new Error("backup not confirmed; aborting");
    return result.profile;
  }
  if (choice === "key") {
    const hex = (await askSecret("private key (0x...)")).trim();
    return (await createImportedWallet(name, hex)).profile;
  }
  throw new Error("seed phrase import not implemented in v0.1; use private key");
}

async function ensureServiceKeys(): Promise<void> {
  console.log("checking service keys in keychain:");
  const wantAlchemy = readAlchemyKey().catch(() => null);
  const wantEnvio = readEnvioToken().catch(() => null);
  const wantTenderly = readTenderlyKey().catch(() => null);
  const [a, e, t] = await Promise.all([wantAlchemy, wantEnvio, wantTenderly]);
  if (a) {
    if (!(await exists(SVC_ALCHEMY, "api-key"))) {
      await writePassword({ service: SVC_ALCHEMY, account: "api-key", password: a, label: "alchemy api key for kura" });
    }
    console.log(`  ${COLOR.green}OK${COLOR.reset} Alchemy`);
  } else {
    const v = (await askSecret(`Alchemy API key (or empty to skip):`)).trim();
    if (v) {
      await writePassword({ service: SVC_ALCHEMY, account: "api-key", password: v, label: "alchemy api key for kura" });
      console.log(`  ${COLOR.green}OK${COLOR.reset} Alchemy stored`);
    } else {
      console.log(`  ${COLOR.yellow}MISSING${COLOR.reset} Alchemy (read endpoints will fail)`);
    }
  }
  if (e) console.log(`  ${COLOR.green}OK${COLOR.reset} HyperSync`);
  else {
    const v = (await askSecret(`HyperSync token from envio.dev/app/api-tokens (or empty):`)).trim();
    if (v) {
      await writePassword({ service: SVC_ENVIO, account: "hypersync-token", password: v, label: "envio hypersync token for kura" });
      console.log(`  ${COLOR.green}OK${COLOR.reset} HyperSync stored`);
    } else {
      console.log(`  ${COLOR.yellow}MISSING${COLOR.reset} HyperSync (history will fail)`);
    }
  }
  if (t) console.log(`  ${COLOR.green}OK${COLOR.reset} Tenderly`);
  else {
    const v = (await askSecret(`Tenderly access key (or empty):`)).trim();
    if (v) {
      await writePassword({ service: SVC_TENDERLY, account: "access-key", password: v, label: "tenderly access key for kura" });
      console.log(`  ${COLOR.green}OK${COLOR.reset} Tenderly stored`);
    } else {
      console.log(`  ${COLOR.yellow}MISSING${COLOR.reset} Tenderly (sim disabled, treated as risk:review)`);
    }
  }
}

async function confirmChains(args: RunArgs): Promise<KuraConfig> {
  console.log(`bundled chains:`);
  for (const c of BUNDLED_CHAINS) {
    console.log(`  - ${c.id.toString().padStart(7)} ${c.name} (tier ${c.tier}, ${c.symbol})`);
  }
  // Skip prompts when caller passed flag-overrides (or stdin is not a TTY)
  const skipPrompts = args.defaultChain !== undefined || args.safeThreshold !== undefined || args.daemonPort !== undefined || !process.stdin.isTTY;
  if (skipPrompts) {
    return {
      ...DEFAULT_CONFIG,
      defaultChain: args.defaultChain ?? DEFAULT_CONFIG.defaultChain,
      safeThresholdUsd: args.safeThreshold ?? DEFAULT_CONFIG.safeThresholdUsd,
      daemonPort: args.daemonPort ?? DEFAULT_CONFIG.daemonPort,
    };
  }
  const defaultChainStr = await ask(`default chain id`, String(DEFAULT_CONFIG.defaultChain));
  const safeStr = await ask(`safe-threshold USD (above this is flagged review)`, String(DEFAULT_CONFIG.safeThresholdUsd));
  const portStr = await ask(`daemon port`, String(DEFAULT_CONFIG.daemonPort));
  return {
    ...DEFAULT_CONFIG,
    defaultChain: Number(defaultChainStr) || DEFAULT_CONFIG.defaultChain,
    safeThresholdUsd: Number(safeStr) || DEFAULT_CONFIG.safeThresholdUsd,
    daemonPort: Number(portStr) || DEFAULT_CONFIG.daemonPort,
  };
}

async function sanityCheck(chainId: number, address: Address): Promise<void> {
  console.log(`pinging daemon endpoints (start daemon in another pane if it isn't running)`);
  const cfg = await import("../../core/config.ts").then((m) => m.getConfig());
  const base = `http://${cfg.daemonHost}:${cfg.daemonPort}`;
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    if (!health.ok) {
      console.log(`${COLOR.yellow}WARN${COLOR.reset} daemon /health returned ${health.status} (skipping further checks)`);
      return;
    }
  } catch {
    console.log(`${COLOR.yellow}WARN${COLOR.reset} daemon not reachable at ${base} (start it with \`kura daemon\` and rerun \`kura init --skip-shim\` if needed)`);
    return;
  }
  const secret = await getOrCreateSecret();
  try {
    const bal = await fetch(`${base}/balance?chain=${chainId}&address=${address}`, {
      headers: { "X-Kura-Key": secret },
      signal: AbortSignal.timeout(8000),
    });
    if (bal.ok) console.log(`  ${COLOR.green}OK${COLOR.reset} balance fetched on chain ${chainId}`);
    else console.log(`  ${COLOR.yellow}WARN${COLOR.reset} /balance returned ${bal.status}`);
  } catch (err) {
    console.log(`  ${COLOR.yellow}WARN${COLOR.reset} /balance threw: ${(err as Error).message}`);
  }
  try {
    const hist = await fetch(`${base}/history?chain=${chainId}&address=${address}&limit=1`, {
      headers: { "X-Kura-Key": secret },
      signal: AbortSignal.timeout(15000),
    });
    if (hist.ok) console.log(`  ${COLOR.green}OK${COLOR.reset} history fetched on chain ${chainId}`);
    else console.log(`  ${COLOR.yellow}WARN${COLOR.reset} /history returned ${hist.status}`);
  } catch (err) {
    console.log(`  ${COLOR.yellow}WARN${COLOR.reset} /history threw: ${(err as Error).message}`);
  }
}
