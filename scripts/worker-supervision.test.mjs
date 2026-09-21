import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
const python = process.env.CODEX_TEST_PYTHON || "python3";
const pythonAvailable = spawnSync(python, ["-c", "import sys; assert sys.version_info >= (3,11)"], { windowsHide: true }).status === 0;
const pythonOptions = { skip: pythonAvailable ? false : "Python 3.11+ required" };
const linuxOptions = { skip: pythonAvailable && process.platform === "linux" ? false : "Linux kernel and Python 3.11+ required" };
function runPython(source) {
  const result = spawnSync(python, ["-c", `
import sys, types, os, signal
if sys.platform == "win32":
    # Constants only for mocked algorithm tests; kernel fixtures stay Linux-only.
    sys.modules["pwd"] = types.ModuleType("pwd")
    os.WNOHANG = 1
    os.O_NONBLOCK = 0
    signal.SIGKILL = 9
import worker_launcher as launcher
${source}`], {
    encoding: "utf8", windowsHide: true, timeout: 15000,
    env: { ...process.env, PYTHONPATH: deploy, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}

test("cleanup finishes only on kernel ECHILD, not an empty or failing process scan", pythonOptions, () => {
  runPython(`
from unittest.mock import patch
import signal
calls = []
def waitpid(pid, flags):
    assert pid == -1 and flags & launcher.WAIT_ALL
    calls.append("wait")
    if calls.count("wait") == 5:
        raise ChildProcessError()
    return (0, 0)
def scan(kind):
    calls.append("signal")
    assert kind == signal.SIGKILL
    if calls.count("signal") == 2:
        raise PermissionError("synthetic inaccessible proc")
with patch.object(launcher.os, "waitpid", waitpid), patch.object(launcher, "signal_children", scan), patch.object(launcher.time, "sleep"), patch.object(launcher.os, "write"):
    launcher.cleanup_children(grace_seconds=0)
assert calls.count("wait") == 5, calls
assert calls.count("signal") == 4, calls
`);
});

test("cleanup reaps all available zombies without blocking on a surviving child", pythonOptions, () => {
  runPython(`
from unittest.mock import patch
with patch.object(launcher.os, "waitpid", side_effect=[(123, 0), (456, 0), (0, 0)]) as wait:
    assert launcher.reap_available() is False
    assert wait.call_count == 3
with patch.object(launcher.os, "waitpid", side_effect=[(123, 0), ChildProcessError()]):
    assert launcher.reap_available() is True
`);
});

test("worker control and environment files are descriptor-pinned and bounded", linuxOptions, () => {
  runPython(`
import os,tempfile,types
from pathlib import Path
from unittest.mock import patch
with tempfile.TemporaryDirectory() as directory:
    base=Path(directory); config_file=base/'worker.conf'; environment=base/'worker.env'
    values={
        'SERVICE_NAME':'fixture', 'RUN_USER':'fixture', 'RUN_HOME':str(base/'home'),
        'INSTALL_DIR':str(base/'app'), 'CODEX_HOME':str(base/'data'),
        'CODEX_WORKSPACE':str(base/'workspace'), 'ENV_FILE':str(environment),
        'CODEX_BIN':str(base/'codex'), 'NODE_BIN':str(base/'node'),
        'SERVICE_PATH':'/usr/bin:/bin',
    }
    config_file.write_text(''.join(f'{key}={value}\\n' for key,value in values.items()),encoding='utf-8'); config_file.chmod(0o600)
    environment.write_text('FIXTURE=value\\n',encoding='utf-8')
    account=types.SimpleNamespace(pw_uid=1200,pw_dir=str(base/'home'))
    with patch.object(launcher,'trusted',side_effect=lambda value,directory=False:str(value)), patch.object(launcher.pwd,'getpwnam',return_value=account,create=True):
        loaded,_=launcher.configuration(config_file)
        assert loaded['SERVICE_NAME']=='fixture'
        config_file.write_bytes(b'x'*(launcher.MAX_WORKER_CONFIGURATION_BYTES+1)); config_file.chmod(0o600)
        try: launcher.configuration(config_file)
        except ValueError as error: assert 'limit' in str(error)
        else: raise AssertionError('oversized worker configuration accepted')
    assert launcher.worker_environment(values)['FIXTURE']=='value'
    environment.write_bytes(b'x'*(launcher.MAX_WORKER_ENVIRONMENT_BYTES+1))
    try: launcher.worker_environment(values)
    except ValueError as error: assert 'limit' in str(error)
    else: raise AssertionError('oversized worker environment accepted')
    if os.name!='nt':
        fifo=base/'worker-fifo'; os.mkfifo(fifo); values['ENV_FILE']=str(fifo)
        try: launcher.worker_environment(values)
        except ValueError: pass
        else: raise AssertionError('special environment file accepted')
`);
});

test("process child inventory fails closed when a proc entry exceeds its cap", pythonOptions, () => {
  runPython(`
from pathlib import Path
from unittest.mock import patch
task=Path('/synthetic/task'); reads=[]
def opened(path, flags):
    assert path==task/'children'; return 17
def read(fd, count):
    reads.append(count)
    return b'1'*(launcher.MAX_PROC_CHILDREN_BYTES+1) if len(reads)==1 else b''
with patch.object(launcher.Path,'iterdir',return_value=iter([task])), patch.object(launcher.os,'open',side_effect=opened), patch.object(launcher.os,'read',side_effect=read), patch.object(launcher.os,'close'):
    try: launcher.direct_children()
    except OSError as error: assert 'limit' in str(error)
    else: raise AssertionError('oversized proc child inventory accepted')
`);
});

// Every synthetic descendant has a finite lifetime as a final test-only
// safety net. The fixture itself is an unprivileged, isolated subreaper.
const kernelTree = `
import os, signal, time
launcher.enable_subreaper()
read_end, write_end = os.pipe()
initial = os.fork()
if initial == 0:
    os.close(read_end)
    os.setsid()
    middle = os.fork()
    if middle:
        os._exit(17)
    os.setsid()
    leaf = os.fork()
    if leaf:
        os._exit(18)
    os.setsid()
    def on_term(*_):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        late = os.fork()
        if late == 0:
            os.setsid()
            os.write(write_end, ("late " + str(os.getpid()) + "\\n").encode())
            os.close(write_end)
            time.sleep(8)
            os._exit(0)
    signal.signal(signal.SIGTERM, on_term)
    os.write(write_end, ("ready " + str(os.getpid()) + "\\n").encode())
    time.sleep(8)
    os._exit(0)
os.close(write_end)
report = b""
while b"ready " not in report or b"\\n" not in report:
    report += os.read(read_end, 4096)
os.waitpid(initial, 0)
`;

for (const missScans of [false, true]) {
  test(`Linux cleanup reaps detached double-fork descendants and retries omitted scans (${missScans})`, linuxOptions, () => {
    const result = runPython(kernelTree + `
original_scan = launcher.direct_children
scans = 0
def scan():
    global scans
    scans += 1
    return set() if ${missScans ? "True" : "False"} and scans <= 3 else original_scan()
launcher.direct_children = scan
try:
    started = time.monotonic()
    launcher.cleanup_children(grace_seconds=0.25)
    assert time.monotonic() - started < 3
    assert launcher.reap_available() is True
    while True:
        chunk = os.read(read_end, 4096)
        if not chunk:
            break
        report += chunk
    assert b"late " in report, report
    if ${missScans ? "True" : "False"}:
        assert scans > 3
    for line in report.decode().splitlines():
        pid = int(line.split()[1])
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        raise AssertionError("synthetic descendant survived: " + str(pid))
    print("ECHILD verified; late-fork descendant reaped")
finally:
    launcher.direct_children = original_scan
    launcher.cleanup_children(grace_seconds=0)
    os.close(read_end)
`);
    assert.match(result, /ECHILD verified/);
  });
}

test("Linux launcher clean status belongs to verified cleanup, not the worker's nonzero status", linuxOptions, () => {
  runPython(`
from unittest.mock import patch
import os, signal, tempfile, types
from pathlib import Path
# Execute only a harmless Python child, under this test's existing identity.
# Privilege changes are suppressed; no root config or service is accessed.
with tempfile.TemporaryDirectory(prefix="harness-owner-status-") as directory:
    gateway = Path(directory) / "apps/gateway"
    gateway.mkdir(parents=True)
    entry = gateway / "fixture.py"
    entry.write_text("import os\\nos._exit(23)\\n")
    config = {"INSTALL_DIR": directory, "NODE_BIN": sys.executable, "WORKER_ENTRY": str(entry)}
    account = types.SimpleNamespace(pw_name="fixture", pw_gid=os.getgid(), pw_uid=os.getuid())
    saved_input = os.dup(0)
    input_read, input_write = os.pipe()
    os.dup2(input_read, 0)
    os.close(input_read)
    statuses = []
    real_wait = os.waitpid
    def waitpid(*args):
        result = real_wait(*args)
        if result[0]:
            statuses.append(result[1])
        return result
    try:
        with patch.object(launcher.os, "initgroups"), patch.object(launcher.os, "setgid"), patch.object(launcher.os, "setuid"), patch.object(launcher.os, "waitpid", waitpid), patch.object(launcher, "worker_environment", return_value={"PATH": "/usr/bin:/bin"}):
            assert launcher.supervise(config, account) == 0
        assert launcher.reap_available() is True
        assert any(os.WIFEXITED(status) and os.WEXITSTATUS(status) == 23 for status in statuses), statuses
    finally:
        os.close(input_write)
        os.dup2(saved_input, 0)
        os.close(saved_input)
`);
});
