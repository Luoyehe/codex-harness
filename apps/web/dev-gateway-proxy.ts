/** Credential-bearing dev traffic is restricted to a loopback, same-origin page. */
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
  request.removeHeader("origin");
  const token = readToken();
  if (token) request.setHeader("cookie", `gw_token=${token}`);
  return true;
}
