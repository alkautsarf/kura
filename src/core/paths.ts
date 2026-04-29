import { homedir } from "node:os";
import { join } from "node:path";

export const KURA_HOME = process.env.KURA_HOME ?? join(homedir(), ".kura");

export const PATH_CONFIG = join(KURA_HOME, "config.toml");
export const PATH_CHAINS = join(KURA_HOME, "chains.toml");
export const PATH_STATE = join(KURA_HOME, "state.json");
export const PATH_POLICY = join(KURA_HOME, "policy.json");
export const PATH_AUDIT = join(KURA_HOME, "audit.jsonl");
export const PATH_SECRET = join(KURA_HOME, "secret");
export const PATH_TLS_CERT = join(KURA_HOME, "tls.cert.pem");
export const PATH_TLS_KEY = join(KURA_HOME, "tls.key.pem");
export const PATH_DAPPS_CACHE = join(KURA_HOME, "cache", "dapps.json");
export const PATH_PHISHING_CACHE = join(KURA_HOME, "cache", "phishing.json");

export const QUTEBROWSER_LEGACY = join(homedir(), ".qutebrowser", "greasemonkey");
export const QUTEBROWSER_XDG = join(homedir(), ".config", "qutebrowser", "greasemonkey");
