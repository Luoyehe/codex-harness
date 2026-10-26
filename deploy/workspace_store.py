"""Bounded native-owned recovery records outside browsable project roots.

No path from a record authorizes a filesystem operation. Recovery files stay
inside their descriptor-pinned UUID directory; a forged record cannot broaden
the scope of a later edit/delete.
"""
from __future__ import annotations

import json
import os
import hashlib
import re
import stat
import uuid
from pathlib import Path
from contextlib import contextmanager

from .common import DeployError, canonical, require
from .workspace_paths import MAX_FILE, Root, read_file, regular

MAX_RECORDS = 256
MAX_BYTES = 64 * 1024 * 1024
MAX_PROJECTS = 32


def operation_id(value: object) -> str:
    try:
        require(isinstance(value, str) and str(uuid.UUID(value)) == value, "Canonical operationId is required")
    except (ValueError, TypeError, AttributeError) as exc:
        raise DeployError("invalid_input", "Canonical operationId is required") from exc
    return value


def private_directory(parent: int, name: str, *, create: bool = False) -> int:
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
            os.fsync(parent)
        except FileExistsError:
            pass
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    info = os.fstat(fd)
    if info.st_uid != os.geteuid() or info.st_mode & 0o077:
        os.close(fd)
        raise DeployError("unsafe_path", "Workspace recovery directory has unsafe ownership or mode")
    return fd


def write_new(parent: int, name: str, data: bytes, mode: int = 0o600) -> os.stat_result:
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
    try:
        os.fchmod(fd, mode)
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            view = view[count:]
        os.fsync(fd)
        info = regular(fd)
    finally:
        os.close(fd)
    os.fsync(parent)
    return info


def read_record(directory: int) -> dict:
    fd = os.open("state.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        data, _ = read_file(fd, 16384)
    finally:
        os.close(fd)
    value = json.loads(data)
    require(isinstance(value, dict), "Invalid workspace operation record", "corrupt_state")
    return value


class Record:
    def __init__(self, fd: int, identity: str):
        self.fd, self.identity = fd, identity
        self.failure_details = {}

    def save(self, value: dict):
        data = canonical(value) + b"\n"
        require(len(data) <= 16384, "Workspace receipt exceeds budget", "budget")
        write_new(self.fd, ".state-next", data)
        os.replace(".state-next", "state.json", src_dir_fd=self.fd, dst_dir_fd=self.fd)
        os.fsync(self.fd)


class Store:
    def __init__(self, root: Root, storage: Path):
        self.root, self.storage = root, storage
        info = os.fstat(root.fd)
        self.project = hashlib.sha256(canonical({"path": str(root.path), "device": info.st_dev, "inode": info.st_ino})).hexdigest()

    def open(self, *, create: bool = False) -> int:
        # storage is derived only from fixed root-owned native.json, never JSON
        # input or a retained operation. Ancestors are opened without symlinks.
        parent = Root(str(self.storage.parent), [])
        global_store = project_lock = None
        try:
            global_store = private_directory(parent.fd, self.storage.name, create=create)
            if create:
                import fcntl
                project_lock = os.open("project.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=global_store)
                info = regular(project_lock)
                require(info.st_uid == os.geteuid() and not info.st_mode & 0o077, "Unsafe workspace project lock", "unsafe_path")
                try:
                    fcntl.flock(project_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as exc:
                    raise DeployError("busy", "Another workspace project is being admitted") from exc
                count = 0
                found = False
                with os.scandir(global_store) as projects:
                    for project in projects:
                        if project.name == "project.lock":
                            continue
                        require(re.fullmatch("[0-9a-f]{64}", project.name) is not None, "Unknown workspace recovery material", "recovery_required")
                        count += 1
                        require(count <= MAX_PROJECTS, "Workspace project recovery budget reached", "budget")
                        found |= project.name == self.project
                require(found or count < MAX_PROJECTS, "Workspace project recovery budget reached", "budget")
            return private_directory(global_store, self.project, create=create)
        finally:
            if project_lock is not None:
                os.close(project_lock)
            if global_store is not None:
                os.close(global_store)
            parent.close()

    def read(self, identity: str) -> dict:
        operation_id(identity)
        try:
            store = self.open()
        except FileNotFoundError:
            return {"operationId": identity, "state": "not_received"}
        try:
            try:
                directory = private_directory(store, identity)
            except FileNotFoundError:
                return {"operationId": identity, "state": "not_received"}
            try:
                return {"operationId": identity, **read_record(directory)}
            finally:
                os.close(directory)
        finally:
            os.close(store)

    def external_payload(self, identity: str) -> bool:
        # Index recovery records depend on the operation receipt for their
        # terminal state even when this store has no before/next file.
        index_store = Store(self.root, self.storage.parent / "git-index-state")
        project = directory = None
        try:
            project = index_store.open()
            directory = private_directory(project, identity)
            return True
        except FileNotFoundError:
            return False
        finally:
            if directory is not None: os.close(directory)
            if project is not None: os.close(project)

    def reclaim_acknowledged(self, store: int, identity: str, directory: int) -> bool:
        saved = read_record(directory)
        if saved.get("acknowledged") is not True or saved.get("state") != "completed" or saved.get("response", {}).get("ok") is not True:
            return False
        with os.scandir(directory) as children:
            names = [entry.name for entry in children]
        if names != ["state.json"] or self.external_payload(identity):
            return False
        actual, pinned = os.stat(identity, dir_fd=store, follow_symlinks=False), os.fstat(directory)
        require((actual.st_dev, actual.st_ino) == (pinned.st_dev, pinned.st_ino), "Workspace receipt directory changed", "conflict")
        os.unlink("state.json", dir_fd=directory)
        os.fsync(directory)
        os.rmdir(identity, dir_fd=store)
        os.fsync(store)
        return True

    def acknowledge(self, identity: str, request_digest: str) -> dict:
        """Internal supervisor cleanup after a durable gateway acceptance.

        This is not a success witness: native-owned files never establish that
        an operation succeeded. Missing receipts are idempotently acknowledged
        because the caller already holds the durable authoritative acceptance.
        """
        import fcntl
        operation_id(identity)
        require(isinstance(request_digest, str) and re.fullmatch("[0-9a-f]{64}", request_digest), "Invalid acknowledgement digest")
        try: store = self.open()
        except FileNotFoundError: return {"acknowledged": True, "operationId": identity, "removed": True}
        lock = directory = None
        try:
            lock = os.open("lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=store)
            info = regular(lock)
            require(info.st_uid == os.geteuid() and not info.st_mode & 0o077, "Unsafe workspace lock", "unsafe_path")
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc: raise DeployError("busy", "Another workspace mutation is running") from exc
            try: directory = private_directory(store, identity)
            except FileNotFoundError: return {"acknowledged": True, "operationId": identity, "removed": True}
            try: saved = read_record(directory)
            except FileNotFoundError:
                # A crash after the metadata unlink can leave an empty directory.
                with os.scandir(directory) as children:
                    require(next(children, None) is None, "Incomplete workspace receipt retains material", "recovery_required")
                os.rmdir(identity, dir_fd=store)
                os.fsync(store)
                return {"acknowledged": True, "operationId": identity, "removed": True}
            require(saved.get("requestDigest") == request_digest, "Workspace acknowledgement digest differs", "operation_conflict")
            require(saved.get("state") == "completed" and isinstance(saved.get("response"), dict) and saved["response"].get("ok") is True,
                    "Only completed accepted operations can be acknowledged", "recovery_required")
            if saved.get("acknowledged") is not True: Record(directory, identity).save({**saved, "acknowledged": True})
            removed = self.reclaim_acknowledged(store, identity, directory)
            return {"acknowledged": True, "operationId": identity, "removed": removed}
        finally:
            if directory is not None: os.close(directory)
            if lock is not None: os.close(lock)
            os.close(store)

    def inventory(self, store: int, reserve_bytes: int = 2 * MAX_FILE + 16384, *, maintenance: bool = False) -> None:
        total = count = scanned = 0
        with os.scandir(store) as entries:
            for entry in entries:
                if entry.name == "lock":
                    continue
                operation_id(entry.name)
                scanned += 1
                require(scanned <= MAX_RECORDS + 1, "Workspace recovery inventory exceeds budget", "budget")
                directory = private_directory(store, entry.name)
                try:
                    if self.reclaim_acknowledged(store, entry.name, directory):
                        continue
                    count += 1
                    # Exactly one extra slot allows an explicit discard to free
                    # material at capacity; failed/unknown cleanup keeps it used.
                    names = []
                    with os.scandir(directory) as children:
                        for child in children:
                            require(len(names) < 4, "Workspace recovery entry budget reached", "budget")
                            names.append(child.name)
                    require(len(names) <= 4 and set(names) <= {"state.json", ".state-next", "before", "next"},
                            "Unexpected workspace recovery material", "recovery_required")
                    for name in names:
                        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                        if stat.S_ISDIR(info.st_mode) and name in ("before", "next"):
                            empty = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                            try:
                                with os.scandir(empty) as children:
                                    require(next(children, None) is None, "Retained directory gained content; inspect recovery", "recovery_required")
                            finally:
                                os.close(empty)
                        else:
                            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= MAX_FILE,
                                    "Unsafe or oversized workspace recovery file", "recovery_required")
                            total += info.st_size
                            require(total + reserve_bytes <= MAX_BYTES, "Workspace recovery byte budget reached", "budget")
                finally:
                    os.close(directory)
        require(count < MAX_RECORDS + (1 if maintenance else 0), "Workspace recovery record budget reached; inspect retained records", "budget")

    @contextmanager
    def mutation(self, identity: str, request_digest: str, *, reserve_bytes: int = 2 * MAX_FILE + 16384, maintenance: bool = False):
        import fcntl
        operation_id(identity)
        store = self.open(create=True)
        lock = directory = None
        try:
            lock = os.open("lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=store)
            info = regular(lock)
            require(info.st_uid == os.geteuid() and not info.st_mode & 0o077, "Unsafe workspace lock", "unsafe_path")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise DeployError("busy", "Another workspace mutation is running") from exc
            try:
                directory = private_directory(store, identity)
            except FileNotFoundError:
                pass
            if directory is not None:
                saved = read_record(directory)
                require(saved.get("requestDigest") == request_digest, "Workspace operation ID reused with different input", "operation_conflict")
                yield saved.get("response", {"ok": False, "error": {"code": "unknown", "message": "Workspace operation needs recovery inspection", "delivery": "unknown"}})
                return
            self.inventory(store, reserve_bytes, maintenance=maintenance)
            os.mkdir(identity, 0o700, dir_fd=store)
            os.fsync(store)
            directory = private_directory(store, identity)
            record = Record(directory, identity)
            saved = {"requestDigest": request_digest, "state": "running"}
            record.save(saved)
            try:
                yield record
            except Exception as exc:
                error = {"code": exc.code if isinstance(exc, DeployError) else "workspace_error",
                         "message": str(exc) if isinstance(exc, DeployError) else "Workspace operation failed; inspect recovery record",
                         "delivery": "unknown"}
                record.save({**saved, **record.failure_details, "state": "failed", "response": {"ok": False, "error": error}})
                raise DeployError(error["code"], error["message"]) from exc
        finally:
            if directory is not None:
                os.close(directory)
            if lock is not None:
                os.close(lock)
            os.close(store)
