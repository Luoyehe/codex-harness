"""Import user-supplied TLS material into a root-managed Caddy directory."""
import argparse
import contextlib
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


CERT_LIMIT = 8 * 1024 * 1024
KEY_LIMIT = 1024 * 1024
COPY_CHUNK = 64 * 1024
MANAGED_ROOT = "/etc/codex-harness/tls"
UNIT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
TEMPORARY = re.compile(r"\.(cert|key)\.pem\.[0-9a-f]{32}\.tmp")
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


def _validate_entries(directory_fd, owner_uid, group_gid, *, allow_partial):
    names = set(os.listdir(directory_fd))
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
    for name in os.listdir(directory_fd):
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
    args = parser.parse_args(argv)
    if os.name != "posix" or not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise ValueError("managed TLS import requires Linux no-follow descriptors")
    if os.geteuid() != 0:
        raise ValueError("managed TLS import requires root")
    account = pwd.getpwnam(args.caddy_user)
    target = _managed_path(args.unit)
    if args.command == "install":
        target = _ensure_managed_directory(args.unit, account.pw_gid)
        install_pair(args.certificate, args.private_key, target, 0, account.pw_gid)
        print(os.path.join(target, "cert.pem") + "\t" + os.path.join(target, "key.pem"))
    elif args.command == "snapshot":
        snapshot_pair(target, args.backup, 0, account.pw_gid)
    elif args.command == "restore":
        target = _ensure_managed_directory(args.unit, account.pw_gid)
        install_pair(os.path.join(args.backup, "cert.pem"), os.path.join(args.backup, "key.pem"), target, 0, account.pw_gid)
    else:
        remove_pair(target, 0, account.pw_gid)


if __name__ == "__main__":
    try:
        main()
    except IncompletePairError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(3) from None
    except (OSError, KeyError, ValueError) as error:
        raise SystemExit(str(error)) from None
