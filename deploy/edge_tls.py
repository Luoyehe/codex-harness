"""Import user-supplied TLS material into a root-managed Caddy directory."""
import argparse
import contextlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import stat
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from trusted_paths import trusted_path
from bounded_read import read_text_bounded


CERT_LIMIT = 8 * 1024 * 1024
KEY_LIMIT = 1024 * 1024
COPY_CHUNK = 64 * 1024
ADAPTED_CONFIG_LIMIT = 16 * 1024 * 1024
COLLECTION_PAIR_LIMIT = 1024
COLLECTION_BYTE_LIMIT = 64 * 1024 * 1024
MANAGED_ROOT = "/etc/codex-harness/tls"
UNIT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
TEMPORARY = re.compile(r"\.(cert|key)\.pem\.[0-9a-f]{32}\.tmp")
PAIR_DIRECTORY = re.compile(r"pair-[0-9a-f]{32}")
DIR_FLAGS = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
SOURCE_FLAGS = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)


class IncompletePairError(ValueError):
    """A trusted managed directory contains no usable published pair."""


def _identity(info):
    return (info.st_dev, info.st_ino)


def _stable(before, after, copied):
    return (
        _identity(before) == _identity(after)
        and before.st_size == after.st_size == copied
        and before.st_mtime_ns == after.st_mtime_ns
        and before.st_ctime_ns == after.st_ctime_ns
        and after.st_nlink == 1
        and stat.S_ISREG(after.st_mode)
    )


def _open_source(path, limit, *, private=False, allow_group_read=False):
    before = os.lstat(path)
    permissions = stat.S_IMODE(before.st_mode)
    unsafe_private_permissions = (
        permissions & 0o007
        or permissions & (0o030 if allow_group_read else 0o070)
    )
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_nlink != 1
        or not 0 < before.st_size <= limit
        or permissions & 0o022
        or private and unsafe_private_permissions
    ):
        raise ValueError("TLS source is not a bounded singly-linked regular file with safe permissions")
    fd = os.open(path, SOURCE_FLAGS)
    try:
        opened = os.fstat(fd)
        current = os.lstat(path)
        if not _stable(before, opened, before.st_size) or not _stable(before, current, before.st_size):
            raise ValueError("TLS source changed while it was opened")
        return (fd, before, limit, path)
    except BaseException:
        os.close(fd)
        raise


def _write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("short write while importing TLS material")
        view = view[written:]


def _copy_pinned(source, target_fd):
    fd, before, limit, path = source
    os.lseek(fd, 0, os.SEEK_SET)
    copied = 0
    while copied <= limit:
        chunk = os.read(fd, min(COPY_CHUNK, limit + 1 - copied))
        if not chunk:
            break
        copied += len(chunk)
        if copied > limit:
            raise ValueError("TLS source grew beyond its byte limit")
        _write_all(target_fd, chunk)
    after = os.fstat(fd)
    current = os.lstat(path)
    if not _stable(before, after, copied) or not _stable(before, current, copied):
        raise ValueError("TLS source changed during import")
    return copied


def _revalidate(source, copied):
    fd, before, _limit, path = source
    after = os.fstat(fd)
    current = os.lstat(path)
    if not _stable(before, after, copied) or not _stable(before, current, copied):
        raise ValueError("TLS source changed before publication")


def _open_directory(path, owner_uid, group_gid, mode):
    before = os.lstat(path)
    fd = os.open(path, DIR_FLAGS)
    try:
        opened = os.fstat(fd)
        current = os.lstat(path)
        if (
            not stat.S_ISDIR(opened.st_mode)
            or _identity(before) != _identity(opened)
            or _identity(opened) != _identity(current)
            or opened.st_uid != owner_uid
            or opened.st_gid != group_gid
            or stat.S_IMODE(opened.st_mode) != mode
        ):
            raise ValueError("managed TLS directory has an unsafe identity or permissions")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _expected_entry(info, owner_uid, group_gid, mode):
    return (
        stat.S_ISREG(info.st_mode)
        and info.st_nlink == 1
        and info.st_uid == owner_uid
        and info.st_gid == group_gid
        and stat.S_IMODE(info.st_mode) == mode
    )


def _directory_names(directory_fd):
    names = set()
    # Give each scan its own directory offset while retaining the pinned path.
    scan_fd = os.open(".", DIR_FLAGS, dir_fd=directory_fd)
    try:
        with os.scandir(scan_fd) as entries:
            for entry in entries:
                names.add(entry.name)
                if len(names) > COLLECTION_PAIR_LIMIT + 2:
                    raise ValueError("managed TLS directory exceeds its entry limit")
    finally:
        os.close(scan_fd)
    return names


def _validate_entries(directory_fd, owner_uid, group_gid, *, allow_partial, allow_pairs=False):
    names = _directory_names(directory_fd)
    if allow_pairs:
        names = {name for name in names if not PAIR_DIRECTORY.fullmatch(name)}
    if names - {"cert.pem", "key.pem"}:
        raise ValueError("managed TLS directory contains unexpected entries")
    if not allow_partial and names != {"cert.pem", "key.pem"}:
        raise ValueError("managed TLS certificate pair is incomplete")
    for name, mode in (("cert.pem", 0o644), ("key.pem", 0o640)):
        if name not in names:
            continue
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if not _expected_entry(info, owner_uid, group_gid, mode):
            raise ValueError("managed TLS file has an unsafe identity or permissions")
    return names


def _remove_stale_temporaries(directory_fd, owner_uid, group_gid):
    removed = False
    for name in _directory_names(directory_fd):
        match = TEMPORARY.fullmatch(name)
        if not match:
            continue
        expected_mode = 0o644 if match.group(1) == "cert" else 0o640
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_uid != owner_uid
            or info.st_gid not in (os.getegid(), group_gid)
            or stat.S_IMODE(info.st_mode) not in (0o600, expected_mode)
        ):
            raise ValueError("managed TLS temporary file has unsafe metadata")
        os.unlink(name, dir_fd=directory_fd)
        removed = True
    if removed:
        _fsync_directory(directory_fd)


def _fsync_directory(directory_fd):
    os.fsync(directory_fd)


def install_pair(cert_path, key_path, target_dir, owner_uid, reader_gid, *, allow_source_key_group_read=False):
    """Publish a pair into an already-created pinned managed directory."""
    cert = _open_source(cert_path, CERT_LIMIT)
    key = None
    directory_fd = None
    temporary = []
    try:
        key = _open_source(key_path, KEY_LIMIT, private=True, allow_group_read=allow_source_key_group_read)
        if _identity(cert[1]) == _identity(key[1]):
            raise ValueError("certificate and private key must be distinct files")
        directory_fd = _open_directory(target_dir, owner_uid, reader_gid, 0o750)
        _remove_stale_temporaries(directory_fd, owner_uid, reader_gid)
        _validate_entries(directory_fd, owner_uid, reader_gid, allow_partial=True)
        copied = {}
        for label, source, mode in (("cert.pem", cert, 0o644), ("key.pem", key, 0o640)):
            temp = f".{label}.{secrets.token_hex(16)}.tmp"
            temporary.append(temp)
            target_fd = os.open(
                temp,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
                0o600,
                dir_fd=directory_fd,
            )
            try:
                copied[label] = _copy_pinned(source, target_fd)
                os.fchown(target_fd, owner_uid, reader_gid)
                os.fchmod(target_fd, mode)
                os.fsync(target_fd)
            finally:
                os.close(target_fd)
        _revalidate(cert, copied["cert.pem"])
        _revalidate(key, copied["key.pem"])
        # Both complete files exist before either public name changes. Caddy is
        # reloaded only after the containing transaction validates the pair.
        for label, temp in zip(("cert.pem", "key.pem"), temporary):
            os.replace(temp, label, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        temporary.clear()
        _fsync_directory(directory_fd)
        _validate_entries(directory_fd, owner_uid, reader_gid, allow_partial=False)
    finally:
        if directory_fd is not None:
            for name in temporary:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(name, dir_fd=directory_fd)
            os.close(directory_fd)
        if key is not None:
            os.close(key[0])
        os.close(cert[0])


def _ensure_managed_directory(unit, reader_gid):
    trusted_path("/etc/codex-harness", directory=True)
    parent_fd = os.open("/etc/codex-harness", DIR_FLAGS)
    try:
        for name, group, mode in (("tls", 0, 0o755), (unit, reader_gid, 0o750)):
            try:
                os.mkdir(name, mode, dir_fd=parent_fd)
                created = True
            except FileExistsError:
                created = False
            child_fd = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
            try:
                current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                opened = os.fstat(child_fd)
                if (
                    not stat.S_ISDIR(opened.st_mode)
                    or _identity(current) != _identity(opened)
                    or opened.st_uid != 0
                    or stat.S_IMODE(opened.st_mode) & 0o022
                ):
                    raise ValueError("managed TLS path is not root-controlled")
                # A root-controlled directory from an earlier interrupted run is
                # safe to normalize for the Caddy reader before reuse.
                os.fchown(child_fd, 0, group)
                os.fchmod(child_fd, mode)
                _fsync_directory(child_fd)
                if created:
                    _fsync_directory(parent_fd)
            except BaseException:
                os.close(child_fd)
                raise
            os.close(parent_fd)
            parent_fd = child_fd
    finally:
        os.close(parent_fd)
    return os.path.join(MANAGED_ROOT, unit)


def _managed_path(unit):
    if not UNIT.fullmatch(unit):
        raise ValueError("invalid gateway unit for managed TLS directory")
    return os.path.join(MANAGED_ROOT, unit)


def snapshot_pair(target_dir, backup_dir, owner_uid, reader_gid):
    directory_fd = _open_directory(target_dir, owner_uid, reader_gid, 0o750)
    try:
        _remove_stale_temporaries(directory_fd, owner_uid, reader_gid)
        names = _validate_entries(directory_fd, owner_uid, reader_gid, allow_partial=True)
        if names != {"cert.pem", "key.pem"}:
            raise IncompletePairError("managed TLS directory contains no complete pair")
    finally:
        os.close(directory_fd)
    os.mkdir(backup_dir, 0o700)
    os.chown(backup_dir, owner_uid, owner_uid)
    os.chmod(backup_dir, 0o700)
    # Backups stay root-private. install_pair expects a 0750 directory, so use
    # a temporary private publishing directory and then tighten it again.
    os.chmod(backup_dir, 0o750)
    install_pair(
        os.path.join(target_dir, "cert.pem"), os.path.join(target_dir, "key.pem"),
        backup_dir, owner_uid, owner_uid, allow_source_key_group_read=True,
    )
    os.chmod(os.path.join(backup_dir, "cert.pem"), 0o600)
    os.chmod(os.path.join(backup_dir, "key.pem"), 0o600)
    os.chmod(backup_dir, 0o700)


def remove_pair(target_dir, owner_uid, reader_gid):
    try:
        directory_fd = _open_directory(target_dir, owner_uid, reader_gid, 0o750)
    except FileNotFoundError:
        return
    try:
        _remove_stale_temporaries(directory_fd, owner_uid, reader_gid)
        _validate_entries(directory_fd, owner_uid, reader_gid, allow_partial=True)
        for name in ("cert.pem", "key.pem"):
            with contextlib.suppress(FileNotFoundError):
                os.unlink(name, dir_fd=directory_fd)
        _fsync_directory(directory_fd)
    finally:
        os.close(directory_fd)
    os.rmdir(target_dir)
    parent_fd = os.open(os.path.dirname(target_dir), DIR_FLAGS)
    try:
        _fsync_directory(parent_fd)
    finally:
        os.close(parent_fd)


def _inventory(target_dir, owner_uid, reader_gid):
    """Validate the entire collection before copying or removing any pair."""
    directory_fd = _open_directory(target_dir, owner_uid, reader_gid, 0o750)
    try:
        _remove_stale_temporaries(directory_fd, owner_uid, reader_gid)
        result = {"": _validate_entries(directory_fd, owner_uid, reader_gid, allow_partial=True, allow_pairs=True)}
        for name in sorted(_directory_names(directory_fd)):
            if not PAIR_DIRECTORY.fullmatch(name):
                continue
            child_fd = _open_directory(os.path.join(target_dir, name), owner_uid, reader_gid, 0o750)
            try:
                _remove_stale_temporaries(child_fd, owner_uid, reader_gid)
                result[name] = _validate_entries(child_fd, owner_uid, reader_gid, allow_partial=True)
            finally:
                os.close(child_fd)
        _check_collection_budget(target_dir, result)
        return result
    finally:
        os.close(directory_fd)


def _check_collection_budget(directory, inventory):
    if len(inventory) - 1 > COLLECTION_PAIR_LIMIT:
        raise ValueError("managed TLS collection exceeds its pair limit")
    total = sum(os.stat(os.path.join(directory, name, entry), follow_symlinks=False).st_size
                for name, entries in inventory.items() for entry in entries)
    if total > COLLECTION_BYTE_LIMIT:
        raise ValueError("managed TLS collection exceeds its byte limit")


def _copy_entries(source_dir, target_dir, names, owner_uid, group_gid, *, private):
    """Copy validated entries into a fresh directory, including partial pairs."""
    directory_fd = _open_directory(target_dir, owner_uid, group_gid, 0o700 if private else 0o750)
    try:
        for name in sorted(names):
            source = _open_source(
                os.path.join(source_dir, name), CERT_LIMIT if name == "cert.pem" else KEY_LIMIT,
                private=name == "key.pem", allow_group_read=True,
            )
            try:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=directory_fd)
                try:
                    copied = _copy_pinned(source, fd)
                    _revalidate(source, copied)
                    os.fchown(fd, owner_uid, group_gid)
                    os.fchmod(fd, 0o600 if private else (0o644 if name == "cert.pem" else 0o640))
                    os.fsync(fd)
                finally:
                    os.close(fd)
            finally:
                os.close(source[0])
        _fsync_directory(directory_fd)
    finally:
        os.close(directory_fd)


def _make_directory(path, owner_uid, group_gid, mode):
    os.mkdir(path, mode)
    os.chown(path, owner_uid, group_gid)
    os.chmod(path, mode)
    parent_fd = os.open(os.path.dirname(path), DIR_FLAGS)
    try:
        _fsync_directory(parent_fd)
    finally:
        os.close(parent_fd)


def install_managed(cert_path, key_path, target_dir, owner_uid, reader_gid):
    # A new immutable identity also protects references from other instances or
    # manually maintained sites. An update never overwrites a referenced pair.
    inventory = _inventory(target_dir, owner_uid, reader_gid)
    if len(inventory) - 1 >= COLLECTION_PAIR_LIMIT:
        raise ValueError("managed TLS collection has no room for another pair")
    pair_dir = os.path.join(target_dir, "pair-" + secrets.token_hex(16))
    _make_directory(pair_dir, owner_uid, reader_gid, 0o750)
    try:
        install_pair(cert_path, key_path, pair_dir, owner_uid, reader_gid)
        _inventory(target_dir, owner_uid, reader_gid)
    except BaseException:
        remove_pair(pair_dir, owner_uid, reader_gid)
        raise
    return pair_dir


def snapshot_managed(target_dir, backup_dir, owner_uid, reader_gid):
    inventory = _inventory(target_dir, owner_uid, reader_gid)
    _make_directory(backup_dir, owner_uid, owner_uid, 0o700)
    for name, entries in inventory.items():
        destination = os.path.join(backup_dir, name)
        if name:
            _make_directory(destination, owner_uid, owner_uid, 0o700)
        _copy_entries(os.path.join(target_dir, name), destination, entries, owner_uid, owner_uid, private=True)


def _backup_inventory(backup_dir, owner_uid):
    result = {}
    parent_fd = _open_directory(backup_dir, owner_uid, owner_uid, 0o700)
    try:
        children = _directory_names(parent_fd) - {"cert.pem", "key.pem"}
        if any(not PAIR_DIRECTORY.fullmatch(name) for name in children):
            raise ValueError("TLS backup contains unexpected entries")
        for name in ["", *sorted(children)]:
            fd = _open_directory(os.path.join(backup_dir, name), owner_uid, owner_uid, 0o700)
            try:
                entries = _directory_names(fd) - (children if not name else set())
                if entries - {"cert.pem", "key.pem"}:
                    raise ValueError("TLS backup contains unexpected entries")
                for entry in entries:
                    info = os.stat(entry, dir_fd=fd, follow_symlinks=False)
                    limit = CERT_LIMIT if entry == "cert.pem" else KEY_LIMIT
                    if not _expected_entry(info, owner_uid, owner_uid, 0o600) or not 0 < info.st_size <= limit:
                        raise ValueError("TLS backup file has unsafe metadata")
                result[name] = entries
            finally:
                os.close(fd)
        _check_collection_budget(backup_dir, result)
        return result
    finally:
        os.close(parent_fd)


def referenced_paths(config):
    """Use Caddy's adapted JSON so imports, snippets and quoted paths count."""
    if not isinstance(config, dict):
        raise ValueError("adapted Caddy configuration must be an object")
    paths, folders = set(), set()
    pending = [config]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            if isinstance(value.get("load_folders"), list):
                folders.update(os.path.realpath(folder) for folder in value["load_folders"] if isinstance(folder, str))
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, str):
            # Resolving symlinks preserves indirect refs. Only load_folders is
            # recursive: an unrelated HTTP route "/" must not retain all keys.
            paths.add(os.path.realpath(value))
    return {"files": paths, "folders": folders}


def remove_managed(target_dir, owner_uid, reader_gid, *, references=None):
    try:
        inventory = _inventory(target_dir, owner_uid, reader_gid)
    except FileNotFoundError:
        if os.path.lexists(target_dir):
            raise
        return
    target_dir = os.fspath(target_dir)
    root_fd = _open_directory(target_dir, owner_uid, reader_gid, 0o750)
    try:
        for name, entries in inventory.items():
            pair_dir = os.path.join(target_dir, name)
            paths = [os.path.realpath(os.path.join(pair_dir, entry)) for entry in ("cert.pem", "key.pem")]
            if references is not None and (
                any(path in references["files"] for path in paths)
                or any(path.startswith(folder.rstrip(os.sep) + os.sep) for path in paths for folder in references["folders"])
            ):
                continue
            if name:
                remove_pair(pair_dir, owner_uid, reader_gid)
            else:
                for entry in entries:
                    os.unlink(entry, dir_fd=root_fd)
        _fsync_directory(root_fd)
        empty = not _directory_names(root_fd)
    finally:
        os.close(root_fd)
    if empty:
        os.rmdir(target_dir)
        parent_fd = os.open(os.path.dirname(target_dir), DIR_FLAGS)
        try:
            _fsync_directory(parent_fd)
        finally:
            os.close(parent_fd)


def restore_managed(target_dir, backup_dir, owner_uid, reader_gid):
    inventory = _backup_inventory(backup_dir, owner_uid)
    remove_managed(target_dir, owner_uid, reader_gid)
    _make_directory(target_dir, owner_uid, reader_gid, 0o750)
    for name, entries in inventory.items():
        destination = os.path.join(target_dir, name)
        if name:
            _make_directory(destination, owner_uid, reader_gid, 0o750)
        _copy_entries(os.path.join(backup_dir, name), destination, entries, owner_uid, reader_gid, private=False)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    install = subparsers.add_parser("install")
    install.add_argument("unit")
    install.add_argument("certificate")
    install.add_argument("private_key")
    install.add_argument("caddy_user")
    snapshot = subparsers.add_parser("snapshot")
    snapshot.add_argument("unit")
    snapshot.add_argument("backup")
    snapshot.add_argument("caddy_user")
    restore = subparsers.add_parser("restore")
    restore.add_argument("unit")
    restore.add_argument("backup")
    restore.add_argument("caddy_user")
    remove = subparsers.add_parser("remove")
    remove.add_argument("unit")
    remove.add_argument("caddy_user")
    prune = subparsers.add_parser("prune")
    prune.add_argument("unit")
    prune.add_argument("caddy_user")
    prune.add_argument("adapted_config")
    args = parser.parse_args(argv)
    if os.name != "posix" or not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise ValueError("managed TLS import requires Linux no-follow descriptors")
    if os.geteuid() != 0:
        raise ValueError("managed TLS import requires root")
    account = pwd.getpwnam(args.caddy_user)
    target = _managed_path(args.unit)
    if args.command == "install":
        target = _ensure_managed_directory(args.unit, account.pw_gid)
        print(install_managed(args.certificate, args.private_key, target, 0, account.pw_gid))
    elif args.command == "snapshot":
        snapshot_managed(target, args.backup, 0, account.pw_gid)
    elif args.command == "restore":
        target = _ensure_managed_directory(args.unit, account.pw_gid)
        restore_managed(target, args.backup, 0, account.pw_gid)
    elif args.command == "prune":
        references = referenced_paths(json.loads(read_text_bounded(args.adapted_config, ADAPTED_CONFIG_LIMIT)))
        remove_managed(target, 0, account.pw_gid, references=references)
    else:
        remove_managed(target, 0, account.pw_gid)


if __name__ == "__main__":
    try:
        main()
    except IncompletePairError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(3) from None
    except (OSError, KeyError, ValueError) as error:
        raise SystemExit(str(error)) from None
