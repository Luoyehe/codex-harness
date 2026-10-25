"""Bounded, descriptor-relative import of untrusted trees.

The producer must be confirmed stopped before snapshot(). A live producer is never
made safe merely by hashing its output. Root owns the destination from creation.
"""
from __future__ import annotations

import hashlib
import os
import posixpath
import stat
from pathlib import Path, PurePosixPath

from .archive import open_archive
from .common import DeployError, fsync_directory, require

MAX_FILES = 150_000
MAX_BYTES = 3 * 1024**3
MAX_FILE = 512 * 1024**2


def stable_identity(status):
    return (status.st_dev, status.st_ino, status.st_mode, status.st_uid, status.st_gid,
            status.st_nlink, status.st_size, status.st_mtime_ns, status.st_ctime_ns)


def tree_mkdir(path: Path, root: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o755)
    for item in [path, *path.parents]:
        if item == root.parent:
            break
        require(not item.is_symlink(), "Directory is a symlink", "unsafe_path")
        os.chmod(item, 0o755)


def bounded_names(directory: Path | int, remaining: int) -> list[str]:
    """Consume at most the remaining budget plus the first rejected entry."""
    names = []
    with os.scandir(directory) as listing:
        for entry in listing:
            require(len(names) < remaining, "Tree has too many files", "budget")
            names.append(entry.name)
    names.sort()
    return names


def prefixes(parts):
    prefix = ""
    for part in parts:
        prefix = prefix + "/" + part if prefix else part
        yield prefix


def safe_relative(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    require(bool(name) and not path.is_absolute() and all(p not in ("", ".", "..") for p in name.split("/"))
            and "\\" not in name and ":" not in name and "\x00" not in name, "Unsafe archive path", "unsafe_path")
    return path


def safe_link(name: str, target: str) -> str:
    require(target and not target.startswith("/") and "\\" not in target and ":" not in target and "\x00" not in target,
            "Absolute or invalid symlink", "unsafe_path")
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
    require(resolved != ".." and not resolved.startswith("../"), "Symlink leaves release", "unsafe_path")
    return resolved


def extract_tar(archive: Path, destination: Path, strip: int = 0) -> None:
    """Never use extractall: links are last and never used as write parents."""
    destination.mkdir(mode=0o755, parents=False, exist_ok=False)
    os.chmod(destination, 0o755)
    entries: dict[str, tuple[str, str | None]] = {}
    directories: set[str] = set()
    entry_count = 0
    total = 0
    with open_archive(archive, max_file=MAX_FILE, max_members=MAX_FILES, max_bytes=MAX_BYTES) as source:
        index = 0
        while (item := source.next()) is not None:
            # We use only the current member. Retaining every PAX dictionary
            # would amplify global metadata into an unbounded parser cache.
            source.members.clear()
            require(index < MAX_FILES, "Archive has too many files", "budget")
            index += 1
            raw = item.name.rstrip("/")
            if not raw:
                continue
            safe_relative(raw)
            parts = PurePosixPath(raw).parts[strip:]
            if not parts:
                continue
            name = "/".join(parts)
            require(name not in entries, "Duplicate archive member", "unsafe_path")
            require(not any(entries.get(str(parent), ("dir",))[0] != "dir" for parent in PurePosixPath(name).parents if str(parent) != "."),
                    "Archive member has a non-directory ancestor", "unsafe_path")
            if item.isdir():
                kind = "dir"
            elif item.issym():
                kind = "link"
                safe_link(name, item.linkname)
            elif item.isreg():
                kind = "file"
                require(0 <= item.size <= MAX_FILE, "Archive file exceeds budget", "budget")
                total += item.size
                require(total <= MAX_BYTES, "Archive exceeds budget", "budget")
            else:
                raise DeployError("unsafe_path", "Hardlinks, devices and special archive members are prohibited")
            require(name not in directories or kind == "dir", "Archive member replaces an implicit directory", "unsafe_path")
            directory_parts = parts if kind == "dir" else parts[:-1]
            # Reserve the entire member before creating any parent. Implicit
            # directories count once even if a later header names them, and a
            # delayed symlink consumes its slot before it is finally created.
            added = sum(prefix not in directories for prefix in prefixes(directory_parts)) + (kind != "dir")
            require(entry_count + added <= MAX_FILES, "Archive filesystem entry budget exceeded", "budget")
            entry_count += added
            target = destination / name
            tree_mkdir(target if kind == "dir" else target.parent, destination)
            directories.update(prefixes(directory_parts))
            if kind == "dir":
                entries[name] = ("dir", None)
            elif kind == "link":
                entries[name] = ("link", item.linkname)
            else:
                entries[name] = ("file", None)
                incoming = source.extractfile(item)
                require(incoming is not None, "Missing archive member", "unsafe_path")
                with target.open("xb") as output:
                    left = item.size
                    while left:
                        block = incoming.read(min(left, 1024**2))
                        require(bool(block), "Truncated archive", "unsafe_path")
                        output.write(block)
                        left -= len(block)
                os.chmod(target, 0o755 if item.mode & 0o111 else 0o644)
    for name, (kind, target) in entries.items():
        if kind == "link":
            os.symlink(target, destination / name)
    check_links(destination)


def check_links(root: Path) -> None:
    resolved_root = root.resolve()
    for parent, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            item = Path(parent) / name
            if item.is_symlink():
                try:
                    target = item.resolve(strict=True)
                except (OSError, RuntimeError) as exc:
                    raise DeployError("unsafe_path", "Dangling or cyclic release link") from exc
                require(target.is_relative_to(resolved_root), "Symlink escapes release", "unsafe_path")


def snapshot(source: Path, destination: Path, *, producer_stopped: bool, expected_uid: int | None = None) -> dict:
    require(producer_stopped, "Producer stop is not confirmed", "stop_unknown")
    require(os.name == "posix", "Secure snapshots require Linux", "unsupported_platform")
    destination.mkdir(mode=0o755, exist_ok=False)
    os.chmod(destination, 0o755)
    source_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    manifest = {}
    total = 0
    reserved = 0

    def visit(fd: int, prefix: str):
        nonlocal total, reserved
        names = bounded_names(fd, MAX_FILES - reserved)
        reserved += len(names)
        for name in names:
            relative = prefix + name
            safe_relative(relative)
            require(len(manifest) < MAX_FILES, "Tree has too many files", "budget")
            before = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if expected_uid is not None:
                require(before.st_uid == expected_uid, "Unexpected producer ownership", "unsafe_path")
            target = destination / relative
            if stat.S_ISDIR(before.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    require(os.fstat(child).st_ino == before.st_ino, "Directory changed during import", "unsafe_path")
                    target.mkdir(mode=0o755)
                    os.chmod(target, 0o755)
                    manifest[relative] = {"type": "dir", "mode": 0o755}
                    visit(child, relative + "/")
                finally:
                    os.close(child)
            elif stat.S_ISLNK(before.st_mode):
                link = os.readlink(name, dir_fd=fd)
                safe_link(relative, link)
                require(stable_identity(os.stat(name, dir_fd=fd, follow_symlinks=False)) == stable_identity(before), "Link changed during import", "unsafe_path")
                os.symlink(link, target)
                manifest[relative] = {"type": "link", "target": link}
            elif stat.S_ISREG(before.st_mode):
                require(before.st_nlink == 1 and before.st_size <= MAX_FILE, "Hardlink or oversized file", "unsafe_path")
                total += before.st_size
                require(total <= MAX_BYTES, "Tree exceeds byte budget", "budget")
                item_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    opened = os.fstat(item_fd)
                    require(stable_identity(opened) == stable_identity(before), "File changed before import", "unsafe_path")
                    sha = hashlib.sha256()
                    size = 0
                    with target.open("xb") as out:
                        while block := os.read(item_fd, 1024**2):
                            size += len(block)
                            require(size <= before.st_size, "File grew during import", "unsafe_path")
                            sha.update(block)
                            out.write(block)
                        out.flush()
                        os.fsync(out.fileno())
                    require(stable_identity(os.fstat(item_fd)) == stable_identity(before) and size == before.st_size, "File changed during import", "unsafe_path")
                    mode = 0o755 if before.st_mode & 0o111 else 0o644
                    os.chmod(target, mode)
                    manifest[relative] = {"type": "file", "mode": mode, "bytes": size, "sha256": sha.hexdigest()}
                finally:
                    os.close(item_fd)
            else:
                raise DeployError("unsafe_path", "Special file in candidate")
    try:
        visit(source_fd, "")
    finally:
        os.close(source_fd)
    check_links(destination)
    fsync_directory(destination)
    return manifest


def inspect_tree(root: Path, *, root_owned: bool = False) -> dict:
    """Read a stopped/root-owned tree for verification, including every root file."""
    result = {}
    total = 0
    reserved = 0
    pending = [root]
    while pending:
        parent = pending.pop()
        names = bounded_names(parent, MAX_FILES - reserved)
        reserved += len(names)
        children = []
        for name in names:
            path = parent / name
            rel = path.relative_to(root).as_posix()
            status = path.lstat()
            require(len(result) < MAX_FILES, "Tree file budget exceeded", "budget")
            if root_owned and os.name == "posix":
                require(status.st_uid == 0 and (stat.S_ISLNK(status.st_mode) or not status.st_mode & 0o022),
                        "Release is not exclusively root writable", "unsafe_path")
            if path.is_symlink():
                target = os.readlink(path)
                safe_link(rel, target)
                result[rel] = {"type": "link", "target": target}
            elif stat.S_ISDIR(status.st_mode):
                result[rel] = {"type": "dir", "mode": stat.S_IMODE(status.st_mode)}
                children.append(path)
            elif stat.S_ISREG(status.st_mode):
                require(status.st_nlink == 1 and status.st_size <= MAX_FILE, "Unsafe release file", "unsafe_path")
                total += status.st_size
                require(total <= MAX_BYTES, "Tree byte budget exceeded", "budget")
                with path.open("rb") as inp:
                    sha = hashlib.file_digest(inp, "sha256").hexdigest()
                result[rel] = {"type": "file", "mode": stat.S_IMODE(status.st_mode), "bytes": status.st_size, "sha256": sha}
            else:
                raise DeployError("unsafe_path", "Special release file")
        pending.extend(reversed(children))
    check_links(root)
    return result
