/** Browser media is either served by this gateway or embedded after bounded
 * protocol validation. Model-authored remote URLs remain explicit links so a
 * response cannot make an administrator's browser contact arbitrary hosts. */
const BASE_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
] as const;

function exactWebSocketSource(host: string, https: boolean): string | null {
  // The caller has already applied the trusted-host allowlist. Keep parsing
  // strict as defense in depth because this value is inserted into a header.
  if (!host || host.length > 512 || /[\u0000-\u0020\u007f;'"\\]/.test(host)) return null;
  try {
    const parsed = new URL(`${https ? "https" : "http"}://${host}/`);
    if (!parsed.hostname || parsed.username || parsed.password
        || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return `${https ? "wss" : "ws"}://${parsed.host}`;
  } catch {
    return null;
  }
}

/** CSP for a response whose Host has already passed AuthToken.isTrustedHost.
 * No generic ws:/wss: source is ever emitted. */
export function contentSecurityPolicy(trustedHost?: string | null, https = false): string {
  const websocket = trustedHost ? exactWebSocketSource(trustedHost, https) : null;
  return [...BASE_POLICY, `connect-src 'self'${websocket ? ` ${websocket}` : ""}`].join("; ");
}

export const CONTENT_SECURITY_POLICY = contentSecurityPolicy();

/** Browser WebSockets must originate from the same authority and the same
 * transport security mode. Host-only comparison would let an HTTP page on an
 * HTTPS deployment attempt an authenticated cross-scheme connection. */
export function isTrustedBrowserOrigin(origin: string, host: string, https: boolean): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === (https ? "https:" : "http:")
      && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
