"""Fixed, root-owned launcher; the gateway cannot choose executable or user.

Only the private worker backend is started. Secrets are read *after* dropping
privileges. This parent never interprets worker messages and never serves a
network listener. Pipe loss/parent loss terminates every descendant before
returning, including grandchildren that created their own process group.
"""
import ctypes
import os
from pathlib import Path
import pwd
import re
import select
import shlex
import signal
import stat
import sys
import threading
import time


KEYS = {"SERVICE_NAME", "RUN_USER", "RUN_HOME", "INSTALL_DIR", "CODEX_HOME",
        "CODEX_WORKSPACE", "ENV_FILE", "CODEX_BIN", "NODE_BIN", "SERVICE_PATH"}
# Linux __WALL also includes children created with non-SIGCHLD clone flags.
# Python does not expose this Linux-only wait option as a named constant.
WAIT_ALL = 0x40000000
MAX_WORKER_CONFIGURATION_BYTES = 64 * 1024
MAX_WORKER_ENVIRONMENT_BYTES = 1024 * 1024
MAX_PROC_CHILDREN_BYTES = 1024 * 1024
MAX_TRACKED_CHILDREN = 65536


def read_text_bounded(path, limit, *, missing_ok=False, nofollow=True):
    """Self-contained because this launcher is installed alone in libexec."""
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
    if nofollow:
        flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        if missing_ok:
            return ""
        raise
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise ValueError("worker control file is not a bounded regular file or exceeds its limit")
        chunks = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(descriptor, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        after = os.fstat(descriptor)
        identity = lambda info: (
            info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns,
        )
        if len(payload) > limit or len(payload) != before.st_size or identity(before) != identity(after):
            raise ValueError("worker control file changed or exceeds its limit")
        return payload.decode("utf-8")
    finally:
        os.close(descriptor)


def trusted(path, directory=False):
    """Check the resolved executable AND every ancestor, never a data path."""
    path = Path(path).resolve(strict=True)
    for component in [path, *path.parents]:
        info = component.stat()
        if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
            raise ValueError("worker launcher code/config must be root-owned and not writable by other users")
    if directory and not path.is_dir():
        raise ValueError("expected trusted directory")
    return str(path)


def configuration(path):
    filename = trusted(path)
    info = os.stat(filename)
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) not in (0o400, 0o600):
        raise ValueError("unsafe worker configuration")
    values = {}
    lines = read_text_bounded(filename, MAX_WORKER_CONFIGURATION_BYTES).splitlines()
    for line in lines:
        key, separator, value = line.partition("=")
        if not separator or key not in KEYS or key in values or not value or any(ord(c) < 32 for c in value):
            raise ValueError("invalid worker configuration")
        values[key] = value
    if set(values) != KEYS:
        raise ValueError("incomplete worker configuration")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", values["SERVICE_NAME"]):
        raise ValueError("invalid instance name")
    account = pwd.getpwnam(values["RUN_USER"])
    if account.pw_uid == 0 or account.pw_dir != values["RUN_HOME"]:
        raise ValueError("worker must use its fixed non-root service account")
    values["NODE_BIN"] = trusted(values["NODE_BIN"])
    values["CODEX_BIN"] = trusted(values["CODEX_BIN"])
    values["WORKER_ENTRY"] = trusted(str(Path(values["INSTALL_DIR"]) / "apps/gateway/dist/worker.js"))
    trusted(values["INSTALL_DIR"], directory=True)
    return values, account


def worker_environment(config):
    # Called only in the permanently unprivileged child. The service-owned
    # EnvironmentFile is data, never shell/Python source or root configuration.
    result = {"HOME": config["RUN_HOME"], "PATH": config["SERVICE_PATH"], "LANG": "C.UTF-8"}
    # Provider transactions intentionally expose this file through a managed
    # generation symlink.  Pin and bound the target after dropping privileges.
    raw = read_text_bounded(
        config["ENV_FILE"], MAX_WORKER_ENVIRONMENT_BYTES,
        missing_ok=True, nofollow=False,
    )
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ValueError("invalid worker environment entry")
        if key.startswith(("GATEWAY_", "CODEX_HARNESS_")) or key in {
            "HOME", "PATH", "CODEX_HOME", "CODEX_WORKSPACE", "CODEX_BIN", "ENV_FILE", "CODEX_WORKER_LAUNCHER",
            "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME", "LD_PRELOAD", "LD_LIBRARY_PATH",
            "BASH_ENV", "ENV", "SUDO_ASKPASS", "SHELLOPTS", "BASHOPTS"}:
            continue
        parsed = shlex.split(value, posix=True)
        if len(parsed) > 1:
            raise ValueError("invalid quoted worker environment value")
        result[key] = parsed[0] if parsed else ""
    result.update({key: config[key] for key in ("CODEX_HOME", "CODEX_WORKSPACE", "CODEX_BIN", "ENV_FILE")})
    result.update(CODEX_HARNESS_WORKER="1", CODEX_HARNESS_MANAGED_WORKER="1", GATEWAY_EXTERNAL_RESTART="1")
    return result


def direct_children():
    """Candidates for signalling, NEVER evidence that the subtree is empty.

    The kernel may omit children during concurrent exits. Only this main
    thread reaps children, so their PIDs cannot be recycled during signalling.
    Enumerate every thread because Linux's children files are per-thread.
    """
    found = set()
    for task in Path(f"/proc/{os.getpid()}/task").iterdir():
        try:
            descriptor = os.open(
                task / "children",
                os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0),
            )
        except FileNotFoundError:
            continue
        try:
            payload = os.read(descriptor, MAX_PROC_CHILDREN_BYTES + 1)
            if len(payload) > MAX_PROC_CHILDREN_BYTES or os.read(descriptor, 1):
                raise OSError("process child inventory exceeds supervision limit")
        finally:
            os.close(descriptor)
        try:
            children = payload.decode("ascii").split()
            if len(children) > MAX_TRACKED_CHILDREN:
                raise ValueError("too many supervised children")
            found.update(int(value) for value in children)
        except (UnicodeError, ValueError) as error:
            raise OSError("invalid process child inventory") from error
        if len(found) > MAX_TRACKED_CHILDREN:
            raise OSError("too many supervised children")
    return found


def signal_children(kind):
    # Kill direct children; deeper descendants become our direct children via
    # subreaper adoption, even after setsid/double-fork. Never signal a merely
    # observed descendant PID that another parent could concurrently reap.
    for pid in direct_children():
        try:
            descriptor = os.pidfd_open(pid)
            try:
                # Verify the pidfd still names OUR child without reaping it.
                # A stale or unrelated process is not a permissible target.
                os.waitid(os.P_PIDFD, descriptor, os.WEXITED | os.WNOHANG | os.WNOWAIT | WAIT_ALL)
                signal.pidfd_send_signal(descriptor, kind)
            finally:
                os.close(descriptor)
        except (ProcessLookupError, ChildProcessError):
            pass


def enable_subreaper():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "cannot supervise worker descendants")
    if not all((hasattr(os, "pidfd_open"), hasattr(os, "P_PIDFD"), hasattr(signal, "pidfd_send_signal"))):
        raise OSError("Linux pidfd supervision requires Python 3.11 and a supported kernel")
    # Fail before forking if this kernel lacks a required pidfd operation.
    descriptor = os.pidfd_open(os.getpid())
    try:
        signal.pidfd_send_signal(descriptor, 0)
        try:
            os.waitid(os.P_PIDFD, descriptor, os.WEXITED | os.WNOHANG | os.WNOWAIT | WAIT_ALL)
        except ChildProcessError:  # our own pidfd must not be a waitable child
            pass
    finally:
        os.close(descriptor)
    # ECHILD is only meaningful if children remain waitable until we reap them.
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)


def reap_available():
    """True only when the kernel confirms there are no children left."""
    while True:
        try:
            exited, _ = os.waitpid(-1, os.WNOHANG | WAIT_ALL)
        except ChildProcessError:
            return True
        if not exited:
            return False


def cleanup_children(grace_seconds=1):
    deadline = time.monotonic() + grace_seconds
    warned = False
    while True:
        try:
            if reap_available():
                return
            signal_children(signal.SIGTERM if time.monotonic() < deadline else signal.SIGKILL)
        except OSError:
            # Losing /proc visibility or signal permission is not cleanup.
            # Keep the authority alive and refuse to confirm a replacement.
            if not warned:
                os.write(2, b"worker cleanup unconfirmed; waiting for all descendants\n")
                warned = True
        # Never block in waitpid: an incomplete /proc scan must be retried so
        # newly adopted children still receive SIGKILL. ECHILD alone ends this.
        time.sleep(0.02)


def supervise(config, account):
    enable_subreaper()
    stop = threading.Event()
    parent = os.getppid()
    # Fork a child directly: unlike preexec_fn with threads, this child can
    # safely drop identity and then parse environment before its final exec.
    input_read, input_write = os.pipe()
    output_read, output_write = os.pipe()
    child = os.fork()
    if child == 0:
        try:
            os.close(input_write)
            os.close(output_read)
            os.dup2(input_read, 0)
            os.dup2(output_write, 1)
            os.close(input_read)
            os.close(output_write)
            os.setsid()
            os.initgroups(account.pw_name, account.pw_gid)
            os.setgid(account.pw_gid)
            os.setuid(account.pw_uid)
            os.umask(0o077)
            os.chdir(str(Path(config["INSTALL_DIR"]) / "apps/gateway"))
            environment = worker_environment(config)
            os.execve(config["NODE_BIN"], [config["NODE_BIN"], config["WORKER_ENTRY"]], environment)
        except BaseException:
            os.write(2, b"worker launch failed after identity transition\n")
            os._exit(1)
    def relay(source, destination):
        try:
            while not stop.is_set():
                block = os.read(source, 65536)
                if not block:
                    break
                while block:
                    count = os.write(destination, block)
                    block = block[count:]
        except OSError:
            pass
        finally:
            stop.set()

    try:
        os.close(input_read)
        os.close(output_write)
        readers = [threading.Thread(target=relay, args=(0, input_write), daemon=True),
                   threading.Thread(target=relay, args=(output_read, 1), daemon=True)]
        for thread in readers:
            thread.start()
        for kind in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(kind, lambda *_: stop.set())
        poller = select.poll()
        poller.register(0, select.POLLHUP | select.POLLERR)
        while not stop.is_set():
            exited, _ = os.waitpid(child, os.WNOHANG)
            if exited:
                break
            if os.getppid() != parent or poller.poll(100):
                break
    finally:
        stop.set()
        cleanup_children()
        os.close(input_write)
        os.close(output_read)
    # This exit status belongs to the cleanup authority, not to the worker.
    # Zero is emitted ONLY after ECHILD. A signal/crash/nonzero launcher exit
    # makes the gateway fail closed instead of assuming its children stopped.
    return 0


if __name__ == "__main__":
    try:
        if os.geteuid() != 0 or len(sys.argv) != 2:
            raise ValueError("fixed worker launcher requires root and one configuration path")
        sys.exit(supervise(*configuration(sys.argv[1])))
    except (ValueError, OSError, KeyError) as error:
        print(f"worker launcher refused ({type(error).__name__})", file=sys.stderr)
        sys.exit(1)
