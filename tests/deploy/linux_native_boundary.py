"""Actual native UID attacks against an installed disposable supervisor.

This does not restart services, send turns, read secret contents or modify a
project. It must be run explicitly as root on the isolated crtest instance.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from deploy.common import Layout, atomic_write, mkdir, read_json, require
from deploy.system import System, require_linux, run


ATTACK = r'''
import ctypes, errno, json, os, socket, sys
pid, socket_path, token, attachment, home, forbidden_groups = sys.argv[1:]
pid = int(pid)
result = {"uid": os.geteuid(), "groups": os.getgroups()}
def denied(name, action):
    try:
        value = action()
        if isinstance(value, int): os.close(value)
        result[name] = False
    except OSError as exc:
        result[name] = exc.errno in (errno.EACCES, errno.EPERM)
denied("tokenDenied", lambda: os.open(token, os.O_RDONLY))
denied("supervisorMemoryDenied", lambda: os.open(f"/proc/{pid}/mem", os.O_RDONLY))
denied("supervisorEnvironmentDenied", lambda: os.open(f"/proc/{pid}/environ", os.O_RDONLY))
denied("supervisorDescriptorsDenied", lambda: os.open(f"/proc/{pid}/fd", os.O_RDONLY | os.O_DIRECTORY))
denied("attachmentWriteDenied", lambda: os.open(attachment, os.O_WRONLY))
denied("supervisorHomeWriteDenied", lambda: os.open(home + "/forbidden-boundary-file", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
with open(attachment, "rb") as source:
    result["attachmentReadable"] = source.read(64) == b"public boundary fixture"
client = socket.socket(socket.AF_UNIX)
try:
    denied("controlSocketDenied", lambda: client.connect(socket_path))
finally:
    client.close()
libc = ctypes.CDLL(None, use_errno=True)
pidfd = os.pidfd_open(pid)
try:
    ctypes.set_errno(0)
    descriptor = libc.syscall(438, pidfd, 0, 0)  # pidfd_getfd on supported x64/arm64
    result["pidfdDuplicateDenied"] = descriptor == -1 and ctypes.get_errno() == errno.EPERM
    if descriptor >= 0: os.close(descriptor)
finally:
    os.close(pidfd)
class IOVec(ctypes.Structure):
    _fields_ = [("iov_base", ctypes.c_void_p), ("iov_len", ctypes.c_size_t)]
buffer = ctypes.create_string_buffer(1)
local, remote = IOVec(ctypes.addressof(buffer), 1), IOVec(1, 1)
ctypes.set_errno(0)
count = libc.process_vm_readv(pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)
result["processMemoryDenied"] = count == -1 and ctypes.get_errno() == errno.EPERM
result["controlGroupsAbsent"] = not set(map(int, forbidden_groups.split(","))) & set(os.getgroups() + [os.getgid()])
print(json.dumps(result))
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--instance", required=True)
    args = parser.parse_args()
    require_linux()
    require(args.instance.startswith("crtest-"), "Only a disposable crtest-* instance is permitted")
    layout = Layout(args.instance)
    config = read_json(layout.config / "instance.json")
    state = System().state(layout.unit("worker"))
    require(state["ActiveState"] == "active" and state["MainPID"] != "0", "Supervisor must be running")
    pid = int(state["MainPID"])
    require(Path("/proc", str(pid)).stat().st_uid == config["supervisorUid"] != config["workerUid"], "Supervisor/native UID separation absent")
    import grp
    ipc_gid = grp.getgrnam(layout.prefix + "-ipc").gr_gid
    stage = layout.work / ("native-boundary-" + uuid.uuid4().hex)
    mkdir(stage, 0o755)
    script = stage / "attack.py"
    atomic_write(script, ATTACK.encode(), 0o644)
    attachment = layout.state / "supervisor/attachments" / ("boundary-" + uuid.uuid4().hex)
    atomic_write(attachment, b"public boundary fixture", 0o640, config["supervisorUid"], config["workerGid"])
    try:
        result = run(["/usr/bin/setpriv", "--reuid", str(config["workerUid"]), "--regid", str(config["workerGid"]), "--clear-groups", "--no-new-privs",
                      "/usr/bin/python3", "-I", str(script), str(pid), str(layout.run / "worker.sock"), str(layout.config / "gateway-token"),
                      str(attachment), str(layout.state / "supervisor"), f"{config['gatewayGid']},{config['supervisorGid']},{ipc_gid}"], timeout=15)
        evidence = json.loads(result.stdout)
        require(evidence["uid"] == config["workerUid"] and all(value is True for key, value in evidence.items() if key not in ("uid", "groups")),
                "Native identity crossed a supervisor boundary")
        # Exercise the actual sudo rule and fixed launcher as the control UID.
        version = run(["/usr/bin/setpriv", "--reuid", str(config["supervisorUid"]), "--regid", str(config["supervisorGid"]),
                       "--groups", f"{config['workerGid']},{ipc_gid}", "/usr/bin/sudo", "-n", "-u", layout.prefix + "-worker", "--",
                       str(layout.control / "native-launch"), "version"], timeout=20)
        require(version.stdout.strip() == "codex-cli 0.164.0", "Native launcher version failed")
        evidence["fixedLauncherVersion"] = version.stdout.strip()
        atomic_write(stage / "evidence.json", json.dumps(evidence, indent=2).encode(), 0o644)
        print(json.dumps({"passed": True, "evidence": str(stage / "evidence.json")}))
    finally:
        attachment.unlink()


if __name__ == "__main__":
    main()
