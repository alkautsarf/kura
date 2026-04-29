import { formatUnits } from "viem";

export const COLOR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

export function fmtUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

export function fmtTok(raw: string | bigint, decimals: number, max = 4): string {
  const n = Number(formatUnits(typeof raw === "bigint" ? raw : BigInt(raw), decimals));
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(max);
}

export function fmtAddr(addr: string | null | undefined, length = 6): string {
  if (!addr) return "-";
  if (addr.length <= length * 2 + 2) return addr;
  return `${addr.slice(0, length + 2)}...${addr.slice(-length)}`;
}

export function fmtAge(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function levelColor(level: "safe" | "review" | "danger"): string {
  switch (level) {
    case "safe": return COLOR.green;
    case "review": return COLOR.yellow;
    case "danger": return COLOR.red;
  }
}

export function levelGlyph(level: "safe" | "review" | "danger"): string {
  switch (level) {
    case "safe": return "[OK]";
    case "review": return "[!!]";
    case "danger": return "[XX]";
  }
}
