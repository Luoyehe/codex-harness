import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

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
  private refs: Record<string, string[]> | null = null;
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
  }

  /** Neutralize anything path-like in a client-supplied filename. */
  private safeName(name: string): string {
    const base = path.basename(String(name ?? "file")).replace(/[^\w.\-\u4e00-\u9fa5 ]+/g, "_");
    return (base || "file").slice(0, 120);
  }

  isOwned(target: string): boolean {
    const resolved = path.resolve(target);
    const root = path.resolve(this.dir);
    return resolved === root || resolved.startsWith(root + path.sep);
  }

  save(name: string, base64: string, kind?: "image" | "file"): { path: string; size: number } {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0) throw new Error("附件内容为空");
    // Client-declared kind wins (the browser sniffs real content types);
    // extension sniffing is only the fallback for direct API callers.
    const isImage = kind === "image" || (kind !== "file" && AttachmentStore.mimeOf(name).startsWith("image/"));
    const cap = isImage ? this.maxImageBytes : this.maxFileBytes;
    if (bytes.length > cap) {
      const mb = Math.floor(cap / 1024 / 1024);
      throw new Error(`${isImage ? "图片" : "文件"}过大（上限 ${mb}MB）`);
    }
    const file = path.join(this.dir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${this.safeName(name)}`);
    writeFileSync(file, bytes);
    return { path: file, size: bytes.length };
  }

  read(target: string): { base64: string; mime: string } {
    if (!this.isOwned(target)) throw new Error("只能读取上传目录内的附件");
    const data = readFileSync(target);
    return { base64: data.toString("base64"), mime: AttachmentStore.mimeOf(target) };
  }

  /** Remove a single uploaded file (user cancelled the attachment or the
   * turn failed). Silently skips files that are already gone or not ours. */
  remove(target: string): void {
    if (!this.isOwned(target)) return;
    try {
      rmSync(target);
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
      if (!this.isOwned(p)) continue;
      const owners = new Set(this.refs![p] ?? []);
      owners.add(threadId);
      this.refs![p] = [...owners];
    }
    this.saveRefs();
  }

  /** Threads whose turns still reference <target> per the registry. */
  registeredOwners(target: string): string[] {
    this.loadRefs();
    return this.refs![target] ?? [];
  }

  private loadRefs(): void {
    if (this.refs) return;
    try {
      this.refs = JSON.parse(readFileSync(this.refsFile, "utf8"));
    } catch {
      this.refs = {};
    }
  }

  private saveRefs(): void {
    try {
      writeFileSync(this.refsFile, JSON.stringify(this.refs ?? {}));
    } catch {
      /* best-effort registry */
    }
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
    sessionsDir: string,
  ): Promise<Set<string>> {
    const found = new Set<string>();
    const pending = [...needles];
    const deadline = Date.now() + AttachmentStore.MAX_SCAN_MS;
    let filesLeft = AttachmentStore.MAX_SCAN_FILES;
    const walk = async (dir: string): Promise<void> => {
      if (pending.length === 0 || filesLeft <= 0 || Date.now() > deadline) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (pending.length === 0 || filesLeft <= 0 || Date.now() > deadline) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.name.endsWith(".jsonl") && !e.name.includes(excludeThreadId)) {
          filesLeft -= 1;
          try {
            const st = await stat(full);
            if (st.size > 64 * 1024 * 1024) continue; // pathological rollout guard
            const text = await readFile(full, "utf8");
            for (const n of [...pending]) {
              if (text.includes(n)) {
                found.add(n);
                pending.splice(pending.indexOf(n), 1);
              }
            }
          } catch {
            /* unreadable rollout — treat as no reference */
          }
        }
      }
    };
    await walk(sessionsDir);
    return found;
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
      const items = Array.isArray((threadItems as any)?.turns)
        ? (threadItems as any).turns.flatMap((t: any) => t?.items ?? [])
        : [];
      paths = [];
      for (const item of items) {
        if (item?.type !== "userMessage" || !Array.isArray(item.content)) continue;
        for (const c of item.content) {
          if ((c?.type === "localImage" || c?.type === "mention") && typeof c.path === "string" && this.isOwned(c.path)) {
            paths.push(c.path);
          }
        }
      }
    } catch {
      return;
    }
    if (!paths.length) return;
    // Registry-protected files are settled synchronously (cheap); everything
    // else goes through the bounded async rollout scan in the background.
    this.loadRefs();
    const toScan: string[] = [];
    for (const p of paths) {
      const remaining = (this.refs![p] ?? []).filter((t) => t !== threadId);
      if (remaining.length > 0) {
        // Registry says other threads still reference it → keep the file,
        // just drop this thread from the owners.
        this.refs![p] = remaining;
      } else {
        toScan.push(p);
      }
    }
    this.saveRefs();
    if (toScan.length === 0) return;
    const sessionsDir = path.join(path.dirname(this.dir), "sessions");
    void this.findReferencedByOtherRollout(toScan, threadId, sessionsDir)
      .then((referenced) => {
        for (const p of toScan) {
          if (referenced.has(p)) continue; // another thread still needs it
          try { rmSync(p); } catch { /* already gone */ }
          if (this.refs) delete this.refs[p];
        }
        this.saveRefs();
      })
      .catch(() => {
        /* best-effort cleanup */
      });
  }
}
