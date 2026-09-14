// Shared: read the gateway auth token and return secret-free WS options.
// All verification scripts import this instead of hardcoding a bare WS URL.
//
// Tokens never enter URLs, proxy logs, shell history, or exception strings.
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function readGatewayToken(env = process.env, home = homedir()) {
  // Never reuse CODEX_HOME/gateway-token: an Agent may have read that old
  // credential before the control/data-plane split. Defaults match index.ts.
  const controlHome = env.GATEWAY_CONTROL_HOME ?? join(home, ".codex-harness-control");
  let value = env.GATEWAY_TOKEN ?? "";
  try {
    if (!value) {
      const file = join(controlHome, "gateway-token");
      if (!lstatSync(file).isFile()) return "";
      const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = fstatSync(descriptor);
        if (!info.isFile() || info.size > 16 * 1024) return "";
        value = readFileSync(descriptor, "utf8").trim();
      } finally { closeSync(descriptor); }
    }
  }
  catch { return ""; }
  if (value.length > 16 * 1024 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid gateway verification credential format");
  return value;
}
const token = readGatewayToken();

/**
 * Kept for call-site compatibility; the URL is deliberately unchanged.
 */
export function wsUrl(base) {
  return base;
}

export function wsOptions() {
  if (!token) throw new Error("Gateway token unavailable: set GATEWAY_CONTROL_HOME and run with permission to read its gateway-token, or explicitly provide GATEWAY_TOKEN. CODEX_HOME is not a credential source.");
  return { headers: { Authorization: `Bearer ${token}` } };
}

export { token };
