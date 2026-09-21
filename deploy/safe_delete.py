"""Descriptor-pinned, non-following Linux cleanup for explicit maintenance.

Data cleanup must run as its unprivileged owner. Code cleanup additionally
requires a root-owned, non-writable ancestor chain. The confirmation token
records every path component, so replacing an ancestor or target after the
operator sees the path fails closed. Directory traversal never follows links
or crosses mounts, including links swapped while cleanup is in progress.
"""
import argparse
import contextlib
import json
import os
from pathlib import Path
import stat
import sys


PROTECTED = {"/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64",
             "/media", "/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/srv",
             "/sys", "/tmp", "/usr", "/usr/local", "/var", "/var/cache",
             "/var/lib", "/var/log", "/var/spool"}
MAX_DELETE_ENTRIES = 250_000
MAX_DELETE_DEPTH = 128


def identity(value):
    return [value.st_dev, value.st_ino]


def mount_id(descriptor):
    """Identify the opened mount, not merely its backing filesystem.

    A bind mount can have the same st_dev AND st_ino as its source. fdinfo
    describes the already-pinned descriptor, so pathname/mount replacement
    cannot redirect this check to an unrelated directory.
    """
    with open(f"/proc/self/fdinfo/{descriptor}", encoding="ascii") as stream:
        for line in stream:
            key, separator, value = line.partition(":")
            if key == "mnt_id" and separator and value.strip().isdecimal():
                return int(value)
    raise ValueError("cannot verify cleanup mount identity; no traversal allowed")


def pinned_identity(descriptor):
    return [*identity(os.fstat(descriptor)), mount_id(descriptor)]


@contextlib.contextmanager
def pinned(path, mode, anchor=False):
    if sys.platform != "linux" or not hasattr(os, "O_NOFOLLOW"):
        raise ValueError("secure maintenance cleanup requires Linux descriptor-relative operations")
    requested = Path(path)
    if not requested.is_absolute() or ".." in requested.parts:
        raise ValueError("cleanup target must be an absolute path without traversal")
    if not anchor and (str(requested) in PROTECTED or requested == Path.home()):
        raise ValueError("refusing to remove a broad filesystem or account root")
    if mode == "data" and os.geteuid() == 0:
        raise ValueError("data cleanup must run as the unprivileged data owner")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open("/", flags)
    descriptors, chain = [descriptor], []
    try:
        for component in requested.parts[1:]:
            current = os.fstat(descriptor)
            if mode == "code" and (current.st_uid != 0 or stat.S_IMODE(current.st_mode) & 0o022):
                raise ValueError("code cleanup requires root-owned, non-writable ancestors")
            chain.append(pinned_identity(descriptor))
            descriptor = os.open(component, flags, dir_fd=descriptor)
            descriptors.append(descriptor)
        target = os.fstat(descriptor)
        if mode == "code" and (target.st_uid != 0 or stat.S_IMODE(target.st_mode) & 0o022):
            raise ValueError("code cleanup requires a root-owned, non-writable target")
        chain.append(pinned_identity(descriptor))
        if not anchor and len(chain) > 1 and chain[-1][2] != chain[-2][2]:
            raise ValueError("cleanup target is a mount point; unmount it before confirming deletion")
        yield descriptors[-2] if len(descriptors) > 1 else descriptor, descriptor, requested.name, chain
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def prepare(path, mode):
    with pinned(path, mode) as (_, _, _, chain):
        return json.dumps(chain, separators=(",", ":"))


def checked_child(descriptor, name, before, device, mount):
    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
    try:
        actual = os.fstat(child)
        if identity(actual) != identity(before) or actual.st_dev != device or mount_id(child) != mount:
            raise ValueError("cleanup target changed or contains another mounted filesystem")
        return child, actual
    except BaseException:
        os.close(child)
        raise


def inspect_directory(descriptor, device, mount, budget, depth=0):
    """Prove the complete deletion fits fixed budgets before mutating it."""
    if depth > MAX_DELETE_DEPTH:
        raise ValueError("cleanup tree exceeds its depth limit; no deletion performed")
    with os.scandir(descriptor) as entries:
        for entry in entries:
            budget[0] += 1
            if budget[0] > MAX_DELETE_ENTRIES:
                raise ValueError("cleanup tree exceeds its entry limit; no deletion performed")
            before = os.stat(entry.name, dir_fd=descriptor, follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode):
                continue
            child, _ = checked_child(descriptor, entry.name, before, device, mount)
            try:
                inspect_directory(child, device, mount, budget, depth + 1)
            finally:
                os.close(child)


def clear_directory(descriptor, device, mount, budget, depth=0):
    if depth > MAX_DELETE_DEPTH:
        raise ValueError("cleanup tree changed beyond its depth limit")
    # scandir(fd) stays anchored even when another process renames the path.
    with os.scandir(descriptor) as entries:
        for entry in entries:
            budget[0] += 1
            if budget[0] > MAX_DELETE_ENTRIES:
                raise ValueError("cleanup tree changed beyond its entry limit")
            before = os.stat(entry.name, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISDIR(before.st_mode):
                child, actual = checked_child(descriptor, entry.name, before, device, mount)
                try:
                    clear_directory(child, device, mount, budget, depth + 1)
                    latest = os.stat(entry.name, dir_fd=descriptor, follow_symlinks=False)
                    if identity(latest) != identity(actual):
                        raise ValueError("directory changed during cleanup")
                    os.rmdir(entry.name, dir_fd=descriptor)
                finally:
                    os.close(child)
            else:
                # unlink removes only this entry, never the destination of a
                # symlink. A directory swap instead raises IsADirectoryError.
                os.unlink(entry.name, dir_fd=descriptor)


def delete(path, mode, expected):
    with pinned(path, mode) as (parent, target, name, chain):
        if json.loads(expected) != chain:
            raise ValueError("cleanup target changed after confirmation; no deletion performed")
        device, mount = os.fstat(target).st_dev, mount_id(target)
        inspect_directory(target, device, mount, [0])
        clear_directory(target, device, mount, [0])
        if identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != identity(os.fstat(target)):
            raise ValueError("cleanup target entry changed; replacement was preserved")
        os.rmdir(name, dir_fd=parent)


def unlink_file(path):
    if os.geteuid() == 0:
        raise ValueError("data-file cleanup must run as the unprivileged data owner")
    requested = Path(path)
    # Pin and reject every ancestor link. The final entry is intentionally
    # allowed to be the managed secrets.env symlink; only the link is removed.
    with pinned(str(requested.parent), "data", anchor=True) as (_, parent, _, _):
        try:
            value = os.stat(requested.name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return
        if not (stat.S_ISREG(value.st_mode) or stat.S_ISLNK(value.st_mode)):
            raise ValueError("expected a regular data file or its managed symlink")
        os.unlink(requested.name, dir_fd=parent)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("prepare", "delete", "unlink-file"))
    parser.add_argument("path")
    parser.add_argument("mode", nargs="?", choices=("data", "code"))
    parser.add_argument("expected", nargs="?")
    args = parser.parse_args()
    if args.action == "unlink-file":
        unlink_file(args.path)
    elif args.action == "prepare":
        print(prepare(args.path, args.mode))
    elif args.expected:
        delete(args.path, args.mode, args.expected)
    else:
        parser.error("delete requires the prepare confirmation token")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        raise SystemExit(str(error)) from error
