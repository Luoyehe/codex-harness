import { readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";

/** Active provider preset and the configured model's reasoning efforts. */
export interface ProviderInfo {
  mode: "openai" | "zhipu" | "custom";
  efforts: string[];
}

export interface CustomEndpointInfo {
  baseUrl: string;
  ctx: number;
  vision: boolean;
}

const OPENAI_EFFORTS = ["minimal", "low", "medium", "high"];
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

interface ParsedConfig {
  top: Map<string, unknown>;
  tables: Map<string, Map<string, unknown>>;
}

function parseTomlString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Parse the entire TOML document; quoted keys and inline tables are valid. */
function parseConfig(text: string): ParsedConfig {
  const document = parse(text, { integersAsBigInt: "asNeeded" });
  const tables = new Map<string, Map<string, unknown>>();
  const visit = (value: Record<string, unknown>, prefix: string[]) => {
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === "object" && !Array.isArray(child)) {
        const name = [...prefix, key];
        const table = child as Record<string, unknown>;
        tables.set(name.join("."), new Map(Object.entries(table)));
        visit(table, name);
      }
    }
  };
  visit(document, []);
  return { top: new Map(Object.entries(document)), tables };
}

function providerMode(id: string): ProviderInfo["mode"] {
  const normalized = id.toLowerCase();
  if (normalized === "zai" || normalized === "zhipu") return "zhipu";
  if (normalized === "custom") return "custom";
  return "openai";
}

export class ProviderInfoReader {
  private readonly configPath: string;

  constructor(private codexHome: string) {
    this.configPath = path.join(codexHome, "config.toml");
  }

  private config(): ParsedConfig | null {
    try {
      if (statSync(this.configPath).size > MAX_CONFIG_BYTES) return null;
      return parseConfig(readFileSync(this.configPath, "utf8"));
    } catch {
      return null;
    }
  }

  private snapshot(config = this.config()): {
    mode: ProviderInfo["mode"];
    model: string;
    providerId: string;
    config: ParsedConfig | null;
  } {
    const providerId = parseTomlString(config?.top.get("model_provider")) ?? "openai";
    const model = parseTomlString(config?.top.get("model")) ?? "";
    return { mode: providerMode(providerId), model, providerId, config };
  }

  /** Mode + configured model from top-level config keys. */
  readModeAndModel(): { mode: ProviderInfo["mode"]; model: string } {
    const { mode, model } = this.snapshot();
    return { mode, model };
  }

  currentModel(): string {
    return this.readModeAndModel().model;
  }

  private providerTable(config: ParsedConfig, providerId: string): Map<string, unknown> | undefined {
    const exact = config.tables.get(`model_providers.${providerId}`);
    if (exact) return exact;
    const wanted = `model_providers.${providerId}`.toLowerCase();
    for (const [name, table] of config.tables) {
      if (name.toLowerCase() === wanted) return table;
    }
    return undefined;
  }

  private catalogPath(config: ParsedConfig): string | null {
    const declared = parseTomlString(config.top.get("model_catalog_json"));
    if (!declared || declared.includes("\0")) return null;
    if (declared === "~") return os.homedir();
    if (declared.startsWith("~/") || declared.startsWith("~\\")) {
      return path.join(os.homedir(), declared.slice(2));
    }
    return path.isAbsolute(declared) ? declared : path.resolve(path.dirname(this.configPath), declared);
  }

  private readCatalog(catalogPath: string): any | null {
    try {
      if (statSync(catalogPath).size > MAX_CATALOG_BYTES) return null;
      return JSON.parse(readFileSync(catalogPath, "utf8"));
    } catch {
      return null;
    }
  }

  /** Custom-mode endpoint settings from the active provider table only. */
  customEndpoint(): CustomEndpointInfo | null {
    return this.customEndpointFrom(this.snapshot());
  }

  private customEndpointFrom(snap: ReturnType<ProviderInfoReader["snapshot"]>): CustomEndpointInfo | null {
    if (snap.mode !== "custom" || !snap.config) return null;
    const table = this.providerTable(snap.config, snap.providerId);
    const baseUrl = parseTomlString(table?.get("base_url"));
    if (!baseUrl) return null;

    let ctx = 131_072;
    let vision = false;
    const declared = this.catalogPath(snap.config);
    const catalog = declared ? this.readCatalog(declared) : null;
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    const entry = snap.model ? models.find((item: any) => item?.slug === snap.model) : models[0];
    if (Number.isInteger(entry?.context_window) && entry.context_window >= 1024 && entry.context_window <= 16_777_216) {
      ctx = entry.context_window;
    }
    vision = Array.isArray(entry?.input_modalities) && entry.input_modalities.includes("image");
    return { baseUrl, ctx, vision };
  }

  /** One config read for admin workflows that must not mix two provider
   * generations if another browser switches the symlink concurrently. */
  adminSnapshot(): {
    mode: ProviderInfo["mode"];
    model: string;
    custom: CustomEndpointInfo | null;
  } {
    const snap = this.snapshot();
    return { mode: snap.mode, model: snap.model, custom: this.customEndpointFrom(snap) };
  }

  read(): ProviderInfo {
    const snap = this.snapshot();
    if (snap.mode === "openai") return { mode: snap.mode, efforts: [...OPENAI_EFFORTS] };

    const candidates: string[] = [];
    if (snap.config) {
      const declared = this.catalogPath(snap.config);
      if (declared) candidates.push(declared);
      try {
        const real = realpathSync(this.configPath);
        candidates.push(path.join(path.dirname(real), "models.json"));
      } catch { /* not a symlink */ }
    }
    candidates.push(path.join(this.codexHome, "models.json"));

    const seen = new Set<string>();
    for (const catalogPath of candidates) {
      if (seen.has(catalogPath)) continue;
      seen.add(catalogPath);
      const catalog = this.readCatalog(catalogPath);
      const models = Array.isArray(catalog?.models) ? catalog.models : [];
      const entry = snap.model ? models.find((item: any) => item?.slug === snap.model) : models[0];
      const levels = entry?.supported_reasoning_levels;
      if (!Array.isArray(levels)) continue;
      const efforts = [...new Set(
        levels
          .map((level: any) => (typeof level === "string" ? level : level?.effort))
          .filter((effort: unknown): effort is string =>
            typeof effort === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(effort)),
      )].slice(0, 16);
      if (efforts.length > 0) return { mode: snap.mode, efforts };
    }
    return { mode: snap.mode, efforts: [] };
  }
}
