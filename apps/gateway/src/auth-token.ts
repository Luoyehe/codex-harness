import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { fsyncDirectorySync } from "./atomic-file.js";
import { readBoundedRegularTextFileSync } from "./bounded-file.js";
import type { FastifyReply, FastifyRequest } from "fastify";

const CREATION_TEMP_RE = /^\.gateway-token\.create-[a-f0-9]{32}\.tmp$/;
const MAX_CONTROL_DIRECTORY_ENTRIES = 4096;

function sameIdentity(one: Stats, two: Stats): boolean {
  return one.dev === two.dev && one.ino === two.ino;
}

function isCommittedCreationInode(info: Stats): boolean {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 2 || info.size !== 65) return false;
  if (process.platform === "win32") return true;
  const currentUid = process.geteuid?.() ?? process.getuid?.();
  return (currentUid === undefined || info.uid === currentUid) && (info.mode & 0o777) === 0o600;
}

function couldBeConcurrentCreation(file: string): boolean {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== 65 || (info.nlink !== 1 && info.nlink !== 2)) {
      return false;
    }
    if (process.platform === "win32") return true;
    const currentUid = process.geteuid?.() ?? process.getuid?.();
    return (currentUid === undefined || info.uid === currentUid) && (info.mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

function hasValidCreationPayload(file: string, expected: Stats): boolean {
  let fd: number | undefined;
  try {
    const flags = process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    fd = openSync(file, flags);
    const opened = fstatSync(fd);
    const current = lstatSync(file);
    if (!isCommittedCreationInode(opened) || !isCommittedCreationInode(current)
        || !sameIdentity(expected, opened) || !sameIdentity(opened, current)) return false;
    const payload = Buffer.allocUnsafe(66);
    let total = 0;
    while (total < payload.length) {
      const count = readSync(fd, payload, total, payload.length - total, null);
      if (count === 0) break;
      total += count;
    }
    const after = fstatSync(fd);
    const finalPath = lstatSync(file);
    return total === 65 && /^[a-f0-9]{64}\n$/.test(payload.subarray(0, total).toString("ascii"))
      && isCommittedCreationInode(after) && isCommittedCreationInode(finalPath)
      && sameIdentity(opened, after) && sameIdentity(after, finalPath)
      && opened.mtimeMs === after.mtimeMs && opened.ctimeMs === after.ctimeMs;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function ensureTrustedControlDirectory(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("path is not a real directory");
    }
    if (process.platform !== "win32") {
      const currentUid = process.geteuid?.() ?? process.getuid?.();
      if (currentUid !== undefined && info.uid !== currentUid) {
        throw new Error(`directory belongs to uid ${info.uid}, expected ${currentUid}`);
      }
      if ((info.mode & 0o077) !== 0) {
        throw new Error(`directory mode ${(info.mode & 0o777).toString(8)} grants group/other access`);
      }
    }
  } catch (error: any) {
    throw new Error(
      `Cannot safely use gateway auth control directory ${dir}: ${error?.message ?? String(error)}. ` +
        "Use a real private directory owned by the gateway service account.",
    );
  }
}

/** Remove only the exact inode created by this process. A same-account actor
 * replacing the pathname must not turn best-effort cleanup into deletion of an
 * unrelated file. */
function unlinkKnownPath(file: string, expected: Stats): void {
  const current = lstatSync(file);
  if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(current, expected)) {
    throw new Error("gateway token creation temporary path changed before cleanup");
  }
  unlinkSync(file);
}

/** Recover the single crash state produced after link(temp, final) but before
 * unlink(temp): both fixed-name paths are regular hardlinks to the same inode
 * and that inode has exactly two links. Anything less specific remains a
 * fail-closed token authority error. */
function recoverCommittedCreationLink(file: string): boolean {
  let finalInfo: Stats;
  try {
    finalInfo = lstatSync(file);
  } catch {
    return false;
  }
  if (!isCommittedCreationInode(finalInfo) || !hasValidCreationPayload(file, finalInfo)) return false;

  const dir = path.dirname(file);
  let matching: { path: string; info: Stats } | undefined;
  let entries = 0;
  let handle: ReturnType<typeof opendirSync> | undefined;
  try {
    handle = opendirSync(dir);
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      entries += 1;
      if (entries > MAX_CONTROL_DIRECTORY_ENTRIES) return false;
      if (!CREATION_TEMP_RE.test(entry.name)) continue;
      const candidatePath = path.join(dir, entry.name);
      let candidate: Stats;
      try {
        candidate = lstatSync(candidatePath);
      } catch {
        return false;
      }
      if (!isCommittedCreationInode(candidate) || !sameIdentity(candidate, finalInfo)) continue;
      if (matching) return false;
      matching = { path: candidatePath, info: candidate };
    }
  } catch {
    return false;
  } finally {
    try { handle?.closeSync(); } catch { /* best effort after a failed scan */ }
  }
  if (!matching) return false;

  // Revalidate both names immediately before the only destructive step.
  try {
    const finalNow = lstatSync(file);
    const tempNow = lstatSync(matching.path);
    if (!isCommittedCreationInode(finalNow) || !isCommittedCreationInode(tempNow)
        || !sameIdentity(finalNow, finalInfo) || !sameIdentity(tempNow, finalInfo)
        || !hasValidCreationPayload(file, finalNow)) return false;
    unlinkKnownPath(matching.path, matching.info);
    fsyncDirectorySync(dir);
    return true;
  } catch {
    // Another concurrent constructor may have completed this same recovery.
    // Its final single-link authority is handled by the caller's normal read.
    return false;
  }
}

function committedFinalAfterConcurrentCleanup(file: string, expected: Stats): boolean {
  try {
    const current = lstatSync(file);
    return current.isFile() && !current.isSymbolicLink() && current.nlink === 1
      && sameIdentity(current, expected);
  } catch {
    return false;
  }
}

/**
 * Gateway authentication token + trusted-host gate.
 *
 * Threat model: loopback binding blocks remote networks, but NOT other local
 * processes/users on the same host. HTML bootstrap always requires a secret;
 * the trusted-host list additionally blocks DNS rebinding (attacker resolves
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
  private readonly configuredBareHosts = new Set<string>();
  readonly bootstrapAuth: "required";
  readonly cookieName: string;

  constructor(codexHome: string, port: number) {
    ensureTrustedControlDirectory(codexHome);
    this.file = path.join(codexHome, "gateway-token");
    const bootstrapAuth = process.env.GATEWAY_BOOTSTRAP_AUTH ?? "required";
    if (bootstrapAuth !== "required") throw new Error("GATEWAY_BOOTSTRAP_AUTH must be required; local automatic login is no longer supported");
    this.bootstrapAuth = "required";
    // Cookies do not have a port scope. Distinct names prevent accidental
    // collisions, not hostile same-host services (use distinct hostnames).
    this.cookieName = `gw_token_${createHash("sha256").update(`${path.resolve(codexHome)}:${port}`).digest("hex").slice(0, 16)}`;

    // Trusted hosts: loopback variants + env-configured external domains.
    this.trustedHosts = new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ]);
    if (port === 80) {
      // This listener serves HTTP: browsers omit only its default port 80.
      // HTTPS reverse-proxy aliases remain explicitly configured below.
      for (const host of ["127.0.0.1", "localhost", "[::1]"]) this.trustedHosts.add(host);
    }
    const extra = process.env.TRUSTED_HOSTS ?? "";
    for (const h of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
      // DNS hostnames are case-insensitive — normalize entries on the way in
      // so isTrustedHost's lowercase compare can't be bypassed (or broken) by
      // mixed-case Host headers.
      const entry = h.toLowerCase();
      if (entry.includes(":")) {
        this.trustedHosts.add(entry);
        if (/^\[[^\]]+\]$/.test(entry)) this.configuredBareHosts.add(entry);
        // Browsers omit default ports from the Host header, so an explicit
        // ":443"/":80" entry must ALSO trust the bare hostname.
        const m = entry.match(/^(.*):(80|443)$/);
        if (m) { this.trustedHosts.add(m[1]); this.configuredBareHosts.add(m[1]); }
      } else {
        // Portless entry: trust the bare hostname — and the gateway port
        // variant for non-browser clients. Safe: the entry is
        // admin-configured, so a DNS-rebinding attacker's domain can never be
        // on this list.
        this.trustedHosts.add(entry);
        this.configuredBareHosts.add(entry);
        this.trustedHosts.add(`${entry}:${port}`);
      }
    }

    if (process.env.GATEWAY_TOKEN) {
      const t = process.env.GATEWAY_TOKEN;
      if (t.length < 32 || t.length > 4096 || !/^[a-zA-Z0-9_-]+$/.test(t)) {
        throw new Error("GATEWAY_TOKEN must be 32-4096 chars of [a-zA-Z0-9_-]");
      }
      this.token = t;
      return;
    }

    const readPersisted = (): string => {
      const raw = readBoundedRegularTextFileSync(this.file, 4098, (fd) => {
        // Apply permissions to the exact inode that was validated and read;
        // chmod(path) would reintroduce a swap race after the read.
        // Even chmod to the existing mode updates ctime on Linux. Avoid
        // invalidating another constructor's stable read of the same token.
        if (process.platform !== "win32" && (fstatSync(fd).mode & 0o7777) !== 0o600) {
          fchmodSync(fd, 0o600);
        }
      });
      // The terminating newline distinguishes a complete published token from
      // old direct-write crash debris and rejects plausible-looking prefixes.
      const match = /^([a-zA-Z0-9_-]{32,4096})\r?\n$/.exec(raw);
      if (!match) {
        throw new Error("persisted gateway token has an invalid format");
      }
      return match[1];
    };
    try {
      this.token = readPersisted();
      return;
    } catch (error: any) {
      let loadError = error;
      if (couldBeConcurrentCreation(this.file)) {
        // Another constructor can be between its atomic link and temporary
        // unlink. Retry through transient identity snapshots; an exact stale
        // two-link state is safe to heal, while all other authorities remain
        // untouched and eventually fail closed.
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            recoverCommittedCreationLink(this.file);
            this.token = readPersisted();
            return;
          } catch (retryError) {
            loadError = retryError;
            if (!couldBeConcurrentCreation(this.file)) break;
            if (attempt < 49) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
      }
      // Only absence authorizes creation. An existing corrupt, special,
      // multiply-linked, unreadable, or unsecurable authority must never be
      // silently replaced with a different credential.
      if (loadError?.code !== "ENOENT") {
        throw new Error(
          `Cannot safely load gateway auth token from ${this.file}: ${loadError?.message ?? String(loadError)}. ` +
            "Repair or remove it explicitly, or set GATEWAY_TOKEN in the service env.",
        );
      }
    }

    const candidate = randomBytes(32).toString("hex");
    const dir = path.dirname(this.file);
    const temp = path.join(dir, `.gateway-token.create-${randomBytes(16).toString("hex")}.tmp`);
    let createdInfo: Stats | undefined;
    try {
      // The final authority never exposes partial bytes. A complete, flushed
      // private temp inode is published with link(2), whose destination create
      // is atomic and no-clobber even across concurrent first starts.
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        const opened = fstatSync(fd);
        createdInfo = opened;
        const openedPath = lstatSync(temp);
        if (!opened.isFile() || opened.nlink !== 1 || !openedPath.isFile() || openedPath.isSymbolicLink()
            || openedPath.nlink !== 1 || !sameIdentity(opened, openedPath)) {
          throw new Error("gateway token creation temporary path changed while opening");
        }
        const encoded = Buffer.from(candidate + "\n", "utf8");
        let offset = 0;
        while (offset < encoded.length) {
          const count = writeSync(fd, encoded, offset, encoded.length - offset);
          if (count < 1) throw new Error("gateway token write made no progress");
          offset += count;
        }
        if (process.platform !== "win32") fchmodSync(fd, 0o600);
        fsyncSync(fd);
        const completed = fstatSync(fd);
        const current = lstatSync(temp);
        if (!completed.isFile() || completed.nlink !== 1 || !current.isFile() || current.isSymbolicLink()
            || current.nlink !== 1 || !sameIdentity(opened, completed) || !sameIdentity(completed, current)) {
          throw new Error("gateway token creation temporary path changed while writing");
        }
        createdInfo = completed;
      } finally {
        closeSync(fd);
      }

      try {
        linkSync(temp, this.file);
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        if (createdInfo) unlinkKnownPath(temp, createdInfo);
        createdInfo = undefined;

        // The winner can be between link and unlink, including after a crash.
        // Retry only this proven no-clobber race and its exact recovery state.
        let lastError: unknown;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            if (recoverCommittedCreationLink(this.file)) {
              this.token = readPersisted();
              return;
            }
            this.token = readPersisted();
            return;
          } catch (readError) {
            lastError = readError;
            if (attempt < 49) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        throw lastError;
      }

      const finalLinked = lstatSync(this.file);
      if (!createdInfo || !sameIdentity(createdInfo, finalLinked)) {
        throw new Error("gateway token path changed while it was being committed");
      }
      let tempLinked: Stats | undefined;
      try {
        tempLinked = lstatSync(temp);
      } catch (error: any) {
        if (error?.code !== "ENOENT" || !committedFinalAfterConcurrentCleanup(this.file, createdInfo)) throw error;
      }
      if (tempLinked) {
        if (!isCommittedCreationInode(tempLinked) || !isCommittedCreationInode(finalLinked)
            || !sameIdentity(tempLinked, finalLinked)) {
          throw new Error("gateway token path changed while it was being committed");
        }
        fsyncDirectorySync(dir);
        try {
          unlinkKnownPath(temp, tempLinked);
        } catch (error: any) {
          if (error?.code !== "ENOENT" || !committedFinalAfterConcurrentCleanup(this.file, createdInfo)) throw error;
        }
      }
      createdInfo = undefined;
      fsyncDirectorySync(dir);
      this.token = readPersisted();
    } catch (err: any) {
      if (createdInfo) {
        try { unlinkKnownPath(temp, createdInfo); } catch { /* never delete an unproven replacement */ }
      }
      // Without a persisted token, restarts invalidate the browser's cookie
      // and every reconnect will 401 — worse than failing fast.
      throw new Error(
        `Cannot persist gateway auth token to ${this.file}: ${err?.message ?? String(err)}. ` +
          `Fix the directory or set GATEWAY_TOKEN in the service env.`,
      );
    }
  }

  /** Check if the request's Host header is in our trusted set. */
  isTrustedHost(host: string | undefined | null): boolean {
    if (!host || typeof host !== "string") return false;
    // Only administrator-configured aliases retain the historical :80/:443
    // compatibility. The built-in HTTP:80 bare host must not also trust :443.
    const lower = host.toLowerCase();
    if (this.trustedHosts.has(lower)) return true;
    const normalized = lower.replace(/:(80|443)$/, "");
    return this.configuredBareHosts.has(normalized);
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
    if (typeof auth === "string" && /^Bearer /i.test(auth)) return auth.slice(7);
    const cookie = req?.headers?.cookie;
    if (typeof cookie === "string") {
      const m = new RegExp(`(?:^|;\\s*)${this.cookieName}=([a-zA-Z0-9_-]+)(?:;|$)`).exec(cookie);
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
    if (this.verify(this.extract({ headers: req?.headers }))) return true;
    const auth = req?.headers?.authorization;
    if (typeof auth !== "string" || !/^Basic /i.test(auth)) return false;
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
    return `${this.cookieName}=${this.token}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
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
