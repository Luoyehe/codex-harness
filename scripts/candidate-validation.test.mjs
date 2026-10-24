import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("../deploy/test-candidate.sh", import.meta.url));
const source = readFileSync(helper, "utf8");
const validationRunner = fileURLToPath(new URL("../deploy/candidate-validation.sh", import.meta.url));
const dependencyRunner = fileURLToPath(new URL("../deploy/candidate-dependencies.sh", import.meta.url));
const validationSource = readFileSync(validationRunner, "utf8");
const dependencySource = readFileSync(dependencyRunner, "utf8");
const python = process.env.CODEX_TEST_PYTHON || "python3";
const pythonAvailable = spawnSync(python, ["-I", "-c", "import unittest.mock"], { windowsHide: true }).status === 0;
const pnpmEntry = process.env.CODEX_TEST_PNPM_ENTRY || process.env.npm_execpath;
const linuxUpdaterTest = fileURLToPath(new URL("./update-candidate-linux.test.py", import.meta.url));
function block(name) {
  const match = source.match(new RegExp(`<<'${name}'[^\\n]*\\n([\\s\\S]*?)\\n${name}\\n`));
  assert.ok(match, `missing ${name} executable block`);
  return match[1];
}

test("trusted candidate bridge passes Linux descriptor and publication fault injection", {
  skip: process.platform !== "linux" || !pythonAvailable ? "Linux Python required" : false,
}, () => {
  const result = spawnSync(python, [linuxUpdaterTest], { encoding: "utf8", timeout: 120000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, windowsHide: true });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("candidate validation uses an ephemeral identity, private copy, and control-group cleanup", () => {
  for (const property of ["DynamicUser=yes", "RuntimeDirectoryMode=0700", "RuntimeDirectoryPreserve=no",
    "RemainAfterExit=yes", "KillMode=control-group", "TimeoutStopSec=15s", "RuntimeMaxSec=30min", "ProtectSystem=strict",
    "ProtectHome=yes", "PrivateDevices=yes", "NoNewPrivileges=yes",
    "MemoryMax=4G", "MemorySwapMax=0", "TasksMax=512", "LimitNOFILE=8192", "LimitFSIZE=512M",
    "StandardOutput=null", "StandardError=null", "CapabilityBoundingSet=", "AmbientCapabilities="])
    assert.ok(source.includes(`--property=${property}`), property);
  assert.doesNotMatch(source, /--wait|--pipe|--collect/);
  assert.match(source, /trap cleanup EXIT/);
  assert.match(source, /"\$systemctl" stop "\$unit\.service"/);
  assert.match(source, /"\$systemctl" reset-failed "\$unit\.service"/);
  assert.match(source, /BindReadOnlyPaths=\$candidate_root:\$runtime\/source/);
  assert.doesNotMatch(source, /Bind(?:ReadOnly)?Paths=.*candidate_root.*parent|ReadWritePaths=.*candidate_root/);
  assert.doesNotMatch(source, /ReadWritePaths=/);
  assert.equal(source.match(/--property="BindPaths=/g)?.length, 2);
  assert.match(source, /BindPaths=\$scratch_tmp:\/tmp/);
  assert.match(source, /BindPaths=\$scratch_var_tmp:\/var\/tmp/);
  assert.match(source, /mount_bin="\$\(trust file \/usr\/bin\/mount\)"/);
  assert.match(source, /umount_bin="\$\(trust file \/usr\/bin\/umount\)"/);
  assert.match(source, /mkdir -m 0700 -- "\$scratch_root"/);
  assert.equal(source.match(/-t tmpfs -o nodev,nosuid,noexec,size=512M,mode=1777/g)?.length, 2);
  assert.match(source, /"\$umount_bin" -- "\$scratch_var_tmp"/);
  assert.match(source, /"\$umount_bin" -- "\$scratch_tmp"/);
  assert.match(source, /TemporaryFileSystem=\$runtime\/executable:rw,nodev,nosuid,exec,mode=1777/);
  assert.match(source, /"\$env_bin" -i \\\n\s*"HOME=\$runtime\/executable\/home"/);
  assert.match(source, /"CODEX_HOME=\$runtime\/executable\/codex-home"/);
  assert.match(source, /"PATH=\$runtime\/executable\/bin:\/usr\/bin:\/bin"/);
  assert.doesNotMatch(source, /EnvironmentFile|PassEnvironment|GATEWAY_TOKEN|OPENAI_API_KEY|ZHIPU_KEY/);
  const runner = validationSource;
  assert.match(runner, /\[ "\$EUID" != 0 \]/);
  assert.match(runner, /cp -a --no-preserve=ownership -- "\$runtime\/source\/\." "\$worktree\/"/);
  assert.match(runner, /pnpm install --offline --frozen-lockfile --store-dir "\$workspace\/store"\npnpm typecheck\npnpm build\nnode scripts\/release-audit\.mjs \.\nif \[ "\$audit_closeout" = 1 \]; then\n  pnpm test\nelse/);
  assert.match(source, /private_network=yes/);
  assert.match(source, /--property="PrivateNetwork=\$private_network"/);
  assert.match(source, /dependencies\)\n\s+runner_name=candidate-dependencies\.sh\n\s+private_network=no/);
  assert.match(runner, /seed-store/);
  assert.match(runner, /seed-cache/);
  assert.match(runner, /node --test scripts\/candidate-validation\.test\.mjs scripts\/service-registration\.test\.mjs/);
  assert.match(runner, /pnpm --filter @codex-harness\/gateway exec vitest run test\/http-auth\.test\.ts/);
  assert.match(runner, /fi\n[\s\S]*node scripts\/release-audit\.mjs \.\nnode scripts\/gateway-smoke\.mjs/);
  assert.match(source, /audit_closeout="\$\{CANDIDATE_AUDIT_CLOSEOUT:-0\}"/);
  assert.match(source, /"\$version" "\$audit_closeout"/);
  assert.ok(runner.indexOf('node scripts/gateway-smoke.mjs') < runner.indexOf('payload="$export_root/payload"'));
  assert.match(runner, /export_root="\$runtime\/export"/);
  assert.match(runner, /: > "\$export_root\/ready"/);
  assert.match(runner, /while \[ ! -e "\$runtime\/accepted" \]/);
  assert.match(source, /"\$bridge" materialize-live/);
  assert.match(source, /"\$bridge" accept-live/);
  assert.ok(source.indexOf("materialize-live") < source.indexOf("accept-live"));
  assert.match(runner, /export pnpm_config_verify_deps_before_run=/);
  assert.match(runner, /--config.verify-deps-before-run=false/);
  assert.doesNotMatch(runner, /cp .*worktree.*source|rsync|pnpm update/);
  assert.match(runner, /cp -R --no-preserve=ownership/);
  assert.match(runner, /deploy\/privileged-helper\.sh "\$payload\/service\/privileged-helper\.sh"/);
  assert.match(runner, /deploy\/worker_launcher\.py "\$payload\/service\/worker_launcher\.py"/);
});

test("candidate runtime checks canonical executables and mounts the actual offline pnpm package", () => {
  assert.match(source, /node_bin="\$\(trust file /);
  assert.match(source, /trust file "\$node_entry"/);
  assert.match(source, /pnpm_launcher="\$\(trust file /);
  assert.match(source, /cli="\$\(trust file "\$runtime_seed\/node_modules\/\.bin\/codex"\)/);
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
  assert.match(source, /BindReadOnlyPaths=\$\{pnpm_package\[0\]\}:\$runtime\/pnpm/);
  assert.match(source, /BindReadOnlyPaths=\$runtime_seed:\$runtime\/codex-runtime/);
  assert.match(source, /"\$\{#pnpm_package\[@\]\}" = 2/);
  assert.match(source, /stage_runner="\$\(trust file "\$SCRIPT_DIR\/\$runner_name"\)"/);
  assert.match(source, /BindReadOnlyPaths=\$stage_runner:\$runtime\/runner\.sh/);
  assert.match(source, /"\$bash_bin" --noprofile --norc "\$runtime\/runner\.sh" "\$\{runner_args\[@\]\}"/);
  assert.doesNotMatch(source, /-c "\$runner"|candidate_root.*candidate-(?:dependencies|validation)\.sh/);
  assert.ok(source.indexOf('seed_fingerprint="$(runtime_fingerprint "$runtime_seed")"') < source.indexOf('"$systemd_run" --quiet'));
  for (const runner of [validationSource, dependencySource]) {
    assert.match(runner, /acknowledgement already exists before/);
    assert.match(runner, /\[ -f "\$runtime\/accepted" \] && \[ ! -L "\$runtime\/accepted" \]/);
    assert.match(runner, /\/usr\/bin\/stat -c '%u:%h:%a' -- "\$runtime\/accepted"/);
    assert.match(runner, /= 0:1:444/);
  }
});

test("phase policy ignores hostile candidate runner names and rejects unknown stages", {
  skip: process.platform === "win32" ? "POSIX Bash fixture required" : false,
}, () => {
  const definition = source.match(/configure_phase\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(definition);
  for (const [phase, expected] of [
    ["dependencies", ["/trusted/deploy/candidate-dependencies.sh", "no:false", "0", "2"]],
    ["validation", ["/trusted/deploy/candidate-validation.sh", "yes:true", "3", "4"]],
    ["../../candidate/runner", null],
  ]) {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `set -euo pipefail
trust() { [ "$1" = file ]; printf '%s\\n' "$2"; }
SCRIPT_DIR=/trusted/deploy
runtime=/run/codex-harness-candidate-fixture
pnpm_package=(/trusted/pnpm bin/pnpm.cjs)
artifact_seed=/trusted/cache
runtime_seed=/trusted/runtime
candidate_root=/hostile/candidate
version=0.149.0
audit_closeout=0
runner_name=/hostile/candidate/candidate-validation.sh
stage_runner=/hostile/candidate/candidate-dependencies.sh
${definition}
configure_phase
printf '%s\\n' "$stage_runner" "$private_network:$offline" "\${#seed_mounts[@]}" "\${#runner_args[@]}"
`], { env: { ...process.env, phase }, encoding: "utf8", timeout: 5000 });
    if (expected) {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.trim().split("\n"), expected);
    } else assert.notEqual(result.status, 0);
  }
});

test("output acknowledgement follows successful materialization and matching copied runtime identity", {
  skip: process.platform === "win32" ? "POSIX Bash fixture required" : false,
}, () => {
  const definition = source.match(/commit_output\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(definition);
  for (const scenario of [
    { phase: "validation", copied: "seed", expected: true },
    { phase: "validation", copied: "tampered", expected: false },
    { phase: "validation", copied: "seed", materializeStatus: "7", expected: false },
    { phase: "validation", copied: "seed", fingerprintStatus: "8", expected: false },
    { phase: "dependencies", copied: "unused", expected: true },
    { phase: "dependencies", copied: "unused", materializeStatus: "7", expected: false },
    { phase: "unknown", copied: "unused", expected: false },
  ]) {
    const fixture = mkdtempSync(path.join(tmpdir(), "candidate-commit-"));
    try {
      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `set -euo pipefail
bridge=/trusted/deploy/update_candidate.py
runtime=/run/candidate
validated_destination=/private/copied
version=0.149.0
dependency_inputs=projection-digest
seed_fingerprint=seed
python3() {
  [ "$1" = -I ] && [ "$2" = "$bridge" ]
  printf '%s\\n' "$3" >> "$FIXTURE_TRACE"
  case "$3" in
    materialize-live|materialize-dependencies-live) return "$FIXTURE_MATERIALIZE_STATUS" ;;
    accept-live) [ "$4" = /run/candidate/export ] ;;
    *) return 99 ;;
  esac
}
runtime_fingerprint() {
  [ "$1" = /private/copied/runtime ] || return 99
  printf '%s\\n' runtime-info >> "$FIXTURE_TRACE"
  printf '%s\\n' "$FIXTURE_COPIED"
  return "$FIXTURE_FINGERPRINT_STATUS"
}
${definition}
commit_output
`], { env: { ...process.env, phase: scenario.phase, FIXTURE_TRACE: path.join(fixture, "trace"),
        FIXTURE_COPIED: scenario.copied, FIXTURE_MATERIALIZE_STATUS: scenario.materializeStatus || "0",
        FIXTURE_FINGERPRINT_STATUS: scenario.fingerprintStatus || "0" }, encoding: "utf8", timeout: 5000 });
      assert.equal(result.status === 0, scenario.expected, result.stderr);
      const trace = existsSync(path.join(fixture, "trace")) ? readFileSync(path.join(fixture, "trace"), "utf8").trim().split("\n") : [];
      assert.equal(trace.includes("accept-live"), scenario.expected);
      if (scenario.phase === "validation" && scenario.expected) assert.deepEqual(trace, ["materialize-live", "runtime-info", "accept-live"]);
      if (scenario.phase === "dependencies") assert.equal(trace.includes("runtime-info"), false);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }
});

test("transient shutdown accepts corroborated garbage collection and rejects inconclusive failures", {
  skip: process.platform === "win32" ? "POSIX Bash fixture required" : false,
}, () => {
  const definition = source.match(/stop_isolated_unit\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(definition);
  for (const scenario of [
    { state: "inactive", status: 3, show: "", accepted: true },
    { state: "inactive", status: 4, show: "LoadState=not-found\nActiveState=inactive\nSubState=dead", accepted: true },
    { state: "unknown", status: 4, show: "SubState=dead\nLoadState=not-found\nActiveState=inactive", accepted: true },
    { state: "inactive", status: 4, show: "LoadState=not-found\nActiveState=active\nSubState=running", accepted: false },
    { state: "inactive", status: 4, show: "LoadState=not-found\nActiveState=inactive\nSubState=dead", showStatus: 1, accepted: false },
    { state: "inactive", status: 4, show: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nSubState=dead", accepted: false },
    { state: "", status: 1, show: "", accepted: false },
    { state: "", status: 124, show: "", accepted: false },
    { state: "unknown", status: 4, show: "", accepted: false },
  ]) {
    const fixture = mkdtempSync(path.join(tmpdir(), "candidate-stop-"));
    try {
      const run = spawnSync("bash", ["-c", `set -euo pipefail
systemctl_mock() {
  case "$1" in
    stop) return 0 ;;
    is-active) printf '%s\\n' "$FIXTURE_STATE"; return "$FIXTURE_STATUS" ;;
    show) printf '%s\\n' "$FIXTURE_SHOW"; return "$FIXTURE_SHOW_STATUS" ;;
    *) return 99 ;;
  esac
}
systemctl=systemctl_mock
unit=fixture
candidate_root="$FIXTURE_ROOT/candidate"
runtime="$FIXTURE_ROOT/runtime"
scratch_root="$FIXTURE_ROOT/scratch"
${definition}
stop_isolated_unit
`], { encoding: "utf8", timeout: 5000, env: { ...process.env,
        FIXTURE_ROOT: fixture, FIXTURE_STATE: scenario.state, FIXTURE_STATUS: String(scenario.status),
        FIXTURE_SHOW: scenario.show, FIXTURE_SHOW_STATUS: String(scenario.showStatus || 0) } });
      assert.equal(run.status === 0, scenario.accepted, run.stdout + run.stderr);
      assert.equal(existsSync(path.join(fixture, "isolation-unconfirmed")), !scenario.accepted);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }
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

test("coordinator rejects existing output or a replaceable destination before launching work", { skip: !pythonAvailable && "Python required" }, () => {
  const result = spawnSync(python, ["-I", "-c", `
import contextlib,io,stat,sys
from pathlib import PurePosixPath
from types import SimpleNamespace
from unittest.mock import patch
code=sys.argv[1]
def info(mode,uid=0): return SimpleNamespace(st_mode=mode,st_uid=uid)
base={'/':info(stat.S_IFDIR|0o755),'/tmp':info(stat.S_IFDIR|0o1777),'/tmp/private':info(stat.S_IFDIR|0o700)}
def check(changes=None,path='/tmp/private/output',exists=False,accepted=False):
    entries={**base,**(changes or {})}; output=io.StringIO()
    with patch('pathlib.Path',PurePosixPath),patch.object(PurePosixPath,'lstat',lambda self:entries[str(self)],create=True),patch.object(PurePosixPath,'stat',lambda self:entries[str(self)],create=True),patch('os.path.lexists',lambda value:exists),patch('sys.argv',['guard',path]),contextlib.redirect_stdout(output):
        try: exec(compile(code,'candidate-destination-guard','exec'),{})
        except SystemExit: assert not accepted, 'safe destination rejected'
        else: assert accepted and output.getvalue().strip()==path, 'unsafe destination accepted'
check(accepted=True)
check(exists=True)
for entry in [info(stat.S_IFDIR|0o755),info(stat.S_IFDIR|0o770),info(stat.S_IFDIR|0o1700,1000),info(stat.S_IFLNK|0o777)]: check({'/tmp/private':entry})
check({'/tmp':info(stat.S_IFDIR|0o777)})
for path in ['/', '/output', 'relative', '/tmp/private/../output', '/tmp/private/bad:name']: check(path=path)
`, block("CHECK_DESTINATION")], { encoding: "utf8", windowsHide: true, timeout: 15000 });
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
    const destination = source.match(/BindReadOnlyPaths=\$runtime_seed:\$runtime\/([^"\n]+)/)?.[1];
    assert.ok(destination, "missing Codex runtime bind destination");
    const modules = path.join(fixture, ...destination.split("/"), "node_modules");
    const cli = path.join(modules, "@fixture/cli/bin/cli.cjs");
    const platform = path.join(modules, "@fixture/platform/index.js");
    mkdirSync(path.dirname(cli), { recursive: true });
    mkdirSync(path.dirname(platform), { recursive: true });
    writeFileSync(cli, "process.stdout.write(require.resolve('@fixture/platform'));");
    writeFileSync(platform, "module.exports = 'native platform stand-in';");
    const result = spawnSync(process.execPath, [cli], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(result.stdout, platform);
    assert.match(validationSource, /ln -s "\$runtime\/codex-runtime\/node_modules\/\.bin\/codex"/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("production runner preserves the whole runtime, propagates gates and rejects forged acknowledgement", {
  skip: process.platform !== "linux" ? "ordinary unprivileged Linux fixture" : false,
}, () => {
  assert.notEqual(process.getuid(), 0, "run candidate copy fixtures as an unprivileged user");
  const fixture = mkdtempSync(path.join(tmpdir(), "candidate-runner-"));
  try {
    for (const name of ["source/dependency", "source/apps/gateway", "source/apps/web", "source/scripts", "source/deploy",
      "pnpm/bin", "codex-runtime/node_modules/.bin", "codex-runtime/node_modules/@openai/codex/bin",
      "codex-runtime/node_modules/@openai/codex-linux-x64", "seed-store", "seed-cache"])
      mkdirSync(path.join(fixture, name), { recursive: true });
    writeFileSync(path.join(fixture, "source/package.json"), "original\n");
    writeFileSync(path.join(fixture, "source/dependency/value"), "linked\n");
    writeFileSync(path.join(fixture, "source/deploy/privileged-helper.sh"), "fixture helper\n");
    writeFileSync(path.join(fixture, "source/deploy/worker_launcher.py"), "fixture worker\n");
    symlinkSync("dependency/value", path.join(fixture, "source/relative-link"));
    for (const [name, value] of [["seed-store/store-marker", "store"], ["seed-cache/cache-marker", "cache"]]) writeFileSync(path.join(fixture, name), value);
    const cli = path.join(fixture, "codex-runtime/node_modules/@openai/codex/bin/codex.js");
    writeFileSync(cli, "#!/usr/bin/env node\nrequire('@openai/codex-linux-x64');\n");
    chmodSync(cli, 0o755);
    symlinkSync("../@openai/codex/bin/codex.js", path.join(fixture, "codex-runtime/node_modules/.bin/codex"));
    symlinkSync("../../codex-linux-x64", path.join(fixture, "codex-runtime/node_modules/@openai/codex/bin/platform"));
    const runtimeFiles = {
      "package.json": '{"dependencies":{"@openai/codex":"0.149.0"}}\n',
      "package-lock.json": '{"lockfileVersion":3}\n',
      "node_modules/.package-lock.json": '{"hidden":true}\n',
      "node_modules/@openai/codex/package.json": '{"name":"@openai/codex","version":"0.149.0"}\n',
      "node_modules/@openai/codex-linux-x64/index.js": "module.exports = 'platform';\n",
    };
    for (const [name, content] of Object.entries(runtimeFiles)) writeFileSync(path.join(fixture, "codex-runtime", name), content);
    linkSync(path.join(fixture, "codex-runtime/package.json"), path.join(fixture, "codex-runtime/root-copy.json"));
    writeFileSync(path.join(fixture, "node"), `#!/bin/bash
set -eu
[ "$(id -u)" != 0 ]
[ -z "\${OPENAI_API_KEY:-}" ]
[ "$HOME" = "${fixture}/executable/home" ]
[ "$(cat relative-link)" = linked ]
if [[ "$1" == */pnpm.cjs ]]; then
  [ "$2" = --config.verify-deps-before-run=false ]
  [ "$3" = --config.manage-package-manager-versions=false ]
  [ "\${pnpm_config_verify_deps_before_run-unset}" = '' ]
  command=$4
else
  command=$1
fi
printf '%s\n' "$command" >> "$HOME/commands"
[ "\${FAIL_STAGE:-}" != "$command" ] || exit 23
case "$command" in
  install) [ "$5" = --offline ] && [ "$6" = --frozen-lockfile ]; mkdir -p node_modules apps/gateway/node_modules apps/web/node_modules ;;
  build) mkdir -p apps/gateway/dist apps/web/dist; echo gateway > apps/gateway/dist/marker; echo web > apps/web/dist/marker ;;
  test|--test) echo test-write >> package.json ;;
  scripts/gateway-smoke.mjs) echo smoke > "$HOME/smoke-passed"; : > "${fixture}/accepted"; chmod 444 "${fixture}/accepted" ;;
esac
`);
    chmodSync(path.join(fixture, "node"), 0o755);
    const scratch = path.join(fixture, "executable");
    const env = { HOME: path.join(scratch, "home"), CODEX_HOME: path.join(scratch, "codex-home"),
      XDG_CACHE_HOME: path.join(scratch, "cache"), TMPDIR: path.join(scratch, "tmp"), PATH: `${scratch}/bin:/usr/bin:/bin`,
      pnpm_config_verify_deps_before_run: "false" };
    const invoke = (auditCloseout = "0") => spawnSync("/bin/bash", ["--noprofile", "--norc", validationRunner, fixture, "bin/pnpm.cjs", "0.149.0", auditCloseout], { env, encoding: "utf8", timeout: 15000 });
    let result = invoke();
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stderr, /invalid root acknowledgement/);
    assert.equal(readFileSync(path.join(fixture, "source/package.json"), "utf8"), "original\n");
    assert.equal(readFileSync(path.join(scratch, "worktree/package.json"), "utf8"), "original\ntest-write\n");
    assert.ok(existsSync(path.join(scratch, "home/smoke-passed")));
    assert.equal(readFileSync(path.join(scratch, "home/commands"), "utf8"),
      "install\ntypecheck\nbuild\nscripts/release-audit.mjs\n--test\n--filter\nscripts/release-audit.mjs\nscripts/gateway-smoke.mjs\n");
    assert.ok(existsSync(path.join(fixture, "export/payload/artifacts/apps/gateway/dist/marker")));
    assert.ok(existsSync(path.join(fixture, "export/payload/runtime/node_modules/.bin/codex")));
    for (const [name, content] of Object.entries(runtimeFiles)) assert.equal(readFileSync(path.join(fixture, "export/payload/runtime", name), "utf8"), content);
    assert.equal(readlinkSync(path.join(fixture, "export/payload/runtime/node_modules/.bin/codex")), "../@openai/codex/bin/codex.js");
    assert.equal(readlinkSync(path.join(fixture, "export/payload/runtime/node_modules/@openai/codex/bin/platform")), "../../codex-linux-x64");
    assert.ok(statSync(path.join(fixture, "export/payload/runtime/node_modules/.bin/codex")).mode & 0o111);
    assert.equal(statSync(path.join(fixture, "export/payload/runtime/root-copy.json")).nlink, 1);
    assert.equal(statSync(path.join(fixture, "export/payload/runtime/package.json")).nlink, 1);
    assert.ok(existsSync(path.join(fixture, "export/payload/service/privileged-helper.sh")));
    rmSync(path.join(fixture, "accepted"));
    rmSync(scratch, { recursive: true, force: true });
    rmSync(path.join(fixture, "export"), { recursive: true, force: true });
    env.FAIL_STAGE = "--test";
    result = invoke();
    assert.equal(result.status, 23, result.stderr + result.stdout);
    assert.equal(existsSync(path.join(fixture, "export/payload")), false);
    assert.equal(readFileSync(path.join(fixture, "source/package.json"), "utf8"), "original\n");
    rmSync(scratch, { recursive: true, force: true });
    delete env.FAIL_STAGE;
    result = invoke("1");
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stderr, /invalid root acknowledgement/);
    assert.equal(readFileSync(path.join(scratch, "home/commands"), "utf8"),
      "install\ntypecheck\nbuild\nscripts/release-audit.mjs\ntest\nscripts/release-audit.mjs\nscripts/gateway-smoke.mjs\n");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("both production runners reject pre-existing acknowledgements before creating a workspace", {
  skip: process.platform !== "linux" ? "ordinary unprivileged Linux fixture" : false,
}, () => {
  assert.notEqual(process.getuid(), 0, "run runner rejection fixtures as an unprivileged user");
  for (const runner of [validationRunner, dependencyRunner]) for (const kind of ["file", "dangling-link", "directory"]) {
    const fixture = mkdtempSync(path.join(tmpdir(), "candidate-preack-"));
    try {
      const ack = path.join(fixture, "accepted");
      if (kind === "file") { writeFileSync(ack, "forged"); chmodSync(ack, 0o444); }
      else if (kind === "dangling-link") symlinkSync("missing", ack);
      else mkdirSync(ack);
      const args = [runner, fixture, "bin/pnpm.cjs", ...(runner === validationRunner ? ["0.149.0", "0"] : [])];
      const result = spawnSync("/bin/bash", args, { encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /acknowledgement already exists before/);
      assert.equal(existsSync(path.join(fixture, "executable")), false);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }
});
