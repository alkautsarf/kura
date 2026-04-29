import { COLOR } from "../format.ts";

export async function run(positional: string[]): Promise<void> {
  console.log(`${COLOR.dim}kura swap is a placeholder for v0.1; route via a dapp through the qutebrowser shim.${COLOR.reset}`);
  console.log(`positional: ${positional.join(" ")}`);
}
