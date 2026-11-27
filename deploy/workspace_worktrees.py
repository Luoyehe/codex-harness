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
from .workspace_errors import WorktreePathError, display_fields
from .workspace_git import git, repository_paths
from .workspace_git_view import directory, read_index
from .workspace_paths import Root, read_file, relative, rename_absent, revision
from .workspace_store import Record, operation_id, private_directory, regular, write_new, pending_state, read_record

MAX_WORKTREES = 32
MAX_TREE_ENTRIES = 100_000
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
    require(isinstance(value, str), "Select HEAD, a complete Git ref, or a commit id")
    if value == "HEAD" or re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", value):
        return value
    from .git_refs import valid_ref
    require(value.startswith(("refs/heads/", "refs/remotes/", "refs/tags/")), "Select a complete branch or tag reference")
    return valid_ref(value)


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
                if entry.name not in ("lock", "retired"):
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


def require_entry(condition, code, message, path):
    if not condition:
        raise WorktreePathError(code, message, path)


def tree(root: Root, metadata: int, head: str) -> str:
    # Keep the canonical v1 manifest byte-for-byte compatible with saved revisions.
    digest = hashlib.sha256(b'{"entries":[')
    count = total = 0
    first = True

    def append(entry):
        nonlocal first
        if not first:
            digest.update(b",")
        first = False
        digest.update(canonical(entry))

    def visit(parent: int, prefix: str, depth: int):
        nonlocal count, total
        require_entry(depth <= MAX_TREE_DEPTH, "budget", "Worktree nesting exceeds budget", prefix.rstrip("/"))
        with os.scandir(parent) as listing:
            names = []
            for entry in listing:
                if entry.name == ".git" and not prefix:
                    continue
                count += 1
                require_entry(count <= MAX_TREE_ENTRIES, "budget", "Worktree entry budget reached", prefix + entry.name)
                names.append(entry.name)
        names.sort()
        for name in names:
            path = prefix + name
            require_entry(name != ".git", "worktree_nested", "Nested repository or initialized submodule cannot be archived", path)
            relative(path)
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(name, dir_fd=parent)
                require_entry(not os.path.isabs(target) and len(os.fsencode(target)) <= 4096,
                              "unsafe_path", "Worktree symbolic link is not a bounded relative target", path)
                location = root.path / path
                try:
                    resolved = (location.parent / target).resolve(strict=True)
                except (OSError, RuntimeError) as error:
                    raise WorktreePathError("unsafe_path", "Worktree symbolic link has an unverifiable target", path) from error
                require_entry(resolved.is_relative_to(root.path) and not ({".git", ".harness-workspace"} & set(resolved.relative_to(root.path).parts)),
                              "unsafe_path", "Worktree symbolic link leaves the managed files", path)
                after = os.stat(name, dir_fd=parent, follow_symlinks=False)
                require_entry(identity(info) == identity(after) and info.st_ctime_ns == after.st_ctime_ns,
                              "conflict", "Worktree symbolic link changed during inspection", path)
                append([path, "symlink", target, revision(after)])
                continue
            require_entry(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                          "unsafe_path", "Worktree contains a hardlink or special file", path)
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_DIRECTORY if stat.S_ISDIR(info.st_mode) else 0), dir_fd=parent)
            try:
                actual = os.fstat(fd)
                require_entry(identity(info) == identity(actual), "conflict", "Worktree entry changed during inspection", path)
                if stat.S_ISDIR(actual.st_mode):
                    append([path, "directory", stat.S_IMODE(actual.st_mode), revision(actual)])
                    visit(fd, path + "/", depth + 1)
                else:
                    try:
                        data, actual = read_file(fd, min(MAX_BLOB, MAX_TREE_BYTES - total))
                    except DeployError as exc:
                        raise WorktreePathError(exc.code, str(exc), path) from exc
                    total += len(data)
                    append([path, "file", stat.S_IMODE(actual.st_mode), revision(actual, data)])
            finally:
                os.close(fd)
    visit(root.fd, "", 0)
    index = read_index(metadata, "index")
    digest.update(b'],"head":')
    digest.update(canonical(head))
    digest.update(b',"index":')
    digest.update(canonical(hashlib.sha256(index).hexdigest()))
    digest.update(b'}')
    return digest.hexdigest()


def inspect(workspace, home: Path, identity_value: str, binding: dict, *, creating: bool = False, lightweight: bool = False, identity_only: bool = False) -> dict:
    common = repository(workspace)
    common_fd = directory(common)
    root = metadata = None
    try:
        common_info = os.fstat(common_fd)
        require(common_info.st_uid == os.geteuid() and not common_info.st_mode & 0o022, "Shared Git metadata cannot authorize managed moves", "worktree_shared")
        active, archived = home / "worktrees" / identity_value, home / "worktree-state" / identity_value / "checkout"
        retired = home / "worktree-state" / "retired" / identity_value / "checkout"
        exists = [path for path in ((active,) if creating else (active, archived, retired)) if path.exists() or path.is_symlink()]
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
        require(backlink in (str(active / ".git"), str(archived / ".git"), str(retired / ".git")), "Worktree metadata points to a shared or unrelated checkout", "worktree_shared")
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
        phase = "active" if location == active and backlink == str(active / ".git") and lock is None else "archived" if location == archived and backlink == str(archived / ".git") and lock == own_lock else "retired" if location == retired and backlink == str(retired / ".git") and lock == own_lock else "recovery"
        head = git(workspace.root, ["rev-parse", "--verify", "HEAD"], environment={"GIT_DIR": str(git_dir), "GIT_WORK_TREE": str(location)}).decode().strip()
        require(re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", head) is not None, "Worktree HEAD is invalid", "git_unavailable")
        result = {"worktreeId": identity_value, "phase": phase, "path": str(location), "head": head, "binding": actual}
        if location == retired:
            require(lock == own_lock, "Retired worktree lock changed", "worktree_shared")
            result["retirementPending"] = phase != "retired"
        if identity_only:
            return result
        try:
            result["revision"] = tree(root, metadata, head)
        except DeployError as exc:
            if not lightweight or exc.code not in ("budget", "unsafe_path", "worktree_nested"):
                raise
            detail = display_fields(exc.code, getattr(exc, "worktree_path", None))
            result.update(revision=None, mutationUnavailable={"code": exc.code, "message": "工作树身份已验证。文件未改动。" + detail["message"]})
        return result
    finally:
        if metadata is not None:
            os.close(metadata)
        if root is not None:
            root.close()
        os.close(common_fd)


def checkout_data(workspace, head: str) -> tuple[list, bytes]:
    listing = git(workspace.root, ["ls-tree", "-r", "-l", "-z", "--full-tree", head], output_limit=32 * 1024 * 1024)
    files, directories, total = [], set(), 0
    for line in listing.split(b"\0"):
        if not line:
            continue
        header, raw_path = line.split(b"\t", 1)
        mode, kind, object_id, size = header.split()
        require(mode in (b"100644", b"100755") and kind == b"blob" and size.isdigit(), "Worktree creation does not materialize symlinks or submodules", "unsupported_path")
        name = raw_path.decode("utf-8", "strict")
        parts = relative(name)
        require_entry(len(parts) - 1 <= MAX_TREE_DEPTH, "budget", "Worktree nesting exceeds budget", name)
        for end in range(1, len(parts)):
            parent = tuple(parts[:end])
            if parent not in directories:
                # Reserve this implicit directory and the current file before
                # retaining the prefix; shared parents consume only one entry.
                require_entry(len(files) + len(directories) + 1 < MAX_TREE_ENTRIES, "budget", "Worktree entry budget reached", name)
                directories.add(parent)
        require_entry(len(files) + len(directories) < MAX_TREE_ENTRIES, "budget", "Worktree entry budget reached", name)
        length = int(size)
        total += length
        require_entry(length <= MAX_BLOB and total <= MAX_TREE_BYTES, "budget", "Worktree checkout exceeds file or byte budget", name)
        files.append((name, object_id, length, 0o755 if mode == b"100755" else 0o644))
    data = git(workspace.root, ["cat-file", "--batch"], input_bytes=b"".join(ident + b"\n" for _, ident, _, _ in files),
               input_limit=MAX_TREE_ENTRIES * 65, output_limit=MAX_TREE_BYTES + MAX_TREE_ENTRIES * 128, seconds=45)
    offset = 0
    for _, object_id, length, _ in files:
        end = data.find(b"\n", offset)
        require(end >= offset and data[offset:end] == object_id + b" blob " + str(length).encode(), "Git blob stream does not match the selected tree", "git_unavailable")
        offset = end + 1
        require(len(data) >= offset + length + 1 and data[offset + length:offset + length + 1] == b"\n", "Git blob stream is incomplete", "git_unavailable")
        offset += length + 1
    require(offset == len(data), "Unexpected trailing Git blob output", "git_unavailable")
    return files, data


def check_partial(root, prepared):
    files, data = prepared
    expected = {}
    parents = set()
    offset = 0
    for path, _, size, mode in files:
        start = data.index(b"\n", offset) + 1
        expected[path] = (start, size, mode)
        offset = start + size + 1
        parents.update(p.as_posix() for p in Path(path).parents)
    found = set()
    def visit(parent, prefix):
        with os.scandir(parent) as entries:
            for entry in entries:
                if not prefix and entry.name == ".git":
                    continue
                path = prefix + entry.name
                info = entry.stat(follow_symlinks=False)
                if path in parents and stat.S_ISDIR(info.st_mode):
                    fd = os.open(entry.name, os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    try:
                        visit(fd, path + "/")
                    finally:
                        os.close(fd)
                    continue
                require(path in expected and stat.S_ISREG(info.st_mode), "Unexpected worktree content preserved", "recovery_required")
                start, size, mode = expected[path]
                fd = os.open(entry.name, os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    content, info = read_file(fd, MAX_BLOB)
                finally:
                    os.close(fd)
                require(content == data[start:start+size] and stat.S_IMODE(info.st_mode) == mode,
                        "Edited worktree file preserved during recovery", "recovery_required")
                found.add(path)
    visit(root.fd, "")
    return found


def materialize(workspace, root: Root, head: str, prepared: tuple[list, bytes], *, resume=False) -> None:
    files, data = prepared
    existing = check_partial(root, prepared) if resume else set()
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
            if name not in existing:
                write_new(parent, parts[-1], data[offset:offset + length], mode)
        finally:
            os.close(parent)
        offset += length + 1
    require(offset == len(data), "Unexpected trailing Git blob output", "git_unavailable")
    git(root, ["read-tree", "--reset", head])


def matches_original_move(workspace, request_digest, action, identity_value, revision, binding):
    from .common import digest
    body = {"version": 1, "root": str(workspace.root.path), "action": action,
            "params": {"worktreeId": identity_value, "expectedRevision": revision, "confirm": True}, "binding": binding}
    if digest(body) == request_digest:
        return True
    if not request_digest:
        return False
    from .workspace_repository_identity import repository_identity
    return digest({**body, "repositoryIdentity": repository_identity(workspace)}) == request_digest


def finish_phase(holder, identity_value, observed, workspace):
    pending = pending_state(holder)
    if pending is None:
        return
    _, candidate = pending
    require(candidate is not None, "Incomplete worktree phase evidence retained", "recovery_required")
    try:
        current = read_record(holder)
    except FileNotFoundError:
        current = {}
    op = operation_id(candidate.get("operationId"))
    phase = candidate.get("phase")
    allowed = {"creating", "active", "archived", "retired", "retiring", "worktree/archive", "worktree/restore"}
    require(phase in allowed and not set(candidate) - {"phase", "operationId", "expectedRevision", "head", "binding"},
            "Unrecognized worktree phase evidence retained", "recovery_required")
    require(candidate.get("binding", observed["binding"]) == observed["binding"] and candidate.get("head", observed["head"]) == observed["head"],
            "Worktree phase identity changed", "recovery_required")
    saved = workspace.store.read(op)
    if phase in ("creating", "active") and op == identity_value:
        valid = current.get("operationId", op) == op and current.get("phase", "creating") in (("creating",) if phase == "creating" else ("creating", "active")) and observed["phase"] == "active"
    elif phase in ("active", "archived", "retired"):
        valid = current.get("operationId") == op and observed["phase"] == phase
    else:
        action = "worktree/retire" if phase == "retiring" else phase
        expected = candidate.get("expectedRevision")
        valid = (expected == observed.get("revision") and (current == candidate or saved.get("state") in ("running", "failed")) and
                 matches_original_move(workspace, saved.get("requestDigest"), action, identity_value, expected, observed["binding"]))
    require(valid and (current == candidate or saved.get("state") in ("running", "failed", "completed")),
            "Worktree phase cannot be tied to its original operation", "recovery_required")
    os.replace(".state-next", "state.json", src_dir_fd=holder, dst_dir_fd=holder)
    os.fsync(holder)


def retire_info(workspace, params):
    op = params["operationId"]
    saved = workspace.store.read(op)
    require(saved.get("requestDigest") == params["requestDigest"], "Original retirement receipt is unavailable", "operation_conflict")
    candidates = []
    with storage(workspace) as (_, _, state, active_ids):
        def inspect_markers(parent, names):
            for name in names:
                operation_id(name)
                fd = private_directory(parent, name)
                try:
                    try:
                        current = read_record(fd)
                    except FileNotFoundError:
                        current = {}
                    pending = pending_state(fd)
                    for item in (current, pending[1] if pending else None):
                        if isinstance(item, dict) and item.get("operationId") == op and item.get("phase") in ("retiring", "retired"):
                            revision = item.get("expectedRevision")
                            require(isinstance(revision, str) and re.fullmatch(r"[a-f0-9]{64}", revision), "Incomplete retirement revision", "recovery_required")
                            candidates.append((name, revision))
                finally:
                    os.close(fd)
        inspect_markers(state, active_ids)
        try:
            retired = private_directory(state, "retired")
        except FileNotFoundError:
            retired = None
        if retired is not None:
            try:
                names = []
                with os.scandir(retired) as listing:
                    for entry in listing:
                        require(len(names) < 256, "Retired worktree inventory exceeds budget", "budget")
                        names.append(entry.name)
                inspect_markers(retired, names)
            finally:
                os.close(retired)
    require(len(set(candidates)) == 1, "No unambiguous original retirement was found", "recovery_required")
    name, revision = candidates[0]
    return {"worktreeId": name, "expectedRevision": revision, "confirm": True}


def reconcile_creation(workspace, params):
    identity_value, request_digest = params["operationId"], params["requestDigest"]
    with workspace.store.mutation(identity_value, request_digest, reconcile=True) as (receipt, saved):
        if saved["state"] == "completed" or saved.get("response", {}).get("error", {}).get("delivery") == "not_sent":
            return {"operationId": identity_value, **saved}
        with storage(workspace) as (home, _, state, names):
            require(identity_value in names, "Original creation journal is unavailable", "recovery_required")
            holder = private_directory(state, identity_value)
            try:
                observed = inspect(workspace, home, identity_value, {}, creating=True, identity_only=True)
                require(Path(observed["binding"]["gitDir"]).name == identity_value and observed["phase"] == "active",
                        "Checkout registration does not match the original creation", "worktree_unbound")
                finish_phase(holder, identity_value, observed, workspace)
                phase = read_record(holder)
                require(phase.get("operationId") == identity_value and phase.get("phase") in ("creating", "active") and
                        phase.get("binding", observed["binding"]) == observed["binding"] and phase.get("head", observed["head"]) == observed["head"],
                        "Original checkout identity or HEAD changed", "worktree_unbound")
                if phase["phase"] == "creating":
                    require(phase.get("head") == observed["head"], "Original checkout HEAD is unavailable", "recovery_required")
                    prepared = checkout_data(workspace, observed["head"])
                    created = Root(observed["path"], [])
                    try:
                        # Never reset a staged change while resuming the final index publication.
                        if (Path(observed["binding"]["gitDir"]) / "index").exists():
                            delta = git(created, ["diff-index", "--cached", "--raw", "-z", observed["head"], "--"])
                            require(not delta, "Changed worktree index retained", "recovery_required")
                        materialize(workspace, created, observed["head"], prepared, resume=True)
                    finally:
                        created.close()
                observed = inspect(workspace, home, identity_value, observed["binding"])
                Record(holder, identity_value).save({"phase": "active", "operationId": identity_value,
                                                     "binding": observed["binding"], "head": observed["head"]})
                complete = {"requestDigest": request_digest, "state": "completed", "response": {"ok": True, "result": {**observed, "created": True}}}
                receipt.save(complete)
                return {"operationId": identity_value, **complete}
            finally:
                os.close(holder)


def run(workspace, request: dict, record: Record | None) -> dict:
    if record is not None:
        record.side_effects = False
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
            registration = common / "worktrees" / identity_value
            require(not registration.exists() and not registration.is_symlink(), "Original worktree id already registered", "conflict")
            common_fd = directory(common)
            try:
                common_info = os.fstat(common_fd)
                require(common_info.st_uid == os.geteuid() and not common_info.st_mode & 0o022, "Shared Git metadata cannot create managed worktrees", "worktree_shared")
            finally:
                os.close(common_fd)
            head = git(workspace.root, ["rev-parse", "--verify", "--end-of-options", ref(params["ref"]) + "^{commit}"]).decode().strip()
            require(re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", head) is not None, "Selected ref is not a commit", "git_unavailable")
            prepared = checkout_data(workspace, head)
            record.side_effects = True
            holder = private_directory(state, identity_value, create=True)
            try:
                journal = Record(holder, identity_value)
                journal.save({"phase": "creating", "operationId": record.identity, "head": head})
                os.mkdir(identity_value, 0o700, dir_fd=active)
                os.fsync(active)
                target = home / "worktrees" / identity_value
                git(workspace.root, ["worktree", "add", "--no-checkout", "--detach", "--", str(target), head], seconds=45)
                observed = inspect(workspace, home, identity_value, {}, creating=True, identity_only=True)
                journal.save({"phase": "creating", "operationId": record.identity, "head": head, "binding": observed["binding"]})
                created = Root(str(target), [])
                try:
                    materialize(workspace, created, head, prepared)
                finally:
                    created.close()
                result = inspect(workspace, home, identity_value, {}, creating=True)
                require(result["phase"] == "active", "Created worktree needs recovery inspection", "recovery_required")
                journal.save({"phase": "active", "operationId": record.identity, "head": head, "binding": result["binding"]})
                return {**result, "created": True}
            finally:
                os.close(holder)
        before = inspect(workspace, home, identity_value, binding, lightweight=action == "worktree/read")
        retired_path = home / "worktree-state" / "retired" / identity_value / "checkout"
        is_retired = Path(before["path"]) == retired_path
        parent = private_directory(state, "retired") if is_retired else os.dup(state)
        try:
            phase_holder = private_directory(parent, identity_value)
            try:
                finish_phase(phase_holder, identity_value, before, workspace)
                try:
                    marker = read_record(phase_holder)
                except FileNotFoundError:
                    marker = {}
                if not is_retired and marker.get("phase") == "retiring" and marker.get("expectedRevision") == before["revision"]:
                    original = workspace.store.read(operation_id(marker.get("operationId")))
                    if matches_original_move(workspace, original.get("requestDigest"), "worktree/retire", identity_value, before["revision"], binding):
                        before["retirementPending"] = True
                        require(action in ("worktree/read", "worktree/retire"), "Complete the pending retirement first", "recovery_required")
                if is_retired:
                    require(marker.get("phase") in ("retiring", "retired") and marker.get("expectedRevision") == before["revision"],
                            "Retired checkout differs from its journal", "recovery_required")
                    before["retirementPending"] = marker["phase"] != "retired" or before["phase"] != "retired"
                    if action == "worktree/retire":
                        require(params["expectedRevision"] == before["revision"], "Retirement revision differs", "conflict")
                        record.side_effects = True
                        if before["retirementPending"]:
                            git(workspace.root, ["worktree", "repair", str(retired_path)])
                            before = inspect(workspace, home, identity_value, binding)
                            require(before["phase"] == "retired", "Incomplete retirement registration", "recovery_required")
                            Record(phase_holder, identity_value).save({**marker, "phase": "retired"})
                        return {**before, "retirementPending": False, "retired": True, "retained": True}
                    require(action == "worktree/read", "Retired checkout only supports retirement reconciliation", "recovery_required")
            finally:
                os.close(phase_holder)
        finally:
            os.close(parent)
        if action == "worktree/read":
            return before
        require(before["revision"] == params["expectedRevision"], "Worktree changed; inspect the current revision", "conflict")
        if action == "worktree/attach":
            require(before["phase"] == "active", "Only an active managed worktree can be attached", "recovery_required")
            return {**before, "attached": True}
        if action == "worktree/retire":
            previous_holder = private_directory(state, identity_value)
            try:
                prior = read_record(previous_holder)
            finally:
                os.close(previous_holder)
            resuming = prior.get("phase") == "retiring" and prior.get("expectedRevision") == before["revision"]
            require(before["phase"] in ("active", "archived") or resuming, "Resolve worktree recovery before retirement", "recovery_required")
            checkout = Root(before["path"], [])
            try:
                from .workspace_git_view import content_view
                with content_view(checkout, Path(binding["gitDir"]), Path(binding["commonDir"])) as (environment, descriptors):
                    dirty = git(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], environment=environment, descriptors=descriptors)
                require(not dirty, "工作树仍有修改、未跟踪或忽略的文件；请先保存或整理，退役不会丢弃它们。", "worktree_dirty")
            finally:
                checkout.close()
            retired = private_directory(state, "retired", create=True)
            holder = private_directory(state, identity_value)
            try:
                with os.scandir(retired) as listing:
                    require(sum(1 for _ in listing) < 256, "Retired worktree retention reached 256; server administrator must inspect retained archives", "budget")
                journal = Record(holder, identity_value)
                record.side_effects = True
                journal.save({"phase": "retiring", "operationId": record.identity, "expectedRevision": before["revision"]})
                target = home / "worktrees" / identity_value
                if before["path"] == str(target):
                    if before["phase"] == "active":
                        git(workspace.root, ["worktree", "lock", "--reason", "codex-harness-archive:" + identity_value, str(target)])
                    rename_absent(active, identity_value, holder, "checkout")
                captured = inspect(workspace, home, identity_value, binding)
                require(captured["revision"] == before["revision"], "Worktree changed during retirement; all files retained", "conflict")
                rename_absent(state, identity_value, retired, identity_value)
                target = home / "worktree-state" / "retired" / identity_value / "checkout"
                git(workspace.root, ["worktree", "repair", str(target)])
                journal.save({"phase": "retired", "operationId": record.identity, "expectedRevision": before["revision"]})
                return {**before, "path": str(target), "phase": "retired", "retired": True, "retained": True}
            finally:
                os.close(holder)
                os.close(retired)
        holder = private_directory(state, identity_value)
        try:
            journal = Record(holder, identity_value)
            require((action == "worktree/archive" and before["phase"] == "active") or
                    (action == "worktree/restore" and before["phase"] in ("archived", "recovery")), "Worktree phase does not permit this change", "recovery_required")
            record.side_effects = True
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
