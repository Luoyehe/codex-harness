import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { atomicWriteFileSync } from "./atomic-file.js";
import { readBoundedRegularFileSync, readBoundedRegularTextFileSync } from "./bounded-file.js";
import type { Thread } from "../../../protocol/v2/Thread.js";
import type { ThreadReadResponse } from "../../../protocol/v2/ThreadReadResponse.js";

export interface AttachmentReservation {
  owner: string;
  threadId: string;
  paths: string[];
}
const PENDING_OWNER_PREFIX = "@codex-harness:pending:";
const UNCLAIMED_OWNER_PREFIX = "@codex-harness:unclaimed:";
const REFS_CAP_BYTES = 64 * 1024 * 1024;
const MAX_REF_PATH_CHARS = 4096;
const MAX_REF_OWNER_CHARS = 2048;
const MAX_REF_OWNERS = 100_000;
const MAX_DISCOVERED_UPLOADS = 100_000;
const MAX_STORE_FILES = 4096;
const MAX_STORE_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Browser-upload store for message attachments. Files land under
 * CODEX_HOME/webui-uploads so they persist next to the codex sessions that
 * reference them. turn/start turns image paths into UserInput localImage and
 * other files into UserInput mention entries.
 */
export class AttachmentStore {
  private dir: string;
  /**
   * Refcount sidecar (webui-uploads/refs.json): uploaded path → set of thread
   * ids whose turns reference it. Lets thread/delete only remove files that
   * no OTHER thread (forks, copied turns) still needs.
   */
  private refsFile: string;
  private canonicalDir: string;
  private refs: Record<string, string[]> | null = null;
  private refsUnknown = false;
  private deletingThreads = new Set<string>();
  private recoveryCursor = "";
  private recovering = false;
  private scanTail: Promise<void> = Promise.resolve();
  private queuedScans = 0;
  private inventoryKnown = true;
  private storedFiles = 0;
  private storedBytes = 0;
  private static readonly INDEX_STATE_KEY = "@codex-harness:index-state";
  private static readonly DELETIONS_KEY = "@codex-harness:deletions";
  private static readonly CURSOR_KEY = "@codex-harness:gc-cursor";
  /** Synthetic owner retained when a rollout reference exists (or a scan was
   * inconclusive).  This keeps the explicit attachment/delete RPC fail-safe
   * even though CLI-created forks are not represented by a WebUI thread id. */
  private static readonly ROLLOUT_OWNER = "@codex-harness:rollout-reference";
  private static readonly INCOMPLETE_SCAN_OWNER = "@codex-harness:scan-incomplete";
  /**
   * Upload caps. Images are capped at 5MB to match the Zhipu vision MCP
   * (@z_ai/mcp-server MAX_IMAGE_SIZE_MB — larger images fail at analysis
   * time); OpenAI's Vision API allows ~20MB, so 5MB is the safe common
   * denominator. Other files just get injected as a path note the model reads
   * itself, so their cap is a transport-practicality limit (base64 over WS).
   */
  readonly maxImageBytes = 5 * 1024 * 1024;
  readonly maxFileBytes = 25 * 1024 * 1024;
  /** Rollout-scan bounds — the background cleanup must never run unbounded. */
  static readonly MAX_SCAN_FILES = 2000;
  static readonly MAX_SCAN_ENTRIES = 100_000;
  static readonly MAX_SCAN_MS = 10_000;
  static readonly MAX_SCAN_NEEDLES = 128;
  static readonly MAX_SCAN_BYTES = 256 * 1024 * 1024;
  static readonly MAX_SCAN_QUEUE = 4;
  static readonly MAX_LEGACY_SCAN_NEEDLES = 8;
  static readonly INCOMPLETE_RETRY_BASE_MS = 5 * 60 * 1000;
  static readonly SCAN_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
  static readonly ROLLOUT_RECHECK_MS = 24 * 60 * 60 * 1000;
  /** A browser draft lives only in memory. Keep uploaded-but-unsent files long
   * enough for reconnect/retry, then reclaim them after a complete rollout
   * scan. The timestamp is persisted in the owner marker. */
  static readonly UNCLAIMED_GRACE_MS = 24 * 60 * 60 * 1000;

  constructor(codexHome: string) {
    this.dir = path.join(codexHome, "webui-uploads");
    this.refsFile = path.join(this.dir, "refs.json");
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.canonicalDir = realpathSync(this.dir);
    // Establish whether this is a genuinely empty store before save() creates
    // an upload. A missing sidecar in an existing store is not proof of zero
    // references; keep that uncertainty across later sidecar writes.
    this.loadRefs();
  }

  /** Disk names have a fixed ASCII byte budget. Original names belong to
   * message metadata, not a filesystem component (NAME_MAX is bytes). */
  private safeExtension(name: string): string {
    const extension = path.extname(String(name ?? ""));
    return /^\.[a-zA-Z0-9]{1,16}$/.test(extension) ? extension.toLowerCase() : "";
  }

  private static newUnclaimedOwner(): string {
    return `${UNCLAIMED_OWNER_PREFIX}${Date.now()}:${randomUUID()}`;
  }

  private static unclaimedCreatedAt(owner: string): number | null {
    const match = /^@codex-harness:unclaimed:(\d{1,16}):[0-9a-f-]{36}$/.exec(owner);
    if (!match) return null;
    const createdAt = Number(match[1]);
    return Number.isSafeInteger(createdAt) && createdAt >= 0 ? createdAt : null;
  }

  private static isUnclaimedOwner(owner: string): boolean {
    return AttachmentStore.unclaimedCreatedAt(owner) !== null;
  }

  private static isRecoveryOwner(owner: string, now: number): boolean {
    const marker = AttachmentStore.scanMarker(owner);
    if (marker) return marker.nextAt <= now;
    const createdAt = AttachmentStore.unclaimedCreatedAt(owner);
    return createdAt !== null && createdAt <= now - AttachmentStore.UNCLAIMED_GRACE_MS;
  }

  /** Resolve an existing regular upload to its single filesystem identity.
   * All registry reads/writes use this value, so aliases such as `dir/./file`
   * cannot bypass a refcount lookup. */
  private canonicalOwnedPath(target: string): string | null {
    if (typeof target !== "string" || !target || target.includes("\0")) return null;
    const resolved = path.resolve(target);
    try {
      // Reject a symlink at the leaf, and resolve every intermediate symlink
      // before applying the containment check. The real path, rather than a
      // caller-supplied spelling of it, is also the ref-registry key.
      const leaf = lstatSync(resolved);
      if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.nlink !== 1) return null;
      const real = realpathSync(resolved);
      if (!real.startsWith(this.canonicalDir + path.sep)) return null;
      // refs.json and its atomic-write temporaries are store internals, never
      // browser attachments. Compare after realpath so aliases cannot reach
      // the sidecar either.
      if (
        real === path.join(this.canonicalDir, "refs.json") ||
        (path.dirname(real) === this.canonicalDir && path.basename(real).startsWith(".refs.json."))
      ) return null;
      return real;
    } catch {
      return null;
    }
  }

  isOwned(target: string): boolean {
    return this.canonicalOwnedPath(target) !== null;
  }

  /** Revalidate an upload immediately before exposing it as localImage.
   * Upload kind is browser metadata and must not be trusted as the final
   * turn kind: a file uploaded under the 25MiB cap may later be submitted as
   * an image, whose cross-provider cap is 5MiB. Open the current leaf without
   * following symlinks and require the descriptor/path to name the same
   * singly-linked regular inode before returning its canonical spelling. */
  validateImageForSend(target: string): string {
    const canonical = this.canonicalOwnedPath(target);
    if (!canonical) throw new Error("图片附件已不存在、被替换或不属于上传目录，拒绝发送");
    let fd: number | undefined;
    try {
      const flags = process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
      fd = openSync(canonical, flags);
      const opened = fstatSync(fd);
      const current = lstatSync(canonical);
      if (
        !opened.isFile() || opened.nlink !== 1 || opened.size < 0 || opened.size > this.maxImageBytes ||
        !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.size !== opened.size ||
        current.dev !== opened.dev || current.ino !== opened.ino
      ) {
        throw new Error("image attachment is not a bounded stable regular file");
      }
      return canonical;
    } catch {
      throw new Error(`图片附件已被替换或大小超过 ${Math.floor(this.maxImageBytes / 1024 / 1024)}MB，拒绝发送`);
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* validation error wins */ }
      }
    }
  }

  save(name: string, base64: string, kind?: "image" | "file"): { path: string; size: number } {
    // Client-declared kind wins (the browser sniffs real content types);
    // extension sniffing is only the fallback for direct API callers.
    const isImage = kind === "image" || (kind !== "file" && AttachmentStore.mimeOf(name).startsWith("image/"));
    const cap = isImage ? this.maxImageBytes : this.maxFileBytes;
    if (typeof base64 !== "string" || base64.length === 0) throw new Error("附件内容为空");
    // Reject before decoding so a huge encoded string cannot multiply memory
    // use. Only canonical RFC 4648 base64 is accepted; Buffer.from() itself is
    // intentionally permissive and silently ignores arbitrary characters.
    if (base64.length > Math.ceil(cap / 3) * 4) {
      const mb = Math.floor(cap / 1024 / 1024);
      throw new Error(`${isImage ? "图片" : "文件"}过大（上限 ${mb}MB）`);
    }
    if (
      base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
    ) {
      throw new Error("附件内容不是有效的 base64");
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0) throw new Error("附件内容为空");
    if (bytes.length > cap) {
      const mb = Math.floor(cap / 1024 / 1024);
      throw new Error(`${isImage ? "图片" : "文件"}过大（上限 ${mb}MB）`);
    }
    if (!this.inventoryKnown) throw new Error("附件存储盘点不完整；为避免磁盘失控，已拒绝新上传，请管理员检查上传目录");
    if (this.storedFiles >= MAX_STORE_FILES || this.storedBytes > MAX_STORE_BYTES - bytes.length) {
      throw new Error(`附件存储已达到实例上限（${MAX_STORE_FILES} 个文件或 4GiB）；请删除不再使用的附件或会话后重试`);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const file = path.join(this.dir, `${randomUUID()}${this.safeExtension(name)}`);
      let fd: number | undefined;
      let createdIdentity: { dev: number; ino: number } | undefined;
      try {
        fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        const created = fstatSync(fd);
        createdIdentity = { dev: created.dev, ino: created.ino };
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
          if (written <= 0) throw new Error("附件写入未取得进展");
          offset += written;
        }
        if (process.platform !== "win32") fchmodSync(fd, 0o600);
        fsyncSync(fd);
        const opened = fstatSync(fd);
        const leaf = lstatSync(file);
        if (!opened.isFile() || opened.nlink !== 1 || !leaf.isFile() || leaf.isSymbolicLink()
            || leaf.nlink !== 1 || opened.dev !== leaf.dev || opened.ino !== leaf.ino || opened.size !== bytes.length) {
          throw new Error("附件文件在提交前被替换");
        }
        closeSync(fd);
        fd = undefined;
        // Return the same canonical spelling the registry uses. This also
        // makes paths embedded in new rollouts stable when CODEX_HOME itself
        // is reached through a symlink.
        const canonical = realpathSync(file);
        // A successful upload must be discoverable after a browser/gateway
        // crash even if turn/start was never attempted. Persist the draft
        // lease before returning its path to the browser.
        this.loadRefs();
        this.refs![canonical] = [AttachmentStore.newUnclaimedOwner()];
        try {
          this.saveRefs(true);
        } catch (error) {
          delete this.refs![canonical];
          try { rmSync(canonical); } catch { /* original persistence error wins */ }
          throw error;
        }
        this.storedFiles += 1;
        this.storedBytes += bytes.length;
        return { path: canonical, size: bytes.length };
      } catch (err: any) {
        if (fd !== undefined) {
          try { closeSync(fd); } catch { /* original error wins */ }
        }
        if (createdIdentity) {
          try {
            const leaf = lstatSync(file);
            if (!leaf.isSymbolicLink() && leaf.isFile() && leaf.dev === createdIdentity.dev && leaf.ino === createdIdentity.ino) rmSync(file);
          } catch { /* absent or replaced: never unlink an unverified path */ }
        }
        if (err?.code !== "EEXIST" || attempt === 4) throw err;
      }
    }
    throw new Error("无法分配附件文件名");
  }

  read(target: string): { base64: string; mime: string } {
    const canonical = this.canonicalOwnedPath(target);
    if (!canonical) throw new Error("只能读取上传目录内的附件");
    try {
      const data = readBoundedRegularFileSync(canonical, this.maxFileBytes);
      return { base64: data.toString("base64"), mime: AttachmentStore.mimeOf(canonical) };
    } catch {
      throw new Error("附件已被替换或大小超出限制，拒绝读取");
    }
  }

  /** Remove a single uploaded file (user cancelled the attachment or the
   * turn failed). Silently skips files that are already gone or not ours. */
  remove(target: string): void {
    const canonical = this.canonicalOwnedPath(target);
    if (!canonical) return;
    let size = 0;
    try { size = lstatSync(canonical).size; } catch { /* removal decides */ }
    try {
      rmSync(canonical);
      this.storedFiles = Math.max(0, this.storedFiles - 1);
      this.storedBytes = Math.max(0, this.storedBytes - size);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw new Error("附件删除失败；文件与清理引用已保留，请检查权限后重试");
    }
  }

  static mimeOf(file: string): string {
    switch (path.extname(file).toLowerCase()) {
      case ".png": return "image/png";
      case ".jpg":
      case ".jpeg": return "image/jpeg";
      case ".gif": return "image/gif";
      case ".webp": return "image/webp";
      case ".svg": return "image/svg+xml";
      case ".pdf": return "application/pdf";
      case ".txt":
      case ".md": return "text/plain; charset=utf-8";
      case ".json": return "application/json";
      case ".csv": return "text/csv";
      default: return "application/octet-stream";
    }
  }

  /** Record that a thread's turn references these uploaded files. */
  rememberPaths(threadId: string, paths: string[]): void {
    if (!paths.length) return;
    this.loadRefs();
    for (const p of paths) {
      const canonical = this.canonicalOwnedPath(p);
      if (!canonical) continue;
      const owners = new Set((this.refs![canonical] ?? []).filter((owner) => !AttachmentStore.isUnclaimedOwner(owner)));
      owners.add(threadId);
      this.refs![canonical] = [...owners];
    }
    this.saveRefs();
  }

  /** Threads whose turns still reference <target> per the registry. */
  registeredOwners(target: string): string[] {
    const canonical = this.canonicalOwnedPath(target);
    if (!canonical) return [];
    this.loadRefs();
    const owners = this.refs![canonical] ?? [];
    if (!owners.length && this.refsUnknown) return [AttachmentStore.INCOMPLETE_SCAN_OWNER];
    return [...new Set(owners.map((owner) => {
      const marker = AttachmentStore.scanMarker(owner);
      return marker?.kind === "rollout" ? AttachmentStore.ROLLOUT_OWNER
        : marker?.kind === "incomplete" ? AttachmentStore.INCOMPLETE_SCAN_OWNER : owner;
    }))];
  }

  /** Persist a lease before sending turn/start. A crash reloads an unfinished
   * lease as a conservative reference to its real thread, so it cannot turn
   * into an unprotected upload after the server may have accepted the turn. */
  reservePaths(threadId: string, paths: string[]): AttachmentReservation {
    const canonical = [...new Set(paths.map((p) => {
      const owned = this.canonicalOwnedPath(p);
      if (!owned) throw new Error("附件已不存在或不属于上传目录");
      return owned;
    }))];
    const reservation = { owner: `${PENDING_OWNER_PREFIX}${encodeURIComponent(threadId)}:${randomUUID()}`, threadId, paths: canonical };
    if (reservation.owner.length > MAX_REF_OWNER_CHARS) throw new Error("会话标识过长，无法保护发送中的附件");
    this.loadRefs();
    const previous = new Map<string, string[] | undefined>();
    for (const p of canonical) {
      previous.set(p, this.refs![p] ? [...this.refs![p]] : undefined);
      this.refs![p] = [...new Set([
        ...(this.refs![p] ?? []).filter((owner) => !AttachmentStore.isUnclaimedOwner(owner)),
        reservation.owner,
      ])];
    }
    try { this.saveRefs(true); } catch (error) {
      for (const p of canonical) {
        const old = previous.get(p);
        if (old) this.refs![p] = old;
        else delete this.refs![p];
      }
      throw error;
    }
    return reservation;
  }

  settleReservation(reservation: AttachmentReservation, acceptedOrUncertain: boolean, uncertain = false): void {
    this.loadRefs();
    const rejectedOwner = acceptedOrUncertain ? null : AttachmentStore.newUnclaimedOwner();
    for (const p of reservation.paths) {
      const owners = new Set((this.refs![p] ?? []).filter((owner) => owner !== reservation.owner));
      // A lost response in the CURRENT app-server generation can still be
      // running before its rollout is flushed. Keep its live lease; only a
      // subsequent backend generation may reconcile this persisted intent.
      if (acceptedOrUncertain) owners.add(uncertain ? reservation.owner : reservation.threadId);
      else owners.add(rejectedOwner!);
      if (owners.size) this.refs![p] = [...owners];
      else delete this.refs![p];
    }
    this.saveRefs();
  }

  private static scanMarker(owner: string): { kind: "rollout" | "incomplete"; attempt: number; nextAt: number } | null {
    for (const [prefix, kind] of [
      [AttachmentStore.ROLLOUT_OWNER, "rollout"],
      [AttachmentStore.INCOMPLETE_SCAN_OWNER, "incomplete"],
    ] as const) {
      if (owner === prefix) return { kind, attempt: -1, nextAt: 0 };
      if (!owner.startsWith(`${prefix}:`)) continue;
      const match = /^(\d{1,3}):(\d{1,16})$/.exec(owner.slice(prefix.length + 1));
      if (!match) return null;
      const attempt = Number(match[1]);
      const nextAt = Number(match[2]);
      return Number.isSafeInteger(attempt) && attempt >= 0 && attempt <= 100
        && Number.isSafeInteger(nextAt) && nextAt >= 0
        ? { kind, attempt, nextAt } : null;
    }
    return null;
  }

  private static isScanMarker(owner: string): boolean {
    return AttachmentStore.scanMarker(owner) !== null;
  }

  private static rolloutMarker(now: number): string {
    return `${AttachmentStore.ROLLOUT_OWNER}:0:${now + AttachmentStore.ROLLOUT_RECHECK_MS}`;
  }

  private static incompleteMarker(owners: string[], now: number): string {
    const prior = owners.reduce((highest, owner) => {
      const marker = AttachmentStore.scanMarker(owner);
      return marker?.kind === "incomplete" ? Math.max(highest, marker.attempt) : highest;
    }, -1);
    const attempt = Math.min(100, prior + 1);
    const exponent = Math.min(attempt, 20);
    const delay = Math.min(AttachmentStore.SCAN_RETRY_MAX_MS, AttachmentStore.INCOMPLETE_RETRY_BASE_MS * 2 ** exponent);
    return `${AttachmentStore.INCOMPLETE_SCAN_OWNER}:${attempt}:${now + delay}`;
  }

  /** Codex rollouts identify their thread in a session_meta record. Only an
   * exact, successfully parsed id is excluded during thread deletion; a file
   * name substring is not an identity boundary and an unreadable/truncated
   * header is conservatively scanned. */
  private static rolloutBelongsToThread(text: string, threadId: string): boolean {
    const header = text.slice(0, 256 * 1024);
    const lines = header.split(/\r?\n/, 65).slice(0, 64);
    for (const line of lines) {
      if (!line || line.length > 128 * 1024) continue;
      try {
        const record = JSON.parse(line);
        if (record?.type === "session_meta" && record?.payload?.id === threadId) return true;
      } catch { /* an unconfirmed header is never excluded */ }
    }
    return false;
  }

  /** An uncertain scan is a reason to recheck, not an immortal thread owner.
   * Keep the final owner check and unlink in one synchronous section, so a
   * turn reservation acquired while scanning cannot be missed. */
  async removeUnreferenced(target: string): Promise<void> {
    const canonical = this.canonicalOwnedPath(target);
    if (!canonical) return;
    this.loadRefs();
    if (this.refsUnknown && !(this.refs![canonical]?.length)) {
      this.refs![canonical] = [AttachmentStore.INCOMPLETE_SCAN_OWNER];
    }
    const initial = this.refs![canonical] ?? [];
    // An explicit browser delete is the owner abandoning its current draft.
    // This synchronous transition cannot race reservePaths on the JS event
    // loop. When the whole index is uncertain, retain the historical scan
    // requirement instead of trusting an attacker/corrupt marker.
    if (!this.refsUnknown && initial.length > 0 && initial.every(AttachmentStore.isUnclaimedOwner)) {
      delete this.refs![canonical];
      try {
        this.saveRefs(true);
        this.remove(canonical);
      } catch (error) {
        if (this.canonicalOwnedPath(canonical)) {
          this.refs![canonical] = initial;
          this.saveRefs();
        }
        throw error;
      }
      return;
    }
    if (initial.length > 0 && initial.every(AttachmentStore.isScanMarker)) {
      const codexHome = path.dirname(this.dir);
      let result: { referenced: Set<string>; complete: boolean };
      try {
        result = await this.scheduleRolloutScan([canonical], "", [
          path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions"),
        ]);
      } catch (error) {
        const current = this.refs![canonical] ?? [];
        if (current.every(AttachmentStore.isScanMarker)) {
          this.refs![canonical] = [AttachmentStore.incompleteMarker(current, Date.now())];
          this.saveRefs();
        }
        throw error;
      }
      const current = this.refs![canonical] ?? [];
      if (current.every(AttachmentStore.isScanMarker)) {
        if (result.complete && !result.referenced.has(canonical)) delete this.refs![canonical];
        else this.refs![canonical] = [result.complete
          ? AttachmentStore.rolloutMarker(Date.now())
          : AttachmentStore.incompleteMarker(current, Date.now())];
        this.saveRefs();
      }
    }
    const owners = this.refs![canonical] ?? [];
    if (owners.length > 0) {
      if (owners.every(AttachmentStore.isScanMarker)) throw new Error("附件仍有历史引用，或历史扫描尚未完成；稍后可重新尝试删除");
      throw new Error(`附件正被 ${owners.length} 个会话或发送中的回合引用，请先删除引用它的会话`);
    }
    this.remove(canonical);
  }

  /** Seed sidecar entries for files produced by older builds (which did not
   * durably register an upload until turn/start) or left behind when a sidecar
   * was missing/corrupt. Discovery is bounded and every discovered file still
   * requires a complete rollout scan before background deletion. */
  private discoverUnindexedUploads(clean: Record<string, string[]>): void {
    let handle: ReturnType<typeof opendirSync> | undefined;
    let files = 0;
    let bytes = 0;
    try {
      handle = opendirSync(this.dir);
      let seen = 0;
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        seen += 1;
        if (seen > MAX_DISCOVERED_UPLOADS) {
          this.refsUnknown = true;
          this.inventoryKnown = false;
          break;
        }
        if (entry.name === "refs.json") continue;
        const candidate = path.join(this.dir, entry.name);
        if (!entry.isFile()) {
          // Unknown directory/symlink/device contents make a total-byte claim
          // impossible. Existing attachments stay usable and deletable, but
          // new uploads fail closed until an administrator repairs the store.
          this.inventoryKnown = false;
          continue;
        }
        const st = lstatSync(candidate);
        if (!Number.isSafeInteger(st.size) || st.size < 0 || bytes > Number.MAX_SAFE_INTEGER - st.size) {
          this.inventoryKnown = false;
        } else {
          files += 1;
          bytes += st.size;
        }
        if (entry.name.startsWith(".refs.json.")) continue;
        const canonical = this.canonicalOwnedPath(candidate);
        if (canonical && !clean[canonical]) clean[canonical] = [AttachmentStore.INCOMPLETE_SCAN_OWNER];
      }
    } catch {
      this.refsUnknown = true;
      this.inventoryKnown = false;
    } finally {
      try { handle?.closeSync(); } catch { /* discovery is already fail-safe */ }
      this.storedFiles = files;
      this.storedBytes = bytes;
    }
  }

  private loadRefs(): void {
    if (this.refs) return;
    try {
      const parsed = JSON.parse(readBoundedRegularTextFileSync(this.refsFile, REFS_CAP_BYTES));
      const clean: Record<string, string[]> = Object.create(null);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const deleting = parsed[AttachmentStore.DELETIONS_KEY];
        if (Array.isArray(deleting) && deleting.length <= MAX_REF_OWNERS && deleting.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_REF_OWNER_CHARS)) {
          this.deletingThreads = new Set(deleting);
        } else if (deleting !== undefined) {
          this.refsUnknown = true;
        }
        const cursor = parsed[AttachmentStore.CURSOR_KEY];
        if (Array.isArray(cursor) && cursor.length === 1 && typeof cursor[0] === "string" && cursor[0].length <= MAX_REF_PATH_CHARS) {
          this.recoveryCursor = cursor[0];
        }
        for (const [file, owners] of Object.entries(parsed)) {
          if (file === AttachmentStore.DELETIONS_KEY || file === AttachmentStore.CURSOR_KEY) continue;
          if (file === AttachmentStore.INDEX_STATE_KEY) {
            this.refsUnknown = true;
            continue;
          }
          if (file.length > MAX_REF_PATH_CHARS) continue;
          if (!Array.isArray(owners) || owners.length > MAX_REF_OWNERS
              || owners.some((owner) => typeof owner !== "string" || !owner || owner.length > MAX_REF_OWNER_CHARS)) {
            this.refsUnknown = true;
            continue;
          }
          // Older sidecars used the caller's raw path spelling as the key.
          // Canonicalise and merge them so an upgrade neither loses owners
          // nor keeps two independently deletable aliases for one file.
          const canonical = this.canonicalOwnedPath(file);
          if (!canonical) continue;
          const merged = new Set(clean[canonical] ?? []);
          for (const owner of owners) {
            if (typeof owner !== "string" || owner.length === 0) continue;
            if (owner.startsWith(PENDING_OWNER_PREFIX)) {
              // A crashed send is uncertain, not a permanent real-thread
              // reference. Keep it protected but eligible for a complete,
              // bounded scan on the next explicit/background cleanup.
              merged.add(AttachmentStore.INCOMPLETE_SCAN_OWNER);
            } else if (owner.startsWith(UNCLAIMED_OWNER_PREFIX)) {
              // A draft upload survives ordinary reconnects for a grace
              // period. Malformed reserved markers are uncertainty, never an
              // immortal ordinary owner.
              if (AttachmentStore.isUnclaimedOwner(owner)) merged.add(owner);
              else {
                this.refsUnknown = true;
                merged.add(AttachmentStore.INCOMPLETE_SCAN_OWNER);
              }
            } else if (owner.startsWith(`${AttachmentStore.ROLLOUT_OWNER}:`)
                || owner.startsWith(`${AttachmentStore.INCOMPLETE_SCAN_OWNER}:`)) {
              // Persisted retry markers are protocol data, not thread ids.
              // A malformed reserved marker is global uncertainty and must be
              // made immediately eligible for a conservative rescan.
              if (AttachmentStore.isScanMarker(owner)) merged.add(owner);
              else {
                this.refsUnknown = true;
                merged.add(AttachmentStore.INCOMPLETE_SCAN_OWNER);
              }
            } else merged.add(this.deletingThreads.has(owner) ? AttachmentStore.INCOMPLETE_SCAN_OWNER : owner);
          }
          clean[canonical] = [...merged];
        }
      } else this.refsUnknown = true;
      this.discoverUnindexedUploads(clean);
      this.refs = clean;
      // Every affected owner has now become a durable/recoverable scan
      // marker. A one-time delete intent need not grow forever after recovery.
      this.deletingThreads.clear();
    } catch (error: any) {
      const clean: Record<string, string[]> = Object.create(null);
      // A genuinely absent sidecar is fully reconstructed from the flat
      // upload directory below. Other read/parse failures retain global
      // uncertainty even after every discoverable file gets a scan marker.
      this.refsUnknown = error?.code !== "ENOENT";
      this.discoverUnindexedUploads(clean);
      this.refs = clean;
    }
  }

  private saveRefs(required = false): void {
    try {
      const encoded = JSON.stringify({
        ...(this.refsUnknown ? { [AttachmentStore.INDEX_STATE_KEY]: ["unknown"] } : {}),
        ...(this.deletingThreads.size ? { [AttachmentStore.DELETIONS_KEY]: [...this.deletingThreads] } : {}),
        ...(this.recoveryCursor ? { [AttachmentStore.CURSOR_KEY]: [this.recoveryCursor] } : {}),
        ...(this.refs ?? {}),
      });
      if (Buffer.byteLength(encoded) > REFS_CAP_BYTES) throw new Error("attachment reference metadata exceeds its size limit");
      atomicWriteFileSync(this.refsFile, encoded);
    } catch (err: any) {
      process.stderr.write(`[attachments] failed to persist refs metadata: ${err?.message ?? String(err)}\n`);
      if (required) throw new Error("无法保护发送中的附件：引用信息持久化失败");
      /* best-effort registry */
    }
  }

  /** Write intent BEFORE thread/delete. On a crash either side of the upstream
   * response, restart scans all rollouts (including this thread if it survived)
   * instead of preserving a deleted thread id forever. */
  beginThreadDeletion(threadId: string): void {
    this.loadRefs();
    this.deletingThreads.add(threadId);
    this.saveRefs(true);
  }
  cancelThreadDeletion(threadId: string): void {
    this.deletingThreads.delete(threadId);
    this.saveRefs();
  }

  /** The supervisor calls this synchronously only once the previous child has
   * actually exited. Transport loss alone is not sufficient proof. */
  reconcileGeneration(): void {
    this.loadRefs();
    for (const [file, owners] of Object.entries(this.refs!)) {
      this.refs![file] = [...new Set(owners.map((owner) => owner.startsWith(PENDING_OWNER_PREFIX) || this.deletingThreads.has(owner)
        ? AttachmentStore.INCOMPLETE_SCAN_OWNER : owner))];
    }
    // An inner restart keeps this store instance alive, so loadRefs() does not
    // re-read its durable delete intents. Reconcile them here as on cold boot.
    this.deletingThreads.clear();
    this.saveRefs();
  }

  /** Called only after the backend has started its NEW app-server generation.
   * Bounded recovery uses one scan, and rechecks newly admitted reservations
   * before unlinking. Incomplete/oversized histories retain every uncertain file. */
  async recoverCleanup(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try { await this.recoverBatch(); } finally { this.recovering = false; }
  }
  private async recoverBatch(): Promise<void> {
    this.loadRefs();
    const now = Date.now();
    const eligible = Object.entries(this.refs!)
      .filter(([, owners]) => owners.length && owners.every((owner) => AttachmentStore.isRecoveryOwner(owner, now)))
      .map(([file]) => file)
      .sort();
    // Persist a moving cursor: referenced/incomplete entries at the front
    // must not starve later orphaned uploads across periodic passes/restarts.
    let start = eligible.findIndex((file) => file > this.recoveryCursor);
    if (start < 0) start = 0;
    const candidates = eligible.slice(start, start + 128);
    if (!candidates.length) return;
    this.recoveryCursor = candidates[candidates.length - 1];
    this.saveRefs(true);
    const codexHome = path.dirname(this.dir);
    let result: { referenced: Set<string>; complete: boolean };
    try {
      result = await this.scheduleRolloutScan(candidates, "", [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")]);
    } catch {
      const retryAt = Date.now();
      for (const file of candidates) {
        const owners = this.refs![file] ?? [];
        if (owners.length && owners.every((owner) => AttachmentStore.isRecoveryOwner(owner, retryAt))) {
          this.refs![file] = [AttachmentStore.incompleteMarker(owners, retryAt)];
        }
      }
      this.saveRefs();
      return;
    }
    for (const file of candidates) {
      const owners = this.refs![file] ?? [];
      if (!owners.length || !owners.every((owner) => AttachmentStore.isRecoveryOwner(owner, Date.now()))) continue;
      if (!result.complete) {
        this.refs![file] = [AttachmentStore.incompleteMarker(owners, Date.now())];
        continue;
      }
      if (result.referenced.has(file)) {
        // In particular, never leave an aged unclaimed marker behind: an
        // explicit draft delete trusts that marker, while the completed scan
        // has now proven a durable rollout reference.
        this.refs![file] = [AttachmentStore.rolloutMarker(Date.now())];
        continue;
      }
      this.remove(file);
      delete this.refs![file];
    }
    this.saveRefs();
  }

  /**
   * Which of `needles` appear in a rollout other than <excludeThreadId>'s —
   * the fallback for references this registry never saw (e.g. a fork created
   * by the codex CLI copies the rollout content).
   *
   * ASYNC and bounded: the scan walks sessions/ once, checks every needle per
   * file, and gives up after MAX_SCAN_FILES files or MAX_SCAN_MS — a huge
   * session history must never stall the gateway's event loop (all IO is
   * fs/promises) or block the delete RPC.
   */
  private scheduleRolloutScan(
    needles: string[],
    excludeThreadId: string,
    sessionsDirs: string[],
  ): Promise<{ referenced: Set<string>; complete: boolean }> {
    if (this.queuedScans >= AttachmentStore.MAX_SCAN_QUEUE) {
      // Every caller has already persisted a scan marker. Refusing excess
      // background work is therefore fail-safe and startup recovery can retry
      // it later without retaining an unbounded promise chain.
      return Promise.resolve({ referenced: new Set<string>(), complete: false });
    }
    const startsImmediately = this.queuedScans === 0;
    this.queuedScans += 1;
    const start = () => this.findReferencedByOtherRollout(needles, excludeThreadId, sessionsDirs);
    let result: Promise<{ referenced: Set<string>; complete: boolean }>;
    if (startsImmediately) {
      // Preserve the historical synchronous start boundary: callers may take
      // a reservation immediately after cleanup begins, and tests/fault
      // injectors must be able to observe that the scan is already pending.
      try { result = Promise.resolve(start()); }
      catch (error) { result = Promise.reject(error); }
    } else result = this.scanTail.then(start);
    this.scanTail = result.then(() => undefined, () => undefined);
    const release = () => { this.queuedScans -= 1; };
    void result.then(release, release);
    return result;
  }

  private async findReferencedByOtherRollout(
    needles: string[],
    excludeThreadId: string,
    sessionsDirs: string[],
  ): Promise<{ referenced: Set<string>; complete: boolean }> {
    const found = new Set<string>();
    const uniqueNeedles = [...new Set(needles)];
    if (uniqueNeedles.length > AttachmentStore.MAX_SCAN_NEEDLES) return { referenced: found, complete: false };
    if (uniqueNeedles.length === 0) return { referenced: found, complete: true };
    const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    const pending = new Set(uniqueNeedles);
    const modern = new Map<string, string[]>();
    const legacy = new Map<string, string[]>();
    const modernName = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[a-z0-9]{1,16})?$/i;
    for (const needle of uniqueNeedles) {
      const basename = path.basename(needle);
      if (modernName.test(basename)) {
        const key = basename.toLowerCase();
        modern.set(key, [...(modern.get(key) ?? []), needle]);
      } else {
        legacy.set(needle, [...new Set([
          fold(needle), fold(JSON.stringify(needle).slice(1, -1)), fold(basename),
        ])]);
      }
    }
    // Current uploads always have random UUID basenames. Keep compatibility
    // with a small number of legacy names, but never multiply a 256 MiB scan
    // by an attacker-selected 128-pattern substring loop.
    if (legacy.size > AttachmentStore.MAX_LEGACY_SCAN_NEEDLES) return { referenced: found, complete: false };
    // A wall-clock adjustment must not extend a bounded cleanup scan.
    const deadline = performance.now() + AttachmentStore.MAX_SCAN_MS;
    let filesLeft = AttachmentStore.MAX_SCAN_FILES;
    let entriesLeft = AttachmentStore.MAX_SCAN_ENTRIES;
    let bytesLeft = AttachmentStore.MAX_SCAN_BYTES;
    let complete = true;
    const scanFile = async (full: string): Promise<void> => {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const st = await lstat(full);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 64 * 1024 * 1024) {
          complete = false;
          return;
        }
        if (st.size > bytesLeft) { complete = false; return; }
        handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== st.dev || opened.ino !== st.ino || opened.size !== st.size) {
          complete = false;
          return;
        }
        bytesLeft -= opened.size;

        // Read only the bounded JSONL header first. We must identify the
        // deleted thread before recording matches from its own rollout.
        const headerLength = Math.min(opened.size, 256 * 1024);
        const header = Buffer.allocUnsafe(headerLength);
        let headerOffset = 0;
        while (headerOffset < headerLength) {
          const { bytesRead } = await handle.read(header, headerOffset, headerLength - headerOffset, headerOffset);
          if (bytesRead === 0) break;
          headerOffset += bytesRead;
          if (performance.now() > deadline) { complete = false; return; }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (headerOffset !== headerLength) { complete = false; return; }
        let headerText: string;
        try { headerText = new TextDecoder("utf-8", { fatal: true }).decode(header); }
        catch { complete = false; return; }
        if (excludeThreadId && AttachmentStore.rolloutBelongsToThread(headerText, excludeThreadId)) return;

        // Scan in small chunks with enough overlap for the longest possible
        // token. This bounds every synchronous CPU section and yields between
        // them, so the wall-clock deadline also protects interrupt/approval
        // handling for a near-limit rollout with no matches.
        const CHUNK_BYTES = 256 * 1024;
        const longestLegacy = Math.max(0, ...[...legacy.values()].flat().map((candidate) => candidate.length));
        const overlapChars = Math.max(64, longestLegacy - 1);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
        let position = 0;
        let overlap = "";
        while (position < opened.size && pending.size > 0) {
          if (performance.now() > deadline) { complete = false; return; }
          const length = Math.min(buffer.length, opened.size - position);
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          if (bytesRead === 0) { complete = false; return; }
          position += bytesRead;
          const final = position === opened.size;
          const decoded = decoder.decode(buffer.subarray(0, bytesRead), { stream: !final });
          const haystack = fold(overlap + decoded);

          // One linear pass discovers every current UUID basename. A basename
          // false-positive only retains an upload; it can never cause deletion.
          const uuidToken = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[a-z0-9]{1,16})?/gi;
          for (let match = uuidToken.exec(haystack), seen = 0; match; match = uuidToken.exec(haystack), seen += 1) {
            const originals = modern.get(match[0].toLowerCase());
            if (originals) for (const needle of originals) { found.add(needle); pending.delete(needle); }
            if ((seen & 1023) === 0 && performance.now() > deadline) { complete = false; return; }
          }
          for (const [needle, candidates] of legacy) {
            if (!pending.has(needle)) continue;
            if (performance.now() > deadline) { complete = false; return; }
            // Backslashes and quotes are escaped in JSONL, hence both plain
            // and serialized candidates. Legacy comparisons are capped above.
            if (candidates.some((candidate) => haystack.includes(candidate))) {
              found.add(needle);
              pending.delete(needle);
            }
          }
          overlap = haystack.slice(-overlapChars);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const after = await handle.stat();
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
            || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1) {
          complete = false;
        }
      } catch {
        complete = false;
      } finally {
        try { await handle?.close(); } catch { complete = false; }
        // Even cached filesystem reads must yield between files so interrupts,
        // heartbeats and terminal controls are not starved by text matching.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    for (const sessionsDir of sessionsDirs) {
      const directories: Array<{ dir: string; root: boolean }> = [{ dir: sessionsDir, root: true }];
      while (directories.length && pending.size > 0) {
        if (performance.now() > deadline) { complete = false; break; }
        const current = directories.pop()!;
        let handle: Awaited<ReturnType<typeof opendir>> | undefined;
        try {
          handle = await opendir(current.dir);
        } catch (err: any) {
          if (!(current.root && err?.code === "ENOENT")) complete = false;
          continue;
        }
        try {
          for (let entry = await handle.read(); entry; entry = await handle.read()) {
            entriesLeft -= 1;
            if (entriesLeft < 0 || performance.now() > deadline) { complete = false; break; }
            const full = path.join(current.dir, entry.name);
            let entryKind: "symlink" | "directory" | "file" | "other";
            if (entry.isSymbolicLink()) entryKind = "symlink";
            else if (entry.isDirectory()) entryKind = "directory";
            else if (entry.isFile()) entryKind = "file";
            else {
              // NFS/FUSE can report DT_UNKNOWN. Resolve it with a bounded
              // no-follow metadata lookup; unreadable/odd entries make the
              // traversal incomplete rather than being silently skipped.
              try {
                const info = await lstat(full);
                entryKind = info.isSymbolicLink() ? "symlink"
                  : info.isDirectory() ? "directory"
                    : info.isFile() ? "file" : "other";
              } catch {
                complete = false;
                continue;
              }
            }
            if (entryKind === "symlink") {
              complete = false;
            } else if (entryKind === "directory") {
              directories.push({ dir: full, root: false });
            } else if (entryKind === "file" && entry.name.endsWith(".jsonl")) {
              if (filesLeft <= 0) { complete = false; break; }
              filesLeft -= 1;
              await scanFile(full);
              if (!complete && (bytesLeft <= 0 || performance.now() > deadline)) break;
            } else if (entryKind === "other") complete = false;
            if (pending.size === 0) break;
          }
        } catch {
          complete = false;
        } finally {
          try { await handle.close(); } catch { /* async iteration may already close it */ }
        }
        if (entriesLeft < 0 || performance.now() > deadline) break;
        if (pending.size > 0 && (bytesLeft <= 0 || filesLeft <= 0)) {
          complete = false;
          break;
        }
      }
    }
    return { referenced: found, complete };
  }

  /**
   * Remove attachments referenced by a thread's userMessage items. Called on
   * thread/delete so uploaded files don't accumulate as orphans. Files still
   * referenced by another thread (refcount registry, or any other rollout —
   * CLI forks) are kept. Best-effort: failures never block the delete; the
   * rollout scan runs in the background so the RPC returns immediately.
   */
  cleanupForThread(threadId: string, threadItems: unknown): void {
    let paths: string[];
    try {
      // The API passes a typed ThreadReadResponse; accept the historical
      // unwrapped Thread spelling only at this compatibility boundary.
      const thread = (threadItems as Partial<ThreadReadResponse> | null)?.thread ?? threadItems as Partial<Thread> | null;
      const items = Array.isArray(thread?.turns)
        ? thread.turns.flatMap((t) => t?.items ?? [])
        : [];
      paths = [];
      for (const item of items) {
        if (item?.type !== "userMessage" || !Array.isArray(item.content)) continue;
        for (const c of item.content) {
          if ((c?.type === "localImage" || c?.type === "mention") && typeof c.path === "string") {
            const canonical = this.canonicalOwnedPath(c.path);
            if (canonical) paths.push(canonical);
          }
        }
      }
    } catch {
      return;
    }
    // Generic files are sent as text notes, not protocol mention items. The
    // persisted sidecar remains the authoritative list for those uploads.
    this.loadRefs();
    for (const [file, owners] of Object.entries(this.refs!)) {
      // A thread deletion may only expand work associated with that thread.
      // Global recovery markers are handled in bounded 128-file batches by
      // recoverCleanup(); adding every marker here turns one deletion into an
      // attacker-controlled all-history scan.
      if (owners.some((owner) => owner === threadId || owner.startsWith(`${PENDING_OWNER_PREFIX}${encodeURIComponent(threadId)}:`)) && this.isOwned(file)) paths.push(file);
    }
    paths = [...new Set(paths)];
    if (!paths.length) { this.cancelThreadDeletion(threadId); return; }
    // Registry-protected files are settled synchronously (cheap); everything
    // else goes through the bounded async rollout scan in the background.
    this.loadRefs();
    const toScan: string[] = [];
    for (const p of paths) {
      const remaining = (this.refs![p] ?? []).filter((t) => t !== threadId
        && !t.startsWith(`${PENDING_OWNER_PREFIX}${encodeURIComponent(threadId)}:`)
        && !AttachmentStore.isScanMarker(t)
        && !AttachmentStore.isUnclaimedOwner(t));
      if (remaining.length > 0) {
        // Registry says other threads still reference it → keep the file,
        // just drop this thread from the owners.
        this.refs![p] = remaining;
      } else {
        // Keep a recoverable scan marker until the rollout
        // scan has reached a conclusion. Otherwise an attachment/delete RPC
        // racing this asynchronous scan could see zero owners and unlink a
        // file that a CLI-created fork still references.
        this.refs![p] = [AttachmentStore.INCOMPLETE_SCAN_OWNER];
        toScan.push(p);
      }
    }
    this.deletingThreads.delete(threadId);
    this.saveRefs();
    if (toScan.length === 0) return;
    // Protect every remaining path above, but scan only one bounded batch in
    // this request. Later generation/startup recovery advances the persisted
    // cursor through any excess without creating an unbounded delete task.
    const scanBatch = toScan.slice(0, AttachmentStore.MAX_SCAN_NEEDLES);
    const codexHome = path.dirname(this.dir);
    void this.scheduleRolloutScan(scanBatch, threadId, [
      path.join(codexHome, "sessions"),
      path.join(codexHome, "archived_sessions"),
    ])
      .then(({ referenced, complete }) => {
        for (const p of scanBatch) {
          // Another turn may have registered the attachment while the async
          // rollout scan was running. Re-check before unlinking.
          const currentOwners = (this.refs?.[p] ?? []).filter((t) => !AttachmentStore.isScanMarker(t));
          if (currentOwners.length > 0) {
            this.refs![p] = currentOwners;
            continue;
          }
          if (!complete) {
            // Persist protection rather than merely skipping this one unlink:
            // future explicit deletes must remain fail-safe too.
            this.refs![p] = [AttachmentStore.incompleteMarker(this.refs![p] ?? [], Date.now())];
            continue;
          }
          if (referenced.has(p)) {
            this.refs![p] = [AttachmentStore.rolloutMarker(Date.now())];
            continue;
          }
          this.remove(p); // repeat realpath/symlink containment at deletion
          if (this.refs) delete this.refs[p];
        }
        this.saveRefs();
      })
      .catch(() => {
        // A rejected scan is also an incomplete attempt. Persist backoff so a
        // permanently unreadable history cannot force a full scan every five
        // minutes forever.
        for (const p of scanBatch) {
          const owners = this.refs?.[p] ?? [];
          if (owners.length && owners.every(AttachmentStore.isScanMarker)) {
            this.refs![p] = [AttachmentStore.incompleteMarker(owners, Date.now())];
          }
        }
        this.saveRefs();
      });
  }
}
