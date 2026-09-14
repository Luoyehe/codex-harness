"""Resolve deployment paths while checking every traversed entry, including links.

The returned spelling is the only spelling callers may persist or execute.
Checking only realpath's final ancestors would hide writable link entrances.
"""
import argparse
import os
from pathlib import PurePosixPath
import re
import stat


def trusted_path(value, *, missing=False, directory=False, lstat_fn=None, readlink_fn=None):
    lstat_fn = lstat_fn or os.lstat
    readlink_fn = readlink_fn or os.readlink
    requested = PurePosixPath(value)
    if requested.anchor != "/" or ".." in requested.parts:
        raise ValueError("trusted deployment paths must be absolute without traversal")
    current = PurePosixPath("/")
    pending = list(requested.parts[1:])
    links = 0
    while True:
        info = lstat_fn(current)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("deployment path ancestors must be root-owned and not writable by other users")
        if not pending:
            if not directory:
                raise ValueError("expected a regular executable file")
            return str(current)
        name = pending.pop(0)
        if name in ("", "."):
            continue
        if name == "..":
            current = current.parent
            continue
        entry = current / name
        try:
            info = lstat_fn(entry)
        except FileNotFoundError:
            if missing and ".." not in pending:
                return str(entry.joinpath(*pending))
            raise
        if stat.S_ISLNK(info.st_mode):
            if info.st_uid != 0:
                raise ValueError("deployment symlinks must be root-owned")
            links += 1
            if links > 40:
                raise ValueError("too many deployment symlinks")
            target = PurePosixPath(readlink_fn(entry))
            if target.is_absolute():
                current = PurePosixPath("/")
                pending = list(target.parts[1:]) + pending
            else:
                pending = list(target.parts) + pending
            continue
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("deployment code must be root-owned and not writable by other users")
        if not pending and not directory:
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("expected a regular deployment executable")
            return str(entry)
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("expected a deployment directory")
        current = entry


def trusted_tree(value):
    root = trusted_path(value, directory=True)
    pending, visited = [root], set()
    while pending:
        directory = pending.pop()
        if directory in visited:
            continue
        visited.add(directory)
        with os.scandir(directory) as entries:
            for entry in entries:
                is_directory = entry.is_dir()
                resolved = trusted_path(entry.path, directory=is_directory)
                # pnpm workspace links can form cycles. Visit their canonical
                # directories once, but still validate every link entrance.
                if is_directory:
                    pending.append(resolved)
    return root


def control_path(value):
    requested = PurePosixPath(value)
    if requested.anchor != "/" or ".." in requested.parts or requested == PurePosixPath("/"):
        raise ValueError("control directory must be an absolute non-root path without traversal")
    parent = trusted_path(str(requested.parent), missing=True, directory=True)
    result = str(PurePosixPath(parent) / requested.name)
    try:
        info = os.lstat(result)
    except FileNotFoundError:
        return result
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError("control directory must be a real directory, not a symlink")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=("tree", "file", "directory", "missing-directory", "control"))
    parser.add_argument("path")
    args = parser.parse_args()
    try:
        if args.kind == "tree":
            result = trusted_tree(args.path)
        elif args.kind == "control":
            result = control_path(args.path)
        else:
            result = trusted_path(args.path, missing=args.kind == "missing-directory", directory=args.kind != "file")
        if not re.fullmatch(r"/[A-Za-z0-9_./@+-]*", result):
            raise ValueError("canonical deployment path contains unsafe systemd characters")
        print(result)
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from None
