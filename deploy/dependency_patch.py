"""One reviewed dependency repair; never execute candidate verification code."""
from __future__ import annotations

import hashlib
import os
import re
import stat
from pathlib import Path, PurePosixPath

from .common import require
from .safe_fs import stable_identity

PATCH_SELECTOR = "picomatch@4.0.7"
PATCH_PATH = "patches/picomatch@4.0.7.patch"
PATCH_SETTINGS = {PATCH_SELECTOR: PATCH_PATH}
MAX_PATCH_BYTES = 64 * 1024
MAX_PACKAGE_FILE_BYTES = 1024 * 1024


def approved_patch() -> dict:
    # This module and the declaration belong to the trusted control generation,
    # not the candidate source or any executable installed npm package.
    from .dependency_patch_contract import APPROVED_PATCH
    value = APPROVED_PATCH
    require(isinstance(value, dict) and value.get("schemaVersion") == 1 and
            value.get("package") == "picomatch" and value.get("version") == "4.0.7" and
            value.get("patchPath") == PATCH_PATH, "Invalid reviewed dependency patch", "integrity")
    require(all(isinstance(value.get(key), str) and re.fullmatch(r"[a-f0-9]{64}", value[key])
                for key in ("patchSha256", "lockPatchHash")), "Invalid reviewed patch digest", "integrity")
    require(isinstance(value.get("upstreamIntegrity"), str) and
            re.fullmatch(r"sha512-[A-Za-z0-9+/]{86}==", value["upstreamIntegrity"]),
            "Invalid reviewed upstream integrity", "integrity")
    files = value.get("files")
    require(isinstance(files, dict) and 1 <= len(files) <= 128 and "package.json" in files,
            "Invalid reviewed package inventory", "integrity")
    for name, checksum in files.items():
        require(isinstance(name, str) and name and not name.startswith("/") and "\\" not in name and
                all(part not in ("", ".", "..") for part in name.split("/")) and
                isinstance(checksum, str) and re.fullmatch(r"[a-f0-9]{64}", checksum),
                "Invalid reviewed package file", "integrity")
    return value


def bounded_file(path: Path, limit: int) -> bytes:
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit,
            "Dependency proof requires a bounded ordinary file", "unsafe_path")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        require(os.path.samestat(before, opened) and stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1,
                "Dependency proof file changed before read", "integrity")
        data = stream.read(limit + 1)
        require(len(data) <= limit and len(data) == opened.st_size and
                stable_identity(opened) == stable_identity(os.fstat(stream.fileno())) and
                stable_identity(before) == stable_identity(path.lstat()),
                "Dependency proof file changed during read", "integrity")
    return data


def read_approved_patch(source: Path) -> bytes:
    declaration = approved_patch()
    directory = source / "patches"
    before = directory.lstat()
    require(stat.S_ISDIR(before.st_mode) and not stat.S_ISLNK(before.st_mode),
            "Dependency patches require an ordinary directory", "unsafe_path")
    with os.scandir(directory) as entries:
        first = next(entries, None)
        require(first is not None and first.name == PurePosixPath(PATCH_PATH).name and next(entries, None) is None,
                "Only the reviewed dependency patch is allowed", "invalid_input")
    data = bounded_file(source / PATCH_PATH, MAX_PATCH_BYTES)
    require(stable_identity(before) == stable_identity(directory.lstat()), "Patch directory changed", "integrity")
    require(hashlib.sha256(data).hexdigest() == declaration["patchSha256"] and b"\r" not in data,
            "Dependency patch bytes differ from reviewed repair", "integrity")
    return data


def validate_patch_lock(lock: str, source: Path) -> dict[str, str]:
    declaration = approved_patch()
    data = read_approved_patch(source)
    blocks = re.findall(r"^patchedDependencies:\n((?:[ \t].*\n|\n)*)", lock, re.M)
    expected = f"  {PATCH_SELECTOR}: {declaration['lockPatchHash']}"
    require(lock.lower().count("patcheddependencies") == 1 and len(blocks) == 1 and blocks[0].strip("\n") == expected,
            "Lock must bind only the reviewed dependency patch", "integrity")
    require(hashlib.sha256(data).hexdigest() == declaration["lockPatchHash"],
            "Lock patch digest differs from reviewed LF bytes", "integrity")
    package = re.findall(r"^  picomatch@4\.0\.7:\n((?:    .*\n|\n)*)", lock, re.M)
    require(len(package) == 1 and
            f"    resolution: {{integrity: {declaration['upstreamIntegrity']}}}" in package[0].splitlines(),
            "Lock upstream package integrity differs from reviewed package", "integrity")
    return {PATCH_PATH: declaration["patchSha256"]}


def copy_approved_patch(source: Path, destination: Path) -> dict[str, str]:
    data = read_approved_patch(source)
    directory = destination / "patches"
    directory.mkdir(mode=0o755)
    with (destination / PATCH_PATH).open("xb") as stream:
        stream.write(data)
    (destination / PATCH_PATH).chmod(0o644)
    return {PATCH_PATH: hashlib.sha256(data).hexdigest()}


def verify_installed_patch(application: Path) -> dict:
    """Read only a root-owned export after the isolated producer has stopped."""
    declaration = approved_patch()
    modules = application / "node_modules"
    store = modules / ".pnpm"
    for directory in (modules, store):
        require(directory.is_dir() and not directory.is_symlink(), "Invalid installed dependency store", "integrity")
    store = store.resolve()
    # Node resolves a package-local node_modules before the shared pnpm sibling.
    # Inspect every physical namespace, including nested or unused instances;
    # following the symlink graph would both miss shadows and create cycles.
    references, pending, count = [], [(modules, 0)], 0
    while pending:
        directory, depth = pending.pop()
        require(depth <= 64, "Installed dependency nesting exceeds proof budget", "budget")
        with os.scandir(directory) as entries:
            for entry in entries:
                count += 1
                require(count <= 100000, "Installed dependency tree exceeds proof budget", "budget")
                child = Path(entry.path)
                if directory.name == "node_modules" and entry.name == "picomatch":
                    references.append(child)
                if entry.is_dir(follow_symlinks=False):
                    pending.append((child, depth + 1))
    packages = set()
    for reference in references:
        if not os.path.lexists(reference):
            continue
        package = reference.resolve(strict=True)
        require(package.is_relative_to(store) and package.is_dir(), "Package link escaped the installed store", "integrity")
        packages.add(package)
    require(packages, "Reviewed dependency patch was not installed", "integrity")
    for package in packages:
        observed = {}
        allowed_dirs = {str(parent) for name in declaration["files"] for parent in PurePosixPath(name).parents
                        if str(parent) != "."}
        for directory, dirs, files in os.walk(package, followlinks=False):
            for name in dirs:
                child = Path(directory) / name
                require(not child.is_symlink() and child.relative_to(package).as_posix() in allowed_dirs,
                        "Patched package contains an unreviewed directory", "integrity")
            for name in files:
                file = Path(directory) / name
                relative = file.relative_to(package).as_posix()
                require(relative in declaration["files"], "Patched package contains an unreviewed file", "integrity")
                observed[relative] = hashlib.sha256(bounded_file(file, MAX_PACKAGE_FILE_BYTES)).hexdigest()
        require(observed == declaration["files"], "Installed dependency differs from reviewed patched package", "integrity")
    return {"package": PATCH_SELECTOR, "patchSha256": declaration["patchSha256"], "instances": len(packages)}
