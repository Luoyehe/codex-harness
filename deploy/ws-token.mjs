// Shared: read the gateway auth token and return secret-free WS options.
// All verification scripts import this instead of hardcoding a bare WS URL.
//
// Tokens never enter URLs, proxy logs, shell history, or exception strings.
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export function readGatewayToken(env = process.env, home = homedir()) {
  // Never reuse CODEX_HOME/gateway-token: an Agent may have read that old
  // credential before the control/data-plane split. Defaults match index.ts.
  const controlHome = env.GATEWAY_CONTROL_HOME ?? join(home, ".codex-harness-control");
  let value = env.GATEWAY_TOKEN ?? "";
  try {
    if (!value) {
      const file = join(controlHome, "gateway-token");
      const before = lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4098) return "";
      if (process.platform !== "win32" && (before.mode & 0o077) !== 0) return "";
      const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const opened = fstatSync(descriptor);
        const same = (one, two) => one.dev === two.dev && one.ino === two.ino && one.mode === two.mode &&
          one.nlink === two.nlink && one.size === two.size && one.mtimeMs === two.mtimeMs && one.ctimeMs === two.ctimeMs;
        if (!opened.isFile() || !same(before, opened) || !same(opened, lstatSync(file))) return "";
        const buffer = Buffer.allocUnsafe(4099);
        let total = 0;
        while (total < buffer.length) {
          const count = readSync(descriptor, buffer, total, buffer.length - total, null);
          if (count === 0) break;
          total += count;
        }
        const after = fstatSync(descriptor);
        if (total !== before.size || total > 4098 || !same(opened, after) || !same(after, lstatSync(file))) return "";
        const match = /^([A-Za-z0-9_-]{32,4096})\r?\n$/.exec(buffer.subarray(0, total).toString("utf8"));
        if (!match) return "";
        value = match[1];
      } finally { closeSync(descriptor); }
    }
  }
  catch { return ""; }
  if (!/^[A-Za-z0-9_-]{32,4096}$/.test(value)) throw new Error("Invalid gateway verification credential format");
  return value;
}
const token = readGatewayToken();

export function wsOptions() {
  if (!token) throw new Error("Gateway token unavailable: set GATEWAY_CONTROL_HOME and run with permission to read its gateway-token, or explicitly provide GATEWAY_TOKEN. CODEX_HOME is not a credential source.");
  return { headers: { Authorization: `Bearer ${token}` } };
}

export { token };

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.length !== 3 || process.argv[2] !== "--check" || !token) process.exitCode = 1;
}
