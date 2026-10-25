"""Fixed, bounded native index backups; journal contents never select a path."""
from __future__ import annotations

import os
import stat
from contextlib import contextmanager

from .common import digest, require
from .workspace_git_view import INDEX_LIMIT
from .workspace_paths import read_file, revision
from .workspace_store import Record, Store, operation_id, private_directory, read_record, write_new

MAX_RECORDS = 64
MAX_BYTES = 128 * 1024 * 1024
SLOTS = {"before": "before.full", "captured": "before.raw", "next": "next"}


def payload(directory, name):
    require(name in SLOTS.values(), "Unknown index backup slot")
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        data, info = read_file(fd, INDEX_LIMIT)
        require(info.st_uid == os.geteuid() and not info.st_mode & 0o022, "Unsafe index backup ownership", "unsafe_path")
        return data, info
    finally:
        os.close(fd)


class IndexStore:
    def __init__(self, workspace):
        self.workspace = workspace
        self.store = Store(workspace.root, workspace.store.storage.parent / "git-index-state")

    def inventory(self, project, reserve, *, cleanup=False):
        count = total = 0
        with os.scandir(project) as entries:
            for entry in entries:
                operation_id(entry.name)
                count += 1
                require(count < MAX_RECORDS + (1 if cleanup else 0), "Git index backup identity budget reached", "budget")
                directory = private_directory(project, entry.name)
                try:
                    names = []
                    with os.scandir(directory) as children:
                        for child in children:
                            names.append(child.name)
                            require(len(names) <= 5 and child.name in {"state.json", ".state-next", *SLOTS.values()}, "Unexpected Git index backup material", "recovery_required")
                            info = child.stat(follow_symlinks=False)
                            limit = INDEX_LIMIT if child.name in SLOTS.values() else 16384
                            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.geteuid() and not info.st_mode & (0o022 if child.name in SLOTS.values() else 0o077) and info.st_size <= limit,
                                    "Unsafe Git index backup file", "recovery_required")
                            total += info.st_size
                            require(total + reserve <= MAX_BYTES, "Git index backup byte budget reached", "budget")
                finally:
                    os.close(directory)

    @contextmanager
    def create(self, identity, current, before, after, *, cleanup=False):
        operation_id(identity)
        reserve = 16384 if cleanup else 16384 + (len(before) if before is not None else 0) + (len(after) if after is not None else 0) + INDEX_LIMIT
        project = self.store.open(create=True)
        directory = None
        try:
            self.inventory(project, reserve, cleanup=cleanup)
            os.mkdir(identity, 0o700, dir_fd=project)
            os.fsync(project)
            directory = private_directory(project, identity)
            saved = {"version": 1, "operationId": identity, "phase": "prepared", "beforeAbsent": before is None, "previous": current}
            Record(directory, identity).save(saved)
            if before is not None: write_new(directory, "before.full", before)
            if after is not None: write_new(directory, "next", after)
            yield directory, saved
        finally:
            if directory is not None: os.close(directory)
            os.close(project)

    @contextmanager
    def open(self, identity):
        operation_id(identity)
        project = self.store.open()
        directory = None
        try:
            directory = private_directory(project, identity)
            yield directory
        finally:
            if directory is not None: os.close(directory)
            os.close(project)

    def inspect(self, directory, identity):
        saved = read_record(directory)
        require(saved.get("version") == 1 and saved.get("operationId") == identity and type(saved.get("beforeAbsent")) is bool,
                "Invalid index backup record", "corrupt_state")
        entries = []
        for slot, name in SLOTS.items():
            try: data, info = payload(directory, name)
            except FileNotFoundError: continue
            entries.append({"slot": slot, "bytes": len(data), "revision": revision(info, data), "absent": False})
        if saved["beforeAbsent"]:
            require(not any(entry["slot"] == "before" for entry in entries), "Ambiguous empty index snapshot", "corrupt_state")
            entries.insert(0, {"slot": "before", "bytes": 0, "revision": digest({"absent": True, "operationId": identity}), "absent": True})
        receipt = self.workspace.store.read(identity)
        state = receipt.get("state", "unknown")
        manifest = digest({"record": saved, "entries": entries, "state": state})
        return {"operationId": identity, "state": state, "phase": saved.get("phase"), "entries": entries, "manifest": manifest,
                "discardAllowed": state == "completed"}, saved

    def read(self, action, params):
        if action == "git/index/recovery/read":
            with self.open(params["operationId"]) as directory:
                return self.inspect(directory, params["operationId"])[0]
        try: project = self.store.open()
        except FileNotFoundError: return {"records": [], "complete": True, "retainedLimit": MAX_RECORDS}
        try:
            names = []
            with os.scandir(project) as listing:
                for entry in listing:
                    operation_id(entry.name)
                    names.append(entry.name)
                    require(len(names) <= MAX_RECORDS + 1, "Git index backup inventory exceeds budget", "budget")
            rows = []
            for identity in sorted(names):
                directory = private_directory(project, identity)
                try:
                    try: rows.append(self.inspect(directory, identity)[0])
                    except FileNotFoundError: rows.append({"operationId": identity, "state": "unknown", "entries": [], "incomplete": True})
                finally: os.close(directory)
            return {"records": rows, "complete": True, "retainedLimit": MAX_RECORDS}
        finally: os.close(project)

    def source(self, identity, slot, selected_revision):
        with self.open(identity) as directory:
            inspected, _ = self.inspect(directory, identity)
            found = [entry for entry in inspected["entries"] if entry["slot"] == slot]
            require(len(found) == 1 and found[0]["revision"] == selected_revision, "Index backup changed before restore", "conflict")
            if found[0]["absent"]: return None
            data, info = payload(directory, SLOTS[slot])
            require(revision(info, data) == selected_revision, "Index backup changed during restore", "conflict")
            return data

    def remove_empty(self, identity, directory):
        # Only fixed metadata and an empty UUID directory are removed. Unknown
        # payloads or replacements are retained; this is never recursive delete.
        with os.scandir(directory) as children:
            names = [entry.name for entry in children]
        require(names == ["state.json"], "Index backup still contains recovery material", "recovery_required")
        project = self.store.open()
        try:
            actual = os.stat(identity, dir_fd=project, follow_symlinks=False)
            pinned = os.fstat(directory)
            require((actual.st_dev, actual.st_ino) == (pinned.st_dev, pinned.st_ino), "Index backup directory ownership changed", "conflict")
            os.unlink("state.json", dir_fd=directory)
            os.fsync(directory)
            os.rmdir(identity, dir_fd=project)
            os.fsync(project)
        finally: os.close(project)
