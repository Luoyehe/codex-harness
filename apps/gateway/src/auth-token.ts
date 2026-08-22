import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Gateway authentication token + trusted-host gate.
 *
 * Threat model: loopback binding blocks remote networks, but NOT other local
 * processes/users on the same host. The token blocks unauthenticated local
 * access; the trusted-host list blocks DNS rebinding (attacker resolves
 * evil.com to 127.0.0.1 — Origin/Host both match evil.com but the host is
 * not in our allowlist, so no cookie is set and WS is rejected).
 *
 * Trusted hosts: 127.0.0.1:PORT, localhost:PORT, [::1]:PORT, plus any
 * comma-separated TRUSTED_HOSTS env entries (reverse-proxy domain names).
 */
export class AuthToken {
  readonly token: string;
  private file: string;
  readonly trustedHosts: Set<string>;

  constructor(codexHome: string, port: number) {
    this.file = path.join(codexHome, "gateway-token");

    // Trusted hosts: loopback variants + env-configured external domains.
    this.trustedHosts = new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ]);
    const extra = process.env.TRUSTED_HOSTS ?? "";
    for (const h of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
      // DNS hostnames are case-insensitive — normalize entries on the way in
      // so isTrustedHost's lowercase compare can't be bypassed (or broken) by
      // mixed-case Host headers.
      const entry = h.toLowerCase();
      if (entry.includes(":")) {
        this.trustedHosts.add(entry);
        // Browsers omit default ports from the Host header, so an explicit
        // ":443"/":80" entry must ALSO trust the bare hostname.
        const m = entry.match(/^(.*):(80|443)$/);
        if (m) this.trustedHosts.add(m[1]);
      } else {
        // Portless entry: trust the bare hostname — and the gateway port
        // variant for non-browser clients. Safe: the entry is
        // admin-configured, so a DNS-rebinding attacker's domain can never be
        // on this list.
        this.trustedHosts.add(entry);
        this.trustedHosts.add(`${entry}:${port}`);
      }
    }

    if (process.env.GATEWAY_TOKEN) {
      const t = process.env.GATEWAY_TOKEN;
      if (t.length < 32 || !/^[a-zA-Z0-9_-]+$/.test(t)) {
        throw new Error("GATEWAY_TOKEN must be >= 32 chars of [a-zA-Z0-9_-]");
      }
      this.token = t;
      return;
    }

    try {
      const t = readFileSync(this.file, "utf8").trim();
      if (t.length >= 32) {
        // Ensure the persisted file is owner-only even if a previous run
        // or manual edit loosened permissions.
        try { chmodSync(this.file, 0o600); } catch { /* read-only fs */ }
        this.token = t;
        return;
      }
    } catch {
      /* not persisted yet */
    }

    this.token = randomBytes(32).toString("hex");
    try {
      if (!existsSync(path.dirname(this.file))) {
        mkdirSync(path.dirname(this.file), { recursive: true });
      }
      writeFileSync(this.file, this.token + "\n", { mode: 0o600 });
      chmodSync(this.file, 0o600);
    } catch (err: any) {
      // Without a persisted token, restarts invalidate the browser's cookie
      // and every reconnect will 401 — worse than failing fast.
      throw new Error(
        `Cannot persist gateway auth token to ${this.file}: ${err.message}. ` +
          `Fix the directory or set GATEWAY_TOKEN in the service env.`,
      );
    }
  }

  /** Check if the request's Host header is in our trusted set. */
  isTrustedHost(host: string | undefined | null): boolean {
    if (!host || typeof host !== "string") return false;
    // DNS hostnames are case-insensitive; default ports (80/443) are omitted
    // by browsers — normalize both away before the exact-match lookup.
    const normalized = host.toLowerCase().replace(/:(80|443)$/, "");
    return this.trustedHosts.has(normalized);
  }

  /** Check a presented token against ours (constant-time). */
  verify(presented: string | undefined | null): boolean {
    if (!presented || typeof presented !== "string") return false;
    if (presented.length !== this.token.length) return false;
    let diff = 0;
    for (let i = 0; i < this.token.length; i++) {
      diff |= this.token.charCodeAt(i) ^ presented.charCodeAt(i);
    }
    return diff === 0;
  }

  /** Extract token from cookie / query / Authorization header. */
  extract(req: any): string | undefined {
    const cookie = req?.headers?.cookie;
    if (typeof cookie === "string") {
      const m = /gw_token=([a-zA-Z0-9_-]+)/.exec(cookie);
      if (m) return m[1];
    }
    const q = req?.query?.token;
    if (typeof q === "string") return q;
    const auth = req?.headers?.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      return auth.slice(7);
    }
    return undefined;
  }

  /**
   * Cookie header string. `secure` should be true when behind HTTPS.
   * Path=/ ensures /index.html also gets the cookie.
   */
  cookieHeader(secure: boolean): string {
    return `gw_token=${this.token}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  }
}
