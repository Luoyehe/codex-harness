import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderInfoReader } from "../src/provider-info.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(config: string, catalog?: unknown): ProviderInfoReader {
  const home = mkdtempSync(path.join(tmpdir(), "codex-provider-info-"));
  homes.push(home);
  writeFileSync(path.join(home, "config.toml"), config);
  if (catalog) writeFileSync(path.join(home, "models.json"), JSON.stringify(catalog));
  return new ProviderInfoReader(home);
}

describe("ProviderInfoReader", () => {
  it("parses quoted keys and inline provider tables using TOML semantics", () => {
    const reader = fixture('"model_provider" = "custom"\n"model" = "selected"\nmodel_providers = { custom = { base_url = "https://api.example.com/v1" } }\n');
    expect(reader.readModeAndModel()).toEqual({ mode: "custom", model: "selected" });
    expect(reader.customEndpoint()?.baseUrl).toBe("https://api.example.com/v1");
  });
  it("uses top-level mode/model and the selected catalog entry", () => {
    const reader = fixture(
      `model_provider = "custom"\nmodel = "chosen"\nmodel_catalog_json = "models.json"\n\n[model_providers.custom]\nmodel = "wrong-table-value"\nbase_url = "https://api.example.com/v1#literal"\nenv_key = "CUSTOM_OPENAI_API_KEY"\n`,
      { models: [
        { slug: "first", context_window: 2048, supported_reasoning_levels: ["low"] },
        { slug: "chosen", context_window: 65536, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "high" }] },
      ] },
    );

    expect(reader.readModeAndModel()).toEqual({ mode: "custom", model: "chosen" });
    expect(reader.read()).toEqual({ mode: "custom", efforts: ["high"] });
    expect(reader.customEndpoint()).toEqual({
      baseUrl: "https://api.example.com/v1#literal",
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
});
