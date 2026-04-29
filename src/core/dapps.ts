import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { DappRecord } from "./types.ts";
import { PATH_DAPPS_CACHE } from "./paths.ts";

const SOURCE = "https://api.llama.fi/protocols";
const TTL_MS = 24 * 60 * 60 * 1000;

interface RawProtocol {
  name: string;
  url?: string;
  category?: string;
  audits?: number | string;
  audit_links?: string[];
}

interface CacheFile {
  fetchedAt: number;
  protocols: DappRecord[];
}

let mem: { byOrigin: Map<string, DappRecord>; ts: number } | null = null;

function eTLDPlus1(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, "");
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join(".");
  const last3 = parts.slice(-3).join(".");
  if (parts.at(-2)! === "co" && parts.at(-1)!.length === 2) return last3;
  return last2;
}

function originKey(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return eTLDPlus1(u.hostname);
  } catch {
    return null;
  }
}

async function readCache(): Promise<CacheFile | null> {
  if (!existsSync(PATH_DAPPS_CACHE)) return null;
  try {
    const text = await readFile(PATH_DAPPS_CACHE, "utf8");
    return JSON.parse(text) as CacheFile;
  } catch {
    return null;
  }
}

async function fetchAndCache(): Promise<DappRecord[]> {
  const resp = await fetch(SOURCE);
  if (!resp.ok) throw new Error(`defillama ${resp.status}`);
  const raw = (await resp.json()) as RawProtocol[];
  const records: DappRecord[] = raw
    .filter((p) => p.category !== "CEX")
    .map((p) => {
      const origin = originKey(p.url);
      return {
        origin: origin ?? "",
        name: p.name,
        category: p.category,
        url: p.url,
        audits: typeof p.audits === "string" ? Number(p.audits) : p.audits,
        auditLinks: p.audit_links,
      };
    })
    .filter((p) => p.origin);
  const file: CacheFile = { fetchedAt: Date.now(), protocols: records };
  await mkdir(dirname(PATH_DAPPS_CACHE), { recursive: true });
  await writeFile(PATH_DAPPS_CACHE, JSON.stringify(file));
  return records;
}

async function loadMap(): Promise<Map<string, DappRecord>> {
  if (mem && Date.now() - mem.ts < TTL_MS) return mem.byOrigin;
  let records: DappRecord[];
  const cached = await readCache();
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    records = cached.protocols;
  } else {
    try {
      records = await fetchAndCache();
    } catch (err) {
      if (cached) records = cached.protocols;
      else throw err;
    }
  }
  const map = new Map<string, DappRecord>();
  for (const r of records) map.set(r.origin, r);
  mem = { byOrigin: map, ts: Date.now() };
  return map;
}

export async function lookupDapp(originOrUrl: string): Promise<DappRecord | null> {
  const key = originKey(originOrUrl) ?? originOrUrl.toLowerCase();
  const map = await loadMap();
  return map.get(key) ?? null;
}

export async function refreshDapps(): Promise<number> {
  const records = await fetchAndCache();
  mem = null;
  return records.length;
}
