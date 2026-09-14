import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
const python = process.env.CODEX_TEST_PYTHON || "python3";
const pythonAvailable = spawnSync(python, ["-c", "import sys; assert sys.version_info >= (3,11)"], { windowsHide: true }).status === 0;
const py = { skip: pythonAvailable ? false : "Python 3.11+ required" };
function run(code, args = []) {
  const result = spawnSync(python, ["-c", code, ...args], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
    env: { ...process.env, PYTHONPATH: deploy, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(result.status, 0, result.stderr);
}

test("trusted paths validate the original entrance and every link hop before canonical publication", py, () => {
  run(`from trusted_paths import trusted_path, control_path
from pathlib import PurePosixPath
from types import SimpleNamespace
from unittest.mock import patch
import stat
def directory(uid=0, mode=0o755): return SimpleNamespace(st_uid=uid, st_mode=stat.S_IFDIR|mode)
def regular(uid=0, mode=0o755): return SimpleNamespace(st_uid=uid, st_mode=stat.S_IFREG|mode)
def link(uid=0): return SimpleNamespace(st_uid=uid, st_mode=stat.S_IFLNK|0o777)
entries = {"/": directory(), "/opt": directory(), "/opt/app": directory(), "/opt/app/main": regular(),
    "/opt/alias": link(), "/opt/npm": directory(), "/opt/npm/bin": directory(), "/opt/npm/bin/codex": link(),
    "/opt/npm/lib": directory(), "/opt/npm/lib/cli.js": regular(), "/home": directory(),
    "/home/worker": directory(1000), "/home/worker/link": link(), "/opt/via-worker": link(),
    "/opt/unowned-link": link(1000), "/opt/group": directory(0,0o775), "/opt/group/alias": link(),
    "/opt/control": directory(1001,0o700)}
links = {"/opt/alias": "/opt/app", "/opt/npm/bin/codex": "../lib/cli.js", "/home/worker/link": "/opt/app",
    "/opt/via-worker": "/home/worker/link", "/opt/unowned-link": "/opt/app", "/opt/group/alias": "/opt/app"}
def metadata(value):
    try: return entries[str(value)]
    except KeyError: raise FileNotFoundError(str(value)) from None
with patch("trusted_paths.os.lstat", side_effect=metadata), patch("trusted_paths.os.readlink", side_effect=lambda value: links[str(value)]):
    assert trusted_path("/opt/alias", directory=True) == "/opt/app"
    assert trusted_path("/opt/alias/main") == "/opt/app/main"
    assert trusted_path("/opt/npm/bin/codex") == "/opt/npm/lib/cli.js"
    assert trusted_path("/opt/new/bin", directory=True, missing=True) == "/opt/new/bin"
    assert control_path("/opt/control") == "/opt/control"
    assert control_path("/opt/new/control") == "/opt/new/control"
    for value in ("/home/worker/link/main", "/opt/via-worker/main", "/opt/unowned-link/main", "/opt/group/alias/main", "/opt/../opt/app/main", "relative", "//opt/app/main", "/"):
        try: trusted_path(value)
        except ValueError: pass
        else: raise AssertionError("untrusted entrance accepted: " + value)
    for value in ("/home/worker/new", "/opt/alias", "/opt/../control"):
        try: control_path(value)
        except ValueError: pass
        else: raise AssertionError("unsafe control home accepted: " + value)
`);
});

test("root directory bootstrap never changes existing inodes or writes below an untrusted ancestor", py, () => {
  run(`import service_directory as m
from pathlib import PurePosixPath
from types import SimpleNamespace
from unittest.mock import patch
import stat
def info(uid, mode=0o755): return SimpleNamespace(st_uid=uid, st_mode=stat.S_IFDIR|mode)
def check(entries, target):
    descriptors, writes = {}, []
    serial = 20
    def opened(name, flags, dir_fd=None):
        nonlocal serial
        value = str(PurePosixPath(descriptors[dir_fd]) / name) if dir_fd is not None else name
        if value not in entries: raise FileNotFoundError(value)
        if entries[value] == "link": raise OSError("no-follow rejected symlink")
        serial += 1; descriptors[serial] = value
        return serial
    def mkdir(name, mode, dir_fd):
        value = str(PurePosixPath(descriptors[dir_fd]) / name)
        writes.append(("mkdir", value, mode)); entries[value] = info(0, mode)
    def chown(fd, uid, gid):
        writes.append(("chown", descriptors[fd], uid)); entries[descriptors[fd]].st_uid = uid
    with patch.object(m.os, "open", side_effect=opened), patch.object(m.os, "close"), patch.object(m.os, "fstat", side_effect=lambda fd: entries[descriptors[fd]]), patch.object(m.os, "mkdir", side_effect=mkdir), patch.object(m.os, "fchown", side_effect=chown, create=True), patch.object(m.os, "fchmod", side_effect=lambda fd,mode: writes.append(("chmod", descriptors[fd], mode)), create=True):
        m.bootstrap(target,1000,1000)
    return writes
base = {"/": info(0), "/var": info(0), "/var/lib": info(0), "/var/lib/worker": info(1000)}
assert check(dict(base), "/var/lib/worker/new/home") == []
assert check({**base, "/var/lib/worker/existing": info(1000)}, "/var/lib/worker/existing") == []
assert check({"/":info(0), "/tmp":info(0,0o1777)}, "/tmp/new") == []
assert check({"/":info(0), "/var":info(0)}, "/var/new/home") == [
    ("mkdir","/var/new",0o755),("mkdir","/var/new/home",0o700),("chown","/var/new/home",1000),("chmod","/var/new/home",0o700)]
try: check({**base,"/var/lib/worker/alias":"link"}, "/var/lib/worker/alias")
except OSError: pass
else: raise AssertionError("symbolic directory accepted")
`);
});

test("service directory CLI preserves isolated sibling imports and creates data only as its non-root owner", { skip: process.platform !== "linux" || !pythonAvailable }, () => {
  assert.notEqual(process.getuid(), 0, "run deployment permission fixtures as a non-root account");
  const dir = mkdtempSync(path.join(tmpdir(), "service-directory-cli-"));
  try {
    // An adjacent hostile import must not shadow the trusted sibling under -I.
    writeFileSync(path.join(dir, "service_env.py"), 'raise AssertionError("ambient module imported")\n');
    run(`import os, pathlib, pwd, subprocess, sys
root=pathlib.Path(sys.argv[1]); deploy=pathlib.Path(sys.argv[2]); user=pwd.getpwuid(os.geteuid()).pw_name
home=root/"data"/"home"
environment={"HOME":str(root),"PATH":"/usr/bin:/bin","PYTHONPATH":str(root),"PYTHONDONTWRITEBYTECODE":"1"}
result=subprocess.run([sys.executable,"-I",str(deploy/"service_directory.py"),user,str(home),"--worker","--private"],cwd=root,env=environment,capture_output=True,text=True)
assert result.returncode==0,result.stderr
assert home.stat().st_uid==os.geteuid() and home.stat().st_mode&0o777==0o700
assert not (root/"__pycache__").exists()
`, [dir, deploy]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("installer and registration wire trusted canonical paths before root execution and never chmod worker paths", () => {
  const install = readFileSync(path.join(deploy, "install.sh"), "utf8");
  const register = readFileSync(path.join(deploy, "register-service.sh"), "utf8");
  assert.ok(install.indexOf('trusted_paths.py" tree') < install.indexOf('"$NODE_BIN" -p'));
  assert.ok(install.indexOf('trusted_paths.py" tree') < install.indexOf('"$PNPM_BIN" install --frozen-lockfile'));
  assert.ok(install.includes('python3 -I "$SCRIPT_DIR/service_directory.py" "$RUN_USER" "$path"'));
  assert.ok(!install.includes('$SUDO chmod 700 "$CODEX_HOME"'));
  assert.ok(!install.includes('install -d -o "$RUN_USER"'));
  for (const name of ["INSTALL_DIR", "NODE_BIN", "BIN_DIR", "GATEWAY_CONTROL_HOME"]) {
    assert.match(register, new RegExp(`${name}="\\$\\(python3 -I "\\$SCRIPT_DIR/trusted_paths.py"`));
  }
  assert.ok(register.includes('SERVICE_PATH="$CODEX_BIN_DIR:$NODE_BIN_DIR:'));
  assert.ok(register.includes('Environment=NODE_BIN_DIR=$NODE_BIN_DIR'));
  assert.ok(register.includes('exec /bin/bash "$INSTALL_DIR/deploy/manage.sh"'));
});
