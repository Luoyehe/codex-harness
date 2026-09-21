"""Safely migrate bounded legacy Authelia state as its service account."""
import argparse
import contextlib
import errno
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import sys
import tempfile
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from service_directory import ensure
from service_env import drop_service_privileges, service_account


NOTIFICATION_LIMIT = 8 * 1024 * 1024
DATABASE_LIMIT = 512 * 1024 * 1024
WAL_LIMIT = 256 * 1024 * 1024
SHM_LIMIT = 64 * 1024 * 1024
COPY_CHUNK = 1024 * 1024
MIGRATION_SECONDS = 120


def _identity(info):
    return (info.st_dev, info.st_ino)


def _stable(before, after, copied):
    return (
        _identity(before) == _identity(after)
        and before.st_size == after.st_size == copied
        and before.st_mtime_ns == after.st_mtime_ns
        and before.st_ctime_ns == after.st_ctime_ns
        and after.st_nlink == 1
    )


def _source_flags():
    return (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )


def _open_source(source_path, limit, *, optional=False):
    try:
        before = os.lstat(source_path)
    except FileNotFoundError:
        if optional:
            return None
        raise
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_nlink != 1
        or before.st_size < 0
        or before.st_size > limit
        or before.st_mode & 0o022
        or before.st_uid not in (0, os.geteuid())
    ):
        raise ValueError("legacy Authelia state is not a bounded private regular file")
    fd = os.open(source_path, _source_flags())
    try:
        opened = os.fstat(fd)
        current = os.lstat(source_path)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or opened.st_size > limit
            or _identity(before) != _identity(opened)
            or _identity(opened) != _identity(current)
        ):
            raise ValueError("legacy Authelia state changed while it was opened")
        return fd, opened, limit, source_path
    except BaseException:
        os.close(fd)
        raise


def _write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("short write while migrating Authelia state")
        view = view[written:]


def _copy_pinned(source, target_fd, deadline):
    fd, before, limit, source_path = source
    os.lseek(fd, 0, os.SEEK_SET)
    copied = 0
    while copied <= limit:
        if time.monotonic() > deadline:
            raise TimeoutError("Authelia state migration exceeded its time limit")
        chunk = os.read(fd, min(COPY_CHUNK, limit + 1 - copied))
        if not chunk:
            break
        copied += len(chunk)
        if copied > limit:
            raise ValueError("legacy Authelia state grew beyond its byte limit")
        _write_all(target_fd, chunk)
    after = os.fstat(fd)
    current = os.lstat(source_path)
    if not _stable(before, after, copied) or not _stable(before, current, copied):
        raise ValueError("legacy Authelia state changed during migration")
    return copied


def _revalidate(source, copied):
    fd, before, _limit, source_path = source
    after = os.fstat(fd)
    current = os.lstat(source_path)
    if not _stable(before, after, copied) or not _stable(before, current, copied):
        raise ValueError("legacy Authelia state changed before publication")


def _fsync_parent(target_path):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    try:
        fd = os.open(os.path.dirname(target_path), flags)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError as error:
        if error.errno not in (errno.EINVAL, getattr(errno, "ENOTSUP", errno.EINVAL), getattr(errno, "EOPNOTSUPP", errno.EINVAL)):
            raise


def _copy_to_new_file(source, target_path, deadline):
    fd = os.open(
        target_path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        copied = _copy_pinned(source, fd, deadline)
        os.fsync(fd)
        return copied
    finally:
        os.close(fd)


def _migrate_notification(source_path, temporary, deadline):
    source = _open_source(source_path, NOTIFICATION_LIMIT)
    try:
        copied = _copy_to_new_file(source, temporary, deadline)
        _revalidate(source, copied)
    finally:
        os.close(source[0])


def _migrate_database(source_path, temporary, target_path, deadline):
    sources = {}
    absent = set()
    limits = {"": DATABASE_LIMIT, "-wal": WAL_LIMIT, "-shm": SHM_LIMIT}
    try:
        for suffix, limit in limits.items():
            opened = _open_source(source_path + suffix, limit, optional=suffix != "")
            if opened is None:
                absent.add(suffix)
            else:
                sources[suffix] = opened

        scratch = tempfile.mkdtemp(prefix=".edge-db-source-", dir=os.path.dirname(target_path))
        try:
            copied = {}
            local = os.path.join(scratch, "source.sqlite3")
            for suffix, source in sources.items():
                destination = local + suffix
                copied[suffix] = _copy_to_new_file(source, destination, deadline)

            # All source descriptors stay pinned until every member of the
            # SQLite snapshot is copied. A stopped Authelia unit must not grow,
            # replace, or introduce a WAL/SHM file during that interval.
            for suffix, source in sources.items():
                _revalidate(source, copied[suffix])
            for suffix in absent:
                try:
                    os.lstat(source_path + suffix)
                except FileNotFoundError:
                    continue
                raise ValueError("legacy Authelia database sidecar appeared during migration")

            source_db = sqlite3.connect(Path(local).absolute().as_uri() + "?mode=ro", uri=True, timeout=30)
            target_db = sqlite3.connect(temporary)
            try:
                def progress(_status, _remaining, _total):
                    if time.monotonic() > deadline:
                        raise TimeoutError("Authelia database backup exceeded its time limit")
                source_db.backup(target_db, pages=256, progress=progress, sleep=0.01)
                target_db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10_000)
                result = target_db.execute("PRAGMA quick_check").fetchone()
                if not result or result[0] != "ok":
                    raise ValueError("SQLite backup integrity check failed")
                target_db.commit()
            finally:
                target_db.close()
                source_db.close()
            fd = os.open(temporary, _source_flags())
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
    finally:
        for source in sources.values():
            os.close(source[0])

def migrate(kind, source_path, target_path):
    if os.geteuid() == 0:
        raise ValueError("Authelia state migration must be unprivileged")
    ensure(os.path.dirname(target_path), private=True)
    deadline = time.monotonic() + MIGRATION_SECONDS
    fd, temporary = tempfile.mkstemp(prefix=".edge-migration-", dir=os.path.dirname(target_path))
    os.close(fd)
    # Database migration needs SQLite to open the path itself; notification
    # migration requires O_EXCL. Remove the placeholder in both cases.
    os.unlink(temporary)
    try:
        if kind == "database":
            open_fd = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
                0o600,
            )
            os.close(open_fd)
            _migrate_database(source_path, temporary, target_path, deadline)
        else:
            _migrate_notification(source_path, temporary, deadline)
        os.replace(temporary, target_path)
        # Stale sidecars belong to the replaced target database. Remove them
        # only after the new main database has been published: deleting them
        # first could discard committed target WAL data if publication failed.
        if kind == "database":
            for suffix in ("-wal", "-shm"):
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(target_path + suffix)
        _fsync_parent(target_path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("database", "notification"))
    parser.add_argument("source")
    parser.add_argument("target")
    args = parser.parse_args()
    account = service_account("authelia")
    drop_service_privileges("authelia")
    if os.geteuid() != account.pw_uid:
        raise ValueError("migration must run as the Authelia service account")
    migrate(args.kind, args.source, args.target)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TimeoutError, sqlite3.Error) as error:
        raise SystemExit(str(error)) from None
