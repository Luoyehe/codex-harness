"""Trusted, descriptor-confined bridge from an unprivileged update sandbox.

Candidate repository code is never imported or executed here.  This helper
only reads one fixed metadata assignment and materializes a fixed output
topology made of bounded regular files, directories, and confined symlinks.
"""
import argparse
import contextlib
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import uuid


VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+\Z")
VERSION_LINE = re.compile(r'^CODEX_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"(?:[ \t]+#[^\r\n]*)?[ \t]*$', re.M)
MAX_METADATA_BYTES = 256 * 1024
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
MAX_ENTRIES = 500_000
MAX_DIRECTORY_ENTRIES = 100_000
MAX_DEPTH = 64
EXPECTED_PAYLOAD = {
    "artifacts": {
        "node_modules": None,
        "apps": {
            "gateway": {"node_modules": None, "dist": None},
            "web": {"node_modules": None, "dist": None},
        },
    },
    "runtime": {"node_modules": None},
    "service": {
        "privileged-helper.sh": "file",
        "worker_launcher.py": "file",
    },
    "manifest.json": "file",
}


def _identity(info):
    return info.st_dev, info.st_ino


def _stable(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _safe_absolute(value):
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts or path == Path(path.anchor):
        raise ValueError("update path must be an absolute non-root path without traversal")
    return Path(os.path.abspath(path))


@contextlib.contextmanager
def _open_path(path):
    path = _safe_absolute(path)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open(path.anchor, flags)
    opened = [descriptor]
    try:
        for part in path.parts[1:]:
            descriptor = os.open(part, flags, dir_fd=descriptor)
            opened.append(descriptor)
        yield descriptor
    finally:
        for descriptor in reversed(opened):
            os.close(descriptor)


def _trusted_root_path(path, *, allow_missing_leaf=False):
    path = _safe_absolute(path)
    current = Path(path.anchor)
    parts = path.parts[1:]
    for index, part in enumerate(parts):
        current /= part
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            if allow_missing_leaf and index == len(parts) - 1:
                return path
            raise
        writable = info.st_mode & 0o022
        protected_sticky_ancestor = (
            index != len(parts) - 1 and stat.S_ISDIR(info.st_mode)
            and info.st_mode & stat.S_ISVTX)
        if (stat.S_ISLNK(info.st_mode) or info.st_uid != 0
                or writable and not protected_sticky_ancestor):
            raise ValueError("trusted update paths must be root-owned real entries")
        if index != len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
            raise ValueError("trusted update path contains a non-directory ancestor")
    return path


def _read_regular_at(directory_fd, name, limit, *, owner=None, private=False):
    before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
            or (owner is not None and before.st_uid != owner)
            or (private and before.st_mode & 0o022) or before.st_size > limit):
        raise ValueError("update input contains an unsafe regular file")
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=directory_fd)
    try:
        opened = os.fstat(descriptor)
        if _stable(before) != _stable(opened):
            raise RuntimeError("update input changed while opening")
        chunks = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    data = b"".join(chunks)
    if len(data) > limit or len(data) != before.st_size or _stable(before) != _stable(after) or _stable(before) != _stable(current):
        raise RuntimeError("update input changed while reading")
    return data


def candidate_version(candidate):
    candidate = _trusted_root_path(candidate)
    with _open_path(candidate) as candidate_fd:
        candidate_info = os.fstat(candidate_fd)
        if candidate_info.st_uid != 0 or candidate_info.st_mode & 0o022:
            raise ValueError("candidate root is not trusted")
        deploy_fd = os.open("deploy", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=candidate_fd)
        try:
            data = _read_regular_at(deploy_fd, "install.sh", MAX_METADATA_BYTES,
                                    owner=0, private=True)
        finally:
            os.close(deploy_fd)
    text = data.decode("utf-8")
    versions = VERSION_LINE.findall(text)
    if len(versions) != 1:
        raise ValueError("candidate must contain exactly one strict CODEX_VERSION assignment")
    return versions[0]


def _names(directory_fd, limit=MAX_DIRECTORY_ENTRIES):
    values = []
    with os.scandir(directory_fd) as entries:
        for entry in entries:
            values.append(entry.name)
            if len(values) > limit:
                raise ValueError("candidate output directory exceeds its entry budget")
    return values


def _validate_topology(directory_fd, specification):
    names = set(_names(directory_fd, 64))
    if names != set(specification):
        raise ValueError("candidate output topology is incomplete or contains extra entries")
    for name, child in specification.items():
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if child == "file":
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("candidate manifest must be a regular file")
            continue
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("candidate output topology contains a non-directory")
        if child is not None:
            descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                 dir_fd=directory_fd)
            try:
                _validate_topology(descriptor, child)
            finally:
                os.close(descriptor)


def _confined_link(relative, target):
    target_path = PurePosixPath(target)
    if target_path.is_absolute() or not target or "\x00" in target:
        return False
    stack = list(relative[:-1])
    for part in target_path.parts:
        if part in ("", "."):
            continue
        if part == "..":
            if not stack:
                return False
            stack.pop()
        else:
            stack.append(part)
    return True


def _budget_entry(budget, info, depth):
    budget["entries"] += 1
    if stat.S_ISREG(info.st_mode):
        budget["bytes"] += info.st_size
        if info.st_size > MAX_FILE_BYTES:
            raise ValueError("candidate output file exceeds its byte limit")
    if depth > MAX_DEPTH or budget["entries"] > MAX_ENTRIES or budget["bytes"] > MAX_TOTAL_BYTES:
        raise ValueError("candidate output exceeds its resource budget")


def _copy_file(source_fd, name, target_fd, info, budget_hash):
    source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=source_fd)
    target = None
    try:
        opened = os.fstat(source)
        if _stable(info) != _stable(opened):
            raise RuntimeError("candidate output file changed while opening")
        mode = 0o755 if info.st_mode & 0o111 else 0o644
        budget_hash.update(f"{mode:o}\0".encode())
        target = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         mode, dir_fd=target_fd)
        os.fchmod(target, mode)
        remaining = info.st_size
        while remaining:
            chunk = os.read(source, min(1024 * 1024, remaining))
            if not chunk:
                raise RuntimeError("candidate output file shrank while copying")
            view = memoryview(chunk)
            while view:
                written = os.write(target, view)
                if written <= 0:
                    raise OSError("candidate output copy made no progress")
                view = view[written:]
            budget_hash.update(chunk)
            remaining -= len(chunk)
        if os.read(source, 1):
            raise RuntimeError("candidate output file grew while copying")
        after = os.fstat(source)
        os.fsync(target)
    finally:
        if target is not None:
            os.close(target)
        os.close(source)
    current = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
    if _stable(info) != _stable(after) or _stable(info) != _stable(current):
        raise RuntimeError("candidate output file changed while copying")


def _copy_tree(source_fd, target_fd, owner, budget, digest, relative=(), depth=0):
    source_root = os.fstat(source_fd)
    if not stat.S_ISDIR(source_root.st_mode) or source_root.st_uid != owner or source_root.st_mode & 0o022:
        raise ValueError("candidate output directory has an unsafe owner or mode")
    entries = []
    with os.scandir(source_fd) as iterator:
        for entry in iterator:
            info = entry.stat(follow_symlinks=False)
            _budget_entry(budget, info, depth)
            entries.append((entry.name, info))
            if len(entries) > MAX_DIRECTORY_ENTRIES:
                raise ValueError("candidate output directory exceeds its entry budget")
    entries.sort(key=lambda item: os.fsencode(item[0]))
    for name, before in entries:
        if before.st_uid != owner or (
                not stat.S_ISLNK(before.st_mode) and before.st_mode & 0o022):
            raise ValueError("candidate output contains an unsafe owner or mode")
        here = (*relative, name)
        encoded = os.fsencode("/".join(here))
        if stat.S_ISDIR(before.st_mode):
            digest.update(b"D\0" + encoded + b"\0")
            source_child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                   dir_fd=source_fd)
            try:
                if _identity(before) != _identity(os.fstat(source_child)):
                    raise RuntimeError("candidate directory changed while opening")
                os.mkdir(name, 0o755, dir_fd=target_fd)
                target_child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                       dir_fd=target_fd)
                try:
                    os.fchmod(target_child, 0o755)
                    _copy_tree(source_child, target_child, owner, budget, digest,
                               here, depth + 1)
                    os.fsync(target_child)
                finally:
                    os.close(target_child)
            finally:
                os.close(source_child)
        elif stat.S_ISREG(before.st_mode):
            if before.st_nlink != 1:
                raise ValueError("candidate output contains a hardlinked file")
            digest.update(b"F\0" + encoded + b"\0" + str(before.st_size).encode() + b"\0")
            _copy_file(source_fd, name, target_fd, before, digest)
        elif stat.S_ISLNK(before.st_mode):
            if before.st_nlink != 1:
                raise ValueError("candidate output contains a hardlinked symlink")
            target_text = os.readlink(name, dir_fd=source_fd)
            if not _confined_link(here, target_text):
                raise ValueError("candidate output symlink leaves the output tree")
            current = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
            if _stable(before) != _stable(current):
                raise RuntimeError("candidate output symlink changed while reading")
            digest.update(b"L\0" + encoded + b"\0" + os.fsencode(target_text) + b"\0")
            os.symlink(target_text, name, dir_fd=target_fd)
        else:
            raise ValueError("candidate output contains a special file")
        current = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        if _stable(before) != _stable(current):
            raise RuntimeError("candidate output entry changed while copying")
    os.fsync(target_fd)


def _remove_tree(directory_fd, budget=None, depth=0):
    budget = budget or {"entries": 0, "bytes": 0}
    entries = []
    with os.scandir(directory_fd) as iterator:
        for entry in iterator:
            info = entry.stat(follow_symlinks=False)
            _budget_entry(budget, info, depth)
            entries.append((entry.name, info))
            if len(entries) > MAX_DIRECTORY_ENTRIES:
                raise ValueError("runtime directory exceeds its entry budget")
    for name, before in entries:
        if stat.S_ISDIR(before.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=directory_fd)
            try:
                if _identity(before) != _identity(os.fstat(child)):
                    raise RuntimeError("runtime changed while removing")
                _remove_tree(child, budget, depth + 1)
            finally:
                os.close(child)
            if _identity(before) != _identity(os.stat(name, dir_fd=directory_fd, follow_symlinks=False)):
                raise RuntimeError("runtime directory changed before removal")
            os.rmdir(name, dir_fd=directory_fd)
        else:
            if _identity(before) != _identity(os.stat(name, dir_fd=directory_fd, follow_symlinks=False)):
                raise RuntimeError("runtime entry changed before removal")
            os.unlink(name, dir_fd=directory_fd)


def _copy_opened(source_fd, destination_parent_fd, destination_name, owner):
    os.mkdir(destination_name, 0o700, dir_fd=destination_parent_fd)
    destination_fd = None
    try:
        destination_fd = os.open(
            destination_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=destination_parent_fd)
        digest = hashlib.sha256()
        _copy_tree(source_fd, destination_fd, owner,
                   {"entries": 0, "bytes": 0}, digest)
        os.fchmod(destination_fd, 0o755)
        os.fsync(destination_fd)
        os.close(destination_fd)
        destination_fd = None
        os.fsync(destination_parent_fd)
        return digest.hexdigest()
    except BaseException:
        if destination_fd is not None:
            try:
                _remove_tree(destination_fd)
            finally:
                os.close(destination_fd)
        try:
            os.rmdir(destination_name, dir_fd=destination_parent_fd)
            os.fsync(destination_parent_fd)
        except OSError:
            pass
        raise


def _materialize_payload(output_fd, destination, version, owner):
    payload_fd = os.open("payload", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                         dir_fd=output_fd)
    try:
        payload_info = os.fstat(payload_fd)
        if payload_info.st_uid != owner or payload_info.st_mode & 0o022:
            raise ValueError("candidate payload has an unsafe owner or mode")
        _validate_topology(payload_fd, EXPECTED_PAYLOAD)
        manifest = json.loads(_read_regular_at(
            payload_fd, "manifest.json", MAX_METADATA_BYTES,
            owner=owner, private=True))
        if manifest != {"format": 1, "version": version}:
            raise ValueError("candidate output manifest does not match the trusted metadata")
        with _open_path(destination.parent) as destination_parent_fd:
            return _copy_opened(
                payload_fd, destination_parent_fd, destination.name, owner)
    finally:
        os.close(payload_fd)


def materialize(output_root, destination, version):
    if not VERSION.fullmatch(version):
        raise ValueError("candidate version is invalid")
    output_root = _safe_absolute(output_root)
    parent = _trusted_root_path(output_root.parent)
    info = os.lstat(output_root)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0
            or stat.S_IMODE(info.st_mode) != 0o733):
        raise ValueError("candidate output exchange must be a root-owned 0733 directory")
    destination = _trusted_root_path(destination, allow_missing_leaf=True)
    if destination.exists() or destination.is_symlink():
        raise ValueError("validated output destination already exists")
    with _open_path(parent) as output_parent_fd:
        output_fd = os.open(output_root.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=output_parent_fd)
        try:
            payload_fd = os.open(
                "payload", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=output_fd)
            try:
                owner = os.fstat(payload_fd).st_uid
            finally:
                os.close(payload_fd)
            if owner == 0:
                raise ValueError("candidate payload was not created by the isolated identity")
            fingerprint = _materialize_payload(
                output_fd, destination, version, owner)
        finally:
            os.close(output_fd)
    return fingerprint


def _live_output(output_root):
    output_root = _safe_absolute(output_root)
    parts = output_root.parts
    if (len(parts) != 4 or parts[:2] != ("/", "run") or parts[3] != "export"
            or not re.fullmatch(r"codex-harness-candidate-[a-f0-9]{24}", parts[2])):
        raise ValueError("live candidate output is outside its transient runtime")
    run_fd = os.open("/run", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    unit_fd = output_fd = None
    try:
        unit_fd = os.open(parts[2], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                          dir_fd=run_fd)
        unit_info = os.fstat(unit_fd)
        if (unit_info.st_uid == 0 or stat.S_IMODE(unit_info.st_mode) != 0o700):
            raise ValueError("live candidate runtime has an unsafe owner or mode")
        output_fd = os.open("export", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=unit_fd)
        output_info = os.fstat(output_fd)
        if (output_info.st_uid != unit_info.st_uid
                or stat.S_IMODE(output_info.st_mode) != 0o700):
            raise ValueError("live candidate export has an unsafe owner or mode")
        yield unit_fd, output_fd, unit_info.st_uid
    finally:
        if output_fd is not None:
            os.close(output_fd)
        if unit_fd is not None:
            os.close(unit_fd)
        os.close(run_fd)


_live_output = contextlib.contextmanager(_live_output)


def materialize_live(output_root, destination, version):
    if not VERSION.fullmatch(version):
        raise ValueError("candidate version is invalid")
    destination = _trusted_root_path(destination, allow_missing_leaf=True)
    if destination.exists() or destination.is_symlink():
        raise ValueError("validated output destination already exists")
    with _live_output(output_root) as (_, output_fd, owner):
        return _materialize_payload(output_fd, destination, version, owner)


def accept_live(output_root):
    with _live_output(output_root) as (unit_fd, _, _):
        descriptor = os.open(
            "accepted", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o444, dir_fd=unit_fd)
        try:
            os.fchmod(descriptor, 0o444)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.fsync(unit_fd)


def _hash_file(source_fd, name, info, digest):
    source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=source_fd)
    try:
        opened = os.fstat(source)
        if _stable(info) != _stable(opened):
            raise RuntimeError("runtime file changed while opening")
        mode = 0o755 if info.st_mode & 0o111 else 0o644
        digest.update(f"{mode:o}\0".encode())
        remaining = info.st_size
        while remaining:
            chunk = os.read(source, min(1024 * 1024, remaining))
            if not chunk:
                raise RuntimeError("runtime file shrank while hashing")
            digest.update(chunk)
            remaining -= len(chunk)
        if os.read(source, 1):
            raise RuntimeError("runtime file grew while hashing")
        after = os.fstat(source)
    finally:
        os.close(source)
    current = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
    if _stable(info) != _stable(after) or _stable(info) != _stable(current):
        raise RuntimeError("runtime file changed while hashing")


def _hash_tree(source_fd, owner, budget, digest, relative=(), depth=0):
    root = os.fstat(source_fd)
    if (not stat.S_ISDIR(root.st_mode) or root.st_uid != owner
            or root.st_mode & 0o022):
        raise ValueError("runtime directory has an unsafe owner or mode")
    entries = []
    with os.scandir(source_fd) as iterator:
        for entry in iterator:
            info = entry.stat(follow_symlinks=False)
            _budget_entry(budget, info, depth)
            entries.append((entry.name, info))
            if len(entries) > MAX_DIRECTORY_ENTRIES:
                raise ValueError("runtime directory exceeds its entry budget")
    entries.sort(key=lambda item: os.fsencode(item[0]))
    for name, before in entries:
        if before.st_uid != owner or (
                not stat.S_ISLNK(before.st_mode) and before.st_mode & 0o022):
            raise ValueError("runtime contains an unsafe owner or mode")
        here = (*relative, name)
        encoded = os.fsencode("/".join(here))
        if stat.S_ISDIR(before.st_mode):
            digest.update(b"D\0" + encoded + b"\0")
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=source_fd)
            try:
                if _stable(before) != _stable(os.fstat(child)):
                    raise RuntimeError("runtime directory changed while opening")
                _hash_tree(child, owner, budget, digest, here, depth + 1)
            finally:
                os.close(child)
        elif stat.S_ISREG(before.st_mode):
            if before.st_nlink != 1:
                raise ValueError("runtime contains a hardlinked file")
            digest.update(b"F\0" + encoded + b"\0" + str(before.st_size).encode() + b"\0")
            _hash_file(source_fd, name, before, digest)
        elif stat.S_ISLNK(before.st_mode):
            if before.st_nlink != 1:
                raise ValueError("runtime contains a hardlinked symlink")
            target = os.readlink(name, dir_fd=source_fd)
            if not _confined_link(here, target):
                raise ValueError("runtime symlink leaves its tree")
            digest.update(b"L\0" + encoded + b"\0" + os.fsencode(target) + b"\0")
        else:
            raise ValueError("runtime contains a special file")
        current = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        if _stable(before) != _stable(current):
            raise RuntimeError("runtime entry changed while hashing")


def _fingerprint_tree(path):
    path = _trusted_root_path(path)
    with _open_path(path) as source_fd:
        root = os.fstat(source_fd)
        digest = hashlib.sha256()
        _hash_tree(source_fd, root.st_uid, {"entries": 0, "bytes": 0}, digest)
        return digest.hexdigest()


def _runtime_package_version(tree):
    with _open_path(tree) as root_fd:
        descriptors = [root_fd]
        try:
            current = root_fd
            for name in ("node_modules", "@openai", "codex"):
                current = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                  dir_fd=current)
                descriptors.append(current)
            data = _read_regular_at(current, "package.json", MAX_METADATA_BYTES,
                                    owner=os.fstat(root_fd).st_uid, private=True)
        finally:
            for descriptor in reversed(descriptors[1:]):
                os.close(descriptor)
    value = json.loads(data).get("version")
    if not isinstance(value, str) or not VERSION.fullmatch(value):
        raise ValueError("Codex runtime package has no strict version")
    return value


def runtime_info(tree, version):
    tree = _trusted_root_path(tree)
    if _runtime_package_version(tree) != version:
        raise ValueError("Codex runtime version does not match")
    fingerprint = _fingerprint_tree(tree)
    cli = tree / "node_modules" / ".bin" / "codex"
    resolved = cli.resolve(strict=True)
    if not resolved.is_relative_to(tree) or not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise ValueError("Codex runtime CLI is missing or leaves its tree")
    return cli, fingerprint


def runtime_lock(base):
    base = _trusted_root_path(base)
    with _open_path(base) as base_fd:
        created = False
        try:
            descriptor = os.open(
                ".publish.lock", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600, dir_fd=base_fd)
            created = True
        except FileExistsError:
            descriptor = os.open(
                ".publish.lock", os.O_RDWR | os.O_NOFOLLOW, dir_fd=base_fd)
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                    or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
                raise ValueError("runtime publication lock is unsafe")
        finally:
            os.close(descriptor)
        if created:
            os.fsync(base_fd)
    return base / ".publish.lock"


def _rename_noreplace(source, destination, source_fd, destination_fd):
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, "renameat2", None)
    if function is None:
        raise OSError(errno.ENOSYS, "renameat2 is required for collision-safe publication")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p,
                         ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    result = function(source_fd, os.fsencode(source), destination_fd,
                      os.fsencode(destination), 1)
    if result != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def publish_runtime(source, base, version, expected):
    source = _trusted_root_path(source)
    base = _trusted_root_path(base)
    cli, fingerprint = runtime_info(source, version)
    if fingerprint != expected:
        raise ValueError("validated runtime fingerprint changed before publication")
    with _open_path(base) as base_fd:
        try:
            existing = os.stat(version, dir_fd=base_fd, follow_symlinks=False)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            target = base / version
            _, current = runtime_info(target, version)
            if current != fingerprint:
                raise RuntimeError("concurrent runtime publication has different content")
            return "reused", target / "node_modules" / ".bin" / "codex", fingerprint
        staging = ".candidate-runtime-" + uuid.uuid4().hex
        source_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            copied = _copy_opened(source_fd, base_fd, staging, 0)
        finally:
            os.close(source_fd)
        try:
            if copied != fingerprint:
                raise RuntimeError("runtime changed while staging publication")
            _rename_noreplace(staging, version, base_fd, base_fd)
            os.fsync(base_fd)
        except BaseException:
            try:
                staging_fd = os.open(staging, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                     dir_fd=base_fd)
            except FileNotFoundError:
                pass
            else:
                try:
                    _remove_tree(staging_fd)
                finally:
                    os.close(staging_fd)
                os.rmdir(staging, dir_fd=base_fd)
            raise
    return "created", base / version / "node_modules" / ".bin" / "codex", fingerprint


def _referenced(cli):
    canonical = str(cli.resolve(strict=True))
    for directory in (Path("/etc/systemd/system"), Path("/etc/codex-harness")):
        try:
            entries = list(directory.iterdir())
        except FileNotFoundError:
            continue
        if len(entries) > 10_000:
            raise ValueError("service reference inventory exceeds its entry budget")
        for entry in entries:
            if directory.name == "system" and entry.suffix != ".service":
                continue
            try:
                info = entry.lstat()
            except FileNotFoundError:
                continue
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                    or info.st_nlink != 1 or info.st_size > 1024 * 1024):
                continue
            text = entry.read_text(encoding="utf-8")
            if ("CODEX_BIN=" + canonical) in text:
                return True
    return False


def remove_runtime(base, version, expected):
    base = _trusted_root_path(base)
    target = base / version
    with _open_path(base) as base_fd:
        try:
            os.stat(version, dir_fd=base_fd, follow_symlinks=False)
        except FileNotFoundError:
            return True
    cli, fingerprint = runtime_info(target, version)
    if fingerprint != expected:
        raise ValueError("runtime changed before rollback cleanup")
    if _referenced(cli):
        return False
    with _open_path(base) as base_fd:
        before = os.stat(version, dir_fd=base_fd, follow_symlinks=False)
        target_fd = os.open(version, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=base_fd)
        try:
            opened = os.fstat(target_fd)
            if _stable(before) != _stable(opened):
                raise RuntimeError("runtime changed while pinning rollback cleanup")
            digest = hashlib.sha256()
            _hash_tree(target_fd, opened.st_uid,
                       {"entries": 0, "bytes": 0}, digest)
            if digest.hexdigest() != expected:
                raise RuntimeError("runtime changed before rollback cleanup commit")
            tombstone = ".unused-runtime-" + uuid.uuid4().hex
            _rename_noreplace(version, tombstone, base_fd, base_fd)
            os.fsync(base_fd)
            if _identity(before) != _identity(os.fstat(target_fd)):
                raise RuntimeError("runtime changed during rollback cleanup")
            _remove_tree(target_fd)
        finally:
            os.close(target_fd)
        os.rmdir(tombstone, dir_fd=base_fd)
        os.fsync(base_fd)
    return True


def main(argv=None):
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="action", required=True)
    version_parser = subparsers.add_parser("version")
    version_parser.add_argument("candidate")
    materialize_parser = subparsers.add_parser("materialize")
    materialize_parser.add_argument("output")
    materialize_parser.add_argument("destination")
    materialize_parser.add_argument("version")
    live_parser = subparsers.add_parser("materialize-live")
    live_parser.add_argument("output")
    live_parser.add_argument("destination")
    live_parser.add_argument("version")
    accept_parser = subparsers.add_parser("accept-live")
    accept_parser.add_argument("output")
    runtime_parser = subparsers.add_parser("runtime-info")
    runtime_parser.add_argument("tree")
    runtime_parser.add_argument("version")
    lock_parser = subparsers.add_parser("runtime-lock")
    lock_parser.add_argument("base")
    publish_parser = subparsers.add_parser("publish-runtime")
    publish_parser.add_argument("source")
    publish_parser.add_argument("base")
    publish_parser.add_argument("version")
    publish_parser.add_argument("fingerprint")
    remove_parser = subparsers.add_parser("remove-runtime")
    remove_parser.add_argument("base")
    remove_parser.add_argument("version")
    remove_parser.add_argument("fingerprint")
    args = parser.parse_args(argv)
    if args.action == "version":
        print(candidate_version(args.candidate))
    elif args.action == "materialize":
        print(materialize(args.output, args.destination, args.version))
    elif args.action == "materialize-live":
        print(materialize_live(args.output, args.destination, args.version))
    elif args.action == "accept-live":
        accept_live(args.output)
    elif args.action == "runtime-info":
        cli, fingerprint = runtime_info(args.tree, args.version)
        print(f"{cli}\t{fingerprint}")
    elif args.action == "runtime-lock":
        print(runtime_lock(args.base))
    elif args.action == "publish-runtime":
        state, cli, fingerprint = publish_runtime(
            args.source, args.base, args.version, args.fingerprint)
        print(f"{state}\t{cli}\t{fingerprint}")
    elif args.action == "remove-runtime":
        if not remove_runtime(args.base, args.version, args.fingerprint):
            raise SystemExit(3)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"candidate update refused ({type(error).__name__})") from None
