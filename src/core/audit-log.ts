import { appendFile, readFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AuditEvent } from "./types.ts";
import { PATH_AUDIT } from "./paths.ts";
import { ensureKuraHome } from "./config.ts";

export async function appendAudit(event: AuditEvent, path: string = PATH_AUDIT): Promise<void> {
  await ensureKuraHome();
  const line = JSON.stringify(event) + "\n";
  const fresh = !existsSync(path);
  await appendFile(path, line);
  if (fresh) await chmod(path, 0o600);
}

export async function logAudit(
  type: string,
  payload: Record<string, unknown>,
  path: string = PATH_AUDIT,
): Promise<void> {
  await appendAudit({ ts: new Date().toISOString(), type, payload }, path);
}

export interface AuditQuery {
  source?: string;
  rejected?: boolean;
  since?: number;
  limit?: number;
}

export async function readAudit(query: AuditQuery = {}, path: string = PATH_AUDIT): Promise<AuditEvent[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  const out: AuditEvent[] = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let ev: AuditEvent;
    try {
      ev = JSON.parse(raw) as AuditEvent;
    } catch {
      continue;
    }
    if (query.source && ev.payload.source !== query.source) continue;
    if (query.rejected && ev.payload.decision !== "reject") continue;
    if (query.since && new Date(ev.ts).getTime() < query.since) continue;
    out.push(ev);
  }
  if (query.limit && out.length > query.limit) {
    return out.slice(out.length - query.limit);
  }
  return out;
}
