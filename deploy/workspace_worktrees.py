"""Managed native worktrees: fixed UUID locations and reversible whole-tree moves.

Native journals never authorize a root. Existing worktrees require a binding
from supervisor-private storage and are checked against actual Git identities.
"""
from __future__ import annotations

import hashlib
import os
import re
import stat
from contextlib import contextmanager
from pathlib import Path

from .common import DeployError, canonical, require
from .workspace_git import git, repository_paths
from .workspace_git_view import directory, read_index
from .workspace_paths import Root, read_file, relative, rename_absent, revision
from .workspace_store import Record, operation_id, private_directory, regular, write_new

MAX_WORKTREES = 32
MAX_TREE_ENTRIES = 10000
MAX_TREE_DEPTH = 32
MAX_TREE_BYTES = 128 * 1024 * 1024
MAX_BLOB = 8 * 1024 * 1024
BINDING_FIELDS = {"version", "worktreeId", "originRoot", "commonDir", "commonDevice", "commonInode", "gitDir", "gitDirDevice", "gitDirInode", "worktreeDevice", "worktreeInode"}
NUMBERS = {"commonDevice", "commonInode", "gitDirDevice", "gitDirInode", "worktreeDevice", "worktreeInode"}


def validate_binding(value: object, identity: str, origin: str) -> dict:
    require(isinstance(value, dict) and set(value) == BINDING_FIELDS and type(value.get("version")) is int and value["version"] == 1 and
            value.get("worktreeId") == identity and value.get("originRoot") == origin, "Trusted worktree binding is required", "worktree_unbound")
    for key in ("commonDir", "gitDir"):
        item = value[key]
        require(isinstance(item, str) and item.startswith("/") and str(Path(item)) == item and len(item.encode()) <= 4096 and
                not any(ord(char) < 32 or ord(char) == 127 for char in item), "Invalid bound Git directory", "worktree_unbound")
    require(all(type(value[key]) is int and 0 <= value[key] <= 9007199254740991 for key in NUMBERS), "Invalid worktree directory identity", "worktree_unbound")
    return value


def ref(value: object) -> str:
    require(isinstance(value, str) and (value == "HEAD" or re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", value) or
            re.fullmatch(r"refs/(?:heads|remotes|tags)/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}", value)), "Select HEAD, a complete Git ref, or a commit id")
    require(".." not in value and "//" not in value and not value.endswith(("/", ".", ".lock")), "Invalid Git ref")
    return value


def text_file(parent: int, name: str, limit: int = 8192) -> str:
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        return read_file(fd, limit)[0].decode("utf-8", "strict").strip()
    finally:
        os.close(fd)


def identity(info: os.stat_result) -> tuple[int, int]:
    return info.st_dev, info.st_ino


def repository(workspace) -> Path:
    return repository_paths(workspace.root, workspace.forbidden)[1]


@contextmanager
def storage(workspace, *, create: bool = False):
    import fcntl
    home = Root(str(workspace.store.storage.parent), [])
    active = state = lock = None
    try:
        active = private_directory(home.fd, "worktrees", create=create)
        state = private_directory(home.fd, "worktree-state", create=create)
        lock = os.open("lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=state)
        info = regular(lock)
        require(info.st_uid == os.geteuid() and not info.st_mode & 0o077, "Unsafe managed worktree lock", "unsafe_path")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise DeployError("busy", "Another managed worktree operation is running") from exc
        with os.scandir(state) as listing:
            names = []
            for entry in listing:
                if entry.name != "lock":
                    names.append(entry.name)
                    require(len(names) <= MAX_WORKTREES, "Managed worktree retention budget reached", "budget")
        for name in names:
            operation_id(name)
            fd = private_directory(state, name)
            os.close(fd)
        yield home.path, active, state, names
    finally:
        for fd in (lock, state, active):
            if fd is not None:
                os.close(fd)
        home.close()


def tree(root: Root, metadata: int, head: str) -> str:
    entries, total = [], 0
    def visit(parent: int, prefix: str, depth: int):
        nonlocal total
        require(depth <= MAX_TREE_DEPTH, "Worktree nesting exceeds budget", "budget")
        with os.scandir(parent) as listing:
            names = []
            for entry in listing:
                names.append(entry.name)
                require(len(names) + len(entries) <= MAX_TREE_ENTRIES + 1, "Worktree entry budget reached", "budget")
            names.sort()
        for name in names:
            if name == ".git" and not prefix:
                continue
            require(name != ".git", "Nested repositories or initialized submodules cannot be archived", "worktree_nested")
            path = prefix + name
            relative(path)
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                    "Worktree contains a symlink, hardlink or special file; no files were discarded", "unsafe_path")
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_DIRECTORY if stat.S_ISDIR(info.st_mode) else 0), dir_fd=parent)
            try:
                actual = os.fstat(fd)
                require(identity(info) == identity(actual), "Worktree entry changed during inspection", "conflict")
                if stat.S_ISDIR(actual.st_mode):
                    entries.append([path, "directory", stat.S_IMODE(actual.st_mode), revision(actual)])
                    require(len(entries) <= MAX_TREE_ENTRIES, "Worktree entry budget reached", "budget")
                    visit(fd, path + "/", depth + 1)
                else:
                    data, actual = read_file(fd, MAX_BLOB)
                    total += len(data)
                    require(total <= MAX_TREE_BYTES, "Worktree byte budget reached; files remain intact", "budget")
                    entries.append([path, "file", stat.S_IMODE(actual.st_mode), revision(actual, data)])
                    require(len(entries) <= MAX_TREE_ENTRIES, "Worktree entry budget reached", "budget")
            finally:
                os.close(fd)
    visit(root.fd, "", 0)
    index = read_index(metadata, "index")
    encoded = canonical({"head": head, "index": hashlib.sha256(index).hexdigest(), "entries": entries})
    require(len(encoded) <= 8 * 1024 * 1024, "Worktree manifest exceeds budget", "budget")
    return hashlib.sha256(encoded).hexdigest()


def inspect(workspace, home: Path, identity_value: str, binding: dict, *, creating: bool = False) -> dict:
    common = repository(workspace)
    common_fd = directory(common)
    root = metadata = None
    try:
        common_info = os.fstat(common_fd)
        require(common_info.st_uid == os.geteuid() and not common_info.st_mode & 0o022, "Shared Git metadata cannot authorize managed moves", "worktree_shared")
        active, archived = home / "worktrees" / identity_value, home / "worktree-state" / identity_value / "checkout"
        exists = [path for path in (active, archived) if path.exists() or path.is_symlink()]
        require(len(exists) == 1, "Managed worktree location is missing or ambiguous; both locations were retained", "recovery_required")
        location = exists[0]
        root = Root(str(location), [])
        root_info = os.fstat(root.fd)
        require(root_info.st_uid == os.geteuid() and not root_info.st_mode & 0o022, "Managed worktree ownership or sharing changed", "worktree_shared")
        pointer = text_file(root.fd, ".git")
        require(pointer.startswith("gitdir: "), "Primary repositories cannot be managed as disposable worktrees", "worktree_primary")
        git_dir = Path(pointer[8:])
        require(git_dir.is_absolute() and git_dir.parent == common / "worktrees" and git_dir.resolve(strict=True) == git_dir,
                "Worktree Git pointer is outside its origin repository", "worktree_unbound")
        metadata = directory(git_dir)
        metadata_info = os.fstat(metadata)
        require(metadata_info.st_uid == os.geteuid() and not metadata_info.st_mode & 0o022, "Shared worktree Git metadata cannot be moved", "worktree_shared")
        common_pointer = text_file(metadata, "commondir")
        require((git_dir / common_pointer).resolve(strict=True) == common, "Worktree common-directory pointer differs", "worktree_unbound")
        backlink = text_file(metadata, "gitdir")
        require(backlink in (str(active / ".git"), str(archived / ".git")), "Worktree metadata points to a shared or unrelated checkout", "worktree_shared")
        actual = {"version": 1, "worktreeId": identity_value, "originRoot": str(workspace.root.path), "commonDir": str(common),
                  "commonDevice": os.fstat(common_fd).st_dev, "commonInode": os.fstat(common_fd).st_ino,
                  "gitDir": str(git_dir), "gitDirDevice": os.fstat(metadata).st_dev, "gitDirInode": os.fstat(metadata).st_ino,
                  "worktreeDevice": root_info.st_dev, "worktreeInode": root_info.st_ino}
        validate_binding(actual, identity_value, str(workspace.root.path))
        require(creating or actual == binding, "Managed worktree identity differs from the supervisor binding", "worktree_unbound")
        try:
            lock = text_file(metadata, "locked")
        except FileNotFoundError:
            lock = None
        own_lock = "codex-harness-archive:" + identity_value
        require(lock in (None, own_lock), "A shared or user-locked worktree cannot be moved", "worktree_shared")
        phase = "active" if location == active and backlink == str(active / ".git") and lock is None else "archived" if location == archived and backlink == str(archived / ".git") and lock == own_lock else "recovery"
        head = git(workspace.root, ["rev-parse", "--verify", "HEAD"], environment={"GIT_DIR": str(git_dir), "GIT_WORK_TREE": str(location)}).decode().strip()
        require(re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", head) is not None, "Worktree HEAD is invalid", "git_unavailable")
        return {"worktreeId": identity_value, "phase": phase, "path": str(location), "head": head,
                "revision": tree(root, metadata, head), "binding": actual}
    finally:
        if metadata is not None:
            os.close(metadata)
        if root is not None:
            root.close()
        os.close(common_fd)


def checkout_data(workspace, head: str) -> tuple[list, bytes]:
    listing = git(workspace.root, ["ls-tree", "-r", "-l", "-z", "--full-tree", head], output_limit=8 * 1024 * 1024)
    files, directories, total = [], set(), 0
    for line in listing.split(b"\0"):
        if not line:
            continue
        header, raw_path = line.split(b"\t", 1)
        mode, kind, object_id, size = header.split()
        require(mode in (b"100644", b"100755") and kind == b"blob" and size.isdigit(), "Worktree creation does not materialize symlinks or submodules", "unsupported_path")
        name = raw_path.decode("utf-8", "strict")
        parts = relative(name)
        require(len(parts) - 1 <= MAX_TREE_DEPTH, "Worktree nesting exceeds budget", "budget")
        for end in range(1, len(parts)):
            parent = tuple(parts[:end])
            if parent not in directories:
                # Reserve this implicit directory and the current file before
                # retaining the prefix; shared parents consume only one entry.
                require(len(files) + len(directories) + 1 < MAX_TREE_ENTRIES,
                        "Worktree entry budget reached", "budget")
                directories.add(parent)
        require(len(files) + len(directories) < MAX_TREE_ENTRIES, "Worktree entry budget reached", "budget")
        length = int(size)
        total += length
        require(length <= MAX_BLOB and total <= MAX_TREE_BYTES and len(files) < MAX_TREE_ENTRIES, "Worktree checkout exceeds file or byte budget", "budget")
        files.append((name, object_id, length, 0o755 if mode == b"100755" else 0o644))
    data = git(workspace.root, ["cat-file", "--batch"], input_bytes=b"".join(ident + b"\n" for _, ident, _, _ in files),
               output_limit=MAX_TREE_BYTES + MAX_TREE_ENTRIES * 128, seconds=45)
    offset = 0
    for _, object_id, length, _ in files:
        end = data.find(b"\n", offset)
        require(end >= offset and data[offset:end] == object_id + b" blob " + str(length).encode(), "Git blob stream does not match the selected tree", "git_unavailable")
        offset = end + 1
        require(len(data) >= offset + length + 1 and data[offset + length:offset + length + 1] == b"\n", "Git blob stream is incomplete", "git_unavailable")
        offset += length + 1
    require(offset == len(data), "Unexpected trailing Git blob output", "git_unavailable")
    return files, data


def materialize(workspace, root: Root, head: str, prepared: tuple[list, bytes]) -> None:
    files, data = prepared
    offset = 0
    for name, object_id, length, mode in files:
        end = data.find(b"\n", offset)
        require(end >= offset and data[offset:end] == object_id + b" blob " + str(length).encode(), "Git blob stream does not match the selected tree", "git_unavailable")
        offset = end + 1
        require(len(data) >= offset + length + 1 and data[offset + length:offset + length + 1] == b"\n", "Git blob stream is incomplete", "git_unavailable")
        parts = relative(name)
        parent = os.dup(root.fd)
        try:
            for part in parts[:-1]:
                try:
                    os.mkdir(part, 0o755, dir_fd=parent)
                    os.fsync(parent)
                except FileExistsError:
                    pass
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                os.close(parent); parent = next_fd
            write_new(parent, parts[-1], data[offset:offset + length], mode)
        finally:
            os.close(parent)
        offset += length + 1
    require(offset == len(data), "Unexpected trailing Git blob output", "git_unavailable")
    git(root, ["read-tree", "--reset", head])


def run(workspace, request: dict, record: Record | None) -> dict:
    action, params = request["action"], request["params"]
    creating = action == "worktree/create"
    identity_value = record.identity if creating else params["worktreeId"]
    native_home = workspace.store.storage.parent
    require(workspace.root.path != native_home / "worktrees" and native_home / "worktrees" not in workspace.root.path.parents,
            "Worktree lifecycle uses the registered origin repository, not a managed child project", "worktree_origin")
    binding = {} if creating else validate_binding(request.get("binding"), identity_value, str(workspace.root.path))
    with storage(workspace, create=creating) as (home, active, state, names):
        if creating:
            require(identity_value not in names and len(names) < MAX_WORKTREES, "Managed worktree retention budget or identity collision", "budget")
            common = repository(workspace)
            common_fd = directory(common)
            try:
                common_info = os.fstat(common_fd)
                require(common_info.st_uid == os.geteuid() and not common_info.st_mode & 0o022, "Shared Git metadata cannot create managed worktrees", "worktree_shared")
            finally:
                os.close(common_fd)
            head = git(workspace.root, ["rev-parse", "--verify", "--end-of-options", ref(params["ref"]) + "^{commit}"]).decode().strip()
            require(re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", head) is not None, "Selected ref is not a commit", "git_unavailable")
            prepared = checkout_data(workspace, head)
            holder = private_directory(state, identity_value, create=True)
            try:
                journal = Record(holder, identity_value)
                journal.save({"phase": "creating", "operationId": record.identity, "head": head})
                os.mkdir(identity_value, 0o700, dir_fd=active)
                os.fsync(active)
                target = home / "worktrees" / identity_value
                git(workspace.root, ["worktree", "add", "--no-checkout", "--detach", "--", str(target), head], seconds=45)
                created = Root(str(target), [])
                try:
                    materialize(workspace, created, head, prepared)
                finally:
                    created.close()
                result = inspect(workspace, home, identity_value, {}, creating=True)
                require(result["phase"] == "active", "Created worktree needs recovery inspection", "recovery_required")
                journal.save({"phase": "active", "operationId": record.identity})
                return {**result, "created": True}
            finally:
                os.close(holder)
        before = inspect(workspace, home, identity_value, binding)
        if action == "worktree/read":
            return before
        require(before["revision"] == params["expectedRevision"], "Worktree changed; inspect the current revision", "conflict")
        if action == "worktree/attach":
            require(before["phase"] == "active", "Only an active managed worktree can be attached", "recovery_required")
            return {**before, "attached": True}
        holder = private_directory(state, identity_value)
        try:
            journal = Record(holder, identity_value)
            journal.save({"phase": action, "operationId": record.identity, "expectedRevision": before["revision"]})
            target, archived = home / "worktrees" / identity_value, home / "worktree-state" / identity_value / "checkout"
            if action == "worktree/archive":
                require(before["phase"] == "active", "Worktree must be active before archive", "recovery_required")
                git(workspace.root, ["worktree", "lock", "--reason", "codex-harness-archive:" + identity_value, str(target)])
                rename_absent(active, identity_value, holder, "checkout")
                captured = inspect(workspace, home, identity_value, binding)
                require(captured["revision"] == before["revision"], "Worktree changed during archive; entire checkout retained", "conflict")
                git(workspace.root, ["worktree", "repair", str(archived)])
                result = inspect(workspace, home, identity_value, binding)
                require(result["phase"] == "archived", "Worktree archive metadata needs recovery", "recovery_required")
                journal.save({"phase": "archived", "operationId": record.identity})
                return {**result, "archived": True}
            require(action == "worktree/restore" and before["phase"] in ("archived", "recovery"), "Worktree does not need restoration", "recovery_required")
            if before["path"] == str(archived):
                rename_absent(holder, "checkout", active, identity_value)
            git(workspace.root, ["worktree", "repair", str(target)])
            metadata = directory(Path(binding["gitDir"]))
            try:
                try:
                    lock = text_file(metadata, "locked")
                except FileNotFoundError:
                    lock = None
                require(lock in (None, "codex-harness-archive:" + identity_value), "Worktree lock changed during restore", "worktree_shared")
                if lock is not None:
                    git(workspace.root, ["worktree", "unlock", str(target)])
            finally:
                os.close(metadata)
            result = inspect(workspace, home, identity_value, binding)
            require(result["phase"] == "active" and result["revision"] == before["revision"], "Restored worktree changed; all files retained", "conflict")
            journal.save({"phase": "active", "operationId": record.identity})
            return {**result, "restored": True}
        finally:
            os.close(holder)
