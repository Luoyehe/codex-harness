import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-file.js";

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
  /** Auto-compact trigger threshold (0-1). 0 = disabled. */
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

  constructor(codexHome: string) {
    this.file = path.join(codexHome, "webui-display.json");
  }

  get(): DisplayPrefs {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      const next: DisplayPrefs = { ...DEFAULTS };
      for (const key of KEYS) {
        if (key === "autoCompactThreshold") {
          const v = parsed?.[key];
          if (typeof v === "number" && v >= 0 && v <= 1) next[key] = v;
        } else if (typeof parsed?.[key] === "boolean") {
          next[key] = parsed[key] as boolean;
        }
      }
      return next;
    } catch {
      return { ...DEFAULTS };
    }
  }

  set(patch: unknown): DisplayPrefs {
    const next = this.get();
    const source = (patch ?? {}) as Record<string, unknown>;
    for (const key of KEYS) {
      if (key === "autoCompactThreshold") {
        const v = source[key];
        if (typeof v === "number" && v >= 0 && v <= 1) next.autoCompactThreshold = v;
      } else if (typeof source[key] === "boolean") {
        (next as any)[key] = source[key] as boolean;
      }
    }
    if (!existsSync(path.dirname(this.file))) {
      mkdirSync(path.dirname(this.file), { recursive: true });
    }
    atomicWriteFileSync(this.file, JSON.stringify(next, null, 2));
    return next;
  }
}
