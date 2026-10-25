"""Bounded, read-only native resources selected by a fresh supervisor catalog."""
from __future__ import annotations

import hashlib
import os
import stat
from pathlib import Path, PurePosixPath

from .common import Layout, digest, require
from .workspace_paths import Root, read_file, relative, revision

ACTIONS = {"resource/skill/read", "resource/directory/resolve", "resource/plugin/preview"}


def absolute_skill(value: object) -> Path:
    require(isinstance(value, str) and value.startswith("/") and len(value.encode()) <= 4096 and
            "\\" not in value and not any(ord(char) < 32 or ord(char) == 127 for char in value),
            "Invalid catalog skill path")
    path = PurePosixPath(value)
    require(str(path) == value and path.name == "SKILL.md", "Catalog resource must name a canonical SKILL.md")
    relative(value[1:])
    return Path(value)


def validate(action: str, params: dict) -> None:
    require(action in ACTIONS and set(params) <= {"path"}, "Unsupported resource request")
    if action == "resource/skill/read":
        absolute_skill(params.get("path"))
    else:
        relative(params.get("path", ""), empty=True)


def location(fd: int, expected: Path) -> None:
    # The descriptor walk rejects links; verify the pinned directory did not
    # move outside its selected location while opening/reading its contents.
    require(os.readlink(f"/proc/self/fd/{fd}") == str(expected),
            "Resource directory moved during validation", "conflict")


def read_skill(root: Root, params: dict, layout: Layout, settings: dict, forbidden: list[Path]) -> dict:
    path = absolute_skill(params["path"])
    bases = [root.path, Path(settings["cwd"]) / ".agents/skills", Path(settings["home"]) / "skills",
             Path(settings["home"]) / "plugins/cache", layout.root / "etc/codex/skills"]
    selected = next((base for base in sorted(bases, key=lambda value: len(value.parts), reverse=True)
                     if base in path.parents), None)
    require(selected is not None, "Skill lies outside the registered project and fixed skill roots", "forbidden_path")
    # Only these fixed resource roots may enter CODEX_HOME. The ordinary
    # workspace interface continues to forbid that whole directory.
    protected = [entry for entry in forbidden if entry != Path(settings["home"])]
    resource = root if selected == root.path else Root(str(selected), protected)
    try:
        with resource.parent(path.relative_to(selected).as_posix()) as (parent, name):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                data, info = read_file(fd)
                location(parent, path.parent)
                location(fd, path)
            finally:
                os.close(fd)
        location(resource.fd, selected)
        try:
            text = data.decode("utf-8", "strict")
        except UnicodeDecodeError:
            require(False, "Skill content is not UTF-8 text", "unsupported_resource")
        require("\0" not in text, "Skill content contains binary data", "unsupported_resource")
        return {"path": str(path), "text": text, "bytes": len(data), "revision": revision(info, data)}
    finally:
        if resource is not root:
            resource.close()


def resolve_directory(root: Root, params: dict) -> dict:
    name = params.get("path", "")
    relative(name, empty=True)
    expected = root.path / name
    with root.directory(name) as directory:
        location(directory, expected)
        info = os.fstat(directory)
        return {"path": str(expected), "device": info.st_dev, "inode": info.st_ino}


def preview_plugin(root: Root, params: dict) -> dict:
    name = params.get("path", "")
    relative(name, empty=True)
    selected = root.path / name
    files, nodes = [], []
    total = directories = 0

    def walk(directory, prefix, depth):
        nonlocal total, directories
        require(depth <= 16, "Plugin directory exceeds depth budget", "budget")
        directories += 1
        require(directories <= 1024, "Plugin directory exceeds directory budget", "budget")
        before = os.fstat(directory)
        nodes.append({"path": prefix, "kind": "directory", "mode": stat.S_IMODE(before.st_mode)})
        with os.scandir(directory) as entries:
            for entry in entries:
                component = entry.name
                relative(component)
                local = prefix + "/" + component if prefix else component
                relative(local)
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                    try:
                        walk(child, local, depth + 1)
                    finally:
                        os.close(child)
                else:
                    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "Plugin contains an unsupported file or link", "unsafe_path")
                    require(len(files) < 512, "Plugin exceeds file budget", "budget")
                    child = os.open(component, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                    try:
                        data, actual = read_file(child, 2 * 1024 * 1024)
                        location(child, selected / local)
                    finally:
                        os.close(child)
                    total += len(data)
                    require(total <= 16 * 1024 * 1024, "Plugin exceeds aggregate byte budget", "budget")
                    item = {"path": local, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                    files.append(item)
                    nodes.append({**item, "kind": "file", "mode": stat.S_IMODE(actual.st_mode)})
        after = os.fstat(directory)
        require((before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns), "Plugin changed during preview", "conflict")
        location(directory, selected / prefix)

    with root.directory(name) as directory:
        walk(directory, "", 0)
    return {"path": str(selected), "revision": digest({"path": str(selected), "entries": sorted(nodes, key=lambda value: value["path"])}),
            "files": sorted(files, key=lambda value: value["path"]), "totalBytes": total}


def run(root: Root, request: dict, layout: Layout, settings: dict, forbidden: list[Path]) -> dict:
    action, params = request["action"], request["params"]
    validate(action, params)
    if action == "resource/skill/read":
        return read_skill(root, params, layout, settings, forbidden)
    return preview_plugin(root, params) if action == "resource/plugin/preview" else resolve_directory(root, params)
