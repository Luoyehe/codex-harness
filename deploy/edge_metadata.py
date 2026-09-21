"""Validate root-controlled edge configuration before privileged metadata writes.

Mutable Authelia state is intentionally excluded: it must be provisioned using
service_directory.py and written only after dropping to the service account.
"""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys


STATE_LIMIT = 64 * 1024
STATE_KEYS = ("CADDY_FILE", "AUTHELIA_DIR", "AUTHELIA_UNIT", "AUTHELIA_ADDR")

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from trusted_paths import trusted_path


def checked_file(value, *, private=False, validate_path=None, lstat_fn=None):
    validate_path = validate_path or trusted_path
    lstat_fn = lstat_fn or os.lstat
    path = PurePosixPath(value)
    if path.anchor != "/" or ".." in path.parts or path == PurePosixPath("/"):
        raise ValueError("edge configuration requires an absolute non-root path without traversal")
    parent = validate_path(str(path.parent), missing=True, directory=True)
    result = str(PurePosixPath(parent) / path.name)
    try:
        info = lstat_fn(result)
    except FileNotFoundError:
        return result
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_nlink != 1:
        raise ValueError("edge configuration must be a singly linked root-owned regular file, not writable by other users; migrate ownership deliberately")
    if private and info.st_mode & 0o077:
        raise ValueError("initial-password contains plaintext credentials and must have no group/other permissions; restrict it deliberately before retrying")
    return result


def checked_configuration(value, *, validate_path=None, lstat_fn=None):
    validate_path = validate_path or trusted_path
    result = validate_path(value, missing=True, directory=True)
    if result in ("/", "/etc", "/var", "/var/lib", "/usr", "/usr/local", "/home", "/root", "/tmp", "/run", "/srv", "/opt"):
        raise ValueError("Authelia requires a dedicated configuration directory, not a shared system directory")
    for name in ("configuration.yml", "users_database.yml", "initial-password"):
        checked_file(str(PurePosixPath(result) / name), private=name == "initial-password", validate_path=validate_path, lstat_fn=lstat_fn)
    return result


def _state_metadata(info):
    return (
        info.st_mode, info.st_uid, info.st_gid, info.st_nlink, info.st_size,
        info.st_mtime_ns, info.st_ctime_ns,
    )


def _read_state_bytes(path):
    try:
        before = os.lstat(path)
    except FileNotFoundError:
        # Prove absence twice around a no-follow open so a concurrently
        # appearing state file is never mistaken for an empty configuration.
        try:
            appeared = os.open(
                path,
                os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            )
        except FileNotFoundError:
            try:
                os.lstat(path)
            except FileNotFoundError:
                return None
            raise RuntimeError("edge state appeared during inspection")
        else:
            os.close(appeared)
            raise RuntimeError("edge state appeared during inspection")
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_uid != 0
        or stat.S_IMODE(before.st_mode) != 0o600
        or before.st_nlink != 1
        or before.st_size > STATE_LIMIT
    ):
        raise ValueError("edge state must be a bounded singly-linked root-private regular file")
    descriptor = os.open(
        path,
        os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
    )
    try:
        opened = os.fstat(descriptor)
        current = os.lstat(path)
        identity = lambda info: (info.st_dev, info.st_ino)
        if (
            identity(before) != identity(opened)
            or identity(opened) != identity(current)
            or _state_metadata(before) != _state_metadata(opened)
            or _state_metadata(opened) != _state_metadata(current)
        ):
            raise RuntimeError("edge state changed while it was opened")
        chunks = []
        remaining = STATE_LIMIT + 1
        while remaining:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        after = os.fstat(descriptor)
        current_after = os.lstat(path)
        if (
            identity(before) != identity(after)
            or identity(after) != identity(current_after)
            or _state_metadata(before) != _state_metadata(after)
            or _state_metadata(after) != _state_metadata(current_after)
        ):
            raise RuntimeError("edge state changed while it was read")
    finally:
        os.close(descriptor)
    if len(raw) > STATE_LIMIT or len(raw) != before.st_size:
        raise ValueError("edge state exceeds its read limit or was read incompletely")
    return raw


def read_state(path, *, validate_path=None):
    validate_path = validate_path or trusted_path
    checked = checked_file(path, validate_path=validate_path)
    raw = _read_state_bytes(checked)
    if raw is None:
        return {}

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("edge state contains duplicate keys")
            result[key] = value
        return result

    data = json.loads(
        raw.decode("utf-8"),
        object_pairs_hook=unique_object,
        parse_constant=lambda value: (_ for _ in ()).throw(ValueError("invalid JSON constant")),
    )
    if not isinstance(data, dict) or set(data) - set(STATE_KEYS):
        raise ValueError("edge state has an invalid top-level shape")
    for key, value in data.items():
        if (
            not isinstance(value, str)
            or not value
            or len(value) > 4096
            or any(ord(character) < 0x20 or ord(character) == 0x7f for character in value)
        ):
            raise ValueError(f"edge state field {key} is invalid")
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("configuration", "file", "state"))
    parser.add_argument("path")
    args = parser.parse_args()
    if args.kind == "configuration":
        print(checked_configuration(args.path))
    elif args.kind == "file":
        print(checked_file(args.path))
    else:
        for key, value in read_state(args.path).items():
            print(key + "\t" + value)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        raise SystemExit(str(error)) from None
