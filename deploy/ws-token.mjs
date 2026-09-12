// Shared: read the gateway auth token and return secret-free WS options.
// All verification scripts import this instead of hardcoding a bare WS URL.
//
// Tokens never enter URLs, proxy logs, shell history, or exception strings.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
let token = process.env.GATEWAY_TOKEN ?? "";
try {
  if (!token) token = readFileSync(join(codexHome, "gateway-token"), "utf8").trim();
} catch {
  // Token file not found — fall through (gateway will 401 with a clear message).
}

/**
 * Kept for call-site compatibility; the URL is deliberately unchanged.
 */
export function wsUrl(base) {
  return base;
}

export function wsOptions() {
  return token ? { headers: { Authorization: `Bearer ${token}` } } : {};
}

export { token };
