import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("../deploy/test-candidate.sh", import.meta.url));
const source = readFileSync(helper, "utf8");
const python = process.env.CODEX_TEST_PYTHON || "python3";
const pythonAvailable = spawnSync(python, ["-I", "-c", "import unittest.mock"], { windowsHide: true }).status === 0;
const pnpmEntry = process.env.CODEX_TEST_PNPM_ENTRY || process.env.npm_execpath;
function block(name) {
  const match = source.match(new RegExp(`<<'${name}'[^\\n]*\\n([\\s\\S]*?)\\n${name}\\n`));
  assert.ok(match, `missing ${name} executable block`);
  return match[1];
}

test("candidate validation uses an ephemeral identity, private copy, and control-group cleanup", () => {
  for (const property of ["DynamicUser=yes", "RuntimeDirectoryMode=0700", "RuntimeDirectoryPreserve=no",
    "KillMode=control-group", "TimeoutStopSec=15s", "RuntimeMaxSec=30min", "ProtectSystem=strict",
    "ProtectHome=yes", "PrivateTmp=yes", "NoNewPrivileges=yes"]) assert.ok(source.includes(`--property=${property}`), property);
  assert.match(source, /--wait --pipe --collect/);
  assert.match(source, /trap cleanup EXIT/);
  assert.match(source, /"\$systemctl" stop "\$unit\.service"/);
  assert.match(source, /BindReadOnlyPaths=\$candidate_root:\$runtime\/source/);
  assert.doesNotMatch(source, /Bind(?:ReadOnly)?Paths=.*candidate_root.*parent|ReadWritePaths=.*candidate_root/);
  assert.match(source, /TemporaryFileSystem=\$runtime\/executable:rw,nodev,nosuid,exec,mode=1777/);
  assert.match(source, /"\$env_bin" -i \\\n\s*"HOME=\$runtime\/executable\/home"/);
  assert.match(source, /"CODEX_HOME=\$runtime\/executable\/codex-home"/);
  assert.match(source, /"PATH=\$runtime\/executable\/bin:\/usr\/bin:\/bin"/);
  assert.doesNotMatch(source, /EnvironmentFile|PassEnvironment|GATEWAY_TOKEN|OPENAI_API_KEY|ZHIPU_KEY/);
  const runner = block("CANDIDATE_RUNNER");
  assert.match(runner, /\[ "\$EUID" != 0 \]/);
  assert.match(runner, /cp -a --no-preserve=ownership -- "\$runtime\/source\/\." "\$workspace\/worktree\/"/);
  assert.match(runner, /pnpm test\nnode scripts\/gateway-smoke\.mjs/);
  assert.match(runner, /export pnpm_config_verify_deps_before_run=/);
  assert.match(runner, /--config.verify-deps-before-run=false/);
  assert.doesNotMatch(runner, /cp .*worktree.*source|rsync|pnpm install|pnpm update/);
});

test("candidate runtime checks canonical executables and mounts the actual offline pnpm package", () => {
  assert.match(source, /node_bin="\$\(trust file /);
  assert.match(source, /trust file "\$node_entry"/);
  assert.match(source, /pnpm_launcher="\$\(trust file /);
  assert.match(source, /cli="\$\(trust file "\$2"\)/);
  assert.match(source, /COREPACK_ENABLE_NETWORK=0/);
  assert.match(source, /HOME="\$probe_home" XDG_CACHE_HOME="\$probe_home\/cache"/);
  assert.match(source, /corepack_cache="\$\(trust tree "\$corepack_cache"\)/);
  assert.match(source, /NPM_CONFIG_USERCONFIG=\/dev\/null NPM_CONFIG_GLOBALCONFIG="\$probe_home\/global\.npmrc"/);
  assert.doesNotMatch(source, /HOME=\/root|HOME="\$HOME"/);
  assert.match(source, /--config.verify-deps-before-run=false --silent run harness-pnpm-entry/);
  assert.match(source, /pnpm_entry="\$\(cd -- "\$probe_home"/);
  assert.doesNotMatch(source, /pnpm_entry="\$\(cd -- "\$candidate_root"/);
  assert.match(block("PREPARE_PROBE"), /json\.dumps\(\{'private':True,'packageManager':manager,'scripts':\{'harness-pnpm-entry':script\}\}\)/);
  assert.match(source, /sys\.path\.insert\(0,sys\.argv\[1\]\)/);
  assert.ok(source.indexOf("sys.dont_write_bytecode=True") < source.indexOf("from trusted_paths import"));
  assert.match(source, /trusted_tree\(str\(package\)\)/);
  assert.match(source, /BindReadOnlyPaths=\$\{runtime_packages\[0\]\}:\$runtime\/pnpm/);
  assert.match(source, /BindReadOnlyPaths=\$\{runtime_packages\[2\]\}:\$runtime\/codex\/node_modules/);
  assert.match(source, /"\$\{#runtime_packages\[@\]\}" = 4/);
});

test("candidate source guard keeps the parent private and rejects writable or aliased entries", { skip: !pythonAvailable && "Python required" }, () => {
  const result = spawnSync(python, ["-I", "-c", `
import contextlib,io,stat,sys
from pathlib import PurePosixPath
from types import SimpleNamespace
from unittest.mock import patch
code=sys.argv[1]
def info(mode,uid=0): return SimpleNamespace(st_mode=mode,st_uid=uid)
base={'/':info(stat.S_IFDIR|0o755),'/tmp':info(stat.S_IFDIR|0o1777),'/tmp/private':info(stat.S_IFDIR|0o700),'/tmp/private/worktree':info(stat.S_IFDIR|0o700)}
def check(changes=None,path='/tmp/private/worktree',accepted=False):
    entries={**base,**(changes or {})}; changes=[]; output=io.StringIO()
    with patch('pathlib.Path',PurePosixPath),patch.object(PurePosixPath,'lstat',lambda self:entries[str(self)],create=True),patch.object(PurePosixPath,'stat',lambda self:entries[str(self)],create=True),patch('os.chmod',lambda path,mode:changes.append((str(path),mode))),patch('sys.argv',['guard',path]),contextlib.redirect_stdout(output):
        try: exec(compile(code,'candidate-source-guard','exec'),{})
        except SystemExit:
            assert not accepted, 'safe private candidate rejected'
            assert changes==[], 'permissions changed before validation completed'
        else:
            assert accepted, 'unsafe candidate accepted'
            assert changes==[(path,0o755)] and output.getvalue().strip()==path
check(accepted=True)
for changes in [
    {'/tmp/private':info(stat.S_IFDIR|0o755)},
    {'/tmp/private':info(stat.S_IFDIR|0o770)},
    {'/tmp/private':info(stat.S_IFLNK|0o777)},
    {'/tmp/private/worktree':info(stat.S_IFLNK|0o777)},
    {'/tmp/private/worktree':info(stat.S_IFDIR|0o1777)},
    {'/tmp':info(stat.S_IFDIR|0o777)},
    {'/tmp':info(stat.S_IFDIR|0o1777,1000)},
]: check(changes)
for path in ['/', '/worktree', 'relative', '/tmp/private/../worktree', '/tmp/private/bad:name']: check(path=path)
`, block("CHECK_CANDIDATE")], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("private pnpm run probe returns the real CLI without modifying the candidate or installing", {
  skip: !pythonAvailable || !pnpmEntry || !existsSync(pnpmEntry) ? "Python and an installed pnpm entry required" : false,
}, () => {
  if (process.platform === "linux") assert.notEqual(process.getuid(), 0, "run pnpm probe fixtures as an unprivileged user");
  const fixture = mkdtempSync(path.join(tmpdir(), "candidate-pnpm-probe-"));
  try {
    const candidate = path.join(fixture, "candidate.json");
    const probe = path.join(fixture, "probe");
    mkdirSync(probe);
    const original = JSON.stringify({ packageManager: "pnpm@11.22.0", dependencies: { "must-not-install": "1.0.0" }, scripts: { preinstall: "exit 99" } });
    writeFileSync(candidate, original);
    // Deployment only permits safe Linux runtime paths. On Windows the system
    // Node path may contain spaces; use its whitelisted PATH entry for this test.
    const probeNode = process.platform === "win32" ? "node" : process.execPath;
    const prepared = spawnSync(python, ["-I", "-c", block("PREPARE_PROBE"), candidate, path.join(probe, "package.json"), probeNode], { encoding: "utf8", windowsHide: true });
    assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
    const env = { HOME: probe, USERPROFILE: probe, APPDATA: probe, LOCALAPPDATA: probe, XDG_CACHE_HOME: probe,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.platform === "win32" ? path.join(process.env.SystemRoot, "System32") : "/usr/bin:/bin"}`,
      COREPACK_ENABLE_NETWORK: "0", PNPM_CONFIG_OFFLINE: "true", pnpm_config_verify_deps_before_run: "",
      NPM_CONFIG_USERCONFIG: path.join(probe, "empty-user.npmrc"), NPM_CONFIG_GLOBALCONFIG: path.join(probe, "empty-global.npmrc") };
    if (process.platform === "win32") Object.assign(env, { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec });
    const result = spawnSync(process.execPath, [pnpmEntry, "--config.verify-deps-before-run=false", "--silent", "run", "harness-pnpm-entry"], {
      cwd: probe, env, encoding: "utf8", timeout: 15000, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const entry = result.stdout.trim();
    assert.ok(path.isAbsolute(entry) && existsSync(entry), `not an executable path: ${entry}`);
    assert.equal(path.dirname(entry), path.dirname(pnpmEntry));
    assert.equal(readFileSync(candidate, "utf8"), original);
    assert.equal(existsSync(path.join(probe, "node_modules")), false);
    assert.equal(existsSync(path.join(probe, "pnpm-lock.yaml")), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the actual Codex bind destination preserves Node sibling optional-package resolution", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "candidate-codex-resolution-"));
  try {
    const destination = source.match(/BindReadOnlyPaths=\$\{runtime_packages\[2\]\}:\$runtime\/([^"\n]+)/)?.[1];
    assert.ok(destination, "missing Codex runtime bind destination");
    const modules = path.join(fixture, ...destination.split("/"));
    const cli = path.join(modules, "@fixture/cli/bin/cli.cjs");
    const platform = path.join(modules, "@fixture/platform/index.js");
    mkdirSync(path.dirname(cli), { recursive: true });
    mkdirSync(path.dirname(platform), { recursive: true });
    writeFileSync(cli, "process.stdout.write(require.resolve('@fixture/platform'));");
    writeFileSync(platform, "module.exports = 'native platform stand-in';");
    const result = spawnSync(process.execPath, [cli], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(result.stdout, platform);
    assert.match(block("CANDIDATE_RUNNER"), /ln -s "\$runtime\/codex\/node_modules\/\$cli_relative"/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("candidate runner writes only its copy, preserves relative dependency links, and propagates failures", {
  skip: process.platform !== "linux" ? "ordinary unprivileged Linux fixture" : false,
}, () => {
  assert.notEqual(process.getuid(), 0, "run candidate copy fixtures as an unprivileged user");
  const fixture = mkdtempSync(path.join(tmpdir(), "candidate-runner-"));
  try {
    for (const name of ["source/dependency", "pnpm/bin", "codex/node_modules/@openai/codex/bin"]) mkdirSync(path.join(fixture, name), { recursive: true });
    writeFileSync(path.join(fixture, "source/package.json"), "original\n");
    writeFileSync(path.join(fixture, "source/dependency/value"), "linked\n");
    symlinkSync("dependency/value", path.join(fixture, "source/relative-link"));
    writeFileSync(path.join(fixture, "node"), `#!/bin/bash
set -eu
[ "$(id -u)" != 0 ]
[ -z "\${OPENAI_API_KEY:-}" ]
[ "$HOME" = "${fixture}/executable/home" ]
[ "$(cat relative-link)" = linked ]
if [[ "$1" == */pnpm.cjs ]]; then
  [ "$2" = --config.verify-deps-before-run=false ]
  [ "$3" = test ]
  [ "\${pnpm_config_verify_deps_before_run-unset}" = '' ]
  echo test-write >> package.json
  [ ! -f "$HOME/fail" ] || exit 23
else
  [ "$1" = scripts/gateway-smoke.mjs ]
  echo smoke > "$HOME/smoke-passed"
fi
`);
    chmodSync(path.join(fixture, "node"), 0o755);
    const scratch = path.join(fixture, "executable");
    const env = { HOME: path.join(scratch, "home"), CODEX_HOME: path.join(scratch, "codex-home"),
      XDG_CACHE_HOME: path.join(scratch, "cache"), TMPDIR: path.join(scratch, "tmp"), PATH: `${scratch}/bin:/usr/bin:/bin`,
      pnpm_config_verify_deps_before_run: "false" };
    const invoke = () => spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", block("CANDIDATE_RUNNER"), "--", fixture, "bin/pnpm.cjs", "@openai/codex/bin/codex.js"], { env, encoding: "utf8", timeout: 15000 });
    let result = invoke();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(readFileSync(path.join(fixture, "source/package.json"), "utf8"), "original\n");
    assert.equal(readFileSync(path.join(scratch, "worktree/package.json"), "utf8"), "original\ntest-write\n");
    assert.ok(existsSync(path.join(scratch, "home/smoke-passed")));
    rmSync(path.join(scratch, "bin"), { recursive: true });
    rmSync(path.join(scratch, "home/smoke-passed"));
    writeFileSync(path.join(scratch, "home/fail"), "fail pnpm test");
    result = invoke();
    assert.equal(result.status, 23, result.stderr + result.stdout);
    assert.equal(existsSync(path.join(scratch, "home/smoke-passed")), false);
    assert.equal(readFileSync(path.join(fixture, "source/package.json"), "utf8"), "original\n");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
