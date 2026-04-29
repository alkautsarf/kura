import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KURA_HOME } from "../core/paths.ts";

export const PATH_PAC = join(KURA_HOME, "proxy.pac");

export function buildPac(host: string, port: number, domains: string[]): string {
  const exact: string[] = [];
  const suffixes: string[] = [];
  for (const d of domains) {
    const s = d.toLowerCase();
    if (s.startsWith("*.")) suffixes.push(s.slice(1));
    else { exact.push(s); suffixes.push("." + s); }
  }
  const exactJson = JSON.stringify(exact);
  const suffixJson = JSON.stringify(suffixes);
  return `// kura proxy.pac (generated)
function FindProxyForURL(url, host) {
  var h = host.toLowerCase();
  var exact = ${exactJson};
  var suffix = ${suffixJson};
  for (var i = 0; i < exact.length; i++) if (h === exact[i]) return "PROXY ${host}:${port}";
  for (var j = 0; j < suffix.length; j++) {
    var s = suffix[j];
    if (h.length >= s.length && h.substring(h.length - s.length) === s) return "PROXY ${host}:${port}";
  }
  return "DIRECT";
}
`;
}

export async function writePac(host: string, port: number, domains: string[]): Promise<string> {
  const text = buildPac(host, port, domains);
  await writeFile(PATH_PAC, text, { mode: 0o644 });
  return PATH_PAC;
}

export function pacUrl(): string {
  return `pac+file://${PATH_PAC}`;
}
