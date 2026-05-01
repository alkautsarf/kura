import { formatUnits } from "viem";
import { get } from "../client.ts";
import { COLOR, fmtAddr } from "../format.ts";
import type { ActivityItem } from "../../core/types.ts";

export async function run(args: { chain?: string | number; wallet?: string; address?: string; limit?: string | number }): Promise<void> {
  const params = new URLSearchParams();
  if (args.chain) params.set("chain", String(args.chain));
  if (args.wallet) params.set("wallet", args.wallet);
  if (args.address) params.set("address", args.address);
  if (args.limit) params.set("limit", String(args.limit));
  const { items } = (await get(`/history?${params}`)) as { items: ActivityItem[] };
  if (items.length === 0) {
    console.log(`${COLOR.dim}no activity${COLOR.reset}`);
    return;
  }
  for (const it of items) {
    const arrow = it.direction === "out" ? `${COLOR.red}<-${COLOR.reset}` : it.direction === "in" ? `${COLOR.green}->${COLOR.reset}` : "<>";
    const counter = it.direction === "out" ? it.to : it.from;
    const dustTag = it.isDust ? `${COLOR.dim}[dust] ${COLOR.reset}` : "";
    const left = it.description
      ? `${dustTag}${it.description}`
      : (() => {
          const amount = it.kind === "erc20"
            ? `${formatUnits(BigInt(it.value), it.decimals ?? 18)} ${it.symbol ?? fmtAddr(it.token, 4)}`
            : `${formatUnits(BigInt(it.value), 18)} ETH`;
          return `${dustTag}${arrow} ${amount}`;
        })();
    console.log(
      `  ${COLOR.dim}#${it.blockNumber.toString().padEnd(10)}${COLOR.reset} ${left.padEnd(48)} ${COLOR.dim}${fmtAddr(counter)}${COLOR.reset}  ${COLOR.dim}${fmtAddr(it.hash, 4)}${COLOR.reset}`,
    );
  }
}
