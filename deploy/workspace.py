"""Versioned native-UID workspace operations; never a shell or root Git bridge."""
from __future__ import annotations

import base64
import json
import os
import signal
import stat
import sys
from pathlib import Path

from .common import DeployError, Layout, canonical, digest, require
from .workspace_paths import MAX_ENTRIES, MAX_FILE, RESERVED, Root, read_file, relative, rename_absent, revision, valid_revision
from .workspace_store import Record, Store, operation_id, write_new
from .workspace_index import FIELDS as INDEX_FIELDS

MAX_INPUT = 1024 * 1024
MAX_OUTPUT = 2 * 1024 * 1024
MAX_DOWNLOAD = 8 * 1024 * 1024
READS = {"list", "read", "download", "search", "metadata", "git/status", "git/diff", "git/refs", "operation/read", "recovery/list", "recovery/read", "worktree/read", "resource/skill/read", "resource/directory/resolve", "resource/plugin/preview"}
WRITES = {"write", "mkdir", "copy", "remove", "git/commit", "recovery/restore", "recovery/discard", "worktree/create", "worktree/attach", "worktree/archive", "worktree/restore"}
READS |= {"git/index/recovery/list", "git/index/recovery/read"}
# Internal supervisor housekeeping. It is deliberately absent from public RPC
# methods; an acknowledgement does not return or attest an operation result.
READS |= {"operation/ack"}
WRITES |= {"git/stage", "git/unstage", "git/index/recovery/restore", "git/index/recovery/discard"}
FIELDS = {"list": {"path"}, "read": {"path"}, "download": {"path", "expectedRevision"}, "metadata": {"path"}, "write": {"path", "text", "expectedRevision"},
          "search": {"path", "query", "mode", "caseSensitive", "limit"},
          "mkdir": {"path"}, "copy": {"path", "destination", "expectedRevision"},
          "remove": {"path", "expectedRevision", "confirm", "recursive"}, "git/status": set(), "git/diff": {"staged"},
          "git/commit": {"expectedHead", "expectedHeadRevision", "expectedIndexRevision", "author", "message"},
          "git/refs": set(), "operation/read": {"operationId"}, "recovery/list": set(), "recovery/read": {"operationId"},
          "recovery/restore": {"recoveryOperationId", "slot", "path", "sourceRevision", "expectedRevision"},
          "recovery/discard": {"recoveryOperationId", "expectedManifest", "confirm"}, "worktree/create": {"ref"}, "worktree/read": {"worktreeId"},
          "worktree/attach": {"worktreeId", "expectedRevision"}, "worktree/archive": {"worktreeId", "expectedRevision", "confirm"},
          "worktree/restore": {"worktreeId", "expectedRevision", "confirm"}, "resource/skill/read": {"path"}, "resource/directory/resolve": {"path"}, "resource/plugin/preview": {"path"}}
FIELDS.update(INDEX_FIELDS)
FIELDS["operation/ack"] = {"operationId", "requestDigest"}


def validate(value: object) -> dict:
    require(isinstance(value, dict) and not set(value) - {"version", "action", "root", "params", "operationId", "binding"} and
            type(value.get("version")) is int and value["version"] == 1, "Invalid workspace envelope")
    action, params = value.get("action"), value.get("params", {})
    require(isinstance(action, str) and action in READS | WRITES and isinstance(params, dict), "Unsupported workspace action")
    require(not set(params) - FIELDS[action], "Unsupported workspace field")
    if action in WRITES:
        operation_id(value.get("operationId"))
    else:
        require("operationId" not in value, "Read operations do not accept a mutation identity")
    if action in ("list", "metadata"):
        relative(params.get("path", ""), empty=True)
    elif action in ("read", "download", "write", "mkdir", "copy", "remove"):
        relative(params.get("path"))
    if action == "write":
        require(isinstance(params.get("text"), str) and "\0" not in params["text"] and len(params["text"].encode()) <= MAX_FILE,
                "Text edit exceeds budget or contains binary content", "budget")
        require("expectedRevision" in params, "Specify null to create or the current revision to edit")
        if params["expectedRevision"] is not None:
            valid_revision(params["expectedRevision"])
    if action in ("copy", "remove", "download"):
        valid_revision(params.get("expectedRevision"))
    if action == "copy":
        relative(params.get("destination"))
        require(params["path"] != params["destination"], "Copy destination must differ from source")
    if action == "remove":
        require(params.get("confirm") is True and params.get("recursive") is False,
                "Removal requires explicit confirmation and recursive:false; only files and empty directories are supported")
    if action == "operation/read":
        operation_id(params.get("operationId"))
    if action == "operation/ack":
        require(set(params) == FIELDS[action], "Invalid workspace acknowledgement fields")
        operation_id(params.get("operationId"))
        valid_revision(params.get("requestDigest"))
    if action == "recovery/read":
        operation_id(params.get("operationId"))
    if action in ("recovery/restore", "recovery/discard"):
        operation_id(params.get("recoveryOperationId"))
    if action == "recovery/restore":
        relative(params.get("path"))
        require(params.get("slot") in ("before", "next"), "Unknown recovery slot")
        valid_revision(params.get("sourceRevision"))
        require("expectedRevision" in params, "Restoring requires null for an absent destination or its current revision")
        if params["expectedRevision"] is not None:
            valid_revision(params["expectedRevision"])
    if action == "recovery/discard":
        valid_revision(params.get("expectedManifest"))
        require(params.get("confirm") is True, "Discarding recovery payloads requires explicit confirmation")
    if action in INDEX_FIELDS:
        from .workspace_index import validate as validate_index
        validate_index(action, params)
    elif action == "git/commit":
        from .workspace_commit import validate as validate_commit
        validate_commit(params)
    elif action.startswith("git/"):
        from .workspace_git import query_args
        query_args(action, params)
    if action.startswith("resource/"):
        from .workspace_resources import validate as validate_resource
        validate_resource(action, params)
    if action == "search":
        from .workspace_search import validate as validate_search
        validate_search(params)
    if action.startswith("worktree/"):
        from .workspace_worktrees import ref, validate_binding
        if action == "worktree/create":
            ref(params.get("ref"))
            require("binding" not in value, "New worktrees cannot import a caller binding")
        else:
            identity = operation_id(params.get("worktreeId"))
            validate_binding(value.get("binding"), identity, value.get("root"))
            if action != "worktree/read":
                valid_revision(params.get("expectedRevision"))
            if action in ("worktree/archive", "worktree/restore"):
                require(params.get("confirm") is True, "Worktree movement requires explicit confirmation")
    else:
        require("binding" not in value, "This action cannot accept a worktree binding")
    return {**value, "params": params}


def blocked_paths(layout: Layout, settings: dict) -> list[Path]:
    return [layout.config, layout.control, layout.app, layout.work, layout.run, Path(settings["home"]), Path(settings["cwd"]) / "workspace-state", Path(settings["cwd"]) / "worktree-state", Path(settings["cwd"]) / "git-index-state",
            *(layout.state / name for name in ("gateway", "supervisor", "identity", "caddy", "requests", "receipts", "transactions"))]


class Workspace:
    def __init__(self, root: Root, forbidden: list[Path], storage: Path):
        self.root, self.forbidden, self.dispatched = root, forbidden, False
        self.store = Store(root, storage)

    def metadata(self, path: str) -> dict:
        if not path:
            info = os.fstat(self.root.fd)
        else:
            with self.root.parent(path) as (parent, name):
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            return {"path": path, "kind": "directory", "revision": revision(info)}
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "Unsupported workspace file type or hardlink", "unsafe_path")
        if info.st_size > MAX_DOWNLOAD:
            return {"path": path, "kind": "file", "bytes": info.st_size, "editable": False, "downloadable": False, "reason": "file_too_large"}
        data, info = self.root.file(path, MAX_DOWNLOAD)
        result = {"path": path, "kind": "file", "bytes": len(data), "revision": revision(info, data), "downloadable": True}
        return {**result, "editable": False, "reason": "preview_too_large"} if len(data) > MAX_FILE else result

    def read(self, action: str, params: dict) -> dict:
        if action.startswith("recovery/"):
            from .workspace_recovery import read
            return read(self, action, params)
        if action == "operation/read":
            return self.store.read(params["operationId"])
        if action == "operation/ack":
            return self.store.acknowledge(params["operationId"], params["requestDigest"])
        if action in INDEX_FIELDS:
            from .workspace_index import run
            return run(self, action, params)
        if action.startswith("git/"):
            from .workspace_git import query
            return query(self.root, action, params, self.forbidden)
        path = params.get("path", "")
        if action == "metadata":
            return self.metadata(path)
        if action == "search":
            from .workspace_search import search
            return search(self.root, params)
        if action == "download":
            data, info = self.root.file(path, MAX_DOWNLOAD)
            actual = revision(info, data)
            require(actual == params["expectedRevision"], "Workspace file changed before download", "conflict")
            return {"path": path, "base64": base64.b64encode(data).decode("ascii"), "bytes": len(data), "revision": actual}
        if action == "list":
            entries = []
            with self.root.directory(path) as directory, os.scandir(directory) as listing:
                for item in listing:
                    if item.name == RESERVED:
                        continue
                    if len(entries) == MAX_ENTRIES:
                        return {"path": path, "entries": sorted(entries, key=lambda entry: entry["name"]), "truncated": True}
                    info = item.stat(follow_symlinks=False)
                    kind = "directory" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "unsupported"
                    entries.append({"name": item.name, "kind": kind, "bytes": info.st_size,
                                    "accessible": item.name != ".git" and kind != "unsupported" and (kind != "file" or info.st_nlink == 1)})
            return {"path": path, "entries": sorted(entries, key=lambda entry: entry["name"]), "truncated": False}
        data, info = self.root.file(path)
        result = {"path": path, "kind": "file", "bytes": len(data), "revision": revision(info, data)}
        try:
            text = data.decode("utf-8", "strict")
            require("\0" not in text, "Binary file")
        except (UnicodeDecodeError, DeployError):
            return {**result, "editable": False, "binary": True}
        return {**result, "editable": True, "binary": False, "text": text}

    def capture(self, record: Record, path: str, expected: str, *, empty_directory: bool = False):
        if empty_directory:
            with self.root.directory(path) as directory, os.scandir(directory) as children:
                require(next(children, None) is None and revision(os.fstat(directory)) == expected,
                        "Directory changed or is not empty", "conflict")
        else:
            data, info = self.root.file(path)
            require(revision(info, data) == expected, "Workspace file changed before mutation", "conflict")
        with self.root.parent(path) as (parent, name):
            rename_absent(parent, name, record.fd, "before")
            # Validate the actual inode captured by the atomic rename, rather
            # than trusting a check followed by an overwrite race.
            fd = None
            try:
                fd = os.open("before", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_DIRECTORY if empty_directory else 0), dir_fd=record.fd)
                if empty_directory:
                    with os.scandir(fd) as children:
                        require(next(children, None) is None, "Directory is not empty", "conflict")
                    actual = revision(os.fstat(fd))
                else:
                    data, info = read_file(fd)
                    actual = revision(info, data)
                require(actual == expected, "Workspace file changed before mutation", "conflict")
            except Exception:
                # Restore only if no writer filled the old path in the meantime.
                # On collision both versions remain, with the captured one in
                # this operation's recovery directory.
                rename_absent(record.fd, "before", parent, name)
                raise
            finally:
                if fd is not None:
                    os.close(fd)

    def mutate(self, action: str, params: dict, record: Record) -> dict:
        if action == "recovery/restore":
            from .workspace_recovery import restore
            return restore(self, params, record)
        if action == "recovery/discard":
            from .workspace_recovery import discard
            return discard(self, params, record)
        path = params["path"]
        if action == "mkdir":
            with self.root.parent(path) as (parent, name):
                os.mkdir(name, 0o755, dir_fd=parent)
                os.fsync(parent)
            return {"path": path, "created": True}
        if action == "remove":
            empty_directory = self.metadata(path)["kind"] == "directory"
            self.capture(record, path, params["expectedRevision"], empty_directory=empty_directory)
            return {"path": path, "removed": True, "recoveryOperationId": record.identity}
        if action == "copy":
            data, info = self.root.file(path)
            require(revision(info, data) == params["expectedRevision"], "Copy source changed", "conflict")
            destination = params["destination"]
            mode = stat.S_IMODE(info.st_mode) & 0o777
        else:
            data, destination = params["text"].encode(), path
            mode = 0o600
            if params["expectedRevision"] is not None:
                previous, info = self.root.file(path)
                require(revision(info, previous) == params["expectedRevision"], "Workspace file changed before mutation", "conflict")
                mode = stat.S_IMODE(info.st_mode) & 0o777
        written = write_new(record.fd, "next", data, mode)
        if action == "write" and params["expectedRevision"] is not None:
            self.capture(record, path, params["expectedRevision"])
        with self.root.parent(destination) as (parent, name):
            rename_absent(record.fd, "next", parent, name)
        return {"path": destination, "revision": revision(written, data), "bytes": len(data), "recoveryOperationId": record.identity}

    def dispatch(self, request: dict) -> dict:
        action, params = request["action"], request["params"]
        if action in READS:
            if action == "worktree/read":
                from .workspace_worktrees import run
                return {"ok": True, "result": run(self, request, None)}
            return {"ok": True, "result": self.read(action, params)}
        request_digest = digest({key: value for key, value in request.items() if key != "operationId"})
        reserve_bytes = 16384 if action in ("recovery/discard", "git/index/recovery/discard") else 2 * MAX_FILE + 16384
        with self.store.mutation(request["operationId"], request_digest, reserve_bytes=reserve_bytes,
                                 maintenance=action in ("recovery/discard", "git/index/recovery/discard")) as record:
            if isinstance(record, dict):
                return record
            self.dispatched = True
            if action in INDEX_FIELDS:
                from .workspace_index import run
                result = run(self, action, params, record)
            elif action.startswith("worktree/"):
                from .workspace_worktrees import run
                result = run(self, request, record)
            elif action == "git/commit":
                from .workspace_commit import run
                result = run(self, params, record, request_digest)
            else:
                result = self.mutate(action, params, record)
            response = {"ok": True, "result": result}
            record.save({"requestDigest": request_digest, "state": "completed", "response": response})
            return response


def failure(exc: Exception, *, dispatched: bool) -> dict:
    if isinstance(exc, DeployError):
        code, message = exc.code, str(exc)
    elif isinstance(exc, FileNotFoundError):
        code, message = "not_found", "Workspace resource does not exist"
    else:
        code, message = "workspace_error", "Workspace operation failed"
    return {"ok": False, "error": {"code": code, "message": message, "delivery": "unknown" if dispatched else "not_sent"}}


def workspace_main(layout: Layout, settings: dict) -> None:
    root = workspace = None
    output_limit = MAX_OUTPUT
    def interrupted(signum, frame):
        raise DeployError("interrupted", "Workspace helper was interrupted; read the original operation")
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM):
        signal.signal(signum, interrupted)
    signal.alarm(20)
    try:
        data = sys.stdin.buffer.read(MAX_INPUT + 1)
        require(len(data) <= MAX_INPUT, "Workspace request exceeds byte budget", "budget")
        request = validate(json.loads(data))
        if request["action"] == "download":
            output_limit = 12 * 1024 * 1024
        if request["action"].startswith("worktree/") or request["action"] in {"git/commit", *INDEX_FIELDS}:
            signal.alarm(75)
        forbidden = blocked_paths(layout, settings)
        root = Root(request.get("root"), forbidden)
        if request["action"].startswith("resource/"):
            from .workspace_resources import run
            response = {"ok": True, "result": run(root, request, layout, settings, forbidden)}
        else:
            workspace = Workspace(root, forbidden, Path(settings["cwd"]) / "workspace-state")
            response = workspace.dispatch(request)
    except Exception as exc:
        response = failure(exc, dispatched=workspace is not None and workspace.dispatched)
    finally:
        signal.alarm(0)
        if root is not None:
            root.close()
    output = canonical(response) + b"\n"
    require(len(output) <= output_limit, "Workspace result exceeds byte budget", "budget")
    sys.stdout.buffer.write(output)
