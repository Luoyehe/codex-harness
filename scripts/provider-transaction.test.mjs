import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const providers = fileURLToPath(new URL("../deploy/providers/", import.meta.url));
const python = process.env.CODEX_TEST_PYTHON || "python3";
const options = { skip: process.platform === "win32" ? "Provider deployment transactions require Linux flock and symlinks" : false };
const pythonAvailable = spawnSync(python, ["-c", "import tomllib"], { timeout: 10000, windowsHide: true }).status === 0;
const unitOptions = { skip: pythonAvailable ? false : "Python 3.11+ needed" };

function runPython(code, args) {
  return spawnSync(python, ["-c", code, ...args], { encoding: "utf8", windowsHide: true, timeout: 10000,
    env: { ...process.env, PYTHONPATH: providers, PYTHONDONTWRITEBYTECODE: "1" } });
}

const checkEnvironment = 'import sys; from pathlib import Path; from provider_transaction import environment_file; print(environment_file(Path(sys.argv[1]).resolve(), sys.argv[2]))';

test("EnvironmentFile rejects dot-dot and directory-alias paths to config", unitOptions, () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "provider-path-"));
  try {
    const home = path.join(fixture, "home");
    mkdirSync(path.join(home, "alias"), { recursive: true });
    const config = path.join(home, "config.toml");
    writeFileSync(config, 'model = "unchanged"\n');
    // Do not path.join/resolve the test input: those would hide the original bug.
    const dotdot = home + path.sep + "alias" + path.sep + ".." + path.sep + "config.toml";
    assert.notEqual(runPython(checkEnvironment, [home, dotdot]).status, 0);
    const alias = path.join(fixture, "home-alias");
    symlinkSync(home, alias, process.platform === "win32" ? "junction" : "dir");
    assert.notEqual(runPython(checkEnvironment, [home, path.join(alias, "config.toml")]).status, 0);
    assert.equal(readFileSync(config, "utf8"), 'model = "unchanged"\n');
    assert.equal(runPython(checkEnvironment, [home, path.join(fixture, "outside.env")]).status, 0);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("EnvironmentFile rejects config symlinks but accepts the managed active-secret alias", options, () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "provider-path-"));
  try {
    const home = path.join(fixture, "home");
    const generation = path.join(home, "providers/.versions/generation-fixture");
    mkdirSync(generation, { recursive: true });
    writeFileSync(path.join(generation, "config.toml"), 'model = "unchanged"\n');
    writeFileSync(path.join(generation, "secrets.env"), "FIXTURE=value\n");
    symlinkSync(generation, path.join(home, "providers/.active"));
    symlinkSync(path.join(home, "providers/.active/config.toml"), path.join(home, "config.toml"));
    const envFile = path.join(fixture, "outside.env");
    symlinkSync(path.join(home, "config.toml"), envFile);
    assert.notEqual(runPython(checkEnvironment, [home, envFile]).status, 0);
    rmSync(envFile);
    symlinkSync(path.join(home, "providers/.active/secrets.env"), envFile);
    const accepted = runPython(checkEnvironment, [home, envFile]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.stdout.trim(), envFile);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("custom sync derives every setting and authentication decision from the locked candidate", unitOptions, () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "provider-sync-"));
  try {
    const catalog = path.join(fixture, "models.json");
    const entry = { slug: "current-model", context_window: 65536, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "high" }] };
    writeFileSync(catalog, JSON.stringify({ models: [entry] }));
    const base = 'model_provider = "custom"\nmodel = "current-model"\nmodel_reasoning_effort = "high"\nmodel_catalog_json = ' + JSON.stringify(catalog) + '\n[model_providers.custom]\nbase_url = "https://current.example/v1"\n';
    const stale = { CUSTOM_BASE_URL: "https://stale.example/v1", CUSTOM_MODEL: "stale-model", CUSTOM_CTX: "1024", CUSTOM_VISION: "0", CUSTOM_EFFORT: "low", CUSTOM_API_KEY: "stale-fixture-key", CUSTOM_REUSE_API_KEY: "1", CUSTOM_MODEL_IDS: "stale-model", PROBE_REASONING: "1" };
    for (const authenticated of [true, false]) {
      writeFileSync(path.join(fixture, "config.toml"), base + (authenticated ? 'env_key = "CUSTOM_OPENAI_API_KEY"\n' : ""));
      const result = runPython('import json,sys; from pathlib import Path; from provider_transaction import custom_sync_environment; env=json.loads(sys.argv[2]); custom_sync_environment(Path(sys.argv[1]),env); print(json.dumps(env))', [fixture, JSON.stringify(stale)]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { CUSTOM_BASE_URL: "https://current.example/v1", CUSTOM_MODEL: "current-model", CUSTOM_CTX: "65536", CUSTOM_VISION: "1", CUSTOM_EFFORT: "high", CUSTOM_API_KEY: "", CUSTOM_REUSE_API_KEY: authenticated ? "1" : "0", CUSTOM_MODEL_IDS: "", PROBE_REASONING: "0" });
      assert.deepEqual(JSON.parse(readFileSync(path.join(fixture, "providers/custom/models.json"), "utf8")).models, [entry]);
    }
    writeFileSync(path.join(fixture, "config.toml"), base + 'env_key = "UNMANAGED_KEY"\n');
    assert.notEqual(runPython('import sys; from pathlib import Path; from provider_transaction import custom_sync_environment; custom_sync_environment(Path(sys.argv[1]),{})', [fixture]).status, 0);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("stale catalog-sync inputs cannot send the current key to an old endpoint", options, () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "provider-sync-"));
  try {
    const home = path.join(fixture, "home"), bin = path.join(fixture, "bin"), capture = path.join(fixture, "curl.txt");
    mkdirSync(bin);
    // This fixture replaces curl completely: there are no network/model calls.
    writeFileSync(path.join(bin, "curl"), '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$@" >> "$HARNESS_CAPTURE"\nif [ "${1:-}" = "-H" ]; then cat >> "$HARNESS_CAPTURE"; fi\nprintf \'{"data":[{"id":"current-model"},{"id":"new-model"}]}\'\n', { mode: 0o700 });
    const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, PYTHONPATH: providers, PYTHONDONTWRITEBYTECODE: "1", CODEX_HOME: home, ENV_FILE: path.join(fixture, "outside.env"), HARNESS_CAPTURE: capture, HARNESS_PROVIDER_TRANSACTION: "0", CUSTOM_SYNC_CATALOG: "0", CUSTOM_BASE_URL: "https://current.example/v1", CUSTOM_MODEL: "current-model", CUSTOM_CTX: "65536", CUSTOM_VISION: "1", CUSTOM_EFFORT: "high", CUSTOM_API_KEY: "current-fixture-key", PROBE_REASONING: "0" };
    const invoke = overrides => spawnSync("bash", [path.join(providers, "custom-openai/setup.sh")], { env: { ...env, ...overrides }, encoding: "utf8", timeout: 20000 });
    const setup = invoke({});
    assert.equal(setup.status, 0, setup.stderr + setup.stdout);
    for (let iteration = 0; iteration < 2; iteration++) {
      const activeBefore = realpathSync(path.join(home, "providers/.active"));
      const sync = invoke({ CUSTOM_SYNC_CATALOG: "1", CUSTOM_BASE_URL: "https://stale.example/v1", CUSTOM_MODEL: "stale-model", CUSTOM_CTX: "1024", CUSTOM_VISION: "0", CUSTOM_EFFORT: "low", CUSTOM_API_KEY: "stale-fixture-key", CUSTOM_REUSE_API_KEY: "0" });
      assert.equal(sync.status, 0, sync.stderr + sync.stdout);
      if (iteration === 1) {
        assert.equal(realpathSync(path.join(home, "providers/.active")), activeBefore, "unchanged refresh must not publish another generation");
        assert.ok(sync.stdout.endsWith('[codex-harness-result] {"changed":false,"restartRequired":false}\n'));
      }
    }
    const sent = readFileSync(capture, "utf8");
    assert.ok(sent.includes("https://current.example/v1/models"));
    assert.ok(sent.includes("Authorization: Bearer current-fixture-key"));
    assert.ok(!sent.includes("stale.example") && !sent.includes("stale-fixture-key"));
    const config = readFileSync(path.join(home, "config.toml"), "utf8");
    assert.ok(config.includes("current-model") && config.includes("high") && !config.includes("stale"));
    const catalog = JSON.parse(readFileSync(path.join(home, "providers/custom/models.json"), "utf8"));
    assert.deepEqual(catalog.models.map(item => item.slug), ["current-model"]);
    assert.deepEqual(catalog.unconfigured_models, [{ id: "new-model", capabilities: "unknown" }]);
    assert.equal(catalog.models[0].context_window, 65536);
    assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("provider generations atomically commit config/catalog/credentials and roll back failed setup", options, () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "provider-transaction-"));
  const home = path.join(fixture, "home");
  const envFile = path.join(fixture, "outside.env");
  const env = { ...process.env, PYTHONPATH: providers, PYTHONDONTWRITEBYTECODE: "1", CODEX_HOME: home, ENV_FILE: envFile,
    CUSTOM_BASE_URL: "http://127.0.0.1:1/v1", CUSTOM_MODEL: "local-model", CUSTOM_EFFORT: "high", CUSTOM_VISION: "0",
    CUSTOM_API_KEY: ["fixture", "credential"].join("-"), PROBE_REASONING: "0" };
  try {
    const setup = spawnSync("bash", [path.join(providers, "custom-openai/setup.sh")], { env, encoding: "utf8", timeout: 20000 });
    assert.equal(setup.status, 0, setup.stderr + setup.stdout);
    const before = { config: readFileSync(path.join(home, "config.toml"), "utf8"), env: readFileSync(envFile, "utf8"), active: realpathSync(path.join(home, "providers/.active")) };
    assert.ok(realpathSync(envFile).startsWith(before.active + path.sep));
    assert.ok(realpathSync(path.join(home, "providers/custom/config.toml")).startsWith(before.active + path.sep));
    const failure = path.join(fixture, "failure.sh");
    writeFileSync(failure, 'set -eu\nprintf "replacement" > "$ENV_FILE"\nprintf "broken" > "$CODEX_HOME/config.toml"\nexit 9\n');
    const failed = spawnSync(python, [path.join(providers, "provider_transaction.py"), "custom", failure], { env, encoding: "utf8", timeout: 20000 });
    assert.equal(failed.status, 9);
    assert.equal(readFileSync(path.join(home, "config.toml"), "utf8"), before.config);
    assert.equal(readFileSync(envFile, "utf8"), before.env);
    assert.equal(realpathSync(path.join(home, "providers/.active")), before.active);
    const native = spawnSync("bash", [path.join(providers, "openai/setup.sh")], { env, encoding: "utf8", timeout: 20000 });
    assert.equal(native.status, 0, native.stderr + native.stdout);
    assert.equal(readFileSync(path.join(home, "config.toml"), "utf8"), "");
    assert.equal(readFileSync(envFile, "utf8"), before.env);
    assert.notEqual(realpathSync(path.join(home, "providers/.active")), before.active);
    const reactivate = spawnSync("bash", [path.join(providers, "activate-config.sh"), "custom"], { env, encoding: "utf8", timeout: 20000 });
    assert.equal(reactivate.status, 0, reactivate.stderr + reactivate.stdout);
    assert.match(readFileSync(path.join(home, "config.toml"), "utf8"), /local-model/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
