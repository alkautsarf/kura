import zlib from "node:zlib";
import { promisify } from "node:util";

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const brotli = promisify(zlib.brotliDecompress);

const META_CSP_RE = /<meta[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy(?:-report-only)?["']?[^>]*>/gi;

export interface CspStripResult {
  body: Buffer;
  modified: boolean;
}

export function stripHtmlCsp(body: Buffer): CspStripResult {
  const text = body.toString("utf8");
  const replaced = text.replace(META_CSP_RE, "");
  if (replaced === text) return { body, modified: false };
  return { body: Buffer.from(replaced, "utf8"), modified: true };
}

export async function decompress(body: Buffer, encoding: string | undefined): Promise<Buffer> {
  if (!encoding || encoding === "identity") return body;
  const enc = encoding.toLowerCase();
  if (enc === "gzip") return gunzip(body);
  if (enc === "deflate") return inflate(body);
  if (enc === "br") return brotli(body);
  return body;
}

const CSP_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-content-security-policy",
  "x-webkit-csp",
]);

export function stripCspResponseHeaders(headers: Record<string, string | string[] | undefined>): {
  headers: Record<string, string | string[] | undefined>;
  removed: string[];
} {
  const out: Record<string, string | string[] | undefined> = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (CSP_RESPONSE_HEADERS.has(k.toLowerCase())) {
      removed.push(k);
      continue;
    }
    out[k] = v;
  }
  return { headers: out, removed };
}
