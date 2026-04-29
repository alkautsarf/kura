import { existsSync } from "node:fs";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { PATH_SECRET } from "./paths.ts";
import { ensureKuraHome } from "./config.ts";

export async function readSecret(path: string = PATH_SECRET): Promise<string | null> {
  if (!existsSync(path)) return null;
  const text = await readFile(path, "utf8");
  return text.trim();
}

export async function getOrCreateSecret(path: string = PATH_SECRET): Promise<string> {
  const existing = await readSecret(path);
  if (existing && existing.length >= 32) return existing;
  await ensureKuraHome();
  const fresh = randomBytes(32).toString("hex");
  await writeFile(path, fresh + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
  return fresh;
}

export async function rotateSecret(path: string = PATH_SECRET): Promise<string> {
  await ensureKuraHome();
  const fresh = randomBytes(32).toString("hex");
  await writeFile(path, fresh + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
  return fresh;
}
