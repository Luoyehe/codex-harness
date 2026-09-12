import { randomBytes } from "node:crypto";
import { readFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-file.js";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Gateway authentication token + trusted-host gate.
 *
 * Threat model: loopback binding blocks remote networks, but NOT other local
 * processes/users on the same host. Default HTML bootstrap deliberately
 * trusts those local clients; the trusted-host list blocks DNS rebinding (attacker resolves
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
  readonly bootstrapAuth: "local" | "required";

  constructor(codexHome: string, port: number) {
    this.file = path.join(codexHome, "gateway-token");
    const bootstrapAuth = process.env.GATEWAY_BOOTSTRAP_AUTH ?? "local";
    if (bootstrapAuth !== "local" && bootstrapAuth !== "required") throw new Error("GATEWAY_BOOTSTRAP_AUTH must be local or required");
    this.bootstrapAuth = bootstrapAuth;

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
      if (t.length >= 32 && /^[a-zA-Z0-9_-]+$/.test(t)) {
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
      atomicWriteFileSync(this.file, this.token + "\n");
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
    // Preserve an exact configured :80/:443 first (the gateway itself may be
    // deliberately bound to either port), then accept the browser form with
    // the scheme-default port omitted.
    const lower = host.toLowerCase();
    if (this.trustedHosts.has(lower)) return true;
    const normalized = lower.replace(/:(80|443)$/, "");
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

  /** Extract token from cookie / Authorization header. Query tokens are an
   * explicit legacy opt-in because URLs leak through history and logs. */
  extract(req: any): string | undefined {
    const auth = req?.headers?.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
    const cookie = req?.headers?.cookie;
    if (typeof cookie === "string") {
      const m = /(?:^|;\s*)gw_token=([a-zA-Z0-9_-]+)(?:;|$)/.exec(cookie);
      if (m) return m[1];
    }
    if (process.env.ALLOW_QUERY_TOKEN === "1") {
      const q = req?.query?.token;
      if (typeof q === "string") return q;
    }
    return undefined;
  }

  /** Strict mode is usable with the browser's native HTTP auth prompt or an
   * authenticated proxy injecting Bearer credentials. Never put secrets in URLs.
   * The surrounding HTML route must still enforce the trusted Host gate. */
  canBootstrap(req: any): boolean {
    if (this.bootstrapAuth === "local") return true;
    if (this.verify(this.extract({ headers: req?.headers }))) return true;
    const auth = req?.headers?.authorization;
    if (typeof auth !== "string" || !auth.startsWith("Basic ")) return false;
    const encoded = auth.slice(6);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon >= 0 && this.verify(decoded.slice(colon + 1));
  }

  /**
   * Cookie header string. `secure` should be true when behind HTTPS.
   * Path=/ ensures /index.html also gets the cookie.
   */
  cookieHeader(secure: boolean): string {
    return `gw_token=${this.token}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  }
}

/** Shared HTML entry gate, kept separate so real HTTP bootstrap behavior can
 * be tested without launching an app-server or touching a user's home. */
export function setBootstrapCookie(
  token: AuthToken,
  req: Pick<FastifyRequest, "headers">,
  reply: FastifyReply,
  secure: boolean,
): void {
  if (!token.isTrustedHost(req.headers.host)) return;
  if (!token.canBootstrap(req)) {
    reply.header("www-authenticate", 'Basic realm="Codex Harness", charset="UTF-8"');
    reply.code(401).type("text/plain").send("Gateway authentication required. Use username codex and the gateway token as the password.");
    return;
  }
  reply.header("set-cookie", token.cookieHeader(secure));
}
