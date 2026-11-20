"""Read-only Git content queries without loading repository callback config."""
from __future__ import annotations

import os
import re
import tempfile
from contextlib import contextmanager
from pathlib import Path

from .common import require
from .workspace_paths import open_directory, read_file

INDEX_LIMIT = 16 * 1024 * 1024
VIEW_LIMIT = 32 * 1024 * 1024


def directory(path: Path) -> int:
    require(path.is_absolute() and path.resolve(strict=True) == path, "Git metadata path is not canonical", "unsafe_path")
    return open_directory(path)


def read_index_state(parent: int, name: str) -> tuple[bytes, os.stat_result]:
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        return read_file(fd, INDEX_LIMIT)
    finally:
        os.close(fd)


def read_index(parent: int, name: str) -> bytes:
    return read_index_state(parent, name)[0]


def config_filemode(root, path):
    from .workspace_git import git
    value = git(root, ["config", "--no-includes", "--file", str(path), "--type=bool", "--get", "core.filemode"],
                allow_missing=True, output_limit=4096)
    require(value in (b"", b"false\n", b"true\n"), "Invalid core.filemode", "git_unavailable")
    return value != b"false\n"


@contextmanager
def content_view(root, git_dir: Path, common_dir: Path):
    from .workspace_git import git
    metadata = directory(git_dir)
    objects = None
    try:
        objects = directory(common_dir / "objects")
        head = git(root, ["rev-parse", "--verify", "-q", "HEAD"], allow_missing=True).strip()
        require(not head or re.fullmatch(b"(?:[0-9a-f]{40}|[0-9a-f]{64})", head) is not None, "Invalid Git HEAD", "git_unavailable")
        algorithm = git(root, ["rev-parse", "--show-object-format"]).strip()
        require(algorithm in (b"sha1", b"sha256"), "Unsupported Git object format", "git_unavailable")
        with tempfile.TemporaryDirectory(prefix="harness-git-view-") as name:
            view = Path(name)
            os.chmod(view, 0o700)
            (view / "refs").mkdir(mode=0o700)
            # The pinned object descriptor is passed to Git. No user config,
            # include directives, hooks, filter commands or credential helpers
            # are copied into this view. Native content queries never modify
            # the original index or worktree metadata.
            os.symlink(f"/proc/self/fd/{objects}", view / "objects")
            config = b"[core]\nrepositoryFormatVersion = " + (b"1" if algorithm == b"sha256" else b"0") + b"\nbare = false\n"
            if algorithm == b"sha256":
                config += b"[extensions]\nobjectFormat = sha256\n"
            common_fd = directory(common_dir)
            try:
                try:
                    raw_config = read_index(common_fd, "config")
                except FileNotFoundError:
                    raw_config = b""
                # Let Git parse its own byte format, without loading includes or
                # projecting other settings into the restricted content view.
                source = view / "repository-config"
                source.write_bytes(raw_config)
                mode = config_filemode(root, source)
                source.unlink()
                config += b"[core]\nfileMode = " + (b"true" if mode else b"false") + b"\n"
                try:
                    info_fd = os.open("info", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=common_fd)
                except FileNotFoundError:
                    info_fd = None
                if info_fd is not None:
                    try:
                        for info_name in ("exclude", "attributes"):
                            try:
                                content = read_index(info_fd, info_name)
                                require(len(content) <= 1024 * 1024, "Git info file exceeds safe view budget", "budget")
                            except FileNotFoundError:
                                continue
                            # Attributes are declarative. Retaining them lets
                            # staging reject transformations without copying
                            # or executing the repository's filter commands.
                            (view / "info").mkdir(mode=0o700, exist_ok=True)
                            (view / "info" / info_name).write_bytes(content)
                    finally:
                        os.close(info_fd)
            finally:
                os.close(common_fd)
            (view / "config").write_bytes(config)
            (view / "HEAD").write_bytes(head + b"\n" if head else b"ref: refs/heads/unborn\n")
            names = []
            with os.scandir(metadata) as listing:
                for entry in listing:
                    if entry.name == "index" or re.fullmatch(r"sharedindex\.[0-9a-f]{40}(?:[0-9a-f]{24})?", entry.name):
                        names.append(entry.name)
                        require(len(names) <= 33, "Git index view exceeds entry budget", "budget")
            total = 0
            for entry in names:
                data, info = read_index_state(metadata, entry)
                total += len(data)
                require(total <= VIEW_LIMIT, "Git index view exceeds byte budget", "budget")
                (view / entry).write_bytes(data)
                # Git uses the index timestamp to recognize racy stat-cache
                # matches. A newer copy can hide same-size, same-tick edits.
                os.utime(view / entry, ns=(info.st_atime_ns, info.st_mtime_ns))
            environment = {"GIT_DIR": str(view), "GIT_COMMON_DIR": str(view), "GIT_WORK_TREE": f"/proc/self/fd/{root.fd}",
                           "GIT_INDEX_FILE": str(view / "index"), "GIT_OBJECT_DIRECTORY": f"/proc/self/fd/{objects}",
                           "GIT_ATTR_NOSYSTEM": "1"}
            yield environment, (objects,)
    finally:
        if objects is not None:
            os.close(objects)
        os.close(metadata)
