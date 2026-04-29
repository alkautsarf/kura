import { del, get } from "../client.ts";
import { COLOR, fmtAddr, fmtAge } from "../format.ts";

export async function run(args: { revoke?: string }): Promise<void> {
  if (args.revoke) {
    await del(`/connections?origin=${encodeURIComponent(args.revoke)}`);
    console.log(`revoked ${args.revoke}`);
    return;
  }
  const { sessions } = (await get(`/connections`)) as {
    sessions: Record<string, { walletName: string; address: string; chainId: number; connectedAt: number }>;
  };
  const entries = Object.entries(sessions);
  if (entries.length === 0) {
    console.log(`${COLOR.dim}no active connections${COLOR.reset}`);
    return;
  }
  for (const [origin, s] of entries) {
    console.log(`  ${COLOR.bold}${origin}${COLOR.reset}  ${s.walletName} ${COLOR.dim}${fmtAddr(s.address)}${COLOR.reset}  chain ${s.chainId}  ${COLOR.dim}${fmtAge(s.connectedAt)} ago${COLOR.reset}`);
  }
}
