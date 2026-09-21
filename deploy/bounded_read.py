"""Small, stable reads for deployment control files.

Deployment commands commonly run as root.  A regular ``Path.read_text`` can
both follow an unexpected final symlink and allocate until the backing file
ends.  This helper pins one descriptor, rejects non-regular inputs, caps the
read before decoding, and refuses a snapshot whose inode metadata changed
while it was being consumed.
"""

from __future__ import annotations

import os
from pathlib import Path
import stat


def _identity(info: os.stat_result) -> tuple[int, ...]:
    return (
        info.st_dev,
        info.st_ino,
        info.st_mode,
        info.st_nlink,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def read_bytes_bounded(
    path: str | os.PathLike[str],
    limit: int,
    *,
    missing_ok: bool = False,
    nofollow: bool = True,
) -> bytes:
    if limit < 0:
        raise ValueError("read limit must not be negative")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
    if nofollow:
        flags |= getattr(os, "O_NOFOLLOW", 0)
    path = Path(path)
    path_before = None
    if nofollow:
        try:
            path_before = os.lstat(path)
        except FileNotFoundError:
            if not missing_ok:
                raise
            # Absence is a state too: do not return an empty snapshot if the
            # name appeared during the failed-open window.
            try:
                os.lstat(path)
            except FileNotFoundError:
                return b""
            raise ValueError(f"file appeared while it was inspected: {path}") from None
    try:
        descriptor = os.open(Path(path), flags)
    except FileNotFoundError:
        if missing_ok:
            return b""
        raise
    try:
        before = os.fstat(descriptor)
        if path_before is not None and (
            path_before.st_dev != before.st_dev or path_before.st_ino != before.st_ino
        ):
            raise ValueError(f"file changed while it was opened: {path}")
        if not stat.S_ISREG(before.st_mode):
            raise ValueError(f"expected a regular file: {path}")
        if before.st_size > limit:
            raise ValueError(f"file exceeds {limit} byte limit: {path}")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            payload = stream.read(limit + 1)
        after = os.fstat(descriptor)
        if len(payload) > limit:
            raise ValueError(f"file exceeds {limit} byte limit: {path}")
        path_after = os.lstat(path) if nofollow else None
        if (len(payload) != before.st_size or _identity(before) != _identity(after)
                or path_after is not None and (
                    path_after.st_dev != after.st_dev or path_after.st_ino != after.st_ino
                    or _identity(path_before) != _identity(path_after)
                )):
            raise ValueError(f"file changed while it was read: {path}")
        return payload
    finally:
        os.close(descriptor)


def read_text_bounded(
    path: str | os.PathLike[str],
    limit: int,
    *,
    missing_ok: bool = False,
    nofollow: bool = True,
) -> str:
    return read_bytes_bounded(path, limit, missing_ok=missing_ok, nofollow=nofollow).decode("utf-8")
