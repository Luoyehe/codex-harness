/// <reference types="node" />

import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";

const MAX_GATEWAY_TOKEN_FILE_BYTES = 4098;

const sameFile = (one: Stats, two: Stats) =>
  one.dev === two.dev && one.ino === two.ino && one.mode === two.mode && one.uid === two.uid &&
  one.gid === two.gid && one.nlink === two.nlink && one.size === two.size &&
  one.mtimeMs === two.mtimeMs && one.ctimeMs === two.ctimeMs;

/** Development still treats the control credential as a secret: never follow
 * a replaceable entry or let a FIFO/growing file block the Vite proxy. */
export function readPinnedDevGatewayToken(directory: string): string {
  const file = join(directory, "gateway-token");
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_GATEWAY_TOKEN_FILE_BYTES ||
      process.platform !== "win32" && (before.mode & 0o077) !== 0) throw new Error("unsafe development gateway token");
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error("development gateway token changed");
    const buffer = Buffer.allocUnsafe(MAX_GATEWAY_TOKEN_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(descriptor, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
    }
    const after = fstatSync(descriptor);
    if (total !== before.size || total > MAX_GATEWAY_TOKEN_FILE_BYTES ||
        !sameFile(opened, after) || !sameFile(after, lstatSync(file))) throw new Error("development gateway token changed");
    return buffer.subarray(0, total).toString("utf8");
  } finally { closeSync(descriptor); }
}

/** Resolve only the control-plane credential; CODEX_HOME belongs to the Agent. */
export function readDevGatewayToken(
  env: { GATEWAY_TOKEN?: string; GATEWAY_CONTROL_HOME?: string },
  homeDirectory: string,
  readControlToken: (directory: string) => string,
): string {
  if (env.GATEWAY_TOKEN) return env.GATEWAY_TOKEN;
  try {
    return readControlToken(env.GATEWAY_CONTROL_HOME ?? `${homeDirectory}/.codex-harness-control`).trim();
  } catch {
    return "";
  }
}

/** Trusted-local-development shortcut, not an Agent/control-plane boundary. */
export function trustedDevGatewayRequest(headers: { host?: unknown; origin?: unknown }): boolean {
  if (headers.host !== "127.0.0.1:5173" && headers.host !== "localhost:5173") return false;
  return headers.origin === `http://${headers.host}`;
}

/** Check the original headers before rewriting Origin or reading a local token. */
export function prepareDevGatewayProxy(
  headers: { host?: unknown; origin?: unknown },
  request: { removeHeader(name: string): void; setHeader(name: string, value: string): unknown; destroy(): unknown },
  socket: { destroy(): unknown },
  readToken: () => string,
): boolean {
  if (!trustedDevGatewayRequest(headers)) {
    request.destroy();
    socket.destroy();
    return false;
  }
  let token: string;
  try { token = readToken(); } catch { token = ""; }
  // Match the gateway's credential syntax and fail closed if startup has not yet
  // generated the token (or it cannot be read). Do not forward browser cookies.
  if (!/^[a-zA-Z0-9_-]{32,4096}$/.test(token)) {
    request.destroy();
    socket.destroy();
    return false;
  }
  request.removeHeader("origin");
  request.removeHeader("cookie");
  request.removeHeader("authorization");
  request.setHeader("authorization", `Bearer ${token}`);
  return true;
}
