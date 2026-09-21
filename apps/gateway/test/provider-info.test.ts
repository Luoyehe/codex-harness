import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROVIDER_INFO_LIMITS, ProviderInfoReader } from "../src/provider-info.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixtureData(config: string, catalog?: unknown): { home: string; reader: ProviderInfoReader } {
  const home = mkdtempSync(path.join(tmpdir(), "codex-provider-info-"));
  homes.push(home);
  writeFileSync(path.join(home, "config.toml"), config);
  if (catalog) writeFileSync(path.join(home, "models.json"), JSON.stringify(catalog));
  return { home, reader: new ProviderInfoReader(home) };
}

function fixture(config: string, catalog?: unknown): ProviderInfoReader {
  return fixtureData(config, catalog).reader;
}

describe("ProviderInfoReader", () => {
  it("parses quoted keys and inline provider tables using TOML semantics", () => {
    const reader = fixture('"model_provider" = "custom"\n"model" = "selected"\nmodel_providers = { custom = { base_url = "https://api.example.com/v1" } }\n');
    expect(reader.readModeAndModel()).toEqual({ mode: "custom", model: "selected" });
    expect(reader.customEndpoint()?.baseUrl).toBe("https://api.example.com/v1");
  });
  it("uses top-level mode/model and the selected catalog entry", () => {
    const reader = fixture(
      `model_provider = "custom"\nmodel = "chosen"\nmodel_catalog_json = "models.json"\n\n[model_providers.custom]\nmodel = "wrong-table-value"\nbase_url = "https://api.example.com/v1"\nenv_key = "CUSTOM_OPENAI_API_KEY"\n`,
      { models: [
        { slug: "first", context_window: 2048, supported_reasoning_levels: ["low"] },
        { slug: "chosen", context_window: 65536, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "high" }] },
      ] },
    );

    expect(reader.readModeAndModel()).toEqual({ mode: "custom", model: "chosen" });
    expect(reader.read()).toEqual({ mode: "custom", efforts: ["high"] });
    expect(reader.customEndpoint()).toEqual({
      baseUrl: "https://api.example.com/v1",
      ctx: 65536,
      vision: true,
    });
  });

  it("never exposes a legacy bearer token to gateway callers", () => {
    const reader = fixture(`model_provider = "custom"\nmodel = "m"\n[model_providers.custom]\nbase_url = "https://api.example.com/v1"\nexperimental_bearer_token = "legacy-secret-value"\n`);
    expect(reader.customEndpoint()).toEqual({ baseUrl: "https://api.example.com/v1", ctx: 131072, vision: false });
  });

  it("ignores model keys and table-looking text inside multiline instructions", () => {
    const reader = fixture('model_provider = "custom"\nmodel = "chosen"\ninstructions = """\nmodel = "wrong"\n[model_providers.fake]\n"""\n[model_providers.custom]\nbase_url = "https://api.example.com/v1"\n');
    expect(reader.readModeAndModel()).toEqual({ mode: "custom", model: "chosen" });
    expect(reader.customEndpoint()?.baseUrl).toBe("https://api.example.com/v1");
  });

  it("does not borrow another model's capabilities when the configured model is absent", () => {
    const reader = fixture(
      `model_provider = "custom"\nmodel = "missing"\nmodel_catalog_json = "models.json"\n[model_providers.custom]\nbase_url = "https://api.example.com/v1"\n`,
      { models: [{ slug: "unrelated", context_window: 2048, input_modalities: ["image"], supported_reasoning_levels: ["high"] }] },
    );
    expect(reader.read()).toEqual({ mode: "custom", efforts: [] });
    expect(reader.customEndpoint()).toEqual({ baseUrl: "https://api.example.com/v1", ctx: 131072, vision: false });
  });

  it("does not borrow the first catalog entry when the configured model is missing or empty", () => {
    for (const declaration of ["", 'model = ""\n']) {
      const reader = fixture(
        `model_provider = "custom"\n${declaration}model_catalog_json = "models.json"\n[model_providers.custom]\nbase_url = "https://api.example.com/v1"\n`,
        { models: [{ slug: "first", context_window: 2048, input_modalities: ["image"], supported_reasoning_levels: ["high"] }] },
      );
      expect(reader.read()).toEqual({ mode: "custom", efforts: [] });
      expect(reader.customEndpoint()).toEqual({ baseUrl: "https://api.example.com/v1", ctx: 131072, vision: false });
    }
  });

  it("supports the deployed active-config symlink while rejecting multiply-linked metadata", (context) => {
    const home = mkdtempSync(path.join(tmpdir(), "codex-provider-info-"));
    homes.push(home);
    const preset = path.join(home, "providers", "custom");
    mkdirSync(preset, { recursive: true });
    const target = path.join(preset, "config.toml");
    writeFileSync(target, 'model_provider = "custom"\nmodel = "linked"\n[model_providers.custom]\nbase_url = "https://api.example.com/v1"\n');
    try { symlinkSync(target, path.join(home, "config.toml"), "file"); }
    catch (error: any) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) { context.skip("file symlinks unavailable"); return; }
      throw error;
    }
    const reader = new ProviderInfoReader(home);
    expect(reader.readModeAndModel()).toEqual({ mode: "custom", model: "linked" });

    linkSync(target, path.join(home, "config-alias.toml"));
    expect(reader.readModeAndModel()).toEqual({ mode: "openai", model: "" });
  });

  it.each([
    "https://user:secret@example.com/v1",
    "https://api.example.com/v1?token=secret",
    "https://api.example.com/v1#fragment",
    "file:///tmp/provider",
    "javascript:alert(1)",
  ])("rejects a non-compliant custom endpoint URL: %s", (baseUrl) => {
    const reader = fixture(`model_provider = "custom"\nmodel = "m"\n[model_providers.custom]\nbase_url = ${JSON.stringify(baseUrl)}\n`);
    expect(reader.customEndpoint()).toBeNull();
  });

  it("invalidates cached config generations after edits, read failure, and repair", () => {
    const original = 'model_provider = "custom"\nmodel = "original"\n[model_providers.custom]\nbase_url = "https://api.example.com/v1"\n';
    const { home, reader } = fixtureData(original);
    const config = path.join(home, "config.toml");
    expect(reader.readModeAndModel()).toEqual({ mode: "custom", model: "original" });
    writeFileSync(config, original.replace('model = "original"', 'model = "updated"'));
    expect(reader.readModeAndModel()).toEqual({ mode: "custom", model: "updated" });
    rmSync(config);
    expect(reader.readModeAndModel()).toEqual({ mode: "openai", model: "" });
    expect(reader.customEndpoint()).toBeNull();
    writeFileSync(config, original);
    expect(reader.readModeAndModel()).toEqual({ mode: "custom", model: "original" });
    expect(reader.customEndpoint()?.baseUrl).toBe("https://api.example.com/v1");
  });

  it("aligns catalog bytes with deploy and rejects oversized collections before capability iteration", () => {
    expect(PROVIDER_INFO_LIMITS.catalogBytes).toBe(1024 * 1024);
    const config = 'model_provider = "custom"\nmodel = "chosen"\nmodel_catalog_json = "models.json"\n[model_providers.custom]\nbase_url = "https://api.example.com/v1"\n';
    const catalogs: unknown[] = [
      { models: Array.from({ length: PROVIDER_INFO_LIMITS.modelEntries + 1 }, (_, index) => ({ slug: `m-${index}` })) },
      { models: [{ slug: "chosen", supported_reasoning_levels: Array.from({ length: PROVIDER_INFO_LIMITS.reasoningLevels + 1 }, () => "low") }] },
      { models: [{ slug: "chosen", input_modalities: Array.from({ length: PROVIDER_INFO_LIMITS.inputModalities + 1 }, () => "text") }] },
      { models: [{ slug: "chosen" }], ...Object.fromEntries(Array.from({ length: PROVIDER_INFO_LIMITS.fieldsPerObject + 1 }, (_, index) => [`field-${index}`, true])) },
    ];
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < PROVIDER_INFO_LIMITS.depth + 1; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    catalogs.push({ models: [{ slug: "chosen", extra: deep }] });
    for (const catalog of catalogs) {
      const reader = fixture(config, catalog);
      expect(reader.read()).toEqual({ mode: "custom", efforts: [] });
      expect(reader.customEndpoint()).toEqual({ baseUrl: "https://api.example.com/v1", ctx: 131072, vision: false });
    }
  });

  it("bounds config depth and bytes and never borrows capabilities for an invalid model id", () => {
    const dotted = Array.from({ length: PROVIDER_INFO_LIMITS.depth + 2 }, () => "nested").join(".");
    expect(fixture(`model_provider = "custom"\n${dotted} = true\n`).readModeAndModel())
      .toEqual({ mode: "openai", model: "" });
    expect(fixture(`model_provider = "custom"\n#${"x".repeat(PROVIDER_INFO_LIMITS.configBytes)}\n`).readModeAndModel())
      .toEqual({ mode: "openai", model: "" });
    const reader = fixture(
      `model_provider = "custom"\nmodel = "${"m".repeat(PROVIDER_INFO_LIMITS.modelIdChars + 1)}"\nmodel_catalog_json = "models.json"\n[model_providers.custom]\nbase_url = "https://api.example.com/v1"\n`,
      { models: [{ slug: "first", input_modalities: ["image"], supported_reasoning_levels: ["high"] }] },
    );
    expect(reader.read()).toEqual({ mode: "custom", efforts: [] });
    expect(reader.customEndpoint()).toEqual({ baseUrl: "https://api.example.com/v1", ctx: 131072, vision: false });
  });

  it("does not reuse a cached catalog after a corrupt generation", () => {
    const config = 'model_provider = "custom"\nmodel = "chosen"\nmodel_catalog_json = "models.json"\n[model_providers.custom]\nbase_url = "https://api.example.com/v1"\n';
    const { home, reader } = fixtureData(config, { models: [{ slug: "chosen", supported_reasoning_levels: ["high"] }] });
    const catalog = path.join(home, "models.json");
    expect(reader.read()).toEqual({ mode: "custom", efforts: ["high"] });
    writeFileSync(catalog, "{broken");
    expect(reader.read()).toEqual({ mode: "custom", efforts: [] });
    writeFileSync(catalog, JSON.stringify({ models: [{ slug: "chosen", supported_reasoning_levels: ["low"] }] }));
    expect(reader.read()).toEqual({ mode: "custom", efforts: ["low"] });
  });
});
