import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const providers = fileURLToPath(new URL("../deploy/providers/", import.meta.url));
const python = process.env.CODEX_TEST_PYTHON || "python3";
const available = spawnSync(python, ["-c", "import tomllib"], { timeout: 10000, windowsHide: true }).status === 0;
const options = { skip: available ? false : "Python 3.11+ needed for provider TOML integration tests" };

function block(script, marker) {
  const source = readFileSync(path.join(providers, script), "utf8");
  const match = [...source.matchAll(/<<'PY'\r?\n([\s\S]*?)\r?\nPY/g)].find((part) => part[1].includes(marker));
  assert.ok(match, `missing embedded Python block: ${marker}`);
  return match[1];
}

function run(code, args, overrides = {}) {
  const result = spawnSync(python, ["-c", code, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 10000,
    env: { ...process.env, PYTHONPATH: providers, PYTHONDONTWRITEBYTECODE: "1", ...overrides },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function parsed(config) {
  return JSON.parse(run("import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))", [config]));
}

test("custom setup preserves top-level settings and escapes model strings", options, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "provider-config-"));
  try {
    const config = path.join(dir, "config.toml");
    writeFileSync(config, 'model = "old"\nsandbox_mode = "read-only"\n[features]\nexample_feature = true\n[model_providers.old]\nbase_url = "https://old.example.com"\n  [profiles.review]\nmodel = "review-model"\n');
    const model = 'model-with-"quotes"-and-\\slash';
    run(block("custom-openai/setup.sh", "config, base_url, model, ctx"), [config, "https://api.example.com/v1", model, "65536", "1", "high", "low high", "1"]);
    const value = parsed(config);
    assert.equal(value.model, model);
    assert.equal(value.sandbox_mode, "read-only");
    assert.equal(value.features.example_feature, true);
    assert.equal(value.profiles.review.model, "review-model");
    assert.equal(value.model_providers.custom.env_key, "CUSTOM_OPENAI_API_KEY");
    assert.equal(value.model_providers.old, undefined);
    assert.equal(value.model_providers.custom.sandbox_mode, undefined);
    const userInstructions = '[model_providers.not-a-table]\nmodel = "literal-not-a-key"\n';
    writeFileSync(config, `instructions = """\n${userInstructions}"""\nmodel = "old"\n`);
    run(block("custom-openai/setup.sh", "config, base_url, model, ctx"), [config, "https://api.example.com/v1", model, "65536", "1", "high", "low high", "1"]);
    assert.equal(parsed(config).instructions, userInstructions);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("custom unauthenticated endpoint selection clears the stored credential for later syncs", options, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "provider-config-"));
  try {
    const envFile = path.join(dir, "secrets.env");
    const config = path.join(dir, "config.toml");
    const credential = ["previous", "provider", "credential"].join("-");
    writeFileSync(envFile, `UNRELATED_OPTION=keep\nCUSTOM_OPENAI_API_KEY="${credential}"\n`);
    const code = block("custom-openai/setup.sh", 'key = os.environ["CUSTOM_API_KEY"]');
    run(code, [], { ENV_FILE: envFile, CUSTOM_API_KEY: "" });
    const stored = readFileSync(envFile, "utf8");
    assert.ok(stored.includes("UNRELATED_OPTION=keep"));
    assert.ok(stored.includes('CUSTOM_OPENAI_API_KEY=""'));
    assert.ok(!stored.includes(credential));
    run(block("custom-openai/setup.sh", "config, base_url, model, ctx"), [config, "http://127.0.0.1:8000/v1", "local", "65536", "0", "medium", "", "0"]);
    assert.equal(parsed(config).model_providers.custom.env_key, undefined);
    const source = readFileSync(path.join(providers, "custom-openai/setup.sh"), "utf8");
    assert.ok(source.includes('if [ "$API_KEY" = "EMPTY" ]; then persist_key ""; else persist_key "$API_KEY"; fi'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Zhipu setup preserves root settings and generates valid fresh config", options, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "provider-config-"));
  try {
    const config = path.join(dir, "config.toml");
    const code = block("zhipu-coding-plan/setup.sh", "config, script_dir, model, effort");
    run(code, [config, path.join(providers, "zhipu-coding-plan"), 'glm-"quoted"', "max"]);
    assert.equal(parsed(config).model, 'glm-"quoted"');
    writeFileSync(config, 'sandbox_mode = "read-only"\nmodel = "old"\n[model_providers.custom]\nbase_url = "https://old.example.com"\n  [profiles.review]\nmodel = "review-model"\n');
    run(code, [config, path.join(providers, "zhipu-coding-plan"), "glm", "high"]);
    const value = parsed(config);
    assert.equal(value.sandbox_mode, "read-only");
    assert.equal(value.profiles.review.model, "review-model");
    assert.equal(value.model_providers.ZAI.env_key, "Z_AI_API_KEY");
    assert.equal(value.model_providers.custom, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Zhipu feature activation ignores comments and overrides a disabled flag idempotently", options, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "provider-config-"));
  try {
    const config = path.join(dir, "config.toml");
    writeFileSync(config, '# mcp_2026_07_28 was disabled\n  [features] # keep other features\nexample_feature = true\nmcp_2026_07_28 = false\n[profiles.review]\nmodel = "review-model"\n');
    const code = block("zhipu-coding-plan/setup.sh", "# Ensure the feature in its actual table");
    run(code, [config]);
    run(code, [config]);
    const value = parsed(config);
    assert.equal(value.features.mcp_2026_07_28, true);
    assert.equal(value.features.example_feature, true);
    assert.equal(value.profiles.review.model, "review-model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP setup preserves indented, quoted, array tables and prefix-similar third-party servers", options, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "provider-config-"));
  try {
    const config = path.join(dir, "config.toml");
    const original = 'instructions = """\n[mcp_servers.web-reader]\nThis is literal user text, not a table.\n"""\n'
      + '[mcp_servers.web-reader]\ncommand = "old"\nargs = [\n["a", "b"]\n]\n'
      + '  [profiles.review]\nmodel = "review-model"\n'
      + '[mcp_servers.web-reader-custom]\ncommand = "keep-custom"\n'
      + '[mcp_servers.zai-mcp-server]\ncommand = "old-vision"\n'
      + '[[jobs]]\nname = "keep-array"\n'
      + '["quoted.profile"]\nvalue = "keep-quoted"\n';
    writeFileSync(config, original);
    const http = block("zhipu-coding-plan/setup-http-mcp.sh", "config, bridge = sys.argv");
    const vision = block("zhipu-coding-plan/setup-zai-mcp.sh", 'table(data, "mcp_servers")["zai-mcp-server"]');
    for (let i = 0; i < 2; i++) {
      run(http, [config, path.join(providers, "zhipu-coding-plan", "mcp-http-bridge.mjs")]);
      run(vision, [config]);
    }
    const value = parsed(config);
    assert.equal(value.instructions, '[mcp_servers.web-reader]\nThis is literal user text, not a table.\n');
    assert.equal(value.profiles.review.model, "review-model");
    assert.equal(value.mcp_servers["web-reader-custom"].command, "keep-custom");
    assert.equal(value.jobs[0].name, "keep-array");
    assert.equal(value["quoted.profile"].value, "keep-quoted");
    assert.deepEqual(value.mcp_servers["web-reader"].env_vars, ["Z_AI_API_KEY"]);
    assert.equal(value.mcp_servers["zai-mcp-server"].command, "zai-mcp-server");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("semantic TOML edits preserve quoted keys, inline features and literal bridge-looking text", options, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "provider-config-"));
  try {
    const config = path.join(dir, "config.toml");
    const instructions = 'A\n\n\n["literal", "mcp-http-bridge.mjs"]\nB';
    writeFileSync(config, '"model" = "old"\nfeatures = { example_feature = true }\n'
      + `instructions = """${instructions}"""\n`
      + 'created = 1979-05-27T07:32:00Z\n[[jobs]]\nname = "keep"\n');
    run(block("custom-openai/setup.sh", "config, base_url, model, ctx"), [config, "https://api.example.com/v1", "new", "65536", "1", "high", "low high", "1"]);
    run(block("zhipu-coding-plan/setup.sh", "# Ensure the feature in its actual table"), [config]);
    run(block("zhipu-coding-plan/setup-http-mcp.sh", "config, bridge = sys.argv"), [config, "/bridge.mjs"]);
    const value = JSON.parse(run("import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],'rb')),default=str))", [config]));
    assert.equal(value.model, "new");
    assert.equal(value.instructions, instructions);
    assert.deepEqual(value.features, { example_feature: true, mcp_2026_07_28: true });
    assert.equal(value.jobs[0].name, "keep");
    assert.equal(value.created, "1979-05-27 07:32:00+00:00");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("custom catalog refresh retains configured effort and known capabilities", options, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "provider-config-"));
  try {
    const config = path.join(dir, "config.toml");
    const code = block("custom-openai/setup.sh", "config, base_url, model, ctx");
    const args = [config, "https://api.example.com/v1", "chosen", "65536", "1", "high", "low high", "1"];
    run(code, args);
    run(code, [...args.slice(0, 6), "", "1"], { CUSTOM_SYNC_CATALOG: "1", CUSTOM_MODEL_IDS: "chosen\nnew-model" });
    const catalog = JSON.parse(readFileSync(path.join(dir, "models.json"), "utf8"));
    assert.equal(parsed(config).model_reasoning_effort, "high");
    assert.deepEqual(catalog.models.map(m => m.slug), ["chosen"]);
    assert.deepEqual(catalog.models[0].supported_reasoning_levels.map(l => l.effort), ["low", "high"]);
    assert.deepEqual(catalog.unconfigured_models, [{ id: "new-model", capabilities: "unknown" }]);
    assert.ok(!("context_window" in catalog.unconfigured_models[0]));
    assert.ok(!("input_modalities" in catalog.unconfigured_models[0]));
    assert.ok(!("default_reasoning_level" in catalog.unconfigured_models[0]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provider catalogs cap bytes, entries and aggregate model identifier output", options, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "provider-catalog-limits-"));
  try {
    const source = path.join(dir, "catalog.json");
    const normalized = path.join(dir, "normalized.json");
    run(`import json,os,sys
from catalog_limits import (MAX_CATALOG_BYTES, custom_response_ids,
                            dump_json_limited, load_json_path, normalize_zhipu)
path, normalized = sys.argv[1:3]
open(path, 'wb').write(b' ' * (MAX_CATALOG_BYTES + 1))
try: load_json_path(path)
except ValueError: pass
else: raise AssertionError('oversized catalog was parsed')
too_many = {'data':[{'id':'m-%d' % index} for index in range(257)]}
try: custom_response_ids(too_many)
except ValueError: pass
else: raise AssertionError('catalog entry cap was not enforced')
aggregate = {'data':[{'id':'x' * 252 + ('%04d' % index)} for index in range(256)]}
try: custom_response_ids(aggregate)
except ValueError: pass
else: raise AssertionError('aggregate model id bytes were not capped')
valid = {'models':[{'slug':'model-a'}]}
open(path, 'w', encoding='utf-8').write(json.dumps(valid))
normalize_zhipu(path, normalized)
assert load_json_path(normalized) == valid
if os.name == 'posix':
    linked = path + '.link'
    try:
        os.symlink(path, linked)
        try: load_json_path(linked)
        except (OSError, ValueError): pass
        else: raise AssertionError('linked catalog was followed')
    finally:
        try: os.unlink(linked)
        except FileNotFoundError: pass
original_lstat = os.lstat
calls = 0
def changed(pathname):
    global calls
    info = original_lstat(pathname)
    calls += 1
    if calls > 1:
        values = {name:getattr(info, name) for name in dir(info) if name.startswith('st_')}
        values['st_mtime_ns'] = info.st_mtime_ns + 1
        return type('ChangedInfo', (), values)()
    return info
from unittest.mock import patch
with patch('catalog_limits.os.lstat', side_effect=changed):
    try: load_json_path(path)
    except ValueError: pass
    else: raise AssertionError('catalog path replacement was accepted')
try: dump_json_limited({'models':[{'slug':'ok','padding':'x' * MAX_CATALOG_BYTES}]})
except ValueError: pass
else: raise AssertionError('serialized catalog cap was not enforced')
`, [source, normalized]);
    for (const script of ["custom-openai/setup.sh", "zhipu-coding-plan/setup.sh"]) {
      assert.match(readFileSync(path.join(providers, script), "utf8"), /--max-filesize 1048576/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("custom models keep independently declared capabilities when another model is configured", options, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "provider-model-capabilities-"));
  try {
    const config = path.join(dir, "config.toml");
    const code = block("custom-openai/setup.sh", "config, base_url, model, ctx");
    run(code, [config, "https://api.example.com/v1", "vision-large", "262144", "1", "high", "low high", "0"]);
    run(code, [config, "https://api.example.com/v1", "text-small", "8192", "0", "low", "low", "0"]);
    run(code, [config, "https://api.example.com/v1", "text-small", "8192", "0", "low", "", "0"], {
      CUSTOM_SYNC_CATALOG: "1", CUSTOM_MODEL_IDS: "vision-large\ntext-small\nunknown-model",
    });
    const catalog = JSON.parse(readFileSync(path.join(dir, "models.json"), "utf8"));
    const vision = catalog.models.find(entry => entry.slug === "vision-large");
    const text = catalog.models.find(entry => entry.slug === "text-small");
    assert.equal(vision.context_window, 262144);
    assert.deepEqual(vision.input_modalities, ["text", "image"]);
    assert.equal(text.context_window, 8192);
    assert.deepEqual(text.input_modalities, ["text"]);
    assert.equal(text.default_reasoning_level, "low");
    assert.deepEqual(catalog.unconfigured_models, [{ id: "unknown-model", capabilities: "unknown" }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid TOML is rejected before changing configuration", options, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "provider-config-"));
  try {
    const config = path.join(dir, "config.toml");
    const original = 'model="one"\nmodel="two"\n';
    writeFileSync(config, original);
    const result = spawnSync(python, ["-c", block("custom-openai/setup.sh", "config, base_url, model, ctx"), config, "https://api.example.com/v1", "new", "65536", "0", "high", "", "0"], {
      encoding: "utf8", windowsHide: true, timeout: 10000,
      env: { ...process.env, PYTHONPATH: providers, PYTHONDONTWRITEBYTECODE: "1" },
    });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(config, "utf8"), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("semantic TOML serialization preserves escaped DEL in strings and keys", options, () => {
  run('from toml_config import dump_config\nimport tomllib\nvalue = {"instructions": "A" + chr(127) + "B", "key" + chr(127): {"nested" + chr(127): "ok"}}\ntext = dump_config(value)\nassert chr(127) not in text\nassert tomllib.loads(text) == value\n', []);
});
