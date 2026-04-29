import { formatUnits } from "viem";
import { get } from "../client.ts";
import { COLOR, fmtUsd } from "../format.ts";
import type { Portfolio } from "../../core/types.ts";

export async function run(args: { chain?: string | number; wallet?: string; address?: string }): Promise<void> {
  const params = new URLSearchParams();
  if (args.chain) params.set("chain", String(args.chain));
  if (args.wallet) params.set("wallet", args.wallet);
  if (args.address) params.set("address", args.address);
  const data = (await get(`/portfolio?${params}`)) as Portfolio;
  console.log(`${COLOR.bold}${data.address}${COLOR.reset}  ${COLOR.dim}chain ${data.chainId}${COLOR.reset}`);
  console.log(`${COLOR.bold}${fmtUsd(data.totalUsd)}${COLOR.reset} total`);
  console.log("");
  for (const t of data.tokens) {
    if ((t.usd ?? 0) < 0.01 && t.token !== "native") continue;
    const amount = Number(formatUnits(BigInt(t.balance), t.decimals));
    const left = amount.toFixed(amount < 1 ? 4 : 2).padStart(14);
    const usd = fmtUsd(t.usd).padStart(10);
    const pct = (t.pct ?? 0).toFixed(1).padStart(5) + "%";
    console.log(`  ${t.symbol.padEnd(8)} ${left} ${usd} ${COLOR.dim}${pct}${COLOR.reset}`);
  }
}
