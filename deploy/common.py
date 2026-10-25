from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
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


def fsync_directory(path: Path) -> None:
    if os.name == "posix":
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
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


def mkdir(path: Path, mode: int = 0o755, uid: int | None = None, gid: int | None = None) -> None:
    path.mkdir(parents=True, exist_ok=True)
    require(not path.is_symlink() and path.is_dir(), "Directory is not a real directory", "unsafe_path")
    os.chmod(path, mode)
    if uid is not None and os.name == "posix":
        os.chown(path, uid, gid if gid is not None else -1)


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
        require(role in ("gateway", "worker", "caddy", "authelia", "config-check"), "Invalid service role")
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
