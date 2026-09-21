import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-file.js";
import { readBoundedRegularTextFileSync } from "./bounded-file.js";

/**
 * Timeline display preferences (which item categories the WebUI shows),
 * persisted next to CODEX_HOME so the choice survives restarts and applies
 * to every browser — unlike theme/Enter, which stay per-browser in
 * localStorage.
 */
export interface DisplayPrefs {
  reasoning: boolean;
  commands: boolean;
  fileChanges: boolean;
  mcpCalls: boolean;
  webSearch: boolean;
  /** Auto-compact trigger fraction (0 <= value < 1). 0 = disabled. */
  autoCompactThreshold: number;
}

const KEYS = ["reasoning", "commands", "fileChanges", "mcpCalls", "webSearch", "autoCompactThreshold"] as const;

const DEFAULTS: DisplayPrefs = {
  reasoning: true,
  commands: true,
  fileChanges: true,
  mcpCalls: true,
  webSearch: true,
  autoCompactThreshold: 0.9,
};

export class DisplayPrefsStore {
  private file: string;
  private cached: DisplayPrefs | null = null;

  constructor(codexHome: string) {
    this.file = path.join(codexHome, "webui-display.json");
  }

  private load(): DisplayPrefs {
    try {
      const parsed = JSON.parse(readBoundedRegularTextFileSync(this.file, 64 * 1024));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("display preference document is not an object");
      }
      const next: DisplayPrefs = { ...DEFAULTS };
      for (const key of KEYS) {
        if (key === "autoCompactThreshold") {
          if (Object.prototype.hasOwnProperty.call(parsed, key)) {
            const v = (parsed as Record<string, unknown>)[key];
            if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1) next[key] = v;
            else {
              // A present-but-invalid automatic action threshold is not the
              // same as a first install. Disable it until the user saves a
              // valid value instead of silently re-enabling the 90% default.
              next[key] = 0;
              process.stderr.write("[display-prefs] invalid auto-compaction threshold; automatic compaction is disabled\n");
            }
          }
        } else if (typeof (parsed as Record<string, unknown>)[key] === "boolean") {
          next[key] = (parsed as Record<string, unknown>)[key] as boolean;
        }
      }
      return next;
    } catch (error: any) {
      // Only genuine absence represents a first install. An existing file
      // that is corrupt, oversized, linked, unreadable or changing while it
      // is read must fail closed for the automatic action.
      if (error?.code === "ENOENT") return { ...DEFAULTS };
      process.stderr.write("[display-prefs] preferences could not be read safely; automatic compaction is disabled\n");
      return { ...DEFAULTS, autoCompactThreshold: 0 };
    }
  }

  get(): DisplayPrefs {
    // This is on the token-usage notification path. Retain the last valid (or
    // fail-closed initial) snapshot instead of synchronously reading disk for
    // every notification.
    this.cached ??= this.load();
    return { ...this.cached };
  }

  set(patch: unknown): DisplayPrefs {
    const next = this.get();
    const source = patch && typeof patch === "object" && !Array.isArray(patch)
      ? patch as Record<string, unknown> : {};
    for (const key of KEYS) {
      if (key === "autoCompactThreshold") {
        const v = source[key];
        if (typeof v === "number" && v >= 0 && v < 1) next.autoCompactThreshold = v;
      } else if (typeof source[key] === "boolean") {
        (next as any)[key] = source[key] as boolean;
      }
    }
    if (!existsSync(path.dirname(this.file))) {
      mkdirSync(path.dirname(this.file), { recursive: true });
    }
    atomicWriteFileSync(this.file, JSON.stringify(next, null, 2));
    // Publish the new in-memory value only after durable replacement succeeds.
    this.cached = next;
    return { ...next };
  }
}
