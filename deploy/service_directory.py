"""Create service directories without privileged writes in worker-owned trees."""
import argparse
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys

# -I deliberately excludes the script directory. Import only this helper's
# trusted sibling, never a module from the caller's working directory/PYTHONPATH.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from service_env import drop_service_privileges, service_account

FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
WORKER_TIMEOUT_SECONDS = 30


def components(value):
    path = PurePosixPath(value)
    if path.anchor != "/" or ".." in path.parts or len(path.parts) < 2:
        raise ValueError("service directory must be absolute without traversal")
    return path.parts[1:]


def bootstrap(value, uid, gid):
    """Root creates only missing entries under a fully root-controlled prefix.

    Existing data is never chowned/chmodded. In a worker-controlled subtree,
    the worker creates missing entries itself after the permanent UID change.
    """
    parts = components(value)
    descriptor = os.open("/", FLAGS)
    trusted = True
    try:
        for index, name in enumerate(parts):
            parent = os.fstat(descriptor)
            trusted = trusted and parent.st_uid == 0 and not parent.st_mode & 0o022
            try:
                child = os.open(name, FLAGS, dir_fd=descriptor)
            except FileNotFoundError:
                if not trusted:
                    return
                last = index == len(parts) - 1
                os.mkdir(name, 0o700 if last else 0o755, dir_fd=descriptor)
                child = os.open(name, FLAGS, dir_fd=descriptor)
                if last:
                    os.fchown(child, uid, gid)
                    os.fchmod(child, 0o700)
            os.close(descriptor)
            descriptor = child
    finally:
        os.close(descriptor)


def ensure(value, private=False):
    if os.geteuid() == 0:
        raise ValueError("service data checks require the unprivileged owner")
    descriptor = os.open("/", FLAGS)
    try:
        for name in components(value):
            try:
                child = os.open(name, FLAGS, dir_fd=descriptor)
            except FileNotFoundError:
                os.mkdir(name, 0o700, dir_fd=descriptor)
                child = os.open(name, FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        if not os.access(".", os.R_OK | os.W_OK | os.X_OK, dir_fd=descriptor, effective_ids=True):
            raise ValueError("service directory is not accessible to its worker")
        if private:
            if os.fstat(descriptor).st_uid != os.geteuid():
                raise ValueError("private CODEX_HOME must belong to its worker; migrate ownership deliberately")
            os.fchmod(descriptor, 0o700)
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("user")
    parser.add_argument("path")
    parser.add_argument("--private", action="store_true")
    parser.add_argument("--worker", action="store_true")
    args = parser.parse_args()
    if os.name != "posix" or not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise ValueError("service directory provisioning requires Linux no-follow directory descriptors")
    account = service_account(args.user)
    if args.worker:
        drop_service_privileges(args.user)
        if os.geteuid() != account.pw_uid:
            raise ValueError("directory checks must run as the requested service account")
        ensure(args.path, args.private)
        return 0
    if os.geteuid() != 0:
        raise ValueError("directory bootstrap requires root")
    bootstrap(args.path, account.pw_uid, account.pw_gid)
    command = [sys.executable, "-I", os.path.abspath(__file__), args.user, args.path, "--worker"]
    if args.private:
        command.append("--private")
    try:
        return subprocess.run(command, env={"HOME": account.pw_dir, "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                              check=False, timeout=WORKER_TIMEOUT_SECONDS).returncode
    except subprocess.TimeoutExpired:
        raise ValueError("service directory worker timed out") from None


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from None
