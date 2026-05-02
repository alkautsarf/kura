import { COLOR } from "../format.ts";
import { post } from "../client.ts";
import { resolve as resolveName } from "../../core/resolve.ts";
import { getConfig, getWallet } from "../../core/config.ts";
import { priceBySymbol, priceByAddress } from "../../core/prices.ts";
import { tokenBalances } from "../../core/balance.ts";
import { parseUnits } from "viem";
import { encodeErc20Transfer } from "../../core/decode-tx.ts";
import type { Address } from "../../core/types.ts";

export async function run(positional: string[], args: { chain?: string | number; wallet?: string; note?: string }): Promise<void> {
  if (positional.length < 3) {
    console.error("usage: kura send <amount|$usd> <token> <to> [--chain N] [--wallet name]");
    process.exit(1);
  }
  const [rawAmount, tokenSym, toRaw] = positional;
  const cfg = await getConfig();
  const chainId = Number(args.chain ?? cfg.defaultChain);
  const walletName = args.wallet ?? cfg.defaultWallet;
  const wallet = await getWallet(walletName);
  if (!wallet) {
    console.error(`unknown wallet: ${walletName}`);
    process.exit(1);
  }
  const resolved = await resolveName(toRaw!);
  if (!resolved.address) {
    console.error(`could not resolve: ${toRaw}`);
    process.exit(1);
  }

  const isNative = tokenSym!.toUpperCase() === "ETH" || tokenSym!.toUpperCase() === "BNB" || tokenSym!.toUpperCase() === "MON";
  let tokenAddr: Address | "native" = "native";
  let decimals = 18;
  if (!isNative) {
    const balances = await tokenBalances(chainId, wallet.address);
    const found = balances.find((b) => b.symbol.toUpperCase() === tokenSym!.toUpperCase());
    if (!found) {
      console.error(`no ${tokenSym} balance on chain ${chainId}`);
      process.exit(1);
    }
    tokenAddr = found.token as Address;
    decimals = found.decimals;
  }

  let amount: bigint;
  if (rawAmount!.startsWith("$")) {
    const usd = Number(rawAmount!.slice(1));
    const price = isNative
      ? await priceBySymbol(tokenSym!.toUpperCase())
      : await priceByAddress(chainId, tokenAddr as string);
    if (!price) {
      console.error(`no price for ${tokenSym}, can't convert $`);
      process.exit(1);
    }
    amount = parseUnits((usd / price).toFixed(decimals), decimals);
  } else {
    amount = parseUnits(rawAmount!, decimals);
  }

  console.log(`${COLOR.bold}sending ${rawAmount} ${tokenSym} to ${resolved.address}${COLOR.reset}`);
  console.log(`${COLOR.dim}wallet ${walletName} on chain ${chainId}${COLOR.reset}`);

  const data = isNative ? "0x" : encodeErc20Transfer(resolved.address as Address, amount);
  const payload = {
    from: wallet.address,
    to: isNative ? resolved.address : (tokenAddr as Address),
    data,
    value: isNative ? amount.toString() : "0",
  };
  const result = await post("/requests", {
    kind: "eth_sendTransaction",
    chainId,
    source: "cli:send",
    payload,
  }) as { decision: string; txHash?: string; error?: string };
  if (result.decision === "approve" && result.txHash) {
    console.log(`${COLOR.green}approved${COLOR.reset}  ${result.txHash}`);
  } else if (result.decision === "approve") {
    console.log(`${COLOR.yellow}approved-but-signer-failed${COLOR.reset}  ${result.error ?? "(no error msg)"}`);
  } else {
    console.log(`${COLOR.red}${result.decision}${COLOR.reset}${result.error ? `  ${result.error}` : ""}`);
  }
}
