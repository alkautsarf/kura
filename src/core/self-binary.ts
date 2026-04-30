import { existsSync } from "node:fs";

const FALLBACKS = ["/opt/homebrew/bin/kura", "/usr/local/bin/kura"];

// `brew upgrade kura` removes the old Cellar dir, leaving any long-running
// daemon (or supervisor) holding a `process.execPath` that no longer exists.
// Re-spawning the binary with that path then fails with exit 127. Resolve to
// the brew symlink (which always tracks the current version) when the cellar
// path is gone.
export function resolveSelfBinary(): string {
  if (existsSync(process.execPath)) return process.execPath;
  for (const fallback of FALLBACKS) {
    if (existsSync(fallback)) return fallback;
  }
  throw new Error(
    `kura binary at ${process.execPath} no longer exists and no fallback found in ${FALLBACKS.join(" or ")}; restart the process`,
  );
}

export function isCompiledBinary(): boolean {
  return !process.execPath.includes("/bun") && !process.execPath.endsWith("bun");
}
