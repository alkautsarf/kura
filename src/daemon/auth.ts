import { getOrCreateSecret } from "../core/secret.ts";

let cachedSecret: string | null = null;

export async function getSecret(): Promise<string> {
  if (!cachedSecret) cachedSecret = await getOrCreateSecret();
  return cachedSecret;
}

export async function checkAuth(req: Request): Promise<boolean> {
  const headerKey = req.headers.get("x-kura-key");
  if (!headerKey) return false;
  const secret = await getSecret();
  return safeEqual(headerKey, secret);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
