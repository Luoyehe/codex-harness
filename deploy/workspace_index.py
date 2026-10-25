"""Explicit-file staging and reversible index publication under HEAD/index locks."""
from __future__ import annotations

import os
import stat
from pathlib import Path

from .common import DeployError, digest, require
from .workspace_commit import OID, IndexLease, expected, file_data, safe_metadata, state
from .workspace_git import git, repository_paths
from .workspace_git_transaction import prepared_refs
from .workspace_git_view import INDEX_LIMIT, content_view, directory
from .workspace_index_store import IndexStore, SLOTS, payload
from .workspace_paths import read_file, relative, rename_absent, revision, valid_revision
from .workspace_store import Record, operation_id

VERSIONS = {"expectedHead", "expectedHeadRevision", "expectedIndexRevision"}
FIELDS = {"git/stage": VERSIONS | {"files"}, "git/unstage": VERSIONS | {"paths"},
          "git/index/recovery/list": set(), "git/index/recovery/read": {"operationId"},
          "git/index/recovery/restore": VERSIONS | {"recoveryOperationId", "slot", "sourceRevision"},
          "git/index/recovery/discard": {"recoveryOperationId", "expectedManifest", "confirm"}}
MAX_FILES = 32
MAX_FILE = 8 * 1024 * 1024
MAX_SELECTED = 32 * 1024 * 1024


def validate(action, params):
    require(action in FIELDS and set(params) == FIELDS[action], "Invalid Git index operation")
    if action in ("git/stage", "git/unstage", "git/index/recovery/restore"):
        require(params["expectedHead"] is None or isinstance(params["expectedHead"], str) and OID.fullmatch(params["expectedHead"]), "Select the current Git HEAD")
        valid_revision(params["expectedHeadRevision"])
        valid_revision(params["expectedIndexRevision"])
    if action in ("git/stage", "git/unstage"):
        choices = params["files" if action == "git/stage" else "paths"]
        require(isinstance(choices, list) and 1 <= len(choices) <= MAX_FILES, "Select between one and 32 explicit files")
        names = []
        for choice in choices:
            if action == "git/stage":
                require(isinstance(choice, dict) and set(choice) == {"path", "expectedRevision", "deleted"} and type(choice["deleted"]) is bool, "Stage needs an explicit file version or deletion")
                if choice["deleted"]: require(choice["expectedRevision"] is None, "Deletion must explicitly select an absent file")
                else: valid_revision(choice["expectedRevision"])
                name = choice["path"]
            else: name = choice
            relative(name)
            require(name not in names, "Duplicate selected index path")
            names.append(name)
    if action == "git/index/recovery/read": operation_id(params["operationId"])
    if action in ("git/index/recovery/restore", "git/index/recovery/discard"):
        operation_id(params["recoveryOperationId"])
    if action == "git/index/recovery/restore":
        require(params["slot"] in SLOTS, "Unknown index recovery slot")
        valid_revision(params["sourceRevision"])
    if action == "git/index/recovery/discard":
        valid_revision(params["expectedManifest"])
        require(params["confirm"] is True, "Discarding index snapshots requires explicit confirmation")


def selected_file(root, item):
    if item["deleted"]:
        try:
            with root.parent(item["path"]) as (parent, name): os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError: return None, None
        raise DeployError("conflict", "Selected deletion now exists")
    data, info = root.file(item["path"], MAX_FILE)
    require(revision(info, data) == item["expectedRevision"], "Selected file changed before staging", "conflict")
    return data, info


def entries(root, environment, descriptors):
    output = git(root, ["ls-files", "--stage", "-z"], environment=environment, descriptors=descriptors, output_limit=16 * 1024 * 1024)
    values = {}
    for line in output.split(b"\0"):
        if not line: continue
        header, name = line.split(b"\t", 1)
        mode, oid, stage = header.decode("ascii").split()
        name = name.decode("utf-8", "strict")
        relative(name)
        require(mode in ("100644", "100755", "120000", "160000") and OID.fullmatch(oid) and stage in ("0", "1", "2", "3"), "Unsupported Git index entry", "unsafe_path")
        require(len(values) < 100000 and (name, stage) not in values, "Index entry budget or duplicate exceeded", "budget")
        values[name, stage] = mode, oid
    return values


def view_bytes(environment):
    index = Path(environment["GIT_INDEX_FILE"])
    parent = directory(index.parent)
    try: return file_data(parent, index.name, INDEX_LIMIT)[0]
    finally: os.close(parent)


def replace_view(environment, data):
    # Only the helper-created private view is replaced, never the real index.
    target = Path(environment["GIT_INDEX_FILE"])
    if data is None:
        target.unlink(missing_ok=True)
    else:
        target.write_bytes(data)


def prepare(workspace, action, params, paths, current, original):
    root = workspace.root
    selected = [item["path"] for item in params["files"]] if action == "git/stage" else params.get("paths", [])
    with content_view(root, *paths) as (environment, descriptors):
        hash_length = 64 if git(root, ["rev-parse", "--show-object-format"], environment=environment, descriptors=descriptors).strip() == b"sha256" else 40
        git(root, ["update-index", "--no-split-index"], environment=environment, descriptors=descriptors)
        before = view_bytes(environment) if original is not None else None
        old_entries = entries(root, environment, descriptors)
        if action == "git/index/recovery/restore":
            after = IndexStore(workspace).source(params["recoveryOperationId"], params["slot"], params["sourceRevision"])
            replace_view(environment, after)
            entries(root, environment, descriptors)
            # Captured raw indexes may be split; materialize a self-contained
            # version before publication instead of retaining external links.
            if after is not None:
                git(root, ["update-index", "--no-split-index"], environment=environment, descriptors=descriptors)
                after = view_bytes(environment)
            return before, after, selected, hash_length
        instructions, total = bytearray(), 0
        for index, name in enumerate(selected):
            instructions.extend(b"0 " + b"0" * hash_length + b"\t" + name.encode() + b"\0")
            if action == "git/stage":
                data, info = selected_file(root, params["files"][index])
                if data is None: continue
                total += len(data)
                require(total <= MAX_SELECTED, "Selected staging files exceed byte budget", "budget")
                oid = git(root, ["hash-object", "-w", "--stdin"], environment=environment, descriptors=descriptors, input_bytes=data, input_limit=MAX_FILE).decode().strip()
                require(OID.fullmatch(oid), "Invalid staged object", "git_unavailable")
                mode = "100755" if info.st_mode & 0o111 else "100644"
            else:
                if current["head"] is None: continue
                output = git(root, ["--literal-pathspecs", "ls-tree", "-z", current["head"], "--", name], environment=environment, descriptors=descriptors)
                if not output: continue
                require(output.count(b"\0") == 1, "Unstage must name an exact entry", "invalid_input")
                header, found = output[:-1].split(b"\t", 1)
                mode, kind, oid = header.decode("ascii").split()
                require(found.decode() == name and mode in ("100644", "100755", "120000", "160000") and OID.fullmatch(oid), "Unstage cannot select an entire directory", "invalid_input")
            instructions.extend(mode.encode() + b" " + oid.encode() + b"\t" + name.encode() + b"\0")
        git(root, ["update-index", "-z", "--index-info"], environment=environment, descriptors=descriptors, input_bytes=bytes(instructions))
        new_entries = entries(root, environment, descriptors)
        changed = {key[0] for key in old_entries.keys() | new_entries.keys() if old_entries.get(key) != new_entries.get(key)}
        require(changed and changed <= set(selected), "No selected index changes, or a directory conflict would change unselected entries", "conflict")
        return before, view_bytes(environment), selected, hash_length


def capture_index(metadata, backup, original):
    if original is None:
        try: os.stat("index", dir_fd=metadata, follow_symlinks=False)
        except FileNotFoundError: return
        raise DeployError("conflict", "An index appeared before publication")
    data, info = original
    rename_absent(metadata, "index", backup, "before.raw")
    try:
        actual, captured = file_data(backup, "before.raw", INDEX_LIMIT)
        require(revision(captured, actual) == revision(info, data), "Original index was replaced before capture", "conflict")
    except Exception:
        # Restore the captured actual inode only while its former path is empty.
        # A newly occupied index and the captured version are both preserved.
        rename_absent(backup, "before.raw", metadata, "index")
        raise


def change(workspace, action, params, record):
    root = workspace.root
    paths = repository_paths(root, workspace.forbidden)
    metadata, common = directory(paths[0]), directory(paths[1])
    lease = None
    try:
        safe_metadata(metadata, common, allow_in_progress=True)
        lease = IndexLease(metadata, record.identity)
        current = state(root, paths)
        expected(current, params)
        try: original = file_data(metadata, "index", INDEX_LIMIT)
        except FileNotFoundError: original = None
        if original is not None:
            require(original[1].st_uid == os.geteuid() and not original[1].st_mode & 0o022, "Shared or foreign-owned index cannot be replaced", "unsafe_path")
        before, after, selected, hash_length = prepare(workspace, action, params, paths, current, original)
        expected(state(root, paths), params)
        store = IndexStore(workspace)
        with store.create(record.identity, current, before, after) as (backup, saved):
            require(os.fstat(backup).st_dev == os.fstat(metadata).st_dev, "Index recovery requires the same filesystem", "unsupported_path")
            prepared_info = payload(backup, "next")[1] if after is not None else None
            with prepared_refs(root, paths, current, lease, {}, hash_length=hash_length):
                expected(state(root, paths, locked_head=current["head"]), params)
                lease.verify()
                if action == "git/stage":
                    for item in params["files"]: selected_file(root, item)
                capture_index(metadata, backup, original)
                if after is not None: rename_absent(backup, "next", metadata, "index")
                if after is None:
                    try: os.stat("index", dir_fd=metadata, follow_symlinks=False)
                    except FileNotFoundError: pass
                    else: raise DeployError("conflict", "An external index appeared after publication")
                else:
                    actual_data, actual_info = file_data(metadata, "index", INDEX_LIMIT)
                    require(actual_data == after and (actual_info.st_dev, actual_info.st_ino) == (prepared_info.st_dev, prepared_info.st_ino),
                            "Index changed after publication; snapshots retained", "conflict")
                final = state(root, paths, locked_head=current["head"])
                Record(backup, record.identity).save({**saved, "phase": "published", "indexRevision": final["indexRevision"]})
            result = {"head": current["head"], "indexRevision": final["indexRevision"], "previousIndexRevision": current["indexRevision"],
                      "recoveryOperationId": record.identity}
            if action == "git/index/recovery/restore": result["restoredFromOperationId"] = params["recoveryOperationId"]
            else: result.update(pathsDigest=digest(selected), selectedCount=len(selected))
            return result
    finally:
        try:
            if lease is not None: lease.close()
        finally:
            os.close(metadata)
            os.close(common)


def discard(workspace, params, record):
    source_id = params["recoveryOperationId"]
    require(source_id != record.identity, "Index recovery source cannot be the current operation")
    store = IndexStore(workspace)
    with store.open(source_id) as source:
        inspected, saved = store.inspect(source, source_id)
        require(inspected["discardAllowed"], "Unknown or failed index operations retain their backups", "recovery_required")
        require(inspected["manifest"] == params["expectedManifest"], "Index backup changed before discard", "conflict")
        with store.create(record.identity, saved.get("previous", {}), None, None, cleanup=True) as (captured, initial):
            Record(captured, record.identity).save({**initial, "beforeAbsent": saved["beforeAbsent"], "phase": "discarding", "sourceOperationId": source_id})
            for entry in inspected["entries"]:
                if entry["absent"]: continue
                name = SLOTS[entry["slot"]]
                rename_absent(source, name, captured, name)
                data, info = payload(captured, name)
                require(revision(info, data) == entry["revision"], "Index backup changed during capture; materials retained", "conflict")
            for entry in inspected["entries"]:
                if not entry["absent"]:
                    os.unlink(SLOTS[entry["slot"]], dir_fd=captured)
                    os.fsync(captured)
            store.remove_empty(source_id, source)
            store.remove_empty(record.identity, captured)
    return {"recoveryOperationId": source_id, "discarded": True, "receiptRetained": True}


def run(workspace, action, params, record=None):
    validate(action, params)
    if action in ("git/index/recovery/list", "git/index/recovery/read"):
        return IndexStore(workspace).read(action, params)
    if action == "git/index/recovery/discard": return discard(workspace, params, record)
    require(action in ("git/stage", "git/unstage", "git/index/recovery/restore"), "Unsupported index mutation")
    if action == "git/index/recovery/restore": require(params["recoveryOperationId"] != record.identity, "Index recovery source cannot be the current operation")
    return change(workspace, action, params, record)
