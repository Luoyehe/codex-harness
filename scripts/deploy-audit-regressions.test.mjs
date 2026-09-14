import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
const python = process.env.CODEX_TEST_PYTHON || "python3";
const pythonAvailable = spawnSync(python, ["-c", "import tomllib"], { timeout: 10000, windowsHide: true }).status === 0;
const py = { skip: !pythonAvailable && "Python 3.11+ required" };
const posix = { skip: !pythonAvailable || process.platform !== "linux" ? "Linux Python and unprivileged fixtures required" : false };
const sh = { skip: process.platform === "win32" ? "POSIX Bash required" : false };

function runPython(code, args = []) {
  const result = spawnSync(python, ["-c", code, ...args], { encoding: "utf8", timeout: 20000, windowsHide: true,
    env: { ...process.env, PYTHONPATH: deploy + path.delimiter + path.join(deploy, "providers"), PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

test("cookie canonical URL migration preserves a surviving shared portal and rejects unverifiable external ports", py, () => {
  runPython(`from lifecycle import sync_cookies
config = 'session:\\n  cookies:\\n    - domain: example.com\\n      authelia_url: https://example.com/authelia/ # portal\\n  expiration: 1h\\n'
updated = sync_cookies(config, ['example.com:8443'], True)
assert 'https://example.com:8443/authelia/ # portal' in updated
assert sync_cookies(updated, ['example.com:8443'], True) == updated
assert sync_cookies(config, ['example.com:443', 'example.com:8443'], True) == config
assert sync_cookies(config, ['app.example.com:8443', 'example.com:443'], False) == config
assert sync_cookies(config, ['app.example.com:8443'], False, ['https://example.com/authelia/']) == config
for owned in (True, False):
    try: sync_cookies(config, ['app.example.com:8443'], owned)
    except ValueError as error: assert 'canonical' in str(error)
    else: raise AssertionError('unverified shared portal accepted')
try: sync_cookies(config, ['example.com:8443'], False)
except ValueError as error: assert 'AUTHELIA_CANONICAL_URL' in str(error)
else: raise AssertionError('stale external port accepted')
for bad in ('http://example.com/authelia/', 'https://example.com/other/', 'https://user@example.com/authelia/'):
    try: sync_cookies(config.replace('https://example.com/authelia/', bad), ['example.com:443'], True)
    except ValueError: pass
    else: raise AssertionError('invalid portal accepted')
`);
});

test("Zhipu refresh derives current model and effort and excludes stale replacement credentials", py, () => {
  runPython(`import tempfile,json
from pathlib import Path
from provider_transaction import zhipu_sync_environment
with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    env = {'ZHIPU_MODEL': 'old-model', 'ZHIPU_EFFORT': 'low', 'ZHIPU_KEY': 'old-fixture', 'PROBE_REASONING': '1'}
    (home / 'config.toml').write_text('model_provider="ZAI"\\nmodel="current-model"\\nmodel_reasoning_effort="high"\\n', encoding='utf-8')
    zhipu_sync_environment(home, env)
    assert env == {'ZHIPU_MODEL':'current-model', 'ZHIPU_EFFORT':'high', 'ZHIPU_KEY':'', 'PROBE_REASONING':'0'}
    for mode in ('custom', 'openai'):
        (home / 'config.toml').write_text('model_provider="' + mode + '"\\n', encoding='utf-8')
        try: zhipu_sync_environment(home, {})
        except ValueError: pass
        else: raise AssertionError('stale refresh accepted after provider switch')
`);
});

test("Zhipu transaction checks the provider after locking and refreshes the locked model before setup", posix, () => {
  runPython(`import os,tempfile
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
from contextlib import contextmanager
import provider_transaction as transaction
assert os.geteuid() != 0, 'run deployment fixtures as an unprivileged account'
with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    config = home / 'config.toml'
    config.write_text('model_provider="ZAI"\\nmodel="before-lock"\\nmodel_reasoning_effort="low"\\n')
    @contextmanager
    def changed_lock(home):
        config.write_text('model_provider="custom"\\n')
        yield
    env = {'CODEX_HOME':str(home), 'ENV_FILE':str(home / 'secrets.env'), 'ZHIPU_SYNC_CATALOG':'1', 'CUSTOM_SYNC_CATALOG':'0', 'ZHIPU_MODEL':'old-model'}
    with patch.dict(os.environ, env), patch.object(transaction, 'transaction_lock', changed_lock), patch.object(transaction.subprocess, 'run') as child:
        try: transaction.execute('zhipu', ['fixture-setup'])
        except ValueError: pass
        else: raise AssertionError('provider changed while acquiring lock')
        child.assert_not_called()
    @contextmanager
    def current_lock(home):
        config.write_text('model_provider="ZAI"\\nmodel="after-lock"\\nmodel_reasoning_effort="high"\\n')
        yield
    def setup(command, env, check):
        assert env['ZHIPU_MODEL'] == 'after-lock' and env['ZHIPU_EFFORT'] == 'high'
        assert env['ZHIPU_KEY'] == '' and env['PROBE_REASONING'] == '0'
        return SimpleNamespace(returncode=9)
    with patch.dict(os.environ, env), patch.object(transaction, 'transaction_lock', current_lock), patch.object(transaction.subprocess, 'run', setup):
        assert transaction.execute('zhipu', ['fixture-setup']) == 9
    assert 'after-lock' in config.read_text()
`);
});

test("environment maintenance rejects unapproved aliases and pins a validated generation across directory replacement", posix, () => {
  runPython(`import os,tempfile
from pathlib import Path
from service_env import locked_environment, write_regular, prepare
assert os.geteuid() != 0, 'run deployment fixtures as an unprivileged account'
with tempfile.TemporaryDirectory() as directory:
    base = Path(directory)
    home = base / 'home'; home.mkdir()
    env = home / 'secrets.env'
    other = base / 'unmanaged'; other.mkdir()
    unrelated = other / 'secrets.env'; unrelated.write_text('UNCHANGED=fixture\\n')
    env.symlink_to(unrelated)
    try: prepare(home, env)
    except ValueError: pass
    else: raise AssertionError('unapproved environment alias accepted')
    assert unrelated.read_text() == 'UNCHANGED=fixture\\n'
    env.unlink()
    versions = home / 'providers' / '.versions'; versions.mkdir(parents=True)
    generation = versions / 'generation-fixture'; generation.mkdir()
    (generation / 'secrets.env').write_text('ORIGINAL=fixture\\n')
    (home / 'providers' / '.active').symlink_to('.versions/generation-fixture')
    env.symlink_to('providers/.active/secrets.env')
    with locked_environment(home, env) as (fd, name, text):
        assert text == 'ORIGINAL=fixture\\n'
        moved = versions / 'generation-pinned'
        generation.rename(moved)
        generation.symlink_to(other, target_is_directory=True)
        write_regular(fd, name, text + 'GATEWAY_HTTPS=true\\n')
    assert unrelated.read_text() == 'UNCHANGED=fixture\\n'
    assert (moved / 'secrets.env').read_text().endswith('GATEWAY_HTTPS=true\\n')
    try: prepare(home, env)
    except OSError: pass
    else: raise AssertionError('linked generation directory accepted')
    generation.unlink(); moved.rename(generation)
    (generation / 'secrets.env').unlink(); (generation / 'secrets.env').symlink_to(unrelated)
    try: prepare(home, env)
    except OSError: pass
    else: raise AssertionError('linked secret inode accepted')
`);
});

test("root environment maintenance loads only service supplementary groups before dropping uid", posix, () => {
  runPython(`from unittest.mock import patch
from types import SimpleNamespace
import service_env
events=[]
with patch('os.geteuid', return_value=0), patch('pwd.getpwnam', return_value=SimpleNamespace(pw_uid=1200,pw_gid=1201)), patch('os.initgroups', side_effect=lambda user, gid: events.append(('groups',user,gid))), patch('os.setgid', side_effect=lambda value: events.append(('gid',value))), patch('os.setuid', side_effect=lambda value: events.append(('uid',value))):
    try: service_env.drop_service_privileges('')
    except ValueError: pass
    else: raise AssertionError('root silently selected a filesystem owner')
    service_env.drop_service_privileges('fixture-service')
assert events == [('groups','fixture-service',1201),('gid',1201),('uid',1200)]
with patch('os.geteuid', return_value=0), patch('pwd.getpwnam', return_value=SimpleNamespace(pw_uid=0,pw_gid=0)):
    try: service_env.drop_service_privileges('root')
    except ValueError: pass
    else: raise AssertionError('root service identity accepted')
`);
});

test("provider maintenance rejects root identity before creating or reading service data even with the legacy bypass", posix, () => {
  runPython(`import os,tempfile
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
import provider_transaction as transaction
from service_env import ServiceIdentityError
with tempfile.TemporaryDirectory() as directory:
    home = Path(directory) / 'state-not-created'
    env = {'CODEX_HOME':str(home), 'ENV_FILE':str(home / 'secrets.env'), 'RUN_USER':'root', 'ALLOW_ROOT_SERVICE':'1'}
    with patch.dict(os.environ, env), patch('os.geteuid', return_value=0), patch('pwd.getpwnam', return_value=SimpleNamespace(pw_uid=0,pw_gid=0)), patch.object(transaction, 'environment_file') as environment, patch.object(transaction.subprocess, 'run') as child:
        try: transaction.execute('openai', ['fixture-never-run'])
        except ServiceIdentityError as error: assert 'migrate' in str(error)
        else: raise AssertionError('legacy root bypass accepted')
        environment.assert_not_called()
        child.assert_not_called()
    assert not home.exists()
`);
});

test("installer rejects a root service before package, build, or environment operations even with the legacy bypass", sh, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "install-service-identity-"));
  try {
    const source = readFileSync(path.join(deploy, "install.sh"), "utf8");
    const preflight = source.slice(source.indexOf('INSTALL_DIR="${INSTALL_DIR:-$REPO_ROOT}"'), source.indexOf('\nRUN_HOME="'))
      .replaceAll("/etc/systemd/system/", `${dir}/units/`);
    for (const [account, bypass] of [["root", "0"], ["root", "1"], ["0", "1"]]) {
      const result = spawnSync("bash", ["-c", `set -eu\n${preflight}\nprintf UNEXPECTED_MUTATION\n`], { encoding: "utf8", timeout: 10000,
        env: { ...process.env, REPO_ROOT: dir, SERVICE_NAME: "isolated-fixture", RUN_USER: account, ALLOW_ROOT_SERVICE: bypass } });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /RUN_USER=<account>/);
      assert.match(result.stderr, /no longer bypasses/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function extract(file, name) {
  const source = readFileSync(path.join(deploy, file), "utf8");
  const start = source.indexOf(`\n${name}() {`) + 1;
  assert.ok(start > 0);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}

test("full reinstall rejects another checkout before any stop, cleanup, or deletion", sh, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "reinstall-instance-"));
  try {
    const unit = path.join(dir, "fixture.service");
    const state = path.join(dir, "state");
    mkdirSync(state); writeFileSync(path.join(state, "keep"), "fixture");
    writeFileSync(unit, "WorkingDirectory=/installed-repo/apps/gateway\n");
    const script = `set -eu\nneed_root() { :; }\ndie() { exit 17; }\nlog() { :; }\npython3() { test "$1" = -I; printf '%s\\n' "$4"; }\n${extract("manage.sh", "assert_instance_checkout")}\n${extract("manage.sh", "do_reinstall")}\ndo_install() { echo UNEXPECTED_INSTALL; }\nsafe_tree_target() { echo UNEXPECTED_TARGET; exit 19; }\nsystemctl() { echo UNEXPECTED_SERVICE; }\ndo_reinstall full\n`;
    const result = spawnSync("bash", ["-c", script], { input: "yes\nyes\n", encoding: "utf8", timeout: 10000,
      env: { ...process.env, REPO_ROOT: "/different-repo", SCRIPT_DIR: "/different-repo/deploy", UNIT_FILE: unit, SERVICE_NAME: "fixture", CODEX_HOME: state, ENV_FILE: path.join(state, "secrets.env") } });
    assert.equal(result.status, 17, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(path.join(state, "keep"), "utf8"), "fixture");
    assert.match(readFileSync(unit, "utf8"), /installed-repo/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("edge rollback only changes authentication runtime actually touched by this transaction", sh, () => {
  for (const [created, touched] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const dir = mkdtempSync(path.join(tmpdir(), "edge-rollback-owned-"));
    try {
      const rollback = extract("setup-edge.sh", "rollback").replaceAll("/etc/systemd/system/", `${dir}/units/`);
      const script = `set -eu\nlog() { :; }\nsystemctl_do() { printf '%s\\n' "$*"; }\npython3() { :; }\nwait_authelia() { :; }\n${rollback}\nrollback 23\n`;
      const env = { ...process.env, RB_DIR: path.join(dir, "rollback"), TMPD: path.join(dir, "temporary"), CADDY_FILE: path.join(dir, "Caddyfile"), AUTHELIA_DIR: path.join(dir, "auth"), AUTH_DROPIN: path.join(dir, "dropin/config"), AUTH_INITIAL: path.join(dir, "initial"), EDGE_STATE: path.join(dir, "edge.json"), CODEX_HOME: dir, ENV_FILE: path.join(dir, "secrets.env"), SCRIPT_DIR: deploy, AUTHELIA_UNIT: "external-auth", GATEWAY_UNIT: "fixture", RB_NEW_CADDY: "1", RB_NEW_AUTH_CONF: "1", RB_NEW_AUTH_USERS: "1", RB_NEW_AUTH_UNIT: "1", RB_NEW_AUTH_DROPIN: "1", RB_NEW_AUTH_INITIAL: "1", RB_NEW_EDGE_STATE: "1", GATEWAY_RUNTIME_TOUCHED: "0", AUTH_UNIT_CREATED: String(created), AUTH_RUNTIME_TOUCHED: String(touched), RB_AUTH_WAS_ENABLED: "1", RB_AUTH_WAS_ACTIVE: "1" };
      const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 10000, env });
      assert.equal(result.status, 23, result.stderr);
      if (!touched) assert.ok(!result.stdout.includes("external-auth"), result.stdout);
      else if (created) assert.match(result.stdout, /disable --now external-auth/);
      else { assert.match(result.stdout, /enable external-auth/); assert.match(result.stdout, /restart external-auth/); assert.ok(!result.stdout.includes("disable --now")); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
