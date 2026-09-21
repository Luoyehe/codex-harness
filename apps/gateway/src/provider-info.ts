import { lstatSync, realpathSync, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { readBoundedRegularTextFileSync } from "./bounded-file.js";

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

export const PROVIDER_INFO_LIMITS = {
  configBytes: 1024 * 1024,
  catalogBytes: 1024 * 1024,
  nodes: 65_536,
  fields: 65_536,
  fieldsPerObject: 1_024,
  depth: 48,
  tables: 4_096,
  fieldNameBytes: 256,
  modelEntries: 256,
  modelIdChars: 256,
  modelIdsBytes: 64 * 1024,
  reasoningLevels: 64,
  inputModalities: 32,
  efforts: 16,
  providerIdChars: 256,
  pathChars: 4_096,
  urlChars: 2_048,
} as const;

interface ParsedConfig {
  top: Map<string, unknown>;
  tables: Map<string, Map<string, unknown>>;
  sourcePath: string;
}

interface ModelCatalog {
  models: Array<Record<string, unknown>>;
}

interface FileSnapshot {
  real: string;
  identity: string;
}

interface CacheEntry<T> extends FileSnapshot {
  value: T;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function boundedString(value: unknown, maxChars: number, allowEmpty = false): string | undefined {
  if (typeof value !== "string" || value.length > maxChars || (!allowEmpty && value.length === 0)
      || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

/** Bound generic parsed trees before walking their fields. The byte bound
 * limits parser allocation; these limits bound every subsequent traversal. */
function hasBoundedStructure(root: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let fields = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > PROVIDER_INFO_LIMITS.nodes || current.depth > PROVIDER_INFO_LIMITS.depth) return false;
    if (!current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value)) return false;
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      if (current.value.length > PROVIDER_INFO_LIMITS.nodes - nodes + 1) return false;
      for (let index = 0; index < current.value.length; index += 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    const entries = Object.entries(current.value);
    if (entries.length > PROVIDER_INFO_LIMITS.fieldsPerObject) return false;
    fields += entries.length;
    if (fields > PROVIDER_INFO_LIMITS.fields || entries.length > PROVIDER_INFO_LIMITS.nodes - nodes + 1) return false;
    for (const [key, child] of entries) {
      if (!key || Buffer.byteLength(key, "utf8") > PROVIDER_INFO_LIMITS.fieldNameBytes
          || /[\u0000-\u001f\u007f]/.test(key)) return false;
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
}

/** Parse the entire TOML document; quoted keys and inline tables are valid. */
function parseConfig(text: string, sourcePath: string): ParsedConfig {
  const document = parse(text, { integersAsBigInt: "asNeeded" });
  if (!record(document) || !hasBoundedStructure(document)) throw new Error("provider config exceeds structural limits");
  const tables = new Map<string, Map<string, unknown>>();
  const stack: Array<{ value: Record<string, unknown>; prefix: string[] }> = [{ value: document, prefix: [] }];
  while (stack.length > 0) {
    const { value, prefix } = stack.pop()!;
    for (const [key, child] of Object.entries(value)) {
      if (!record(child)) continue;
      const name = [...prefix, key];
      if (tables.size >= PROVIDER_INFO_LIMITS.tables) throw new Error("provider config has too many tables");
      tables.set(name.join("."), new Map(Object.entries(child)));
      stack.push({ value: child, prefix: name });
    }
  }
  return { top: new Map(Object.entries(document)), tables, sourcePath };
}

function providerMode(id: string): ProviderInfo["mode"] {
  const normalized = id.toLowerCase();
  if (normalized === "zai" || normalized === "zhipu") return "zhipu";
  if (normalized === "custom") return "custom";
  return "openai";
}

function regularSnapshot(file: string, maxBytes: number): FileSnapshot {
  const real = realpathSync(file);
  const info: Stats = lstatSync(real);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 0 || info.size > maxBytes) {
    throw new Error("provider metadata is not a bounded singly-linked regular file");
  }
  return {
    real,
    identity: [real, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join("\0"),
  };
}

function sameSnapshot(one: FileSnapshot, two: FileSnapshot): boolean {
  return one.real === two.real && one.identity === two.identity;
}

function parseCatalog(text: string): ModelCatalog {
  const value = JSON.parse(text) as unknown;
  // Reject the potentially large collection before any find/map/filter or
  // generic tree traversal pass.
  if (!record(value) || !Array.isArray(value.models)
      || value.models.length > PROVIDER_INFO_LIMITS.modelEntries) throw new Error("model catalog exceeds structural limits");
  const models: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let aggregateIdBytes = 0;
  for (const entry of value.models) {
    if (!record(entry)) throw new Error("invalid model catalog entry");
    const slug = boundedString(entry.slug, PROVIDER_INFO_LIMITS.modelIdChars);
    if (!slug || seen.has(slug)) throw new Error("invalid or duplicate model identifier");
    seen.add(slug);
    aggregateIdBytes += Buffer.byteLength(slug, "utf8") + 1;
    if (aggregateIdBytes > PROVIDER_INFO_LIMITS.modelIdsBytes) throw new Error("model identifiers exceed aggregate limit");
    if (entry.supported_reasoning_levels !== undefined
        && (!Array.isArray(entry.supported_reasoning_levels)
          || entry.supported_reasoning_levels.length > PROVIDER_INFO_LIMITS.reasoningLevels)) {
      throw new Error("model reasoning levels exceed limit");
    }
    if (entry.input_modalities !== undefined
        && (!Array.isArray(entry.input_modalities)
          || entry.input_modalities.length > PROVIDER_INFO_LIMITS.inputModalities)) {
      throw new Error("model input modalities exceed limit");
    }
    models.push(entry);
  }
  if (!hasBoundedStructure(value)) throw new Error("model catalog exceeds structural limits");
  return { models };
}

function selectedModel(catalog: ModelCatalog | null, model: string): Record<string, unknown> | undefined {
  // A missing/empty configured model is not an instruction to borrow the
  // first catalog entry. Doing so can overstate context, vision, or effort
  // support for a malformed or only partially written external config.
  if (!catalog || !model) return undefined;
  for (const entry of catalog.models) if (entry.slug === model) return entry;
  return undefined;
}

function validatedHttpUrl(value: unknown): string | null {
  const raw = boundedString(value, PROVIDER_INFO_LIMITS.urlChars);
  if (!raw || /\s/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)
        || url.username || url.password || url.search || url.hash) return null;
    return raw;
  } catch {
    return null;
  }
}

const sameKeys = (table: Map<string, unknown>, expected: readonly string[]): boolean =>
  table.size === expected.length && expected.every((key) => table.has(key));

const sameStringArray = (value: unknown, expected: readonly string[]): boolean =>
  Array.isArray(value) && value.length === expected.length
  && expected.every((item, index) => value[index] === item);

const MANAGED_HTTP_SERVERS = new Map([
  ["web-search-prime", "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp"],
  ["web-reader", "https://open.bigmodel.cn/api/mcp/web_reader/mcp"],
  ["zread", "https://open.bigmodel.cn/api/mcp/zread/mcp"],
]);

export class ProviderInfoReader {
  private readonly configPath: string;
  private readonly managedHttpBridge: string;
  private configCache: CacheEntry<ParsedConfig> | null = null;
  private readonly catalogCache = new Map<string, CacheEntry<ModelCatalog>>();

  constructor(private codexHome: string) {
    this.configPath = path.join(codexHome, "config.toml");
    this.managedHttpBridge = fileURLToPath(new URL("../../../deploy/providers/zhipu-coding-plan/mcp-http-bridge.mjs", import.meta.url));
  }

  private config(): ParsedConfig | null {
    let before: FileSnapshot;
    try {
      before = regularSnapshot(this.configPath, PROVIDER_INFO_LIMITS.configBytes);
      if (this.configCache && sameSnapshot(before, this.configCache)) return this.configCache.value;
      const value = parseConfig(
        readBoundedRegularTextFileSync(before.real, PROVIDER_INFO_LIMITS.configBytes),
        before.real,
      );
      // Re-resolve the active alias after the read. A concurrent preset switch
      // must never combine an old config with a new generation's trust claim.
      const after = regularSnapshot(this.configPath, PROVIDER_INFO_LIMITS.configBytes);
      if (!sameSnapshot(before, after)) throw new Error("provider config generation changed while reading");
      this.configCache = { ...after, value };
      return value;
    } catch {
      // Never return a previously cached generation after a stat/read/parse
      // failure. A later call must prove a fresh stable identity again.
      this.configCache = null;
      return null;
    }
  }

  private snapshot(config = this.config()): {
    mode: ProviderInfo["mode"];
    model: string;
    modelValid: boolean;
    providerId: string;
    config: ParsedConfig | null;
  } {
    const providerId = boundedString(config?.top.get("model_provider"), PROVIDER_INFO_LIMITS.providerIdChars) ?? "openai";
    const rawModel = config?.top.get("model");
    const parsedModel = boundedString(rawModel, PROVIDER_INFO_LIMITS.modelIdChars, true);
    const modelValid = rawModel === undefined || parsedModel !== undefined;
    const model = parsedModel ?? "";
    return { mode: providerMode(providerId), model, modelValid, providerId, config };
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
    const declared = boundedString(config.top.get("model_catalog_json"), PROVIDER_INFO_LIMITS.pathChars);
    if (!declared) return null;
    let resolved: string;
    if (declared === "~") resolved = os.homedir();
    else if (declared.startsWith("~/") || declared.startsWith("~\\")) resolved = path.join(os.homedir(), declared.slice(2));
    else resolved = path.isAbsolute(declared) ? declared : path.resolve(path.dirname(config.sourcePath), declared);
    return resolved.length <= PROVIDER_INFO_LIMITS.pathChars ? resolved : null;
  }

  private rememberCatalog(entry: CacheEntry<ModelCatalog>): void {
    this.catalogCache.delete(entry.real);
    this.catalogCache.set(entry.real, entry);
    while (this.catalogCache.size > 4) this.catalogCache.delete(this.catalogCache.keys().next().value!);
  }

  private readCatalog(catalogPath: string): ModelCatalog | null {
    let before: FileSnapshot | null = null;
    try {
      before = regularSnapshot(catalogPath, PROVIDER_INFO_LIMITS.catalogBytes);
      const cached = this.catalogCache.get(before.real);
      if (cached && sameSnapshot(before, cached)) {
        this.catalogCache.delete(before.real);
        this.catalogCache.set(before.real, cached);
        return cached.value;
      }
      const value = parseCatalog(readBoundedRegularTextFileSync(before.real, PROVIDER_INFO_LIMITS.catalogBytes));
      const after = regularSnapshot(catalogPath, PROVIDER_INFO_LIMITS.catalogBytes);
      if (!sameSnapshot(before, after)) throw new Error("model catalog generation changed while reading");
      this.rememberCatalog({ ...after, value });
      return value;
    } catch {
      if (before) this.catalogCache.delete(before.real);
      return null;
    }
  }

  /** Prove that a bypassed MCP call belongs to the active managed Zhipu
   * generation. Names and metadata alone are attacker-controlled. */
  isManagedZhipuMcpServer(serverName: string): boolean {
    const snap = this.snapshot();
    if (!snap.config || snap.mode !== "zhipu" || snap.providerId !== "ZAI") return false;
    const provider = snap.config.tables.get("model_providers.ZAI");
    if (!provider || !sameKeys(provider, ["name", "base_url", "env_key", "wire_api"])
        || provider.get("name") !== "Zhipu Coding Plan"
        || provider.get("base_url") !== "https://open.bigmodel.cn/api/v1"
        || provider.get("env_key") !== "Z_AI_API_KEY"
        || provider.get("wire_api") !== "responses") return false;
    if (snap.config.tables.get("features")?.get("mcp_2026_07_28") !== true) return false;

    const server = snap.config.tables.get(`mcp_servers.${serverName}`);
    if (!server) return false;
    const endpoint = MANAGED_HTTP_SERVERS.get(serverName);
    if (endpoint) {
      const args = server.get("args");
      return sameKeys(server, ["type", "startup_timeout_sec", "default_tools_approval_mode", "command", "env_vars", "args"])
        && server.get("type") === "local"
        && server.get("startup_timeout_sec") === 120
        && server.get("default_tools_approval_mode") === "approve"
        && server.get("command") === "node"
        && sameStringArray(server.get("env_vars"), ["Z_AI_API_KEY"])
        && Array.isArray(args) && args.length === 2
        && typeof args[0] === "string" && path.isAbsolute(args[0])
        && path.normalize(args[0]) === path.normalize(this.managedHttpBridge)
        && args[1] === endpoint;
    }
    if (serverName !== "zai-mcp-server") return false;
    const env = server.get("env");
    return sameKeys(server, ["type", "default_tools_approval_mode", "command", "env_vars", "env"])
      && server.get("type") === "local"
      && server.get("default_tools_approval_mode") === "approve"
      && server.get("command") === "zai-mcp-server"
      && sameStringArray(server.get("env_vars"), ["Z_AI_API_KEY"])
      && record(env) && Object.keys(env).length === 1 && env.Z_AI_MODE === "ZHIPU";
  }

  /** Custom-mode endpoint settings from the active provider table only. */
  customEndpoint(): CustomEndpointInfo | null {
    return this.customEndpointFrom(this.snapshot());
  }

  private customEndpointFrom(snap: ReturnType<ProviderInfoReader["snapshot"]>): CustomEndpointInfo | null {
    if (snap.mode !== "custom" || !snap.config) return null;
    const table = this.providerTable(snap.config, snap.providerId);
    const baseUrl = validatedHttpUrl(table?.get("base_url"));
    if (!baseUrl) return null;

    let ctx = 131_072;
    let vision = false;
    const declared = this.catalogPath(snap.config);
    const entry = snap.modelValid
      ? selectedModel(declared ? this.readCatalog(declared) : null, snap.model)
      : undefined;
    if (typeof entry?.context_window === "number" && Number.isSafeInteger(entry.context_window)
        && entry.context_window >= 1024 && entry.context_window <= 16_777_216) ctx = entry.context_window;
    if (Array.isArray(entry?.input_modalities)) {
      for (const modality of entry.input_modalities) if (modality === "image") { vision = true; break; }
    }
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
    // There is no provider-wide OpenAI effort list. The selected model's
    // model/list capability record is the authority (including unknown).
    if (snap.mode === "openai") return { mode: snap.mode, efforts: [] };
    if (!snap.modelValid) return { mode: snap.mode, efforts: [] };

    const candidates: string[] = [];
    if (snap.config) {
      const declared = this.catalogPath(snap.config);
      if (declared) candidates.push(declared);
      candidates.push(path.join(path.dirname(snap.config.sourcePath), "models.json"));
    }
    candidates.push(path.join(this.codexHome, "models.json"));

    const seen = new Set<string>();
    for (const catalogPath of candidates) {
      const normalized = path.resolve(catalogPath);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const entry = selectedModel(this.readCatalog(catalogPath), snap.model);
      const levels = entry?.supported_reasoning_levels;
      if (!Array.isArray(levels)) continue;
      const efforts: string[] = [];
      const unique = new Set<string>();
      for (let index = 0; index < levels.length && efforts.length < PROVIDER_INFO_LIMITS.efforts; index += 1) {
        const level = levels[index];
        const effort = typeof level === "string" ? level : record(level) ? level.effort : undefined;
        if (typeof effort === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(effort) && !unique.has(effort)) {
          unique.add(effort);
          efforts.push(effort);
        }
      }
      if (efforts.length > 0) return { mode: snap.mode, efforts };
    }
    return { mode: snap.mode, efforts: [] };
  }
}
