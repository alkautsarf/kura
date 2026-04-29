import { startProxy, type ProxyOptions } from "./server.ts";
export type { ProxyHandle } from "./server.ts";
import type { ProxyHandle } from "./server.ts";
import { writePac, pacUrl, PATH_PAC } from "./pac.ts";
import { caInstalled } from "./cert.ts";

export interface StartOptions extends ProxyOptions {
  writePac?: boolean;
}

export async function start(opts: StartOptions): Promise<ProxyHandle & { pacPath?: string; pacUrl?: string }> {
  if (!caInstalled()) {
    throw new Error("mkcert root CA not found. Run `mkcert -install` first so the kura proxy can issue per-host TLS certs.");
  }
  const handle = await startProxy(opts);
  let pacPath: string | undefined;
  let pacUrlStr: string | undefined;
  if (opts.writePac !== false) {
    pacPath = await writePac(opts.host, opts.port, opts.domains);
    pacUrlStr = pacUrl();
  }
  return { ...handle, pacPath, pacUrl: pacUrlStr };
}

export { PATH_PAC, pacUrl, caInstalled };
