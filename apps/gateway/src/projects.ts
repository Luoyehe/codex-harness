import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Simple project registry persisted next to CODEX_HOME so it survives
 * container restarts (codex-home is a mounted volume). A project is just a
 * working directory the agent may be pointed at via thread/start {cwd}.
 */

export interface ProjectEntry {
  path: string;
  addedAt: number;
  lastUsedAt: number;
}

interface Registry {
  projects: ProjectEntry[];
}

export class ProjectRegistry {
  private file: string;
  private cache: Registry | null = null;
  /**
   * Paths guaranteed to be persistent mounts in the container. Creating a
   * project anywhere else would land in the container's ephemeral layer and
   * vanish on rebuild, so add() refuses with an actionable error instead.
   */
  private persistentRoots: string[];

  constructor(codexHome: string, workspaceRoot: string, persistentRoots: string[] = []) {
    this.file = path.join(codexHome, "webui-projects.json");
    if (persistentRoots.length > 0) {
      this.persistentRoots = [...new Set(persistentRoots.filter(Boolean))];
    } else if (ProjectRegistry.runningInContainer()) {
      // Inside Docker only mounted paths survive a rebuild; keep the guard so
      // projects never land in the ephemeral container layer by accident.
      this.persistentRoots = [...new Set([workspaceRoot, codexHome, "/srv", "/opt", "/home"].filter(Boolean))];
    } else {
      // Bare-metal / systemd: the whole host filesystem is persistent.
      this.persistentRoots = ["/"];
    }
    // The gateway workspace root is always a valid first project.
    const bootstrap: Registry = {
      projects: [{ path: workspaceRoot, addedAt: Date.now(), lastUsedAt: Date.now() }],
    };
    if (!existsSync(this.file)) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(bootstrap, null, 2));
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
    try {
      return realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  }

  /** True when target sits inside a mounted (persistent) directory. */
  isPersistent(target: string): boolean {
    const norm = ProjectRegistry.canonical(target).replace(/[\\/]+$/, "");
    return this.persistentRoots.some((root) => {
      const r = ProjectRegistry.canonical(root).replace(/[\\/]+$/, "");
      if (r === "/" || r === "") return true; // everything is persistent
      return norm === r || norm.startsWith(r + "/") || norm.startsWith(r + "\\");
    });
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
    writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
  }

  list(): ProjectEntry[] {
    const seen = new Set<string>();
    return this.load()
      .projects.filter((p) => {
        if (typeof p?.path !== "string" || seen.has(p.path)) return false;
        seen.add(p.path);
        return true;
      })
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
  }

  /** Validated absolute path (POSIX or Windows drive letter); no ".." traversal. */
  static validPath(input: string): boolean {
    if (!input || input.includes("\0") || input.split(/[\\/]/).includes("..")) return false;
    if (/^[A-Za-z]:[\\/]/.test(input)) return true; // Windows drive
    return input.startsWith("/");
  }

  add(input: string, create: boolean): ProjectEntry {
    const target = input.replace(/[\\/]+$/, "") || input;
    if (!ProjectRegistry.validPath(target)) throw new Error("路径必须是绝对路径且不能包含 ..");
    if (!this.isPersistent(target)) {
      throw new Error(
        `该路径不在持久化区域内（当前允许: ${this.persistentRoots.join(", ")}）。若网关运行在容器/受限环境中，请先把该目录挂载或加入 CODEX_PERSISTENT_ROOTS`,
      );
    }
    if (!existsSync(target)) {
      if (!create) throw new Error(`目录不存在: ${target}`);
      mkdirSync(target, { recursive: true });
    }
    if (!statSync(target).isDirectory()) throw new Error(`不是目录: ${target}`);
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
    return input.replace(/[\\/]+$/, "") || input;
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
