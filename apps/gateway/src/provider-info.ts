import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Which provider preset is ACTIVE in ~/.codex (exclusive activation) plus the
 * reasoning efforts its catalog declares for the configured model. Powers the
 * composer's per-turn effort selector in ALL three modes:
 * - custom: efforts probed from the endpoint at setup time (models.json)
 * - zhipu:  efforts declared by the Coding Plan catalog (models.json)
 * - openai: codex's built-in gpt catalog doesn't expose levels via model/list,
 *           so we use the documented OpenAI responses values.
 */
export interface ProviderInfo {
  mode: "openai" | "zhipu" | "custom";
  efforts: string[];
}

const OPENAI_EFFORTS = ["minimal", "low", "medium", "high"];

export class ProviderInfoReader {
  constructor(private codexHome: string) {}

  /** Mode + configured model from the active config (symlink-aware). */
  readModeAndModel(): { mode: ProviderInfo["mode"]; model: string } {
    let mode: ProviderInfo["mode"] = "openai";
    let model = "";
    try {
      const config = readFileSync(path.join(this.codexHome, "config.toml"), "utf8");
      const m = /^model_provider\s*=\s*"([^"]+)"/m.exec(config);
      if (m) {
        if (m[1] === "ZAI") mode = "zhipu";
        else if (m[1] === "custom") mode = "custom";
      }
      const mm = /^model\s*=\s*"([^"]+)"/m.exec(config);
      if (mm) model = mm[1];
    } catch {
      /* no config.toml = native OpenAI mode */
    }
    return { mode, model };
  }

  currentModel(): string {
    return this.readModeAndModel().model;
  }

  /** Custom-mode endpoint settings from the active config (admin sync). */
  customEndpoint(): { baseUrl: string; token: string; ctx: number; vision: boolean } | null {
    try {
      const config = readFileSync(path.join(this.codexHome, "config.toml"), "utf8");
      const base = /^base_url\s*=\s*"([^"]+)"/m.exec(config)?.[1];
      const token = /^experimental_bearer_token\s*=\s*"([^"]+)"/m.exec(config)?.[1] ?? "";
      if (!base) return null;
      // context window from the custom catalog when present
      let ctx = 131072;
      let vision = false;
      try {
        const catalogDecl = /^model_catalog_json\s*=\s*"([^"]+)"/m.exec(config)?.[1];
        if (catalogDecl) {
          const catalog = JSON.parse(readFileSync(catalogDecl, "utf8"));
          const entry = catalog?.models?.[0];
          if (typeof entry?.context_window === "number") ctx = entry.context_window;
          vision = Array.isArray(entry?.input_modalities) && entry.input_modalities.includes("image");
        }
      } catch { /* defaults */ }
      return { baseUrl: base, token, ctx, vision };
    } catch {
      return null;
    }
  }

  read(): ProviderInfo {
    const { mode } = this.readModeAndModel();
    const model = this.currentModel();
    let efforts: string[] = [];
    if (mode === "openai") {
      efforts = OPENAI_EFFORTS;
    } else {
      const candidates: string[] = [];
      try {
        const configText = readFileSync(path.join(this.codexHome, "config.toml"), "utf8");
        // Preferred: the path declared in model_catalog_json — handles custom
        // catalog locations that our symlink heuristic wouldn't find.
        const catalogDecl = /^model_catalog_json\s*=\s*"([^"]+)"/m.exec(configText);
        if (catalogDecl) {
          const declared = catalogDecl[1].replace(/^~/, this.codexHome.replace(/\/\.codex$/, ""));
          candidates.push(declared);
        }
        // Fallback: resolve the config symlink and look for models.json alongside.
        try {
          const real = realpathSync(path.join(this.codexHome, "config.toml"));
          candidates.push(path.join(path.dirname(real), "models.json"));
        } catch {
          /* not a symlink */
        }
      } catch {
        /* no config */
      }
      candidates.push(path.join(this.codexHome, "models.json"));
      for (const catalogPath of candidates) {
        try {
          const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
          const models = Array.isArray(catalog?.models) ? catalog.models : [];
          const entry = models.find((x: any) => x?.slug === model) ?? models[0];
          const levels = entry?.supported_reasoning_levels;
          if (Array.isArray(levels)) {
            efforts = levels.map((l: any) => (typeof l === "string" ? l : l?.effort)).filter((e: unknown): e is string => typeof e === "string");
            if (efforts.length > 0) break;
          }
        } catch {
          /* try next candidate */
        }
      }
    }
    return { mode, efforts };
  }
}
