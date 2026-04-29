import { get } from "../client.ts";
import { COLOR } from "../format.ts";
import type { AuditEvent } from "../../core/types.ts";

export async function run(args: { limit?: string | number; source?: string; since?: string; rejected?: boolean; json?: boolean }): Promise<void> {
  const params = new URLSearchParams();
  if (args.limit) params.set("limit", String(args.limit));
  if (args.since) params.set("since", args.since);
  const { events } = (await get(`/audit?${params}`)) as { events: AuditEvent[] };
  let filtered = events;
  if (args.source) filtered = filtered.filter((e) => (e.payload as { source?: string }).source === args.source);
  if (args.rejected) filtered = filtered.filter((e) => (e.payload as { decision?: string }).decision === "reject");
  if (args.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }
  if (filtered.length === 0) {
    console.log(`${COLOR.dim}no audit events${COLOR.reset}`);
    return;
  }
  for (const e of filtered) {
    const summary = JSON.stringify(e.payload);
    console.log(`  ${COLOR.dim}${e.ts}${COLOR.reset}  ${COLOR.bold}${e.type}${COLOR.reset}  ${COLOR.dim}${summary.slice(0, 120)}${COLOR.reset}`);
  }
}
