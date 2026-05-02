import { COLOR } from "../format.ts";
import { ask, choose, confirm } from "../prompt.ts";
import {
  DEFAULT_HOT_CAPABILITIES,
  getBundledChain,
  listHotChains,
  loadAllChains,
  validateRpc,
  writeHotChains,
  reloadHotChains,
} from "../../core/chains.ts";
import type { ChainCapabilities, KuraChainConfig, Tier } from "../../core/types.ts";

interface ChainArgs {
  _: string[];
  yes?: boolean;
}

export async function run(args: ChainArgs): Promise<void> {
  const sub = args._[0] ?? "list";
  switch (sub) {
    case "list":
    case "ls":
      return listCmd();
    case "add":
      return addCmd(args);
    case "remove":
    case "rm":
      return removeCmd(args);
    case "show":
      return showCmd(args);
    default:
      throw new Error(`unknown chain subcommand: ${sub}\nusage: kura chain [list|add|remove|show]`);
  }
}

async function listCmd(): Promise<void> {
  const all = await loadAllChains();
  const hot = new Set(listHotChains().map((c) => c.id));
  if (all.length === 0) {
    console.log("no chains configured");
    return;
  }
  const idW = Math.max(2, ...all.map((c) => String(c.id).length));
  const nameW = Math.max(4, ...all.map((c) => c.name.length));
  const symW = Math.max(3, ...all.map((c) => c.symbol.length));
  const head = `${COLOR.dim}${"id".padEnd(idW)}  ${"name".padEnd(nameW)}  ${"sym".padEnd(symW)}  tier  source  capabilities${COLOR.reset}`;
  console.log(head);
  for (const c of all.sort((a, b) => a.id - b.id)) {
    const src = hot.has(c.id) ? `${COLOR.green}hot${COLOR.reset}` : `${COLOR.dim}bundled${COLOR.reset}`;
    const tnet = c.testnet ? ` ${COLOR.dim}(testnet)${COLOR.reset}` : "";
    const caps = `${c.capabilities.history}/${c.capabilities.simulation}/${c.capabilities.risk}`;
    console.log(`${String(c.id).padEnd(idW)}  ${c.name.padEnd(nameW)}  ${c.symbol.padEnd(symW)}  ${String(c.tier).padEnd(4)}  ${src.padEnd(15)}  ${COLOR.dim}${caps}${COLOR.reset}${tnet}`);
  }
}

async function showCmd(args: ChainArgs): Promise<void> {
  const id = Number(args._[1]);
  if (!Number.isFinite(id)) throw new Error("usage: kura chain show <id>");
  const all = await loadAllChains();
  const c = all.find((x) => x.id === id);
  if (!c) throw new Error(`chain ${id} not found`);
  console.log(`${COLOR.bold}${c.name}${COLOR.reset}  (${c.id})`);
  console.log(`  symbol         ${c.symbol}`);
  console.log(`  tier           ${c.tier}${c.testnet ? "  (testnet)" : ""}`);
  console.log(`  rpcUrl         ${c.rpcUrl}`);
  console.log(`  explorer       ${c.explorer || "(none)"}`);
  if (c.hyperSyncUrl) console.log(`  hyperSyncUrl   ${c.hyperSyncUrl}`);
  if (c.alchemyNetwork) console.log(`  alchemy        ${c.alchemyNetwork}`);
  console.log(`  capabilities`);
  console.log(`    history      ${c.capabilities.history}`);
  console.log(`    simulation   ${c.capabilities.simulation}`);
  console.log(`    risk         ${c.capabilities.risk}`);
  console.log(`    contractSrc  ${c.capabilities.contractSource}`);
}

async function addCmd(args: ChainArgs): Promise<void> {
  const idArg = args._[1];
  const rpcArg = args._[2];
  if (!idArg || !rpcArg) {
    throw new Error("usage: kura chain add <id> <rpc-url>");
  }
  const id = Number(idArg);
  if (!Number.isFinite(id) || id <= 0) throw new Error(`bad chain id: ${idArg}`);
  if (getBundledChain(id)) {
    throw new Error(`${id} is a bundled chain; cannot override via chain.toml`);
  }
  const existing = listHotChains().find((c) => c.id === id);
  if (existing && !args.yes) {
    const ok = await confirm(`chain ${id} (${existing.name}) already in chains.toml; overwrite?`, false);
    if (!ok) {
      console.log("cancelled");
      return;
    }
  }

  process.stdout.write(`${COLOR.dim}validating ${rpcArg}...${COLOR.reset} `);
  let chainId: number;
  try {
    const r = await validateRpc(rpcArg, id);
    chainId = r.chainId;
    console.log(`${COLOR.green}ok${COLOR.reset} (chain id ${chainId})`);
  } catch (err) {
    console.log(`${COLOR.red}FAIL${COLOR.reset}`);
    throw new Error(`rpc validation failed: ${(err as Error).message}`);
  }

  const name = await ask("name", `Chain ${id}`);
  const symbol = (await ask("native symbol", "ETH")).toUpperCase();
  const explorer = await ask("explorer url (optional)", "");
  const testnet = await confirm("is this a testnet?", false);
  const hyperSync = await ask("hypersync url (optional, leave blank for none)", "");
  const alchemyNet = await ask("alchemy network slug (optional, leave blank for none)", "");

  const capabilities: ChainCapabilities = { ...DEFAULT_HOT_CAPABILITIES };
  if (hyperSync) capabilities.history = "hypersync";
  if (alchemyNet) capabilities.risk = "goplus-partial";

  const tier: Tier = 2;
  const chain: KuraChainConfig = {
    id,
    name,
    symbol,
    tier,
    testnet: testnet || undefined,
    rpcUrl: rpcArg,
    explorer,
    hyperSyncUrl: hyperSync || undefined,
    alchemyNetwork: alchemyNet || undefined,
    capabilities,
  };

  const merged = listHotChains().filter((c) => c.id !== id);
  merged.push(chain);
  await writeHotChains(merged);
  console.log(`${COLOR.green}OK${COLOR.reset} added ${name} (${id})`);
  console.log(`${COLOR.dim}note: restart the daemon to pick up the new chain (launchctl kickstart -k gui/$(id -u)/homebrew.mxcl.kura)${COLOR.reset}`);
}

async function removeCmd(args: ChainArgs): Promise<void> {
  const id = Number(args._[1]);
  if (!Number.isFinite(id)) throw new Error("usage: kura chain remove <id>");
  if (getBundledChain(id)) {
    console.log(`${COLOR.yellow}WARN${COLOR.reset} ${id} is a bundled chain; nothing to remove`);
    return;
  }
  const hot = listHotChains();
  const found = hot.find((c) => c.id === id);
  if (!found) throw new Error(`chain ${id} not in chains.toml`);
  if (!args.yes) {
    const ok = await confirm(`remove chain ${COLOR.bold}${found.name}${COLOR.reset} (${id})?`, false);
    if (!ok) {
      console.log("cancelled");
      return;
    }
  }
  const remaining = hot.filter((c) => c.id !== id);
  await writeHotChains(remaining);
  await reloadHotChains();
  console.log(`${COLOR.green}OK${COLOR.reset} removed ${found.name} (${id})`);
}
