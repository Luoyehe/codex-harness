import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const preset = fileURLToPath(new URL("../deploy/providers/zhipu-coding-plan/", import.meta.url));
const builtin = JSON.parse(readFileSync(path.join(preset, "models.json"), "utf8"));
const linux = { skip: process.platform !== "linux" && "Linux provider transaction fixtures required" };

function fixture(t, catalog = structuredClone(builtin)) {
  assert.notEqual(process.getuid(), 0, "run provider fixtures as an unprivileged account");
  const directory = mkdtempSync(path.join(tmpdir(), "harness-zhipu-refresh-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin"), home = path.join(directory, "home");
  mkdirSync(bin); mkdirSync(home, { mode: 0o700 });
  const catalogFile = path.join(directory, "response.json"), requests = path.join(directory, "requests");
  writeFileSync(catalogFile, JSON.stringify(catalog));
  writeFileSync(requests, "");
  // Replace curl completely. Only the free catalog request is accepted; no
  // model, MCP, real credential, account, network or service is consulted.
  writeFileSync(path.join(bin, "curl"), `#!/usr/bin/env python3
import os,pathlib,sys
args=sys.argv[1:]
assert args[:2]==['-H','@-']
assert sys.stdin.read().startswith('Authorization: Bearer fixture-only-')
assert 'https://open.bigmodel.cn/api/v1/models' in args
assert not any('/responses' in arg for arg in args)
with open(os.environ['FIXTURE_REQUESTS'],'a') as stream: stream.write('catalog\\n')
pathlib.Path(args[args.index('-o')+1]).write_bytes(pathlib.Path(os.environ['FIXTURE_CATALOG']).read_bytes())
`, { mode: 0o700 });
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: directory, CODEX_HOME: home,
    ENV_FILE: path.join(home, "secrets.env"), LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1",
    ZHIPU_MODEL: "glm-5-turbo", ZHIPU_KEY: ["fixture", "only", "offline"].join("-"), PROBE_REASONING: "0",
    FIXTURE_CATALOG: catalogFile, FIXTURE_REQUESTS: requests,
  };
  function invoke(refresh = false, overrides = {}) {
    return spawnSync("bash", [path.join(preset, "setup.sh")], {
      env: { ...env, ...(refresh ? { ZHIPU_SYNC_CATALOG: "1", ZHIPU_KEY: "" } : {}), ...overrides },
      encoding: "utf8", timeout: 20000,
    });
  }
  const initial = invoke();
  assert.equal(initial.status, 0, initial.stdout + initial.stderr);
  return {
    invoke,
    catalog,
    writeCatalog() { writeFileSync(catalogFile, JSON.stringify(catalog)); },
    requestCount() { return readFileSync(requests, "utf8").trim().split("\n").length; },
    config() { return readFileSync(path.join(home, "config.toml"), "utf8"); },
    setConfig(key, value) {
      const config = path.join(home, "config.toml");
      const pattern = new RegExp(`^"${key}" = .*?$`, "m");
      const text = readFileSync(config, "utf8");
      assert.match(text, pattern);
      writeFileSync(config, text.replace(pattern, `"${key}" = ${JSON.stringify(value)}`));
    },
    snapshot() {
      return {
        active: readlinkSync(path.join(home, "providers/.active")),
        versions: readdirSync(path.join(home, "providers/.versions")).sort(),
        config: readFileSync(path.join(home, "config.toml"), "utf8"),
        catalog: readFileSync(path.join(home, "providers/zhipu/models.json"), "utf8"),
        secret: readFileSync(path.join(home, "secrets.env"), "utf8"),
      };
    },
  };
}

function result(run, changed) {
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const line = run.stdout.split("\n").find(value => value.startsWith("[codex-harness-result] "));
  assert.ok(line, run.stdout);
  assert.deepEqual(JSON.parse(line.slice("[codex-harness-result] ".length)), { changed, restartRequired: changed });
}

for (const [effort, levels] of [["max", []], ["adaptive-vendor", [{ effort: "high" }]]]) {
  test(`Zhipu refresh preserves a native default outside the override list (${effort})`, linux, t => {
    const catalog = structuredClone(builtin);
    Object.assign(catalog.models[1], { default_reasoning_level: effort, supported_reasoning_levels: levels });
    const f = fixture(t, catalog), before = f.snapshot();
    result(f.invoke(true), false);
    assert.deepEqual(f.snapshot(), before, "an identical catalog must not publish or request a restart");

    f.catalog.models[1].description = "refreshed fixture metadata";
    f.writeCatalog();
    result(f.invoke(true), true);
    const after = f.snapshot();
    assert.notEqual(after.active, before.active);
    assert.equal(after.secret, before.secret);
    assert.match(f.config(), new RegExp(`^"model_reasoning_effort" = "${effort}"$`, "m"));
    const selected = JSON.parse(after.catalog).models[1];
    assert.equal(selected.description, "refreshed fixture metadata");
    assert.equal(selected.default_reasoning_level, effort);
    assert.deepEqual(selected.supported_reasoning_levels, levels, "refresh must not invent an advertised override");
    result(f.invoke(true), false);
    assert.deepEqual(f.snapshot(), after);
  });
}

test("Zhipu refresh preserves advertised overrides and rejects a removed or unadvertised non-default", linux, t => {
  const catalog = structuredClone(builtin);
  catalog.models[1].supported_reasoning_levels = [{ effort: "high" }];
  const f = fixture(t, catalog);
  f.setConfig("model_reasoning_effort", "high");
  result(f.invoke(true), true);
  assert.match(f.config(), /^"model_reasoning_effort" = "high"$/m);
  const before = f.snapshot();
  f.catalog.models[1].supported_reasoning_levels = [];
  f.writeCatalog();
  const rejected = f.invoke(true);
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.match(rejected.stdout, /当前思考档位不在刷新目录中/);
  assert.deepEqual(f.snapshot(), before);
  assert.doesNotMatch(rejected.stdout, /"restartRequired":true/);
});

test("Zhipu refresh still refuses a removed model or changed native default without publishing", linux, t => {
  const f = fixture(t), before = f.snapshot();
  f.catalog.models[1].default_reasoning_level = "high";
  f.writeCatalog();
  assert.equal(f.invoke(true).status, 1);
  assert.deepEqual(f.snapshot(), before);
  f.catalog.models.splice(1, 1);
  f.writeCatalog();
  assert.equal(f.invoke(true).status, 1);
  assert.deepEqual(f.snapshot(), before);
});

test("Zhipu refresh retains the transaction's provider and generation guards before any request", linux, t => {
  const f = fixture(t), before = f.snapshot(), requests = f.requestCount();
  assert.notEqual(f.invoke(true, { PROVIDER_EXPECTED_ACTIVE: "generation-stale" }).status, 0);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.requestCount(), requests);
  f.setConfig("model_reasoning_effort", "");
  const emptyEffort = f.snapshot();
  assert.notEqual(f.invoke(true).status, 0);
  assert.deepEqual(f.snapshot(), emptyEffort);
  assert.equal(f.requestCount(), requests);
  f.setConfig("model_reasoning_effort", "max");
  f.setConfig("model_provider", "custom");
  const switched = f.snapshot();
  assert.notEqual(f.invoke(true).status, 0);
  assert.deepEqual(f.snapshot(), switched);
  assert.equal(f.requestCount(), requests);
});
