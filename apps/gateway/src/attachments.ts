import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFileSync } from "./atomic-file.js";
import type { Thread } from "../../../protocol/v2/Thread.js";
import type { ThreadReadResponse } from "../../../protocol/v2/ThreadReadResponse.js";

export interface AttachmentReservation {
  owner: string;
  threadId: string;
  paths: string[];
}
const PENDING_OWNER_PREFIX = "@codex-harness:pending:";

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
  static readonly MAX_SCAN_MS = 10_000;

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
      if (leaf.isSymbolicLink() || !leaf.isFile()) return null;
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
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const file = path.join(this.dir, `${randomUUID()}${this.safeExtension(name)}`);
      try {
        writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
        // Return the same canonical spelling the registry uses. This also
        // makes paths embedded in new rollouts stable when CODEX_HOME itself
        // is reached through a symlink.
        return { path: realpathSync(file), size: bytes.length };
      } catch (err: any) {
        if (err?.code !== "EEXIST" || attempt === 4) throw err;
      }
    }
    throw new Error("无法分配附件文件名");
  }

  read(target: string): { base64: string; mime: string } {
    const canonical = this.canonicalOwnedPath(target);
    if (!canonical) throw new Error("只能读取上传目录内的附件");
    // Open without following a leaf symlink, then verify the opened inode is
    // the same one we inspected. This closes the check/open race where a local
    // process swaps an upload for a symlink after the realpath check.
    const before = lstatSync(canonical);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("附件已被替换，拒绝读取");
    const fd = openSync(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size > this.maxFileBytes
      ) throw new Error("附件已被替换或大小超出限制，拒绝读取");
      const data = readFileSync(fd);
      return { base64: data.toString("base64"), mime: AttachmentStore.mimeOf(canonical) };
    } finally {
      closeSync(fd);
    }
  }

  /** Remove a single uploaded file (user cancelled the attachment or the
   * turn failed). Silently skips files that are already gone or not ours. */
  remove(target: string): void {
    const canonical = this.canonicalOwnedPath(target);
    if (!canonical) return;
    try {
      rmSync(canonical);
    } catch {
      /* already deleted or not writable */
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
      const owners = new Set(this.refs![canonical] ?? []);
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
    return owners.length || !this.refsUnknown ? [...owners] : [AttachmentStore.INCOMPLETE_SCAN_OWNER];
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
    this.loadRefs();
    for (const p of canonical) this.refs![p] = [...new Set([...(this.refs![p] ?? []), reservation.owner])];
    try { this.saveRefs(true); } catch (error) {
      for (const p of canonical) this.refs![p] = this.refs![p].filter((owner) => owner !== reservation.owner);
      throw error;
    }
    return reservation;
  }

  settleReservation(reservation: AttachmentReservation, acceptedOrUncertain: boolean, uncertain = false): void {
    this.loadRefs();
    for (const p of reservation.paths) {
      const owners = new Set((this.refs![p] ?? []).filter((owner) => owner !== reservation.owner));
      // A lost response in the CURRENT app-server generation can still be
      // running before its rollout is flushed. Keep its live lease; only a
      // subsequent backend generation may reconcile this persisted intent.
      if (acceptedOrUncertain) owners.add(uncertain ? reservation.owner : reservation.threadId);
      if (owners.size) this.refs![p] = [...owners];
      else delete this.refs![p];
    }
    this.saveRefs();
  }

  private static isScanMarker(owner: string): boolean {
    return owner === AttachmentStore.ROLLOUT_OWNER || owner === AttachmentStore.INCOMPLETE_SCAN_OWNER;
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
    if (initial.length > 0 && initial.every(AttachmentStore.isScanMarker)) {
      const codexHome = path.dirname(this.dir);
      const result = await this.findReferencedByOtherRollout([canonical], "", [
        path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions"),
      ]);
      const current = this.refs![canonical] ?? [];
      if (current.every(AttachmentStore.isScanMarker) && result.complete && !result.referenced.has(canonical)) {
        delete this.refs![canonical];
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

  private loadRefs(): void {
    if (this.refs) return;
    try {
      const parsed = JSON.parse(readFileSync(this.refsFile, "utf8"));
      const clean: Record<string, string[]> = Object.create(null);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const deleting = parsed[AttachmentStore.DELETIONS_KEY];
        if (Array.isArray(deleting) && deleting.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256)) {
          this.deletingThreads = new Set(deleting);
        }
        if (Array.isArray(parsed[AttachmentStore.CURSOR_KEY]) && typeof parsed[AttachmentStore.CURSOR_KEY][0] === "string") this.recoveryCursor = parsed[AttachmentStore.CURSOR_KEY][0];
        for (const [file, owners] of Object.entries(parsed)) {
          if (file === AttachmentStore.DELETIONS_KEY || file === AttachmentStore.CURSOR_KEY) continue;
          if (file === AttachmentStore.INDEX_STATE_KEY) {
            this.refsUnknown = true;
            continue;
          }
          if (!Array.isArray(owners) || owners.some((owner) => typeof owner !== "string" || !owner)) {
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
            } else merged.add(this.deletingThreads.has(owner) ? AttachmentStore.INCOMPLETE_SCAN_OWNER : owner);
          }
          clean[canonical] = [...merged];
        }
      } else this.refsUnknown = true;
      this.refs = clean;
      // Every affected owner has now become a durable/recoverable scan
      // marker. A one-time delete intent need not grow forever after recovery.
      this.deletingThreads.clear();
    } catch (error: any) {
      this.refs = Object.create(null);
      this.refsUnknown = true;
      if (error?.code === "ENOENT") {
        try {
          this.refsUnknown = readdirSync(this.dir).some((name) => !name.startsWith(".refs.json."));
        } catch { /* unreadable store remains unknown */ }
      }
    }
  }

  private saveRefs(required = false): void {
    try {
      atomicWriteFileSync(this.refsFile, JSON.stringify({
        ...(this.refsUnknown ? { [AttachmentStore.INDEX_STATE_KEY]: ["unknown"] } : {}),
        ...(this.deletingThreads.size ? { [AttachmentStore.DELETIONS_KEY]: [...this.deletingThreads] } : {}),
        ...(this.recoveryCursor ? { [AttachmentStore.CURSOR_KEY]: [this.recoveryCursor] } : {}),
        ...(this.refs ?? {}),
      }));
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
      this.refs![file] = [...new Set(owners.map((owner) => owner.startsWith(PENDING_OWNER_PREFIX) ? AttachmentStore.INCOMPLETE_SCAN_OWNER : owner))];
    }
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
    const eligible = Object.entries(this.refs!).filter(([, owners]) => owners.length && owners.every(AttachmentStore.isScanMarker)).map(([file]) => file).sort();
    // Persist a moving cursor: referenced/incomplete entries at the front
    // must not starve later orphaned uploads across periodic passes/restarts.
    let start = eligible.findIndex((file) => file > this.recoveryCursor);
    if (start < 0) start = 0;
    const candidates = eligible.slice(start, start + 128);
    if (!candidates.length) return;
    this.recoveryCursor = candidates[candidates.length - 1];
    this.saveRefs(true);
    const codexHome = path.dirname(this.dir);
    const result = await this.findReferencedByOtherRollout(candidates, "", [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")]);
    for (const file of candidates) {
      const owners = this.refs![file] ?? [];
      if (!owners.every(AttachmentStore.isScanMarker)) continue;
      if (!result.complete || result.referenced.has(file)) continue;
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
  private async findReferencedByOtherRollout(
    needles: string[],
    excludeThreadId: string,
    sessionsDirs: string[],
  ): Promise<{ referenced: Set<string>; complete: boolean }> {
    const found = new Set<string>();
    const pending = [...needles];
    const deadline = Date.now() + AttachmentStore.MAX_SCAN_MS;
    let filesLeft = AttachmentStore.MAX_SCAN_FILES;
    let complete = true;
    const walk = async (dir: string, root = false): Promise<void> => {
      if (pending.length === 0) return;
      if (filesLeft <= 0 || Date.now() > deadline) {
        complete = false;
        return;
      }
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err: any) {
        // A never-created sessions directory proves there are no rollouts.
        // Any other unreadable directory makes the scan inconclusive.
        if (!(root && err?.code === "ENOENT")) complete = false;
        return;
      }
      for (const e of entries) {
        if (pending.length === 0) return;
        if (filesLeft <= 0 || Date.now() > deadline) {
          complete = false;
          return;
        }
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) {
          // A linked directory/file can contain references, but following it
          // could leave CODEX_HOME or loop forever. The scan is inconclusive.
          complete = false;
        } else if (e.isDirectory()) {
          await walk(full);
        } else if (e.name.endsWith(".jsonl") && (!excludeThreadId || !e.name.includes(excludeThreadId))) {
          filesLeft -= 1;
          try {
            const st = await stat(full);
            if (st.size > 64 * 1024 * 1024) {
              complete = false; // it may contain a reference; keep files
              continue;
            }
            const text = await readFile(full, "utf8");
            if (Date.now() > deadline) complete = false;
            for (const n of [...pending]) {
              // Windows backslashes (and quotes in POSIX names) are escaped
              // in JSONL. Search the serialized form as well as plain text.
              // The randomised basename is included for rollout compatibility
              // with pre-migration paths whose CODEX_HOME spelling traversed a
              // symlink. False positives only retain a file, never delete one.
              const haystack = process.platform === "win32" ? text.toLowerCase() : text;
              const candidates = [n, JSON.stringify(n).slice(1, -1), path.basename(n)]
                .map((candidate) => process.platform === "win32" ? candidate.toLowerCase() : candidate);
              if (candidates.some((candidate) => haystack.includes(candidate))) {
                found.add(n);
                pending.splice(pending.indexOf(n), 1);
              }
            }
          } catch {
            // Fail safe: unreadable does not mean unreferenced.
            complete = false;
          }
        }
      }
    };
    for (const sessionsDir of sessionsDirs) await walk(sessionsDir, true);
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
      if ((owners.some((owner) => owner === threadId || owner.startsWith(`${PENDING_OWNER_PREFIX}${encodeURIComponent(threadId)}:`)) || owners.some(AttachmentStore.isScanMarker)) && this.isOwned(file)) paths.push(file);
    }
    paths = [...new Set(paths)];
    if (!paths.length) { this.cancelThreadDeletion(threadId); return; }
    // Registry-protected files are settled synchronously (cheap); everything
    // else goes through the bounded async rollout scan in the background.
    this.loadRefs();
    const toScan: string[] = [];
    for (const p of paths) {
      const remaining = (this.refs![p] ?? []).filter((t) => t !== threadId && !t.startsWith(`${PENDING_OWNER_PREFIX}${encodeURIComponent(threadId)}:`) && !AttachmentStore.isScanMarker(t));
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
    const codexHome = path.dirname(this.dir);
    void this.findReferencedByOtherRollout(toScan, threadId, [
      path.join(codexHome, "sessions"),
      path.join(codexHome, "archived_sessions"),
    ])
      .then(({ referenced, complete }) => {
        for (const p of toScan) {
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
            this.refs![p] = [AttachmentStore.INCOMPLETE_SCAN_OWNER];
            continue;
          }
          if (referenced.has(p)) {
            this.refs![p] = [AttachmentStore.ROLLOUT_OWNER];
            continue;
          }
          this.remove(p); // repeat realpath/symlink containment at deletion
          if (this.refs) delete this.refs[p];
        }
        this.saveRefs();
      })
      .catch(() => {
        /* best-effort cleanup */
      });
  }
}
