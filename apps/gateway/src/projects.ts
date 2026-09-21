import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { atomicWriteFile, atomicWriteFileSync } from "./atomic-file.js";
import { readBoundedRegularTextFile } from "./bounded-file.js";

/**
 * Project registry persisted next to CODEX_HOME. Filesystem inspection is
 * deliberately asynchronous and bounded: registered roots may live on slow or
 * disconnected network filesystems, and one projects/list request must never
 * stall WebSocket heartbeats or emergency controls for every client.
 */

export interface ProjectEntry {
  path: string;
  addedAt: number;
  lastUsedAt: number;
  available?: boolean;
}

interface Registry {
  projects: ProjectEntry[];
}

interface AnnotatedProject {
  project: ProjectEntry;
  key: string;
  identity: string | null;
  timedOut: boolean;
}

interface ProjectSnapshot {
  projects: ProjectEntry[];
  byIdentity: Map<string, string>;
  complete: boolean;
}

const REGISTRY_CAP_BYTES = 16 * 1024 * 1024;
const MAX_PROJECTS = 10_000;
const MAX_PROJECT_PATH = 4096;
const FILESYSTEM_CONCURRENCY = 8;
const MAX_FILESYSTEM_WAITERS = 64;
const FILESYSTEM_BUDGET_MS = 2_500;
const SNAPSHOT_TTL_MS = 1_000;
const MAX_ANCESTORS = 256;

class ProjectIoTimeout extends Error {
  constructor() { super("project filesystem inspection timed out"); }
}

function rawIdentity(target: string): string {
  const normalized = path.normalize(target);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

type IoResult = { ok: true; value: unknown } | { ok: false; error: unknown };
interface PendingIo { waiters: Set<(result: IoResult) => void> }

// Shared by every registry instance and every inspection route. A caller's
// timeout cannot cancel realpath/stat/mkdir in the OS; only physical settlement
// releases this slot. Do not queue new paths behind disconnected mounts.
const pendingFilesystemIo = new Map<string, PendingIo>();
let filesystemWaiters = 0;

function filesystemIo<T>(kind: "realpath" | "stat" | "mkdir", target: string, start: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0 || filesystemWaiters >= MAX_FILESYSTEM_WAITERS) return Promise.reject(new ProjectIoTimeout());
  const key = `${kind}:${rawIdentity(path.resolve(target))}`;
  let entry = pendingFilesystemIo.get(key);
  const fresh = !entry;
  if (!entry) {
    if (pendingFilesystemIo.size >= FILESYSTEM_CONCURRENCY) return Promise.reject(new ProjectIoTimeout());
    entry = { waiters: new Set() };
    pendingFilesystemIo.set(key, entry);
  }
  const pending = entry;
  return new Promise<T>((resolve, reject) => {
    const finish = (result: IoResult) => {
      if (!pending.waiters.delete(finish)) return;
      filesystemWaiters -= 1;
      clearTimeout(timer);
      if (result.ok) resolve(result.value as T);
      else reject(result.error);
    };
    const timer = setTimeout(() => finish({ ok: false, error: new ProjectIoTimeout() }), remaining);
    timer.unref?.();
    pending.waiters.add(finish);
    filesystemWaiters += 1;
    if (!fresh) return;
    const settled = (result: IoResult) => {
      if (pendingFilesystemIo.get(key) === pending) pendingFilesystemIo.delete(key);
      for (const waiter of pending.waiters) waiter(result);
    };
    // Exactly one callback pair is retained on the underlying operation.
    // Expired subscribers remove themselves even if that operation never ends.
    try { void start().then((value) => settled({ ok: true, value }), (error) => settled({ ok: false, error })); }
    catch (error) { settled({ ok: false, error }); }
  });
}

function eventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function withinDeadline<T>(start: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) throw new ProjectIoTimeout();
  const operation = start();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProjectIoTimeout()), remaining);
    timer.unref?.();
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function mapLimited<T, R>(items: readonly T[], worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(FILESYSTEM_CONCURRENCY, Math.max(1, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
      if ((index & 63) === 63) await eventLoopTurn();
    }
  });
  await Promise.all(runners);
  return results;
}

export class ProjectRegistry {
  private readonly file: string;
  private cache: Registry | null = null;
  private loadInFlight: Promise<Registry> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private revision = 0;
  private snapshotCache: { revision: number; expiresAt: number; value: ProjectSnapshot } | null = null;
  private snapshotInFlight: { revision: number; value: Promise<ProjectSnapshot> } | null = null;
  /** Optional explicit persistent roots, plus a legacy container safety guard. */
  private readonly persistentRoots: string[] | null;

  constructor(codexHome: string, workspaceRoot: string, persistentRoots: string[] = []) {
    for (const candidate of [codexHome, workspaceRoot, ...persistentRoots]) {
      if (!ProjectRegistry.validPath(candidate)) throw new Error("项目根目录必须是受支持的绝对路径且不能包含 ..");
    }
    this.file = path.join(codexHome, "webui-projects.json");
    if (persistentRoots.length > 0) {
      this.persistentRoots = [...new Set([workspaceRoot, codexHome, ...persistentRoots].filter(Boolean))];
    } else if (ProjectRegistry.runningInContainer()) {
      this.persistentRoots = [...new Set([workspaceRoot, codexHome].filter(Boolean))];
    } else {
      this.persistentRoots = null;
    }

    const bootstrap: Registry = {
      projects: [{ path: workspaceRoot, addedAt: Date.now(), lastUsedAt: Date.now() }],
    };
    if (!existsSync(this.file)) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      atomicWriteFileSync(this.file, JSON.stringify(bootstrap, null, 2));
    }
  }

  private static runningInContainer(): boolean {
    try {
      return existsSync("/.dockerenv") || readFileSync("/proc/1/cgroup", "utf8").includes("docker");
    } catch {
      return false;
    }
  }

  /** Resolve the nearest existing ancestor so a missing leaf below a symlink
   * cannot bypass a persistent-root boundary. Every filesystem hop shares the
   * caller's deadline. */
  private static async canonical(target: string, deadline: number): Promise<string> {
    let ancestor = path.resolve(target);
    const missing: string[] = [];
    for (let depth = 0; depth <= MAX_ANCESTORS; depth += 1) {
      try {
        const resolved = await filesystemIo("realpath", ancestor, () => realpath(ancestor), deadline);
        return path.join(resolved, ...missing.reverse());
      } catch (error: any) {
        if (error instanceof ProjectIoTimeout) throw error;
        if (error?.code !== "ENOENT") throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        missing.push(path.basename(ancestor));
        ancestor = parent;
      }
    }
    throw new Error("项目路径层级超过安全上限");
  }

  private static async identity(target: string, deadline: number): Promise<string> {
    const canonical = await ProjectRegistry.canonical(target, deadline);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  }

  private static async annotate(projects: readonly ProjectEntry[], deadline: number): Promise<AnnotatedProject[]> {
    const bySpelling = new Map<string, Promise<Omit<AnnotatedProject, "project">>>();
    return mapLimited(projects, async (project) => {
      let identity = bySpelling.get(project.path);
      if (!identity) {
        identity = (async () => {
          try {
            const canonical = await ProjectRegistry.identity(project.path, deadline);
            return { key: `canonical:${canonical}`, identity: canonical, timedOut: false };
          } catch (error) {
            return {
              key: `raw:${rawIdentity(project.path)}`,
              identity: null,
              timedOut: error instanceof ProjectIoTimeout,
            };
          }
        })();
        bySpelling.set(project.path, identity);
      }
      return { project, ...await identity };
    });
  }

  /** Collapse aliases while retaining the first spelling and conservatively
   * merging timestamps. Canonical identities are also retained as a lookup
   * index so thread/start never has to synchronously rescan the registry. */
  private static compact(annotated: readonly AnnotatedProject[]): {
    projects: ProjectEntry[];
    byIdentity: Map<string, string>;
    complete: boolean;
  } {
    const byKey = new Map<string, ProjectEntry>();
    const identities = new Map<string, string>();
    let complete = true;
    for (const item of annotated) {
      if (item.timedOut) complete = false;
      const existing = byKey.get(item.key);
      if (existing) {
        existing.addedAt = Math.min(existing.addedAt, item.project.addedAt);
        existing.lastUsedAt = Math.max(existing.lastUsedAt, item.project.lastUsedAt);
      } else {
        byKey.set(item.key, {
          path: item.project.path,
          addedAt: item.project.addedAt,
          lastUsedAt: item.project.lastUsedAt,
        });
      }
      if (item.identity !== null) identities.set(item.identity, byKey.get(item.key)!.path);
    }
    return { projects: [...byKey.values()], byIdentity: identities, complete };
  }

  private async inspect(projects: readonly ProjectEntry[], deadline: number): Promise<ProjectSnapshot> {
    const compacted = ProjectRegistry.compact(await ProjectRegistry.annotate(projects, deadline));
    const availability = await mapLimited(compacted.projects, async (entry) => {
      try { return (await filesystemIo("stat", entry.path, () => stat(entry.path), deadline)).isDirectory(); }
      catch { return false; }
    });
    return {
      projects: compacted.projects
        .map((entry, index) => ({ ...entry, available: availability[index] ?? false }))
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt),
      byIdentity: compacted.byIdentity,
      complete: compacted.complete,
    };
  }

  /** True when target sits inside a mounted (persistent) directory. */
  async isPersistent(target: string): Promise<boolean> {
    return this.isPersistentBefore(target, performance.now() + FILESYSTEM_BUDGET_MS);
  }

  private async isPersistentBefore(target: string, deadline: number, knownCanonical?: string): Promise<boolean> {
    if (this.persistentRoots === null) return true;
    try {
      const normalized = knownCanonical ?? await ProjectRegistry.canonical(target, deadline);
      const roots = await mapLimited(this.persistentRoots, (root) => ProjectRegistry.canonical(root, deadline));
      return roots.some((root) => {
        const relative = path.relative(root, normalized);
        return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      });
    } catch {
      return false;
    }
  }

  private async load(): Promise<Registry> {
    if (this.cache) return this.cache;
    if (this.loadInFlight) return this.loadInFlight;
    const pending = (async () => {
      try {
        const parsed = JSON.parse(await readBoundedRegularTextFile(this.file, REGISTRY_CAP_BYTES));
        if (!Array.isArray(parsed?.projects) || parsed.projects.length > MAX_PROJECTS || parsed.projects.some((entry: unknown) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
          const project = entry as ProjectEntry;
          return typeof project.path !== "string" || project.path.length > MAX_PROJECT_PATH || !ProjectRegistry.validPath(project.path)
            || !Number.isSafeInteger(project.addedAt) || project.addedAt < 0
            || !Number.isSafeInteger(project.lastUsedAt) || project.lastUsedAt < 0;
        })) throw new Error("invalid registry");
        const loaded = { projects: parsed.projects.map((entry: ProjectEntry) => ({
          path: entry.path,
          addedAt: entry.addedAt,
          lastUsedAt: entry.lastUsedAt,
        })) };
        this.cache = loaded;
        return loaded;
      } catch {
        throw new Error("项目注册表无法可靠读取；请修复 webui-projects.json 后重试，原记录未覆盖");
      }
    })();
    this.loadInFlight = pending;
    try { return await pending; }
    finally { if (this.loadInFlight === pending) this.loadInFlight = null; }
  }

  private async saveCompacted(projects: ProjectEntry[]): Promise<void> {
    if (projects.length > MAX_PROJECTS) throw new Error(`项目数量已达到上限 ${MAX_PROJECTS}`);
    const encoded = JSON.stringify({ projects }, null, 2);
    if (Buffer.byteLength(encoded) > REGISTRY_CAP_BYTES) throw new Error("项目注册表超过安全大小上限");
    await mkdir(path.dirname(this.file), { recursive: true });
    await atomicWriteFile(this.file, encoded);
    this.cache = { projects: projects.map((entry) => ({
      path: entry.path,
      addedAt: entry.addedAt,
      lastUsedAt: entry.lastUsedAt,
    })) };
    this.revision += 1;
    this.snapshotCache = null;
    this.snapshotInFlight = null;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async snapshot(): Promise<ProjectSnapshot> {
    const registry = await this.load();
    const now = performance.now();
    if (this.snapshotCache?.revision === this.revision && this.snapshotCache.expiresAt > now) {
      return this.snapshotCache.value;
    }
    if (this.snapshotInFlight?.revision === this.revision) return this.snapshotInFlight.value;
    const revision = this.revision;
    const pending = this.inspect(registry.projects, now + FILESYSTEM_BUDGET_MS);
    this.snapshotInFlight = { revision, value: pending };
    try {
      const value = await pending;
      if (this.revision === revision) {
        this.snapshotCache = { revision, expiresAt: performance.now() + SNAPSHOT_TTL_MS, value };
      }
      return value;
    } finally {
      if (this.snapshotInFlight?.value === pending) this.snapshotInFlight = null;
    }
  }

  async list(): Promise<ProjectEntry[]> {
    return (await this.snapshot()).projects.map((entry) => ({ ...entry }));
  }

  /** Resolve a selected cwd to a currently existing registered directory.
   * Exact spellings take a fast path. Alias lookup uses the bounded snapshot,
   * and every selected path is then re-canonicalized and re-statted. A timeout
   * fails closed instead of holding the gateway event loop hostage. */
  async resolveRegistered(target: string): Promise<string | null> {
    if (!ProjectRegistry.validPath(target)) return null;
    const registry = await this.load();
    const lexical = rawIdentity(target);
    const exact = registry.projects.find((entry) => rawIdentity(entry.path) === lexical);
    const deadline = performance.now() + FILESYSTEM_BUDGET_MS;
    try {
      const wanted = await ProjectRegistry.identity(target, deadline);
      let candidate = exact?.path;
      if (!candidate) candidate = (await withinDeadline(() => this.snapshot(), deadline)).byIdentity.get(wanted);
      if (!candidate) return null;
      const current = await ProjectRegistry.identity(candidate, deadline);
      if (current !== wanted) return null;
      const info = await filesystemIo("stat", candidate, () => stat(candidate), deadline);
      if (!info.isDirectory()) return null;
      if (!await this.isPersistentBefore(candidate, deadline, current)) return null;
      return candidate;
    } catch {
      return null;
    }
  }

  /** Validated absolute path in the current host grammar; no `..` traversal. */
  static validPath(input: string): boolean {
    if (!input || input.length > MAX_PROJECT_PATH || input.includes("\0") || input.split(/[\\/]/).includes("..")) return false;
    return path.isAbsolute(input);
  }

  async add(input: string, create: boolean): Promise<ProjectEntry> {
    return this.enqueueMutation(async () => {
      const target = this.normalize(input);
      if (!ProjectRegistry.validPath(target)) throw new Error("路径必须是绝对路径且不能包含 ..");
      const deadline = performance.now() + FILESYSTEM_BUDGET_MS;
      if (!await this.isPersistentBefore(target, deadline)) {
        throw new Error(
          `该路径不在持久化区域内（当前允许: ${this.persistentRoots?.join(", ")}）。若网关运行在容器/受限环境中，请先把该目录挂载或加入 CODEX_PERSISTENT_ROOTS`,
        );
      }
      let info;
      try {
        info = await filesystemIo("stat", target, () => stat(target), deadline);
      } catch (error: any) {
        if (error?.code !== "ENOENT" || !create) {
          if (error?.code === "ENOENT") throw new Error(`目录不存在: ${target}`);
          throw error;
        }
        await filesystemIo("mkdir", target, () => mkdir(target, { recursive: true }), deadline);
        info = await filesystemIo("stat", target, () => stat(target), deadline);
      }
      if (!info.isDirectory()) throw new Error(`不是目录: ${target}`);
      const targetIdentity = await ProjectRegistry.identity(target, deadline);
      if (!await this.isPersistentBefore(target, deadline, targetIdentity)) {
        throw new Error("目录创建期间路径发生变化，不再位于持久化区域内");
      }

      const registry = await this.load();
      const compacted = ProjectRegistry.compact(await ProjectRegistry.annotate(registry.projects, deadline));
      if (!compacted.complete) throw new Error("项目目录检查超时；注册表未修改，请稍后重试");
      const existingPath = compacted.byIdentity.get(targetIdentity);
      const existing = existingPath === undefined ? undefined : compacted.projects.find((entry) => entry.path === existingPath);
      const now = Date.now();
      if (existing) existing.lastUsedAt = now;
      else {
        if (compacted.projects.length >= MAX_PROJECTS) throw new Error(`项目数量已达到上限 ${MAX_PROJECTS}`);
        compacted.projects.push({ path: target, addedAt: now, lastUsedAt: now });
      }
      await this.saveCompacted(compacted.projects);
      return { ...(existing ?? { path: target, addedAt: now, lastUsedAt: now }) };
    });
  }

  private normalize(input: string): string {
    const root = path.parse(input).root;
    // Backslashes are filename characters on POSIX, not path separators.
    // Retain them so add, touch, and remove always address the requested path.
    const trimmed = input.replace(process.platform === "win32" ? /[\\/]+$/ : /\/+$/, "");
    return trimmed.length < root.length ? root : trimmed || input;
  }

  async remove(target: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const norm = this.normalize(target);
      const registry = await this.load();
      const deadline = performance.now() + FILESYSTEM_BUDGET_MS;
      let wanted: string | null = null;
      if (ProjectRegistry.validPath(norm)) {
        try { wanted = await ProjectRegistry.identity(norm, deadline); } catch { /* exact stale spelling remains removable */ }
      }
      const annotated = await ProjectRegistry.annotate(registry.projects, deadline);
      if (annotated.some((entry) => entry.timedOut)) {
        // Removing a registration never removes files. Even a disconnected
        // mount must remain removable by its exact stored spelling. Preserve
        // every other entry verbatim when canonical identities are uncertain.
        const retained = registry.projects.filter((entry) => entry.path !== norm && entry.path !== target);
        if (retained.length === registry.projects.length) throw new Error("项目目录检查超时；注册表未修改，请稍后重试");
        await this.saveCompacted(retained);
        return;
      }
      const retained = annotated.filter((entry) => {
        if (entry.project.path === norm || entry.project.path === target) return false;
        return wanted === null || entry.identity !== wanted;
      });
      await this.saveCompacted(ProjectRegistry.compact(retained).projects);
    });
  }

  async touch(target: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const norm = this.normalize(target);
      const registry = await this.load();
      const deadline = performance.now() + FILESYSTEM_BUDGET_MS;
      let wanted: string | null = null;
      if (ProjectRegistry.validPath(norm)) {
        try { wanted = await ProjectRegistry.identity(norm, deadline); } catch { /* exact stale spelling remains touchable */ }
      }
      const annotated = await ProjectRegistry.annotate(registry.projects, deadline);
      if (annotated.some((entry) => entry.timedOut)) throw new Error("项目目录检查超时；注册表未修改，请稍后重试");
      const compacted = ProjectRegistry.compact(annotated);
      const entry = compacted.projects.find((project) => {
        if (project.path === norm || project.path === target) return true;
        return wanted !== null && compacted.byIdentity.get(wanted) === project.path;
      });
      if (entry) {
        entry.lastUsedAt = Date.now();
        await this.saveCompacted(compacted.projects);
      }
    });
  }
}
