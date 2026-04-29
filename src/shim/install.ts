import { existsSync } from "node:fs";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { QUTEBROWSER_LEGACY, QUTEBROWSER_XDG } from "../core/paths.ts";
import { getOrCreateSecret } from "../core/secret.ts";
import { getConfig } from "../core/config.ts";
import { USERSCRIPT_TEMPLATE } from "./template.ts";

export interface InstallResult {
  path: string;
  note?: string;
}

async function pickDir(preferXdg: boolean | undefined): Promise<string> {
  if (preferXdg) return QUTEBROWSER_XDG;
  if (existsSync(dirname(QUTEBROWSER_LEGACY))) return QUTEBROWSER_LEGACY;
  return QUTEBROWSER_XDG;
}

export async function installShim(opts: { force?: boolean; preferXdg?: boolean } = {}): Promise<InstallResult> {
  const dir = await pickDir(opts.preferXdg);
  await mkdir(dir, { recursive: true });
  const target = join(dir, "kura.user.js");
  if (existsSync(target) && !opts.force) {
    const s = await stat(target);
    if (s.size > 0) {
      return { path: target, note: "already exists, pass --force to overwrite" };
    }
  }
  const cfg = await getConfig();
  const secret = await getOrCreateSecret();
  const script = USERSCRIPT_TEMPLATE.replace(/__KURA_SECRET__/g, secret)
    .replace(/__KURA_HOST__/g, cfg.daemonHost)
    .replace(/__KURA_PORT__/g, String(cfg.daemonPort));
  await writeFile(target, script);
  return { path: target };
}
