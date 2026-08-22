// Shared: read the gateway auth token and return a WS URL with it appended.
// All verification scripts import this instead of hardcoding a bare WS URL.
//
// NOTE: the ?token= query string is only acceptable for LOOPBACK verification
// runs (token could otherwise land in proxy access logs or shell history).
// Point GATEWAY_WS at ws://127.0.0.1:<port>/ws — never at an external proxy.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
let token = "";
try {
  token = readFileSync(join(codexHome, "gateway-token"), "utf8").trim();
} catch {
  // Token file not found — fall through (gateway will 401 with a clear message).
}

/**
 * Build a WebSocket URL with the auth token appended.
 * Prefers Authorization header approach (no query string in logs/history),
 * but WebSocket browser/subprocess APIs often can't set headers — so query
 * param is the practical fallback. For local scripts this is fine.
 */
export function wsUrl(base) {
  if (!token) return base;
  return `${base}${base.includes("?") ? "&" : "?"}token=${token}`;
}

export { token };
