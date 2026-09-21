import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const providers = fileURLToPath(new URL("../deploy/providers/", import.meta.url));
const linuxFaultSuite = fileURLToPath(new URL("./provider-transaction-linux.test.py", import.meta.url));
const python = process.env.CODEX_TEST_PYTHON || "python3";
const options = { skip: process.platform === "win32" ? "Provider deployment transactions require Linux flock and symlinks" : false };
const pythonAvailable = spawnSync(python, ["-c", "import tomllib"], { timeout: 10000, windowsHide: true }).status === 0;
const unitOptions = { skip: pythonAvailable ? false : "Python 3.11+ needed" };

function runPython(code, args) {
  return spawnSync(python, ["-c", code, ...args], { encoding: "utf8", windowsHide: true, timeout: 10000,
    env: { ...process.env, PYTHONPATH: providers, PYTHONDONTWRITEBYTECODE: "1" } });
}

test("Linux provider transaction fault-injection suite", options, () => {
  const result = spawnSync(python, [linuxFaultSuite], {
    encoding: "utf8", windowsHide: true, timeout: 30000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

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

test("provider setup isolates credential-handling Python from the caller directory and PYTHONPATH", options, () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "provider-python-path-"));
  const home = path.join(fixture, "home"), hostile = path.join(fixture, "hostile"), marker = path.join(fixture, "imported");
  mkdirSync(hostile);
  writeFileSync(path.join(hostile, "json.py"), `import os
open(os.environ["IMPORT_MARKER"], "w", encoding="utf-8").write("caller module imported")
raise RuntimeError("caller json.py must not run")
`);
  const env = { ...process.env, PYTHONPATH: hostile, PYTHONDONTWRITEBYTECODE: "1", IMPORT_MARKER: marker,
    CODEX_HOME: home, ENV_FILE: path.join(fixture, "secrets.env"), CUSTOM_BASE_URL: "http://127.0.0.1:1/v1",
    CUSTOM_MODEL: "local-model", CUSTOM_EFFORT: "high", CUSTOM_VISION: "0", CUSTOM_API_KEY: "synthetic-private-value", PROBE_REASONING: "0" };
  try {
    const run = spawnSync("bash", [path.join(providers, "custom-openai/setup.sh")], { cwd: hostile, env, encoding: "utf8", timeout: 20000 });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.equal(existsSync(marker), false, "provider setup imported a caller-controlled Python module");
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("an invalid provider command is rejected before creating a candidate generation", options, () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "provider-command-"));
  const home = path.join(fixture, "home");
  try {
    const run = spawnSync(python, [path.join(providers, "provider_transaction.py"), "custom", path.join(fixture, "missing.sh")], {
      env: { ...process.env, CODEX_HOME: home, ENV_FILE: path.join(fixture, "secrets.env"), PYTHONDONTWRITEBYTECODE: "1" },
      encoding: "utf8", timeout: 10000,
    });
    assert.notEqual(run.status, 0);
    const versions = path.join(home, "providers/.versions");
    assert.deepEqual(existsSync(versions) ? readdirSync(versions) : [], []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("generation retention keeps the active snapshot and only the newest bounded history", options, () => {
  const result = runPython(`import os,sys,tempfile
from pathlib import Path
from provider_transaction import prune_generations
with tempfile.TemporaryDirectory() as directory:
    home = Path(directory) / "home"
    providers = home / "providers"
    versions = providers / ".versions"
    versions.mkdir(parents=True, mode=0o700)
    os.chmod(providers, 0o700); os.chmod(versions, 0o700)
    generations = []
    for index in range(6):
        generation = versions / ("generation-%d" % index)
        generation.mkdir(mode=0o700)
        secret = generation / "secrets.env"
        secret.write_text("SECRET_%d=fixture\\n" % index)
        os.chmod(secret, 0o600)
        os.utime(generation, (index + 1, index + 1))
        generations.append(generation)
    outside = Path(directory) / "outside"
    outside.mkdir(); (outside / "sentinel").write_text("keep")
    (generations[1] / "escape").symlink_to(outside, target_is_directory=True)
    os.utime(generations[1], (2, 2))
    (versions / "generation-linked").symlink_to(outside, target_is_directory=True)
    unsafe = versions / "generation-public"
    unsafe.mkdir(mode=0o700); (unsafe / "sentinel").write_text("keep"); os.chmod(unsafe, 0o755)
    active = providers / ".active"
    active.symlink_to(generations[0], target_is_directory=True)
    removed = set(prune_generations(versions, active))
    assert removed == {"generation-1", "generation-2"}, removed
    assert all(generations[index].is_dir() for index in (0, 3, 4, 5))
    assert (versions / "generation-linked").is_symlink() and (outside / "sentinel").read_text() == "keep"
    assert (unsafe / "sentinel").read_text() == "keep"
    active.unlink()
    active.symlink_to(".versions/../.versions/generation-0", target_is_directory=True)
    try: prune_generations(versions, active, keep_history=0)
    except ValueError: pass
    else: raise AssertionError("active traversal spelling was accepted")
    assert all(generations[index].is_dir() for index in (0, 3, 4, 5))
`, []);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("candidate cleanup preserves same-name directory and symlink replacements", options, () => {
  const result = runPython(`import os,tempfile
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import provider_transaction as transaction

def layout(base):
    home = base / 'home'; providers = home / 'providers'; versions = providers / '.versions'
    versions.mkdir(parents=True, mode=0o700)
    os.chmod(providers, 0o700); os.chmod(versions, 0o700)
    return home, versions

for replacement_kind in ('directory', 'symlink'):
    with tempfile.TemporaryDirectory() as directory:
        base = Path(directory); home, versions = layout(base)
        moved = versions / ('moved-' + replacement_kind)
        outside = base / ('outside-' + replacement_kind)
        outside.mkdir(); (outside / 'sentinel').write_text('outside')
        def replace_then_fail(_path):
            candidate = next(path for path in versions.iterdir() if path.name.startswith('generation-'))
            candidate.rename(moved)
            if replacement_kind == 'directory':
                candidate.mkdir(mode=0o700); (candidate / 'sentinel').write_text('replacement')
            else:
                candidate.symlink_to(outside, target_is_directory=True)
            raise RuntimeError('synthetic snapshot failure')
        with patch.object(transaction, 'load_config', side_effect=replace_then_fail):
            try: transaction.snapshot(home, base / 'secrets.env', versions)
            except RuntimeError: pass
            else: raise AssertionError('snapshot failure did not propagate')
        candidate = next(path for path in versions.iterdir() if path.name.startswith('generation-'))
        assert moved.is_dir()
        if replacement_kind == 'directory':
            assert (candidate / 'sentinel').read_text() == 'replacement'
        else:
            assert candidate.is_symlink() and (outside / 'sentinel').read_text() == 'outside'

with tempfile.TemporaryDirectory() as directory:
    base = Path(directory); home, versions = layout(base)
    (home / 'config.toml').write_text('')
    env_file = base / 'secrets.env'
    script = base / 'setup.sh'; script.write_text('#!/bin/sh\\nexit 0\\n'); script.chmod(0o700)
    candidate = versions / 'generation-execute'
    candidate.mkdir(mode=0o700); (candidate / 'config.toml').write_text(''); (candidate / 'secrets.env').write_text('FIXTURE=old\\n')
    os.chmod(candidate / 'config.toml', 0o600); os.chmod(candidate / 'secrets.env', 0o600)
    identity = os.stat(candidate, follow_symlinks=False)
    moved = versions / 'moved-execute'
    @contextmanager
    def unlocked(_home, _home_fd): yield
    def child(*_args, **_kwargs):
        candidate.rename(moved); candidate.mkdir(mode=0o700); (candidate / 'sentinel').write_text('replacement')
        return SimpleNamespace(returncode=9)
    environment = {'CODEX_HOME':str(home), 'ENV_FILE':str(env_file),
                   'CUSTOM_SYNC_CATALOG':'0', 'ZHIPU_SYNC_CATALOG':'0'}
    with patch.dict(os.environ, environment), patch.object(transaction, 'transaction_lock', unlocked), \
         patch.object(transaction, 'snapshot', return_value=(candidate, identity)), \
         patch.object(transaction.subprocess, 'run', side_effect=child):
        assert transaction.execute('openai', [str(script)]) == 9
    assert moved.is_dir() and (candidate / 'sentinel').read_text() == 'replacement'
`, []);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("legacy snapshots reject links, special files, hardlinks and oversized files without reading them", options, () => {
  const result = runPython(`import os,tempfile
from pathlib import Path
import provider_transaction as transaction

for kind in ('symlink', 'hardlink', 'fifo', 'oversized'):
    with tempfile.TemporaryDirectory() as directory:
        base = Path(directory); home = base / 'home'; source = home / 'providers' / 'custom'
        source.mkdir(parents=True); os.chmod(home / 'providers', 0o700)
        (home / 'config.toml').write_text(''); env_file = base / 'secrets.env'; env_file.write_text('FIXTURE=value\\n')
        outside = base / 'outside'; outside.write_text('keep')
        entry = source / 'entry'
        if kind == 'symlink': entry.symlink_to(outside)
        elif kind == 'hardlink': os.link(outside, entry)
        elif kind == 'fifo': os.mkfifo(entry, 0o600)
        else:
            with entry.open('wb') as stream: stream.truncate(transaction.MAX_SNAPSHOT_FILE_BYTES + 1)
        versions = home / 'providers' / '.versions'
        try: transaction.snapshot(home, env_file, versions)
        except (ValueError, RuntimeError): pass
        else: raise AssertionError(kind + ' legacy entry was copied')
        assert outside.read_text() == 'keep'
        assert list(versions.iterdir()) == [], list(versions.iterdir())

with tempfile.TemporaryDirectory() as directory:
    base = Path(directory); home = base / 'home'; nested = home / 'providers' / 'custom' / 'nested'
    nested.mkdir(parents=True); os.chmod(home / 'providers', 0o700)
    (nested / 'value').write_text('copied')
    (home / 'config.toml').write_text(''); env_file = base / 'secrets.env'; env_file.write_text('FIXTURE=value\\n')
    generation, _ = transaction.snapshot(home, env_file, home / 'providers' / '.versions')
    copied = generation / 'providers' / 'custom' / 'nested' / 'value'
    assert copied.read_text() == 'copied' and (copied.stat().st_mode & 0o077) == 0
`, []);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("descriptor-relative snapshot reads detect source growth and same-name replacement", options, () => {
  const result = runPython(`import os,tempfile
from pathlib import Path
from unittest.mock import patch
import provider_transaction as transaction

for mutation in ('grow', 'replace'):
    with tempfile.TemporaryDirectory() as directory:
        base = Path(directory); source = base / 'source'; target = base / 'target'
        source.mkdir(); target.mkdir(); item = source / 'item'; item.write_bytes(b'original')
        source_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
        target_fd = os.open(target, os.O_RDONLY | os.O_DIRECTORY)
        real_read = os.read; changed = False
        def mutate_then_read(descriptor, amount):
            global changed
            if not changed:
                changed = True
                if mutation == 'grow':
                    with item.open('ab') as stream: stream.write(b'-growth')
                else:
                    moved = source / 'moved'; item.rename(moved); item.write_bytes(b'replacement')
            return real_read(descriptor, amount)
        try:
            with patch.object(transaction.os, 'read', side_effect=mutate_then_read):
                try: transaction._copy_regular_at(source_fd, 'item', target_fd, 'item', transaction._new_snapshot_budget())
                except RuntimeError: pass
                else: raise AssertionError(mutation + ' was not detected')
            assert not (target / 'item').exists()
        finally:
            os.close(target_fd); os.close(source_fd)
`, []);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("publish preparation rejects linked and special candidate entries", options, () => {
  const result = runPython(`import os,stat,tempfile
from pathlib import Path
from provider_transaction import private_generation
for kind in ('symlink', 'hardlink', 'fifo'):
    with tempfile.TemporaryDirectory() as directory:
        base = Path(directory); versions = base / 'providers' / '.versions'
        versions.mkdir(parents=True, mode=0o700)
        os.chmod(versions.parent, 0o700); os.chmod(versions, 0o700)
        candidate = versions / ('generation-' + kind); candidate.mkdir(mode=0o700)
        outside = base / 'outside'; outside.write_text('keep')
        if kind == 'symlink': (candidate / 'entry').symlink_to(outside)
        elif kind == 'hardlink': os.link(outside, candidate / 'entry')
        else: os.mkfifo(candidate / 'entry', 0o600)
        identity = os.stat(candidate, follow_symlinks=False)
        try: private_generation(candidate, identity)
        except ValueError: pass
        else: raise AssertionError(kind + ' candidate entry was accepted')
        assert outside.read_text() == 'keep'
with tempfile.TemporaryDirectory() as directory:
    base = Path(directory); versions = base / 'providers' / '.versions'
    versions.mkdir(parents=True, mode=0o700)
    os.chmod(versions.parent, 0o700); os.chmod(versions, 0o700)
    candidate = versions / 'generation-_valid'; candidate.mkdir(mode=0o700)
    regular = candidate / 'config.toml'; regular.write_text(''); identity = os.stat(candidate, follow_symlinks=False)
    private_generation(candidate, identity)
    assert stat.S_IMODE(candidate.stat().st_mode) == 0o700 and stat.S_IMODE(regular.stat().st_mode) == 0o600
`, []);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("active publication restores the old link after candidate replacement or directory fsync failure", options, () => {
  const result = runPython(`import os,tempfile
from pathlib import Path
from unittest.mock import patch
import provider_transaction as transaction

def layout(base):
    providers = base / 'providers'; versions = providers / '.versions'
    versions.mkdir(parents=True, mode=0o700); os.chmod(providers, 0o700); os.chmod(versions, 0o700)
    old = versions / 'generation-old'; old.mkdir(mode=0o700)
    candidate = versions / 'generation-candidate'; candidate.mkdir(mode=0o700)
    (providers / '.active').symlink_to(old, target_is_directory=True)
    return providers, versions, old, candidate

with tempfile.TemporaryDirectory() as directory:
    providers, versions, old, candidate = layout(Path(directory)); moved = versions / 'moved-candidate'
    expected = os.stat(candidate, follow_symlinks=False); real_replace = os.replace; injected = False
    def replace(source, destination, *args, **kwargs):
        global injected
        if not injected and destination == '.active' and str(source).startswith('.provider-link-commit-'):
            injected = True; candidate.rename(moved); candidate.mkdir(mode=0o700)
        return real_replace(source, destination, *args, **kwargs)
    with transaction._opened_versions(versions) as (providers_fd, versions_fd, canonical):
        with patch.object(transaction.os, 'replace', side_effect=replace):
            try: transaction._commit_active(providers_fd, versions_fd, canonical, candidate, expected)
            except RuntimeError: pass
            else: raise AssertionError('candidate replacement committed')
    assert (providers / '.active').resolve() == old.resolve()
    assert moved.is_dir() and candidate.is_dir()

with tempfile.TemporaryDirectory() as directory:
    providers, versions, old, candidate = layout(Path(directory))
    expected = os.stat(candidate, follow_symlinks=False); failed = False; real_fsync = os.fsync
    with transaction._opened_versions(versions) as (providers_fd, versions_fd, canonical):
        def fsync(descriptor):
            global failed
            if descriptor == providers_fd and not failed:
                failed = True
                raise OSError('synthetic directory fsync failure')
            return real_fsync(descriptor)
        with patch.object(transaction.os, 'fsync', side_effect=fsync):
            try: transaction._commit_active(providers_fd, versions_fd, canonical, candidate, expected)
            except OSError: pass
            else: raise AssertionError('directory fsync failure was reported as committed')
    assert failed and (providers / '.active').resolve() == old.resolve()
`, []);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("pruning isolates poisoned generations and unknown entries consume the hard publication budget", options, () => {
  const result = runPython(`import os,tempfile
from pathlib import Path
import provider_transaction as transaction

with tempfile.TemporaryDirectory() as directory:
    providers = Path(directory) / 'providers'; versions = providers / '.versions'
    versions.mkdir(parents=True, mode=0o700); os.chmod(providers, 0o700); os.chmod(versions, 0o700)
    generations = []
    for index in range(6):
        generation = versions / ('generation-%d' % index); generation.mkdir(mode=0o700)
        item = generation / 'item'; item.write_text('fixture'); os.chmod(item, 0o600)
        os.utime(generation, (index + 1, index + 1)); generations.append(generation)
    os.chmod(generations[2] / 'item', 0o644)
    active = providers / '.active'; active.symlink_to(generations[0], target_is_directory=True)
    problems = []
    removed = set(transaction.prune_generations(versions, active, keep_history=2, problems=problems))
    assert removed == {'generation-1', 'generation-3'}, removed
    assert generations[2].is_dir() and problems == ['unsafe'], problems

with tempfile.TemporaryDirectory() as directory:
    providers = Path(directory) / 'providers'; versions = providers / '.versions'
    versions.mkdir(parents=True, mode=0o700); os.chmod(providers, 0o700); os.chmod(versions, 0o700)
    unknown = versions / 'operator-residue'
    with unknown.open('wb') as stream: stream.truncate(transaction.MAX_VERSIONS_BYTES + 1)
    with transaction._opened_versions(versions) as (_providers_fd, versions_fd, _canonical):
        try: transaction._assert_versions_budget(versions_fd, reserve_generations=0)
        except ValueError: pass
        else: raise AssertionError('unknown version residue did not consume the hard budget')
    assert unknown.is_file()
`, []);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("candidate durability reaches files and leaf directories before versions and active, and failures do not switch", options, () => {
  const result = runPython(`import os,tempfile
from pathlib import Path
from unittest.mock import patch
import provider_transaction as transaction

def make_generation(path):
    path.mkdir(mode=0o700)
    (path / 'config.toml').write_text(''); (path / 'secrets.env').write_text('FIXTURE=value\\n')
    os.chmod(path / 'config.toml', 0o600); os.chmod(path / 'secrets.env', 0o600)
    tree = path / 'providers'; tree.mkdir(mode=0o700)
    for mode in transaction.MODES: (tree / mode).mkdir(mode=0o700)

def make_layout(base):
    home = base / 'home'; providers = home / 'providers'; versions = providers / '.versions'
    versions.mkdir(parents=True, mode=0o700); os.chmod(home, 0o700); os.chmod(providers, 0o700); os.chmod(versions, 0o700)
    old = versions / 'generation-old'; candidate = versions / 'generation-candidate'
    make_generation(old); make_generation(candidate)
    (providers / '.active').symlink_to(old, target_is_directory=True)
    return home, providers, versions, old, candidate

with tempfile.TemporaryDirectory() as directory:
    base = Path(directory); home, providers, versions, old, candidate = make_layout(base)
    env_file = base / 'service.env'; expected = os.stat(candidate, follow_symlinks=False)
    labels = {}
    for label, path in [('file', candidate / 'config.toml'), ('leaf', candidate / 'providers' / 'custom'),
                        ('provider-tree', candidate / 'providers'), ('generation', candidate),
                        ('versions', versions), ('active-parent', providers)]:
        info = os.stat(path, follow_symlinks=False); labels[(info.st_dev, info.st_ino)] = label
    events = []; real_fsync = os.fsync
    def record(descriptor):
        info = os.fstat(descriptor); events.append(labels.get((info.st_dev, info.st_ino), 'other'))
        return real_fsync(descriptor)
    with patch.object(transaction.os, 'fsync', side_effect=record):
        transaction.publish(home, env_file, versions, candidate, expected)
    last = lambda label: len(events) - 1 - events[::-1].index(label)
    assert last('file') < last('generation') < last('versions') < last('active-parent'), events
    assert last('leaf') < last('provider-tree') < last('generation'), events
    assert (providers / '.active').resolve() == candidate.resolve()

with tempfile.TemporaryDirectory() as directory:
    base = Path(directory); home, providers, versions, old, candidate = make_layout(base)
    env_file = base / 'service.env'; expected = os.stat(candidate, follow_symlinks=False)
    file_identity = os.stat(candidate / 'config.toml'); real_fsync = os.fsync; failed = False
    def fail_file(descriptor):
        global failed
        info = os.fstat(descriptor)
        if not failed and (info.st_dev, info.st_ino) == (file_identity.st_dev, file_identity.st_ino):
            failed = True; raise OSError('synthetic candidate fsync failure')
        return real_fsync(descriptor)
    with patch.object(transaction.os, 'fsync', side_effect=fail_file):
        try: transaction.publish(home, env_file, versions, candidate, expected)
        except OSError: pass
        else: raise AssertionError('candidate fsync failure was reported as committed')
    assert failed and (providers / '.active').resolve() == old.resolve()
`, []);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("provider atomic writes surface parent-directory fsync failures", options, () => {
  const result = runPython(`import os,stat,tempfile
from pathlib import Path
from unittest.mock import patch
import atomic_write as writer
with tempfile.TemporaryDirectory() as directory:
    target = Path(directory) / 'config.toml'; target.write_text('before')
    real_fsync = os.fsync; directory_fsync = False
    def fail_directory(descriptor):
        global directory_fsync
        if stat.S_ISDIR(os.fstat(descriptor).st_mode):
            directory_fsync = True
            raise OSError('synthetic parent fsync failure')
        return real_fsync(descriptor)
    with patch.object(writer.os, 'fsync', side_effect=fail_directory):
        try: writer.atomic_write(target, 'after')
        except OSError: pass
        else: raise AssertionError('parent directory fsync failure was hidden')
    assert directory_fsync
`, []);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("provider transaction strips startup and runtime injection hooks from its child", options, () => {
  const result = runPython(`import os,tempfile
from pathlib import Path
from unittest.mock import patch
import provider_transaction as transaction
with tempfile.TemporaryDirectory() as directory:
    generation = Path(directory)
    hostile = {
        'BASH_ENV':'/tmp/bash-hook', 'ENV':'/tmp/sh-hook',
        'SHELLOPTS':'xtrace', 'BASHOPTS':'extdebug', 'CDPATH':'/tmp',
        'GLOBIGNORE':'*', 'PROMPT_COMMAND':'malicious', 'PS4':'malicious',
        'LD_PRELOAD':'/tmp/inject.so', 'LD_LIBRARY_PATH':'/tmp',
        'NODE_OPTIONS':'--require=/tmp/inject.js', 'NODE_PATH':'/tmp',
        'PYTHONHOME':'/tmp/python', 'PYTHONSTARTUP':'/tmp/start.py',
        'PYTHONINSPECT':'1', 'PYTHONWARNINGS':'error',
        'BASH_FUNC_curl%%':'() { malicious; }', 'GATEWAY_TOKEN':'private',
        'CODEX_HARNESS_WORKER':'hostile',
        'HTTPS_PROXY':'http://proxy.example:8080', 'CUSTOM_MODEL':'fixture-model',
    }
    with patch.dict(os.environ, hostile, clear=True):
        child = transaction._provider_child_environment(generation)
    for key in transaction.CHILD_ENVIRONMENT_BLOCKLIST:
        assert key not in child, key
    for key in ('BASH_FUNC_curl%%', 'GATEWAY_TOKEN', 'CODEX_HARNESS_WORKER'):
        assert key not in child, key
    assert child['HTTPS_PROXY'] == hostile['HTTPS_PROXY']
    assert child['CUSTOM_MODEL'] == hostile['CUSTOM_MODEL']
    assert child['CODEX_HOME'] == str(generation)
    assert child['ENV_FILE'] == str(generation / 'secrets.env')
    assert child['PYTHONPATH'] == str(transaction.MODULE_DIR)
    assert child['PYTHONSAFEPATH'] == '1'
`, []);
  assert.equal(result.status, 0, result.stderr + result.stdout);
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
    const transaction = path.join(providers, "provider_transaction.py");
    const activeName = spawnSync(python, [transaction, "active-name"], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(activeName.status, 0, activeName.stderr);
    assert.equal(activeName.stdout.trim(), path.basename(before.active));
    const stale = spawnSync("bash", [path.join(providers, "openai/setup.sh")], {
      env: { ...env, PROVIDER_EXPECTED_ACTIVE: "generation-stale" }, encoding: "utf8", timeout: 20000,
    });
    assert.notEqual(stale.status, 0);
    assert.equal(realpathSync(path.join(home, "providers/.active")), before.active);
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
    const predecessor = spawnSync(python, [transaction, "predecessor-name"], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(predecessor.status, 0, predecessor.stderr);
    assert.equal(predecessor.stdout.trim(), path.basename(before.active));
    const restored = spawnSync(python, [transaction, "restore-active", predecessor.stdout.trim()], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(restored.status, 0, restored.stderr + restored.stdout);
    assert.equal(realpathSync(path.join(home, "providers/.active")), before.active);
    assert.equal(readFileSync(path.join(home, "config.toml"), "utf8"), before.config);
    const nativeAgain = spawnSync("bash", [path.join(providers, "openai/setup.sh")], { env, encoding: "utf8", timeout: 20000 });
    assert.equal(nativeAgain.status, 0, nativeAgain.stderr + nativeAgain.stdout);
    const reactivate = spawnSync("bash", [path.join(providers, "activate-config.sh"), "custom"], { env, encoding: "utf8", timeout: 20000 });
    assert.equal(reactivate.status, 0, reactivate.stderr + reactivate.stdout);
    assert.match(readFileSync(path.join(home, "config.toml"), "utf8"), /local-model/);
    const bounded = spawnSync("bash", [path.join(providers, "openai/setup.sh")], { env, encoding: "utf8", timeout: 20000 });
    assert.equal(bounded.status, 0, bounded.stderr + bounded.stdout);
    const histories = readdirSync(path.join(home, "providers/.versions")).filter(name => name.startsWith("generation-"));
    assert.equal(histories.length, 4, "active plus three rollback generations must remain");
    assert.ok(histories.some(name => realpathSync(path.join(home, "providers/.active")) === realpathSync(path.join(home, "providers/.versions", name))));
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
