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
  if (!/^[a-zA-Z0-9_-]{32,}$/.test(token)) {
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
