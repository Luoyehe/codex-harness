import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { projectInputs, readInput, writeInputs } from "../deploy/dependency-inputs.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const names = ["package.json", "apps/gateway/package.json", "apps/web/package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"];
function inputs() { return Object.fromEntries(names.map(name => [name, readFileSync(path.join(root, name), "utf8")])); }
function changedLock(change) {
  const text = inputs(), lock = parse(text["pnpm-lock.yaml"]);
  change(lock); text["pnpm-lock.yaml"] = JSON.stringify(lock); return text;
}

test("network preparation projects only dependency data and preserves the real frozen graph", () => {
  const source = inputs();
  const manifest = JSON.parse(source["package.json"]);
  manifest.pnpm = { pnpmfile: "/untrusted-hook" };
  manifest.config = { unsafe: "candidate-config" };
  source["package.json"] = JSON.stringify(manifest);
  source[".npmrc"] = "registry=https://untrusted.invalid/";
  source[".pnpmfile.cjs"] = "UNTRUSTED_HOOK_TEXT";
  const result = projectInputs(source, "pnpm@11.22.0");
  assert.deepEqual(Object.keys(result.files).sort(), [...names].sort());
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  const clean = JSON.parse(result.files["package.json"]);
  assert.equal(clean.scripts, undefined);
  assert.equal(clean.pnpm, undefined);
  assert.equal(clean.config, undefined);
  assert.deepEqual(clean.devDependencies, manifest.devDependencies);
  assert.deepEqual(JSON.parse(result.files["pnpm-lock.yaml"]), parse(source["pnpm-lock.yaml"]));
  assert.ok(!JSON.stringify(result.files).includes("UNTRUSTED_HOOK_TEXT"));
});

test("preparation rejects package-manager replacement and external dependency sources", () => {
  for (const value of ["file:../private", "link:../private", "git+https://example.invalid/repo", "https://example.invalid/a.tgz", "npm:other@1.0.0"]) {
    const source = inputs(), manifest = JSON.parse(source["package.json"]);
    manifest.devDependencies.ws = value; source["package.json"] = JSON.stringify(manifest);
    assert.throws(() => projectInputs(source, "pnpm@11.22.0"), /registry/);
  }
  const source = inputs(), manifest = JSON.parse(source["package.json"]);
  manifest.packageManager = "pnpm@99.0.0"; source["package.json"] = JSON.stringify(manifest);
  assert.throws(() => projectInputs(source, "pnpm@11.22.0"), /pnpm differs/);
  for (const mutation of [
    lock => { lock.packages["ws@8.21.3"].resolution.tarball = "https://example.invalid/a.tgz"; },
    lock => { lock.packages["ws@8.21.3"].resolution.registry = "https://example.invalid/"; },
    lock => { lock.snapshots["ws@8.21.3"].dependencies = { ws: "file:/private" }; },
    lock => { lock.importers["."].devDependencies.ws.version = "link:../private"; },
    lock => { lock.packages["@jsr/fixture@1.0.0"] = lock.packages["ws@8.21.3"]; },
    lock => { lock.packages["git+https://example.invalid/repo"] = lock.packages["ws@8.21.3"]; },
    lock => { lock.patchedDependencies = { ws: "../private" }; },
  ]) assert.throws(() => projectInputs(changedLock(mutation), "pnpm@11.22.0"));
});

test("workspace hook settings, aliases, tags, duplicate keys and multiple YAML documents fail closed", () => {
  for (const value of [
    "packages: [apps/*]\npnpmfile: /private/hook\n",
    "packages: &packages [apps/*]\noverrides: *packages\n",
    "packages: !custom [apps/*]\n",
    "packages: [apps/*]\npackages: [apps/*]\n",
    "packages: [apps/*]\n---\npackages: [apps/*]\n",
  ]) {
    const source = inputs(); source["pnpm-workspace.yaml"] = value;
    assert.throws(() => projectInputs(source, "pnpm@11.22.0"));
  }
});

test("candidate snapshots reject directory aliases and oversized files", { skip: process.platform !== "win32" ? "Windows junction fixture; Linux ownership checked separately" : false }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-dependency-inputs-"));
  try {
    mkdirSync(path.join(dir, "actual"));
    writeFileSync(path.join(dir, "actual/value"), "bounded");
    symlinkSync(path.join(dir, "actual"), path.join(dir, "alias"), "junction");
    assert.throws(() => readInput(dir, "alias/value", 32), /alias/);
    assert.equal(readInput(dir, "actual/value", 7), "bounded");
    assert.throws(() => readInput(dir, "actual/value", 6), /oversized/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("data projection remains readable under updater umask 077 without changing its private parent", { skip: process.platform === "win32" ? "POSIX mode bits required" : false }, () => {
  const previousMask = process.umask(0o077);
  const dir = mkdtempSync(path.join(tmpdir(), "harness-dependency-permissions-"));
  try {
    const destination = path.join(dir, "projection");
    writeInputs(projectInputs(inputs(), "pnpm@11.22.0"), destination);
    assert.equal(process.umask(), 0o077);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const relative of ["", "apps", "apps/gateway", "apps/web"]) {
      assert.equal(statSync(path.join(destination, relative)).mode & 0o777, 0o755);
    }
    for (const relative of [...names, "dependency-inputs.json"]) {
      assert.equal(statSync(path.join(destination, relative)).mode & 0o777, 0o644);
    }
    assert.throws(() => writeInputs(projectInputs(inputs(), "pnpm@11.22.0"), destination));
    assert.equal(process.umask(), 0o077, "failed publication must restore the caller mask too");
  } finally {
    process.umask(previousMask);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parser diagnostics do not echo malformed candidate bytes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-dependency-diagnostic-"));
  try {
    writeFileSync(path.join(dir, "package.json"), "CANDIDATE_RAW_DATA_MUST_NOT_APPEAR");
    const result = spawnSync(process.execPath, [path.join(root, "deploy/dependency-inputs.mjs"), dir, path.join(dir, "output")], { encoding: "utf8", timeout: 5000, windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /CANDIDATE_RAW_DATA_MUST_NOT_APPEAR/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("portable cache export drops only pnpm 11 project indexes and retains packages and metadata", {
  skip: process.platform === "win32" ? "POSIX copy and symlink fixture required" : false,
}, () => {
  const source = readFileSync(path.join(root, "deploy/candidate-dependencies.sh"), "utf8");
  const definition = source.match(/export_dependency_cache\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(definition);
  for (const indexKind of ["directory", "symlink"]) {
    const dir = mkdtempSync(path.join(tmpdir(), "harness-portable-cache-"));
    try {
      const workspace = path.join(dir, "workspace"), payload = path.join(dir, "payload"), cache = path.join(dir, "cache");
      for (const relative of ["store/v11/files", "store/v11/index", "worktree"]) mkdirSync(path.join(workspace, relative), { recursive: true });
      mkdirSync(payload); mkdirSync(cache);
      writeFileSync(path.join(workspace, "store/v11/files/package"), "package-bytes");
      writeFileSync(path.join(workspace, "store/v11/index/package.json"), "package-index");
      writeFileSync(path.join(workspace, "worktree/keep"), "source-worktree");
      writeFileSync(path.join(cache, "registry.jsonl"), "registry-metadata");
      const projects = path.join(workspace, "store/v11/projects");
      if (indexKind === "directory") {
        mkdirSync(projects);
        symlinkSync("../../../worktree", path.join(projects, "42dc92bb91abdcf04134368eaf1af4b1"));
      } else symlinkSync("../../worktree", projects);
      const result = spawnSync("bash", ["-c", `set -euo pipefail\n${definition}\nexport_dependency_cache`], {
        encoding: "utf8", timeout: 5000,
        env: { ...process.env, workspace, payload, XDG_CACHE_HOME: cache },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.throws(() => lstatSync(path.join(payload, "store/v11/projects")), { code: "ENOENT" });
      assert.equal(readFileSync(path.join(payload, "store/v11/files/package"), "utf8"), "package-bytes");
      assert.equal(readFileSync(path.join(payload, "store/v11/index/package.json"), "utf8"), "package-index");
      assert.equal(readFileSync(path.join(payload, "cache/registry.jsonl"), "utf8"), "registry-metadata");
      assert.equal(readFileSync(path.join(workspace, "worktree/keep"), "utf8"), "source-worktree");
      assert.ok(lstatSync(projects));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("production dependency runner starts empty, requests registry data only, and propagates acquisition failure", {
  skip: process.platform !== "linux" ? "ordinary unprivileged Linux fixture" : false,
}, () => {
  assert.notEqual(process.getuid(), 0, "run dependency runner fixtures as an unprivileged user");
  for (const failInstall of [false, true]) {
    const fixture = mkdtempSync(path.join(tmpdir(), "harness-dependency-runner-"));
    try {
      for (const name of ["source", "pnpm/bin"]) mkdirSync(path.join(fixture, name), { recursive: true });
      const manifest = JSON.stringify({ format: 1, dependencyInputs: "a".repeat(64) }) + "\n";
      writeFileSync(path.join(fixture, "source/dependency-inputs.json"), manifest);
      writeFileSync(path.join(fixture, "source/package.json"), '{"name":"fixture","private":true}\n');
      writeFileSync(path.join(fixture, "pnpm/bin/pnpm.cjs"), "fixture only\n");
      writeFileSync(path.join(fixture, "node"), `#!/bin/bash
set -euo pipefail
[ "$(id -u)" != 0 ]
[ -z "\${OPENAI_API_KEY:-}" ]
[ "$(find "$HOME" -mindepth 1 | wc -l)" = 0 ]
[ "$(find "$XDG_CACHE_HOME" -mindepth 1 | wc -l)" = 0 ]
[ "$(find "${fixture}/executable/store" -mindepth 1 | wc -l)" = 0 ]
[ "$#" = 12 ]
[ "$1" = "${fixture}/pnpm/bin/pnpm.cjs" ]
[ "$2" = --config.verify-deps-before-run=false ]
[ "$3" = --config.manage-package-manager-versions=false ]
[ "$4" = install ] && [ "$5" = --frozen-lockfile ]
[ "$6" = --ignore-scripts ] && [ "$7" = --ignore-pnpmfile ]
[ "$8" = --registry=https://registry.npmjs.org/ ]
[ "$9" = --config.@jsr:registry=https://registry.npmjs.org/ ]
[ "\${10}" = --package-import-method=copy ]
[ "\${11}" = --store-dir ]
[ "\${12}" = "${fixture}/executable/store" ]
[ "\${FAIL_INSTALL:-0}" = 0 ] || exit 23
mkdir -p "${fixture}/executable/store/v11/files" "${fixture}/executable/store/v11/index" "${fixture}/executable/store/v11/projects"
echo package > "${fixture}/executable/store/v11/files/package"
echo metadata > "${fixture}/executable/store/v11/index/package.json"
ln -s ../../../worktree "${fixture}/executable/store/v11/projects/disposable"
echo registry > "$XDG_CACHE_HOME/metadata.json"
: > "${fixture}/accepted"
chmod 444 "${fixture}/accepted"
`);
      chmodSync(path.join(fixture, "node"), 0o755);
      const scratch = path.join(fixture, "executable");
      const result = spawnSync("/bin/bash", [path.join(root, "deploy/candidate-dependencies.sh"), fixture, "bin/pnpm.cjs"], {
        env: { HOME: path.join(scratch, "home"), XDG_CACHE_HOME: path.join(scratch, "cache"),
          TMPDIR: path.join(scratch, "tmp"), PATH: `${scratch}/bin:/usr/bin:/bin`, FAIL_INSTALL: failInstall ? "1" : "0" },
        encoding: "utf8", timeout: 5000,
      });
      assert.equal(result.status, failInstall ? 23 : 1, result.stderr + result.stdout);
      if (failInstall) assert.equal(existsSync(path.join(fixture, "export")), false);
      else {
        assert.match(result.stderr, /invalid root acknowledgement/);
        assert.equal(readFileSync(path.join(fixture, "export/payload/manifest.json"), "utf8"), manifest);
        assert.equal(readFileSync(path.join(fixture, "export/payload/store/v11/files/package"), "utf8"), "package\n");
        assert.equal(readFileSync(path.join(fixture, "export/payload/store/v11/index/package.json"), "utf8"), "metadata\n");
        assert.equal(readFileSync(path.join(fixture, "export/payload/cache/metadata.json"), "utf8"), "registry\n");
        assert.equal(existsSync(path.join(fixture, "export/payload/store/v11/projects")), false);
        assert.ok(lstatSync(path.join(scratch, "store/v11/projects/disposable")).isSymbolicLink());
      }
      assert.equal(readFileSync(path.join(fixture, "source/package.json"), "utf8"), '{"name":"fixture","private":true}\n');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }
});

test("update prepares data before stop and keeps executable validation offline", () => {
  const management = readFileSync(path.join(root, "deploy/manage.sh"), "utf8");
  const candidate = readFileSync(path.join(root, "deploy/test-candidate.sh"), "utf8");
  const preparation = readFileSync(path.join(root, "deploy/prepare-candidate-deps.sh"), "utf8");
  const update = management.slice(management.indexOf("do_update() {"));
  assert.ok(update.indexOf('bash "$SCRIPT_DIR/prepare-candidate-deps.sh"') < update.indexOf("applying=1"));
  assert.match(update, /"\$validated" "\$dependency_seed" "\$runtime_seed"/);
  assert.match(update, /isolation-unconfirmed[\s\S]*exit "\$status"/);
  assert.match(preparation, /"\$env_bin" -i/);
  assert.match(candidate, /validation\)\n\s+runner_name=candidate-validation\.sh\n\s+private_network=yes\n\s+offline=true/);
  const prepare = readFileSync(path.join(root, "deploy/candidate-dependencies.sh"), "utf8");
  assert.ok(prepare);
  assert.match(prepare, /--ignore-scripts --ignore-pnpmfile/);
  assert.match(prepare, /--config.manage-package-manager-versions=false/);
  assert.match(prepare, /--registry=https:\/\/registry.npmjs.org\//);
  assert.match(prepare, /payload\/store/);
  assert.match(prepare, /payload\/cache/);
  assert.match(prepare, /rm -rf -- "\$payload\/store\/v11\/projects"/);
  assert.doesNotMatch(prepare, /pnpm (?:build|test|exec)|node_modules.*payload/);
  assert.match(candidate, /materialize-dependencies-live/);
  assert.match(candidate, /stop_isolated_unit\nif \[ "\$phase" = dependencies/);
});
