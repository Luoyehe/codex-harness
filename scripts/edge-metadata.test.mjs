import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertLocalMediaCsp } from "./csp-policy.mjs";
const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
const python = process.env.CODEX_TEST_PYTHON || "python3";
const options = { skip: spawnSync(python, ["-c", "import sys; assert sys.version_info >= (3,11)"], { windowsHide: true }).status !== 0 && "Python 3.11+ required" };
const bash = process.env.CODEX_TEST_BASH || "bash";
const bashOptions = { skip: spawnSync(bash, ["--version"], { windowsHide: true }).status !== 0 && "Bash required" };
const rootLinuxOptions = {
  skip: options.skip || (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0) && "Linux root required",
};
test("root edge metadata rejects linked, non-regular or worker-controlled configuration before mutation", options, () => {
  const result = spawnSync(python, ["-c", `import stat
from types import SimpleNamespace as S
from edge_metadata import checked_file, checked_configuration
def trusted(path, **kwargs): return path
def info(mode=stat.S_IFREG|0o640, uid=0, links=1): return S(st_mode=mode, st_uid=uid, st_nlink=links)
assert checked_file('/etc/auth/configuration.yml', validate_path=trusted, lstat_fn=lambda p: info()) == '/etc/auth/configuration.yml'
for bad in (info(stat.S_IFLNK|0o777), info(uid=1001), info(links=2), info(stat.S_IFREG|0o660), info(stat.S_IFIFO|0o600)):
    try: checked_file('/etc/auth/configuration.yml', validate_path=trusted, lstat_fn=lambda p: bad)
    except ValueError: pass
    else: raise AssertionError('unsafe metadata path accepted')
seen=[]
def reject(path, **kwargs):
    seen.append(path)
    raise ValueError('untrusted ancestor')
try: checked_configuration('/etc/auth', validate_path=reject, lstat_fn=lambda p: (_ for _ in ()).throw(AssertionError('read before ancestry check')))
except ValueError: pass
assert seen == ['/etc/auth']
for broad in ('/', '/etc', '/var', '/var/lib', '/usr', '/usr/local', '/home', '/root', '/tmp', '/run', '/srv', '/opt'):
    try: checked_configuration(broad, validate_path=trusted, lstat_fn=lambda p: info())
    except ValueError: pass
    else: raise AssertionError('broad directory accepted for chmod/chown')
`], { encoding: "utf8", windowsHide: true, timeout: 10000, env: { ...process.env, PYTHONPATH: deploy, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, result.stderr);
});
test("Authelia mutable state is provisioned with descriptors and migration runs after permanent privilege drop", () => {
  const source = readFileSync(new URL("../deploy/setup-edge.sh", import.meta.url), "utf8");
  assert.ok(!/install -d -o authelia|chown authelia:authelia|install -o authelia/.test(source));
  assert.match(source, /service_directory\.py" authelia "\$AUTHELIA_STATE_DIR" --private/);
  const migration = readFileSync(new URL("../deploy/edge_state.py", import.meta.url), "utf8");
  assert.ok(migration.indexOf('drop_service_privileges("authelia")') < migration.indexOf("migrate(args."));
});

test("the public edge keeps the gateway's local-only image and media CSP", () => {
  const source = readFileSync(new URL("../deploy/setup-edge.sh", import.meta.url), "utf8");
  const policy = source.match(/Content-Security-Policy "([^"]+)"/)?.[1];
  assertLocalMediaCsp(policy);
  const connect = policy.split(";").map((part) => part.trim().split(/\s+/))
    .find(([name]) => name === "connect-src")?.slice(1);
  assert.deepEqual(connect, ["'self'", "wss://{http.request.host}"]);
  assert.ok(!connect.includes("ws:") && !connect.includes("wss:"));
});

test("privileged inline Python never imports modules from the caller directory", () => {
  const source = readFileSync(new URL("../deploy/setup-edge.sh", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bpython3 (?:-c|- )/);
  assert.doesNotMatch(source, /\bpython3 (?!-I )"\$SCRIPT_DIR\/(?:edge_env|lifecycle|authelia_hash)\.py"/);
});

test("the root edge-environment launcher isolates Python and passes a minimal worker environment", options, () => {
  const result = spawnSync(python, ["-c", `import os,sys
from types import SimpleNamespace as S
from unittest.mock import patch
import edge_env
account=S(pw_dir='/srv/codex-worker',pw_name='codex-worker')
child=S(returncode=0,stdout='null')
with patch.dict(os.environ,{'RUN_USER':'codex-worker','PYTHONPATH':'hostile','PYTHONHOME':'hostile','NODE_OPTIONS':'--inspect','LD_PRELOAD':'hostile','GATEWAY_TOKEN':'private'},clear=False), patch.object(edge_env.os,'geteuid',return_value=0,create=True), patch.object(edge_env,'service_account',return_value=account), patch.object(edge_env.subprocess if hasattr(edge_env,'subprocess') else __import__('subprocess'),'run',return_value=child) as run:
    with patch.object(sys,'argv',['edge_env.py','/srv/codex-worker/data','/srv/codex-worker/secrets.env','set','app.example.com']):
        edge_env.main()
call=run.call_args
argv=call.args[0]; environment=call.kwargs['env']
assert argv[1]=='-I' and argv[-2:]==['--worker','codex-worker'], repr(argv)
assert environment=={'HOME':'/srv/codex-worker','USER':'codex-worker','LOGNAME':'codex-worker','PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8'}, repr(environment)
for key in ('PYTHONPATH','PYTHONHOME','NODE_OPTIONS','LD_PRELOAD','GATEWAY_TOKEN'):
    assert key not in environment
`], { encoding: "utf8", windowsHide: true, timeout: 10000,
    env: { ...process.env, PYTHONPATH: deploy, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, result.stderr);
});

test("initial plaintext password must stay root-private while Authelia configuration may be group-readable", options, () => {
  const result = spawnSync(python, ["-c", `import stat
from types import SimpleNamespace as S
from edge_metadata import checked_configuration
def trusted(path, **kwargs): return path
def info(mode): return S(st_mode=stat.S_IFREG|mode, st_uid=0, st_nlink=1)
for password_mode in (0o600, 0o400):
    assert checked_configuration('/etc/auth', validate_path=trusted,
        lstat_fn=lambda p: info(password_mode if p.endswith('/initial-password') else 0o640)) == '/etc/auth'
for password_mode in (0o640, 0o644, 0o604, 0o610, 0o601):
    try:
        checked_configuration('/etc/auth', validate_path=trusted,
            lstat_fn=lambda p: info(password_mode if p.endswith('/initial-password') else 0o640))
    except ValueError: pass
    else: raise AssertionError('non-private initial password accepted: ' + oct(password_mode))
`], { encoding: "utf8", windowsHide: true, timeout: 10000, env: { ...process.env, PYTHONPATH: deploy, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, result.stderr);
});
test("unprivileged state migration includes committed WAL data, copies notifications atomically, and refuses unsafe sources", {
  skip: options.skip || (process.platform !== "linux" && "Linux ownership and no-follow descriptors required"),
}, () => {
  const result = spawnSync(python, ["-c", `import os, pathlib, sqlite3, tempfile
from unittest.mock import patch
import edge_state as m
with tempfile.TemporaryDirectory() as root:
    service_uid = os.geteuid()
    assert service_uid != 0
    source = pathlib.Path(root) / 'source.sqlite3'
    target = pathlib.Path(root) / 'target.sqlite3'
    db = sqlite3.connect(source)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE fixture(value TEXT)')
    db.execute("INSERT INTO fixture VALUES ('committed-wal')")
    db.commit()
    with patch.object(m.os, 'geteuid', return_value=service_uid, create=True), patch.object(m, 'ensure') as ensure:
        m.migrate('database', str(source), str(target))
        ensure.assert_called_once_with(root, private=True)
    copied = sqlite3.connect(target)
    assert copied.execute('SELECT value FROM fixture').fetchone() == ('committed-wal',)
    copied.close()
    target_main = target.read_bytes()
    for suffix in ('-wal', '-shm'):
        pathlib.Path(str(target) + suffix).write_bytes(('old-target' + suffix).encode())
    with patch.object(m.os, 'geteuid', return_value=service_uid, create=True), patch.object(m, 'ensure'), patch.object(m, '_migrate_database', side_effect=RuntimeError('publication fixture')):
        try: m.migrate('database', str(source), str(target))
        except RuntimeError: pass
        else: raise AssertionError('database migration failure fixture did not fail')
    assert target.read_bytes() == target_main
    for suffix in ('-wal', '-shm'):
        assert pathlib.Path(str(target) + suffix).read_bytes() == ('old-target' + suffix).encode()
    with patch.object(m.os, 'geteuid', return_value=service_uid, create=True), patch.object(m, 'ensure'):
        m.migrate('database', str(source), str(target))
    for suffix in ('-wal', '-shm'):
        assert not pathlib.Path(str(target) + suffix).exists()
    db.close()
    notification = pathlib.Path(root) / 'old-notification'
    notification.write_text('synthetic-notification', encoding='utf-8')
    destination = pathlib.Path(root) / 'new-notification'
    destination.write_text('previous', encoding='utf-8')
    with patch.object(m.os, 'geteuid', return_value=service_uid, create=True), patch.object(m, 'ensure'):
        m.migrate('notification', str(notification), str(destination))
    assert destination.read_text() == 'synthetic-notification'
    unsafe_target = pathlib.Path(root) / 'unsafe-target'
    unsafe_target.write_text('unsafe', encoding='utf-8')
    symlink = pathlib.Path(root) / 'notification-symlink'
    symlink.symlink_to(unsafe_target)
    hardlink = pathlib.Path(root) / 'notification-hardlink'
    os.link(unsafe_target, hardlink)
    fifo = pathlib.Path(root) / 'notification-fifo'
    os.mkfifo(fifo)
    oversized = pathlib.Path(root) / 'notification-oversized'
    with oversized.open('wb') as stream: stream.truncate(m.NOTIFICATION_LIMIT + 1)
    for unsafe in (symlink, hardlink, fifo, oversized):
        with patch.object(m.os, 'geteuid', return_value=service_uid, create=True), patch.object(m, 'ensure'):
            try: m.migrate('notification', str(unsafe), str(destination))
            except ValueError: pass
            else: raise AssertionError('unsafe state source accepted: ' + unsafe.name)
        assert destination.read_text() == 'synthetic-notification'
    original_copy = m._copy_pinned
    def mutate_after_copy(source, target_fd, deadline):
        copied = original_copy(source, target_fd, deadline)
        with notification.open('ab') as changed: changed.write(b'-changed')
        return copied
    notification.write_text('stable-before-copy', encoding='utf-8')
    with patch.object(m.os, 'geteuid', return_value=service_uid, create=True), patch.object(m, 'ensure'), patch.object(m, '_copy_pinned', side_effect=mutate_after_copy):
        try: m.migrate('notification', str(notification), str(destination))
        except ValueError: pass
        else: raise AssertionError('source mutation after copy was accepted')
    assert destination.read_text() == 'synthetic-notification'
    with patch.object(m.os, 'geteuid', return_value=0, create=True), patch.object(m, 'ensure', side_effect=AssertionError('root entered state tree')):
        try: m.migrate('notification', str(notification), str(destination))
        except ValueError: pass
        else: raise AssertionError('root migration accepted')
    assert not list(pathlib.Path(root).glob('.edge-migration-*'))
`], { encoding: "utf8", windowsHide: true, timeout: 10000, env: { ...process.env, PYTHONPATH: deploy, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, result.stderr);
});

test("state migration uses pinned bounded descriptors and a private SQLite snapshot", () => {
  const source = readFileSync(new URL("../deploy/edge_state.py", import.meta.url), "utf8");
  for (const contract of ["O_NOFOLLOW", "O_NONBLOCK", "st_nlink != 1", "NOTIFICATION_LIMIT", "DATABASE_LIMIT",
    "WAL_LIMIT", "SHM_LIMIT", "_revalidate", "edge-db-source-", "mode=ro", "quick_check", "_fsync_parent"]) {
    assert.ok(source.includes(contract), contract);
  }
  assert.doesNotMatch(source, /shutil\.copyfileobj|Path\(source_path\)\.absolute\(\)\.as_uri/);
});

test("root edge state loading is bounded, no-follow, duplicate-safe and stable across pathname races", rootLinuxOptions, () => {
  const result = spawnSync(python, ["-c", `import json, os, pathlib, tempfile
from unittest.mock import patch
import edge_metadata as m

def trusted(path, **kwargs): return path
def rejected(call, message):
    try: call()
    except (OSError, UnicodeError, ValueError, RuntimeError, json.JSONDecodeError): pass
    else: raise AssertionError(message)

with tempfile.TemporaryDirectory() as root:
    root = pathlib.Path(root)
    state = root / 'edge.json'
    state.write_text('{"CADDY_FILE":"/etc/caddy/Caddyfile","AUTHELIA_UNIT":"auth"}', encoding='utf-8')
    os.chmod(state, 0o600)
    assert m.read_state(str(state), validate_path=trusted)['AUTHELIA_UNIT'] == 'auth'

    ordinary = root / 'ordinary'
    ordinary.write_text('{}', encoding='utf-8'); os.chmod(ordinary, 0o600)
    linked = root / 'linked'; linked.symlink_to(ordinary)
    hard = root / 'hard'; os.link(ordinary, hard)
    fifo = root / 'fifo'; os.mkfifo(fifo)
    oversized = root / 'oversized'
    with oversized.open('wb') as stream: stream.truncate(m.STATE_LIMIT + 1)
    os.chmod(oversized, 0o600)
    for unsafe in (linked, hard, fifo, oversized):
        rejected(lambda unsafe=unsafe: m.read_state(str(unsafe), validate_path=trusted), 'unsafe edge state accepted: ' + unsafe.name)

    replacement = root / 'replacement'
    replacement.write_text('{"CADDY_FILE":"/etc/caddy/replaced"}', encoding='utf-8')
    os.chmod(replacement, 0o600)
    real_read = m.os.read
    swapped = [False]
    def replace_during_read(descriptor, size):
        data = real_read(descriptor, size)
        if data and not swapped[0]:
            swapped[0] = True
            os.replace(replacement, state)
        return data
    with patch.object(m.os, 'read', side_effect=replace_during_read):
        rejected(lambda: m.read_state(str(state), validate_path=trusted), 'pathname replacement during read accepted')

    for malformed in (
        '{"CADDY_FILE":"/a","CADDY_FILE":"/b"}',
        '{"UNKNOWN":"value"}',
        '{"CADDY_FILE":"bad\\nvalue"}',
    ):
        state.write_text(malformed, encoding='utf-8'); os.chmod(state, 0o600)
        rejected(lambda: m.read_state(str(state), validate_path=trusted), 'malformed edge state accepted')
`], { encoding: "utf8", windowsHide: true, timeout: 10000, env: { ...process.env, PYTHONPATH: deploy, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, result.stderr);
});

test("managed TLS import rejects unsafe sources, preserves the published pair, and supports repair and rollback", rootLinuxOptions, () => {
  const result = spawnSync(python, ["-c", `import os, pathlib, stat, tempfile
from unittest.mock import patch
import edge_tls as m

def rejected(call, message):
    try: call()
    except (OSError, ValueError): pass
    else: raise AssertionError(message)

with tempfile.TemporaryDirectory() as root:
    root = pathlib.Path(root)
    source = root / 'source'; source.mkdir()
    target = root / 'managed'; target.mkdir(); os.chmod(target, 0o750)
    uid, gid = os.geteuid(), os.getegid()
    cert = source / 'cert.pem'; key = source / 'key.pem'
    cert.write_text('cert-v1', encoding='utf-8'); os.chmod(cert, 0o644)
    key.write_text('key-v1', encoding='utf-8'); os.chmod(key, 0o600)
    m.install_pair(str(cert), str(key), str(target), uid, gid)
    assert (target / 'cert.pem').read_text() == 'cert-v1'
    assert (target / 'key.pem').read_text() == 'key-v1'
    assert stat.S_IMODE((target / 'cert.pem').stat().st_mode) == 0o644
    assert stat.S_IMODE((target / 'key.pem').stat().st_mode) == 0o640
    before = ((target / 'cert.pem').read_bytes(), (target / 'key.pem').read_bytes())

    ordinary = source / 'ordinary'; ordinary.write_text('unsafe', encoding='utf-8'); os.chmod(ordinary, 0o644)
    linked = source / 'linked'; linked.symlink_to(ordinary)
    hard = source / 'hard'; os.link(ordinary, hard)
    fifo = source / 'fifo'; os.mkfifo(fifo)
    oversized = source / 'oversized'
    with oversized.open('wb') as stream: stream.truncate(m.CERT_LIMIT + 1)
    os.chmod(oversized, 0o644)
    for unsafe in (linked, hard, fifo, oversized):
        rejected(lambda unsafe=unsafe: m.install_pair(str(unsafe), str(key), str(target), uid, gid), 'unsafe TLS source accepted: ' + unsafe.name)
        assert ((target / 'cert.pem').read_bytes(), (target / 'key.pem').read_bytes()) == before

    os.chmod(key, 0o644)
    rejected(lambda: m.install_pair(str(cert), str(key), str(target), uid, gid), 'world-readable private key accepted')
    os.chmod(key, 0o600)
    assert ((target / 'cert.pem').read_bytes(), (target / 'key.pem').read_bytes()) == before

    # A rerun repairs an interrupted first publication that left one safe name.
    (target / 'key.pem').unlink()
    stale = target / ('.key.pem.' + 'a' * 32 + '.tmp')
    stale.write_text('interrupted-key', encoding='utf-8'); os.chmod(stale, 0o600)
    cert.write_text('cert-v2', encoding='utf-8')
    key.write_text('key-v2', encoding='utf-8')
    m.install_pair(str(cert), str(key), str(target), uid, gid)
    assert not stale.exists()
    assert (target / 'cert.pem').read_text() == 'cert-v2'
    assert (target / 'key.pem').read_text() == 'key-v2'
    stable = ((target / 'cert.pem').read_bytes(), (target / 'key.pem').read_bytes())

    original_copy = m._copy_pinned
    def replace_after_copy(item, target_fd):
        copied = original_copy(item, target_fd)
        if item[3] == str(cert):
            replacement = source / 'replacement'
            replacement.write_text('cert-replaced', encoding='utf-8'); os.chmod(replacement, 0o644)
            os.replace(replacement, cert)
        return copied
    with patch.object(m, '_copy_pinned', side_effect=replace_after_copy):
        rejected(lambda: m.install_pair(str(cert), str(key), str(target), uid, gid), 'TLS pathname replacement accepted')
    assert ((target / 'cert.pem').read_bytes(), (target / 'key.pem').read_bytes()) == stable

    backup = root / 'backup'
    m.snapshot_pair(str(target), str(backup), uid, gid)
    assert stat.S_IMODE(backup.stat().st_mode) == 0o700
    assert stat.S_IMODE((backup / 'cert.pem').stat().st_mode) == 0o600
    assert stat.S_IMODE((backup / 'key.pem').stat().st_mode) == 0o600
    (target / 'cert.pem').write_text('tampered', encoding='utf-8')
    m.install_pair(str(backup / 'cert.pem'), str(backup / 'key.pem'), str(target), uid, gid)
    assert ((target / 'cert.pem').read_bytes(), (target / 'key.pem').read_bytes()) == stable
    m.remove_pair(str(target), uid, gid)
    assert not target.exists()
`], { encoding: "utf8", windowsHide: true, timeout: 15000, env: { ...process.env, PYTHONPATH: deploy, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, result.stderr);
});

test("legacy database and notification migration stops an active unit exactly once and failure restores runtime", bashOptions, () => {
  const setup = readFileSync(new URL("../deploy/setup-edge.sh", import.meta.url), "utf8");
  const match = setup.match(/migrate_legacy_auth_state\(\) \{[\s\S]*?\n\}\n\n# --- 1\./);
  assert.ok(match, "migration function not found");
  const migrationFunction = match[0].replace(/\n\n# --- 1\.$/, "");
  const run = (caseName, failKind = "") => spawnSync(bash, ["-c", `set -euo pipefail
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
AUTHELIA_DIR="$fixture/auth"
AUTHELIA_STATE_DIR="$fixture/state"
AUTHELIA_UNIT=fixture-auth
AUTHELIA_BIN=/bin/true
SCRIPT_DIR=/fixture
RB_AUTH_WAS_ACTIVE=1
AUTH_RUNTIME_TOUCHED=0
mkdir -p "$AUTHELIA_DIR" "$AUTHELIA_STATE_DIR"
case "$CASE_NAME" in
  notification)
    printf notice > "$AUTHELIA_DIR/notification.txt"
    printf 'filename: %s/notification.txt\n' "$AUTHELIA_DIR" > "$AUTHELIA_DIR/configuration.yml"
    ;;
  both|failure)
    printf database > "$AUTHELIA_DIR/db.sqlite3"
    printf notice > "$AUTHELIA_DIR/notification.txt"
    printf 'path: %s/db.sqlite3\nfilename: %s/notification.txt\n' "$AUTHELIA_DIR" "$AUTHELIA_DIR" > "$AUTHELIA_DIR/configuration.yml"
    ;;
esac
log() { :; }
systemctl_do() { printf 'systemctl:%s\n' "$*"; }
python3() {
  printf 'migrate:%s\n' "$3"
  [ -z "$FAIL_KIND" ] || [ "$FAIL_KIND" != "$3" ]
}
rollback() {
  printf 'rollback:touched=%s:active=%s\n' "$AUTH_RUNTIME_TOUCHED" "$RB_AUTH_WAS_ACTIVE"
  if [ "$AUTH_RUNTIME_TOUCHED" = 1 ] && [ "$RB_AUTH_WAS_ACTIVE" = 1 ]; then
    systemctl_do restart "$AUTHELIA_UNIT"
  fi
  exit 73
}
${migrationFunction}
migrate_legacy_auth_state
printf 'done:touched=%s\n' "$AUTH_RUNTIME_TOUCHED"
`], { encoding: "utf8", windowsHide: true, timeout: 10000, env: { ...process.env, CASE_NAME: caseName, FAIL_KIND: failKind } });

  for (const caseName of ["notification", "both"]) {
    const result = run(caseName);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout.match(/^systemctl:stop fixture-auth$/gm) || []).length, 1, result.stdout);
    assert.match(result.stdout, /migrate:notification/);
    if (caseName === "both") assert.match(result.stdout, /migrate:database/);
  }
  const failed = run("failure", "notification");
  assert.equal(failed.status, 73, failed.stderr);
  assert.equal((failed.stdout.match(/^systemctl:stop fixture-auth$/gm) || []).length, 1, failed.stdout);
  assert.equal((failed.stdout.match(/^systemctl:restart fixture-auth$/gm) || []).length, 1, failed.stdout);
  assert.match(failed.stdout, /rollback:touched=1:active=1/);
});

test("setup-edge uses only managed TLS paths and bounded HTTPS downloads", () => {
  const setup = readFileSync(new URL("../deploy/setup-edge.sh", import.meta.url), "utf8");
  assert.match(setup, /CERT_LINE="tls \$\{MANAGED_TLS_DIR\}\/cert\.pem \$\{MANAGED_TLS_DIR\}\/key\.pem"/);
  assert.doesNotMatch(setup, /CERT_LINE="tls \$CERT_Q \$KEY_Q"/);
  for (const command of ["install", "snapshot", "restore", "remove"]) {
    assert.match(setup, new RegExp(`edge_tls\\.py\\" ${command}`));
  }
  const downloader = setup.match(/download_https\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  for (const option of ["--proto '=https'", "--proto-redir '=https'", "--connect-timeout 10", "--max-time 120", "--retry 2", "--retry-max-time 180", "--max-filesize"]) {
    assert.ok(downloader.includes(option), option);
  }
  assert.match(setup, /download_https 'https:\/\/dl\.cloudsmith\.io\/public\/caddy\/stable\/gpg\.key'/);
  assert.match(setup, /download_https 'https:\/\/dl\.cloudsmith\.io\/public\/caddy\/stable\/debian\.deb\.txt'/);
  assert.match(setup, /download_https "\$RELEASE_URL\/\$ARCHIVE"/);
  assert.match(setup, /download_https "\$RELEASE_URL\/\$ARCHIVE\.sha256"/);
});

test("bounded HTTPS download propagates curl failure instead of accepting a partial file", bashOptions, () => {
  const setup = readFileSync(new URL("../deploy/setup-edge.sh", import.meta.url), "utf8");
  const downloader = setup.match(/download_https\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(downloader);
  const result = spawnSync(bash, ["-c", `set -eu
curl() { return 17; }
stat() { echo UNEXPECTED_STAT >&2; return 0; }
${downloader}
if download_https https://fixture.invalid /tmp/unused-download 1024; then
  exit 99
fi
`], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /UNEXPECTED_STAT/);
});

test("edge state is loaded only under the root lock and TLS/state helpers retain final-path checks", () => {
  const setup = readFileSync(new URL("../deploy/setup-edge.sh", import.meta.url), "utf8");
  assert.doesNotMatch(setup.slice(0, setup.indexOf("load_saved_edge_state()")), /EDGE_SAVED|python3 -I - "\$EDGE_STATE"/);
  assert.match(setup, /lock_edge\n  load_saved_edge_state\n  validate_edge_values\n  check_edge_paths/);
  assert.match(setup, /lock_edge\nload_saved_edge_state\nvalidate_edge_values\ncheck_edge_paths/);
  const metadata = readFileSync(new URL("../deploy/edge_metadata.py", import.meta.url), "utf8");
  for (const contract of ["STATE_LIMIT", "O_NOFOLLOW", "O_NONBLOCK", "st_nlink != 1", "_state_metadata", "object_pairs_hook", "os.lstat(path)"]) {
    assert.ok(metadata.includes(contract), contract);
  }
  const state = readFileSync(new URL("../deploy/edge_state.py", import.meta.url), "utf8");
  assert.ok((state.match(/os\.lstat\(source_path\)/g) || []).length >= 3);
  assert.ok(state.indexOf("os.replace(temporary, target_path)") < state.indexOf("os.unlink(target_path + suffix)"));
  const tls = readFileSync(new URL("../deploy/edge_tls.py", import.meta.url), "utf8");
  for (const contract of ["CERT_LIMIT", "KEY_LIMIT", "O_NOFOLLOW", "O_NONBLOCK", "st_nlink != 1", "_revalidate", "os.lstat(path)", "IncompletePairError", "_remove_stale_temporaries", "0o644", "0o640", "0o750"]) {
    assert.ok(tls.includes(contract), contract);
  }
});
