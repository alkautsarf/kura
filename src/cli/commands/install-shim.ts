import { installShim } from "../../shim/install.ts";
import { COLOR } from "../format.ts";

export async function run(args: { force?: boolean; xdg?: boolean }): Promise<void> {
  const result = await installShim({ force: args.force, preferXdg: args.xdg });
  console.log(`${COLOR.green}installed${COLOR.reset}  ${result.path}`);
  if (result.note) console.log(`${COLOR.dim}${result.note}${COLOR.reset}`);
}
