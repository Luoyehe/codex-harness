"""Explicit recovery within a registered root; retained paths never authorize writes."""
from __future__ import annotations

import os
import stat
from contextlib import contextmanager

from .common import DeployError, canonical, digest, require
from .workspace_paths import MAX_FILE, read_file, rename_absent, revision
from .workspace_store import MAX_RECORDS, Record, operation_id, private_directory, read_record, write_new

SLOTS = ("before", "next")


@contextmanager
def retained(workspace, identity: str):
    operation_id(identity)
    store = workspace.store.open()
    directory = None
    try:
        directory = private_directory(store, identity)
        yield directory
    finally:
        if directory is not None:
            os.close(directory)
        os.close(store)


def payload(directory: int, slot: str) -> tuple[dict, bytes | None, os.stat_result]:
    require(slot in SLOTS, "Unknown recovery slot")
    fd = os.open(slot, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        info = os.fstat(fd)
        if stat.S_ISDIR(info.st_mode):
            with os.scandir(fd) as listing:
                require(next(listing, None) is None, "Retained directory gained content; inspect recovery", "recovery_required")
            after = os.fstat(fd)
            require((info.st_mtime_ns, info.st_ctime_ns) == (after.st_mtime_ns, after.st_ctime_ns), "Recovery directory changed", "conflict")
            return {"slot": slot, "kind": "directory", "revision": revision(after)}, None, after
        data, info = read_file(fd)
        return {"slot": slot, "kind": "file", "bytes": len(data), "revision": revision(info, data)}, data, info
    finally:
        os.close(fd)


def inspect(directory: int, identity: str, *, preview: bool = False) -> tuple[dict, dict]:
    saved = read_record(directory)
    require(saved.get("state") in ("running", "completed", "failed"), "Invalid recovery receipt state", "corrupt_state")
    entries, plain = [], []
    for slot in SLOTS:
        try:
            entry, data, _ = payload(directory, slot)
        except FileNotFoundError:
            continue
        plain.append(entry)
        entry = dict(entry)
        if preview and data is not None:
            try:
                text = data.decode("utf-8", "strict")
                require("\0" not in text, "Binary content")
            except (UnicodeError, DeployError):
                entry.update(editable=False, binary=True)
            else:
                # Bound JSON escaping as well as original file bytes. Two
                # previews must fit the helper's existing output envelope.
                entry.update(editable=True, binary=False)
                if len(canonical(text)) <= MAX_FILE:
                    entry["text"] = text
                else:
                    entry["previewUnavailable"] = "escaped_text_exceeds_budget"
        entries.append(entry)
    manifest = digest({"record": saved, "entries": plain})
    return {"operationId": identity, "state": saved["state"], "requestDigest": saved.get("requestDigest"),
            "manifest": manifest, "discarded": saved.get("recoveryDiscarded") is True, "entries": entries}, saved


def read(workspace, action: str, params: dict) -> dict:
    if action == "recovery/read":
        with retained(workspace, params["operationId"]) as directory:
            return inspect(directory, params["operationId"], preview=True)[0]
    try:
        store = workspace.store.open()
    except FileNotFoundError:
        return {"records": [], "complete": True, "receiptLimit": MAX_RECORDS}
    try:
        names = []
        with os.scandir(store) as listing:
            for entry in listing:
                if entry.name == "lock":
                    continue
                operation_id(entry.name)
                names.append(entry.name)
                require(len(names) <= MAX_RECORDS + 1, "Recovery record inventory exceeds budget", "budget")
        records = []
        for identity in sorted(names):
            directory = private_directory(store, identity)
            try:
                try:
                    record, _ = inspect(directory, identity)
                except FileNotFoundError:
                    record = {"operationId": identity, "state": "unknown", "entries": [], "incomplete": True}
                records.append(record)
            finally:
                os.close(directory)
        return {"records": records, "complete": True, "receiptLimit": MAX_RECORDS}
    finally:
        os.close(store)


def restore(workspace, params: dict, record: Record) -> dict:
    identity, slot, destination = params["recoveryOperationId"], params["slot"], params["path"]
    require(identity != record.identity, "Recovery source cannot be the current operation")
    with retained(workspace, identity) as source:
        entry, data, info = payload(source, slot)
        require(entry["revision"] == params["sourceRevision"], "Retained recovery content changed", "conflict")
        mode = stat.S_IMODE(info.st_mode) & 0o777
        if data is None:
            os.mkdir("next", mode, dir_fd=record.fd)
            directory = os.open("next", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=record.fd)
            try:
                os.fchmod(directory, mode)
                os.fsync(directory)
                written = os.fstat(directory)
            finally:
                os.close(directory)
            os.fsync(record.fd)
        else:
            written = write_new(record.fd, "next", data, mode)
    if params["expectedRevision"] is not None:
        target = workspace.metadata(destination)
        workspace.capture(record, destination, params["expectedRevision"], empty_directory=target["kind"] == "directory")
    with workspace.root.parent(destination) as (parent, name):
        rename_absent(record.fd, "next", parent, name)
    result = {"path": destination, "kind": entry["kind"], "revision": revision(written, data),
              "restoredFromOperationId": identity, "recoveryOperationId": record.identity}
    if data is not None:
        result["bytes"] = len(data)
    return result


def discard(workspace, params: dict, record: Record) -> dict:
    identity = params["recoveryOperationId"]
    require(identity != record.identity, "Recovery source cannot be the current operation")
    with retained(workspace, identity) as source:
        inspected, saved = inspect(source, identity)
        require(saved["state"] == "completed", "Unknown or failed operations must retain recovery payloads", "recovery_required")
        require(inspected["manifest"] == params["expectedManifest"], "Recovery content changed before discard", "conflict")
        # Capture only the fixed slots into this operation's private directory.
        # Validate every captured inode before deleting any payload. A failed
        # validation retains all captured material in the new recovery record.
        for entry in inspected["entries"]:
            slot = entry["slot"]
            rename_absent(source, slot, record.fd, slot)
            actual, _, _ = payload(record.fd, slot)
            require(actual == entry, "Recovery payload changed during discard; captured material retained", "conflict")
        Record(source, identity).save({**saved, "recoveryDiscarded": True})
        for entry in inspected["entries"]:
            if entry["kind"] == "directory":
                os.rmdir(entry["slot"], dir_fd=record.fd)
            else:
                os.unlink(entry["slot"], dir_fd=record.fd)
            os.fsync(record.fd)
    return {"recoveryOperationId": identity, "discarded": True, "receiptRetained": True}
