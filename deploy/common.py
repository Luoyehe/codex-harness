from __future__ import annotations

import contextlib
import errno
import hashlib
import json
import os
import re
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path

NODE_VERSION = "24.22.1"
PNPM_VERSION = "11.22.0"
CODEX_VERSION = "0.164.0"
INSTANCE = re.compile(r"[a-z][a-z0-9-]{0,19}\Z")


class DeployError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def require(condition: bool, message: str, code: str = "invalid_input") -> None:
    if not condition:
        raise DeployError(code, message)


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def read_json(path: Path, limit: int = 1024 * 1024):
    with path.open("rb") as source:
        data = source.read(limit + 1)
    require(len(data) <= limit, "JSON file exceeds limit", "corrupt_state")
    return json.loads(data)


def fsync_directory(path: Path, *, descriptor: int | None = None) -> None:
    if os.name == "posix":
        if descriptor is not None:
            os.fsync(descriptor)
            return
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def atomic_write(path: Path, data: bytes, mode: int = 0o600, uid: int | None = None, gid: int | None = None) -> None:
    """Replace a file within an already trusted parent; never follow its old link."""
    fd, name = tempfile.mkstemp(prefix=".new-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fchmod(output.fileno(), mode) if os.name == "posix" else os.chmod(name, mode)
            if uid is not None and os.name == "posix":
                os.fchown(output.fileno(), uid, gid if gid is not None else -1)
            os.fsync(output.fileno())
        os.replace(name, path)
        fsync_directory(path.parent)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name)


def write_json(path: Path, value: object, **kwargs) -> None:
    atomic_write(path, canonical(value) + b"\n", **kwargs)


def durable_directory(path: Path, *, create: bool = False, mode: int | None = None,
                      uid: int | None = None, gid: int | None = None,
                      shared_root: Path | None = None) -> None:
    """Publish a trusted directory and its ancestry, including interrupted retries.

    Existing ancestors are never chmod/chowned. Only an explicitly supplied
    final-directory mode/owner is applied; callers creating shared containers
    leave these unset. Syncing only newly created entries is insufficient: an
    earlier attempt may have stopped after mkdir and before its parent fsync.
    shared_root opts service-shared callers into root ownership and traversal
    checks below the deployment root; it never repairs existing ancestor modes.
    """
    require(".." not in path.parts, "Directory ancestry is not canonical", "unsafe_path")
    path = path.absolute()
    if shared_root is not None:
        require(".." not in shared_root.parts, "Shared directory root is not canonical", "unsafe_path")
        shared_root = shared_root.absolute()
        require(path.is_relative_to(shared_root), "Shared directory escaped its deployment root", "unsafe_path")
    chain = list(reversed(path.parents)) + [path]
    if os.name != "posix":
        # Windows is a portable validation environment, not a directory-fsync
        # implementation. Still reject links/reparse points before chmod.
        for directory in chain:
            if create and directory != Path(path.anchor):
                try:
                    directory.mkdir()
                except FileExistsError:
                    pass
            info = directory.lstat()
            require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and
                    not getattr(info, "st_file_attributes", 0) & 0x400,
                    "Directory is not a real directory", "unsafe_path")
        if mode is not None:
            os.chmod(path, mode)
        for directory in reversed(chain):
            fsync_directory(directory)
        return
    descriptors = []
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        for directory in chain:
            parent = descriptors[-1] if descriptors else None
            name = directory.name if parent is not None else str(directory)
            created = False
            creation_mode = mode if directory == path and mode is not None else 0o755
            try:
                try:
                    fd = os.open(name, flags, dir_fd=parent)
                except FileNotFoundError:
                    if not create:
                        raise
                    try:
                        os.mkdir(name, creation_mode, dir_fd=parent)
                        created = True
                    except FileExistsError:
                        pass
                    fd = os.open(name, flags, dir_fd=parent)
            except OSError as exc:
                if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                    raise DeployError("unsafe_path", "Directory is not a real directory") from exc
                raise
            descriptors.append(fd)
            if created:
                # umask may restrict newly created shared traversal parents.
                # Never apply this normalization to a pre-existing directory.
                os.fchmod(fd, creation_mode)
            if directory == path:
                if mode is not None:
                    os.fchmod(fd, mode)
                if uid is not None:
                    os.fchown(fd, uid, gid if gid is not None else -1)
            if shared_root is not None and shared_root in directory.parents:
                info = os.fstat(fd)
                require(info.st_uid == 0 and info.st_mode & 0o111 == 0o111,
                        "Shared service directory requires root ownership and owner/group/other traversal; "
                        "inspect its permissions before retrying initialization: " + str(directory), "unsafe_path")
        # Use the verified descriptors rather than reopening paths that could
        # now name a different directory. Parents persist every child name.
        for directory, fd in reversed(list(zip(chain, descriptors))):
            fsync_directory(directory, descriptor=fd)
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def mkdir(path: Path, mode: int = 0o755, uid: int | None = None, gid: int | None = None) -> None:
    durable_directory(path, create=True, mode=mode, uid=uid, gid=gid)


@dataclass(frozen=True)
class Layout:
    instance: str
    root: Path = Path("/")  # Only tests construct a relocated layout; CLI never accepts it.

    def __post_init__(self):
        require(bool(INSTANCE.fullmatch(self.instance)), "Instance must match [a-z][a-z0-9-]{0,19}")

    @property
    def app(self): return self.root / "opt/codex-harness" / self.instance
    @property
    def config(self): return self.root / "etc/codex-harness" / self.instance
    @property
    def state(self): return self.root / "var/lib/codex-harness-instances" / self.instance
    @property
    def control(self): return self.root / "usr/lib/codex-harness" / self.instance
    @property
    def work(self): return self.root / "var/cache/codex-harness" / self.instance
    @property
    def run(self): return self.root / "run" / ("codex-harness-" + self.instance)
    @property
    def units(self): return self.root / "etc/systemd/system"
    @property
    def prefix(self): return "ch-" + self.instance

    def unit(self, role: str) -> str:
        require(role in ("gateway", "worker", "caddy", "authelia", "config-check", "proxy", "proxy-routes"), "Invalid service role")
        return "codex-harness-" + self.instance + "-" + role + ".service"


@contextlib.contextmanager
def exclusive(path: Path):
    import fcntl  # Linux only; validation modules remain importable elsewhere.
    with path.open("a+b") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise DeployError("busy", "Another management transaction is running") from exc
        yield
