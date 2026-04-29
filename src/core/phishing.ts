import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PATH_PHISHING_CACHE } from "./paths.ts";

const SOURCE = "https://raw.githubusercontent.com/MetaMask/eth-phishing-detect/master/src/config.json";
const TTL_MS = 24 * 60 * 60 * 1000;

interface CacheFile {
  fetchedAt: number;
  blacklist: string[];
  fuzzylist: string[];
  whitelist: string[];
}

let mem: { data: CacheFile; ts: number } | null = null;

async function readCache(): Promise<CacheFile | null> {
  if (!existsSync(PATH_PHISHING_CACHE)) return null;
  try {
    const text = await readFile(PATH_PHISHING_CACHE, "utf8");
    return JSON.parse(text) as CacheFile;
  } catch {
    return null;
  }
}

async function fetchAndCache(): Promise<CacheFile> {
  const resp = await fetch(SOURCE);
  if (!resp.ok) throw new Error(`phishing ${resp.status}`);
  const raw = (await resp.json()) as { blacklist?: string[]; fuzzylist?: string[]; whitelist?: string[] };
  const file: CacheFile = {
    fetchedAt: Date.now(),
    blacklist: (raw.blacklist ?? []).map((s) => s.toLowerCase()),
    fuzzylist: (raw.fuzzylist ?? []).map((s) => s.toLowerCase()),
    whitelist: (raw.whitelist ?? []).map((s) => s.toLowerCase()),
  };
  await mkdir(dirname(PATH_PHISHING_CACHE), { recursive: true });
  await writeFile(PATH_PHISHING_CACHE, JSON.stringify(file));
  return file;
}

async function load(): Promise<CacheFile> {
  if (mem && Date.now() - mem.ts < TTL_MS) return mem.data;
  let data: CacheFile;
  const cached = await readCache();
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    data = cached;
  } else {
    try {
      data = await fetchAndCache();
    } catch (err) {
      if (cached) data = cached;
      else throw err;
    }
  }
  mem = { data, ts: Date.now() };
  return data;
}

export type PhishingVerdict = "safe" | "blocked" | "fuzzy";

export async function checkOrigin(host: string): Promise<PhishingVerdict> {
  const h = host.toLowerCase().replace(/^www\./, "");
  const data = await load();
  if (data.whitelist.includes(h)) return "safe";
  if (data.blacklist.includes(h)) return "blocked";
  if (data.fuzzylist.some((f) => h.includes(f))) return "fuzzy";
  return "safe";
}

export async function refreshPhishing(): Promise<number> {
  const f = await fetchAndCache();
  mem = null;
  return f.blacklist.length;
}
