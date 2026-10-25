"""Native-identity descriptor paths. No caller-selected host command or home."""
from __future__ import annotations

import ctypes
import errno
import hashlib
import os
import re
import stat
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

from .common import DeployError, canonical, require

MAX_FILE = 512 * 1024
MAX_ENTRIES = 1000
RESERVED = ".harness-workspace"


def relative(value: object, *, empty: bool = False) -> list[str]:
    require(isinstance(value, str) and len(value.encode()) <= 4096 and (empty or bool(value)), "Invalid relative workspace path")
    require(not value.startswith("/") and "\\" not in value and not any(ord(c) < 32 or ord(c) == 127 for c in value),
            "Workspace paths must be relative and contain no control characters")
    parts = value.split("/") if value else []
    require(all(part not in ("", ".", "..", ".git", RESERVED) and len(part.encode()) <= 255 for part in parts),
            "Workspace path contains a reserved or escaping component")
    return parts


def revision(info: os.stat_result, content: bytes | None = None) -> str:
    return hashlib.sha256(canonical({"device": info.st_dev, "inode": info.st_ino, "size": info.st_size, "mode": stat.S_IMODE(info.st_mode),
                                    "mtime": info.st_mtime_ns, "content": hashlib.sha256(content).hexdigest() if content is not None else None})).hexdigest()


def regular(fd: int) -> os.stat_result:
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "Only ordinary single-link files are supported", "unsafe_path")
    return info


def read_file(fd: int, limit: int = MAX_FILE) -> tuple[bytes, os.stat_result]:
    before = regular(fd)
    require(before.st_size <= limit, "Workspace file exceeds byte budget", "budget")
    data = bytearray()
    while len(data) <= limit:
        block = os.read(fd, min(65536, limit + 1 - len(data)))
        if not block:
            break
        data.extend(block)
    after = regular(fd)
    require(len(data) <= limit, "Workspace file exceeds byte budget", "budget")
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
            "Workspace file changed during read", "conflict")
    return bytes(data), after


def rename_absent(source_fd: int, source: str, target_fd: int, target: str) -> None:
    # Both directions are descriptor-relative, and the kernel refuses a target
    # appearing between validation and rename. No shell or path-based fallback.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    require(rename is not None, "Atomic no-replace rename is unavailable", "unsupported_platform")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(source_fd, os.fsencode(source), target_fd, os.fsencode(target), 1) != 0:
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            raise DeployError("conflict", "Workspace destination changed; recovery material retained")
        if error == errno.EXDEV:
            raise DeployError("unsupported_path", "Workspace mutation cannot cross a filesystem boundary")
        raise OSError(error, os.strerror(error))
    os.fsync(source_fd)
    if target_fd != source_fd:
        os.fsync(target_fd)


def open_directory(path: Path) -> int:
    """Pin a real directory without requiring read permission on ancestors."""
    parts = PurePosixPath(str(path)).parts[1:]
    fd = os.open("/", (os.O_PATH if parts else os.O_RDONLY) | os.O_DIRECTORY)
    try:
        for index, part in enumerate(parts):
            # Ancestors need search permission, never directory listing.
            # The actual directory retains read/fsync capabilities.
            access = os.O_RDONLY if index == len(parts) - 1 else os.O_PATH
            next_fd = os.open(part, access | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


class Root:
    def __init__(self, value: object, forbidden: list[Path]):
        require(isinstance(value, str) and value.startswith("/") and len(value.encode()) <= 4096 and
                not any(ord(c) < 32 or ord(c) == 127 for c in value), "Invalid registered workspace root")
        require(os.name == "posix" and hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_PATH"), "Workspace helper requires Linux descriptor paths", "unsupported_platform")
        self.path = Path(value)
        require(not any(part in (".git", RESERVED) for part in self.path.parts), "Workspace root names reserved metadata", "forbidden_path")
        require(str(self.path) == value and self.path.resolve(strict=True) == self.path, "Workspace root must be canonical", "unsafe_path")
        for blocked in forbidden:
            try:
                blocked = blocked.resolve(strict=False)
            except PermissionError as exc:
                # A missing canonical protected root is not permission to omit
                # it. Fixed deployment paths must remain resolvable for scope
                # validation even when their contents are unreadable.
                raise DeployError("protected_path_unresolved", "Protected workspace boundaries could not be resolved") from exc
            require(self.path != blocked and blocked not in self.path.parents and self.path not in blocked.parents,
                    "Workspace root overlaps managed settings or control storage", "forbidden_path")
        self.fd = open_directory(self.path)

    def close(self):
        os.close(self.fd)

    @contextmanager
    def parent(self, value: object):
        parts = relative(value)
        fd = os.dup(self.fd)
        try:
            for part in parts[:-1]:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            yield fd, parts[-1]
        finally:
            os.close(fd)

    @contextmanager
    def directory(self, value: object):
        parts = relative(value, empty=True)
        fd = os.dup(self.fd)
        try:
            for part in parts:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            yield fd
        finally:
            os.close(fd)

    def file(self, value: object, limit: int = MAX_FILE) -> tuple[bytes, os.stat_result]:
        with self.parent(value) as (parent, name):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                return read_file(fd, limit)
            finally:
                os.close(fd)


def valid_revision(value: object) -> str:
    require(isinstance(value, str) and re.fullmatch("[0-9a-f]{64}", value) is not None, "Expected file revision is required")
    return value
