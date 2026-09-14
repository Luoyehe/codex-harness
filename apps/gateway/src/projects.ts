import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-file.js";

/**
 * Simple project registry persisted next to CODEX_HOME across service restarts.
 * Bare-metal deployments use host paths; the container check below is a
 * compatibility safeguard, not a supported container deployment workflow. A project is a
 * working directory the agent may be pointed at via thread/start {cwd}.
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

export class ProjectRegistry {
  private file: string;
  private cache: Registry | null = null;
  /**
   * Optional explicit persistent roots, plus a legacy container safety guard.
   * Bare-metal/systemd defaults to unrestricted persistent host paths.
   */
  private persistentRoots: string[] | null;

  constructor(codexHome: string, workspaceRoot: string, persistentRoots: string[] = []) {
    this.file = path.join(codexHome, "webui-projects.json");
    if (persistentRoots.length > 0) {
      this.persistentRoots = [...new Set([workspaceRoot, codexHome, ...persistentRoots].filter(Boolean))];
    } else if (ProjectRegistry.runningInContainer()) {
      // Inside Docker only mounted paths survive a rebuild; keep the guard so
      // projects never land in the ephemeral container layer by accident.
      this.persistentRoots = [...new Set([workspaceRoot, codexHome].filter(Boolean))];
    } else {
      // Bare-metal / systemd: the whole host filesystem is persistent.
      this.persistentRoots = null;
    }
    // The gateway workspace root is always a valid first project.
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

  /** Canonical form for persistence checks: realpath when the path exists
   * (resolves symlinks — a lexical prefix check can be bypassed by linking
   * from inside a persistent root to ephemeral storage), resolve otherwise. */
  private static canonical(target: string): string {
    // Resolve the nearest existing ancestor too. realpath(new/leaf) fails
    // even when its existing parent is a symlink out of the allowed mount.
    let ancestor = path.resolve(target);
    const missing: string[] = [];
    while (true) {
      try { return path.join(realpathSync(ancestor), ...missing.reverse()); }
      catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        missing.push(path.basename(ancestor));
        ancestor = parent;
      }
    }
  }

  /** True when target sits inside a mounted (persistent) directory. */
  isPersistent(target: string): boolean {
    if (this.persistentRoots === null) return true;
    try {
      const norm = ProjectRegistry.canonical(target);
      return this.persistentRoots.some((root) => {
        const relative = path.relative(ProjectRegistry.canonical(root), norm);
        return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      });
    } catch { return false; }
  }

  private load(): Registry {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      this.cache = { projects: Array.isArray(parsed?.projects) ? parsed.projects : [] };
    } catch {
      this.cache = { projects: [] };
    }
    return this.cache!;
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    atomicWriteFileSync(this.file, JSON.stringify(this.cache, null, 2));
  }

  list(): ProjectEntry[] {
    const seen = new Set<string>();
    return this.load()
      .projects.filter((p) => {
        if (typeof p?.path !== "string" || seen.has(p.path)) return false;
        seen.add(p.path);
        return true;
      })
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      .map((entry) => {
        let available = false;
        try { available = statSync(entry.path).isDirectory(); } catch { /* retain removable stale entries */ }
        return { ...entry, available };
      });
  }

  /**
   * Resolve a browser-selected cwd to an existing registered directory.
   * Both sides are canonicalized so aliases/symlinks cannot turn an exact
   * registry check into a path traversal. The stored spelling is returned to
   * preserve the path users recognize in Codex history.
   */
  resolveRegistered(target: string): string | null {
    if (!ProjectRegistry.validPath(target)) return null;
    let wanted: string;
    try { wanted = ProjectRegistry.canonical(target); } catch { return null; }
    for (const entry of this.list()) {
      try {
        if (ProjectRegistry.canonical(entry.path) !== wanted) continue;
        if (!statSync(entry.path).isDirectory()) return null;
        return entry.path;
      } catch {
        continue;
      }
    }
    return null;
  }

  /** Validated absolute path (POSIX or Windows drive letter); no ".." traversal. */
  static validPath(input: string): boolean {
    if (!input || input.includes("\0") || input.split(/[\\/]/).includes("..")) return false;
    if (/^[A-Za-z]:[\\/]/.test(input)) return true; // Windows drive
    return input.startsWith("/");
  }

  add(input: string, create: boolean): ProjectEntry {
    const target = this.normalize(input);
    if (!ProjectRegistry.validPath(target)) throw new Error("路径必须是绝对路径且不能包含 ..");
    if (!this.isPersistent(target)) {
      throw new Error(
        `该路径不在持久化区域内（当前允许: ${this.persistentRoots?.join(", ")}）。若网关运行在容器/受限环境中，请先把该目录挂载或加入 CODEX_PERSISTENT_ROOTS`,
      );
    }
    if (!existsSync(target)) {
      if (!create) throw new Error(`目录不存在: ${target}`);
      mkdirSync(target, { recursive: true });
    }
    if (!statSync(target).isDirectory()) throw new Error(`不是目录: ${target}`);
    if (!this.isPersistent(target)) throw new Error("目录创建期间路径发生变化，不再位于持久化区域内");
    const registry = this.load();
    const existing = registry.projects.find((p) => p.path === target);
    const now = Date.now();
    if (existing) {
      existing.lastUsedAt = now;
    } else {
      registry.projects.push({ path: target, addedAt: now, lastUsedAt: now });
    }
    this.save();
    return existing ?? { path: target, addedAt: now, lastUsedAt: now };
  }

  /** Normalize a path the same way add() does, so remove/touch find entries
   * regardless of trailing slashes or mixed separators. */
  private normalize(input: string): string {
    const root = path.parse(input).root;
    const trimmed = input.replace(/[\\/]+$/, "");
    return trimmed.length < root.length ? root : trimmed || input;
  }

  remove(target: string): void {
    const norm = this.normalize(target);
    const registry = this.load();
    registry.projects = registry.projects.filter((p) => p.path !== norm && p.path !== target);
    this.save();
  }

  touch(target: string): void {
    const norm = this.normalize(target);
    const registry = this.load();
    const entry = registry.projects.find((p) => p.path === norm || p.path === target);
    if (entry) {
      entry.lastUsedAt = Date.now();
      this.save();
    }
  }
}
