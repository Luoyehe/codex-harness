"""Bounded native-identity rollout compatibility repair; never emits history text.

The 0.164 writer coordination lock excludes both existing and newly opened
writers. Every rewritten JSONL record keeps its original byte length, newline
and ordinal, including frozen fork-prefix offsets. Originals are never deleted.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import gzip
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

from .common import DeployError, fsync_directory

REQUEST_LIMIT = 8192
ROLLOUT_LIMIT = 1024 * 1024 * 1024
LINE_LIMIT = 32 * 1024 * 1024
LINE_COUNT_LIMIT = 1000000
BACKUP_LIMIT = 512 * 1024 * 1024
BACKUP_COUNT_LIMIT = 4096
ANCESTOR_LIMIT = 16
LOOKUP_ENTRY_LIMIT = 10000
COPY_METADATA_LIMIT = 2 * 1024 * 1024


class HistoryError(DeployError):
    def __init__(self, code: str, message: str, delivery: str = "not_sent"):
        super().__init__(code, message)
        self.delivery = delivery


def check(condition: bool, message: str, code: str = "thread_history_invalid") -> None:
    if not condition:
        raise HistoryError(code, message)


def _decode(raw: bytes) -> object:
    def unique(pairs):
        value = {}
        for key, item in pairs:
            check(key not in value, "Duplicate history JSON field")
            value[key] = item
        return value
    def invalid(_):
        raise HistoryError("thread_history_invalid", "Non-finite history JSON value")
    return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)


def _safe(info: os.stat_result, uid: int, *, directory: bool = False) -> None:
    check((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)) and
          not getattr(info, "st_file_attributes", 0) & 0x400 and
          (directory or info.st_nlink == 1), "History path is not a private regular entry")
    if os.name == "posix":
        check(info.st_uid == uid and not info.st_mode & 0o022,
              "History path ownership or permissions changed")


def _local_path(value: str) -> Path:
    path = Path(value)
    if os.name == "nt":
        text = str(path)
        if re.match(r"^\\\\\?\\[A-Za-z]:\\", text):
            path = Path(text[4:])
        else:
            check(not text.startswith(("\\\\?\\", "\\\\.\\")), "Unsupported Windows history namespace")
    return path


def _path(home: Path, requested: object, uid: int, *, inspect_compressed: bool = False) -> Path:
    check(home.is_absolute() and isinstance(requested, str) and "\x00" not in requested,
          "Invalid native history path")
    path = _local_path(requested)
    check(path.is_absolute() and ".." not in path.parts and path.is_relative_to(home),
          "History path is outside the native home")
    if inspect_compressed and path.suffix == ".jsonl" and not path.exists() and not path.is_symlink():
        compressed = path.with_suffix(".jsonl.zst")
        if compressed.exists() or compressed.is_symlink(): path = compressed
    relative = path.relative_to(home)
    check(len(relative.parts) >= 2 and relative.parts[0] in ("sessions", "archived_sessions") and
          (path.suffix == ".jsonl" or inspect_compressed and path.name.endswith(".jsonl.zst")),
          "History path is not a supported rollout")
    _safe(home.lstat(), uid, directory=True)
    current = home
    for part in relative.parts[:-1]:
        current /= part
        _safe(current.lstat(), uid, directory=True)
    _safe(path.lstat(), uid)
    return path


def _open(path: Path, flags: int, uid: int, *, create: bool = False) -> int:
    before = None
    try:
        before = path.lstat()
        _safe(before, uid)
    except FileNotFoundError:
        if not create:
            raise
    fd = os.open(path, flags | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0), 0o600)
    try:
        after = os.fstat(fd)
        _safe(after, uid)
        check(before is None or os.path.samestat(before, after), "History entry changed while opening", "thread_history_changed")
        check(os.path.samestat(after, path.lstat()), "History path changed while opening", "thread_history_changed")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _identity(info: os.stat_result) -> tuple:
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def _witness(info: os.stat_result, digest: str) -> dict:
    return {"sha256": digest, "device": str(info.st_dev), "inode": str(info.st_ino),
            "size": str(info.st_size), "mtimeNs": str(info.st_mtime_ns)}


def _read_witness(path: Path, uid: int) -> dict:
    with os.fdopen(_open(path, os.O_RDONLY, uid), "rb") as source:
        before = os.fstat(source.fileno())
        check(before.st_size <= ROLLOUT_LIMIT, "Rollout exceeds the repair budget", "thread_history_limit")
        digest = hashlib.sha256(); size = 0
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            check(size <= ROLLOUT_LIMIT, "Rollout exceeds the repair budget", "thread_history_limit")
            digest.update(chunk)
        check(size == before.st_size and _identity(before) == _identity(os.fstat(source.fileno())),
              "History changed during inspection", "thread_history_changed")
    return _witness(before, digest.hexdigest())


def _transform_line(line: bytes, thread_id: str, mode: str, index: int) -> tuple[bytes, int, int, str | None, bool, bool]:
    value = _decode(line)
    check(isinstance(value, dict) and isinstance(value.get("payload"), dict), "Invalid rollout record")
    payload = value["payload"]
    history_mode = None
    inherited = False
    if index == 0:
        check(value.get("type") == "session_meta" and payload.get("id") == thread_id,
              "Rollout thread identity does not match")
        history_mode = payload.get("history_mode")
        inherited = payload.get("history_base") is not None
        check(history_mode is None or history_mode in ("legacy", "paginated"), "Unsupported rollout history mode")
    else:
        check(value.get("type") != "session_meta", "Repeated rollout identity")
    changed = reasoning = 0
    opaque = False
    def item(entry: object) -> object:
        nonlocal changed, reasoning, opaque
        if isinstance(entry, dict) and entry.get("type") in ("compaction", "context_compaction") and entry.get("encrypted_content"):
            opaque = True
        if isinstance(entry, dict) and entry.get("type") == "reasoning":
            reasoning += 1
            if mode == "foreign" or isinstance(entry.get("content"), list) and bool(entry["content"]):
                changed += 1
                # Official ResponseItem::Other is excluded by is_api_message.
                return {"type": "other"}
        return entry
    if value.get("type") == "response_item":
        value["payload"] = item(payload)
    elif value.get("type") == "compacted" and payload.get("replacement_history") is not None:
        replacement = payload["replacement_history"]
        check(isinstance(replacement, list), "Invalid compacted replacement history")
        metadata = payload.get("replacement_history_metadata")
        check(metadata is None or isinstance(metadata, list) and len(metadata) == len(replacement),
              "Compacted history metadata does not match its items")
        retained = []
        for position, entry in enumerate(replacement):
            before = changed
            item(entry)
            if changed == before: retained.append(position)
        # Checkpoints bypass is_api_message: remove entries here, including the
        # parallel metadata, while preserving the outer JSONL byte boundary.
        payload["replacement_history"] = [replacement[position] for position in retained]
        if metadata is not None:
            payload["replacement_history_metadata"] = [metadata[position] for position in retained]
    if not changed:
        return line, reasoning, changed, history_mode, inherited, opaque
    ending = b"\r\n" if line.endswith(b"\r\n") else b"\n"
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    padding = len(line) - len(encoded) - len(ending)
    check(padding >= 0, "Repaired record cannot preserve its byte offset", "thread_history_limit")
    return encoded + b" " * padding + ending, reasoning, changed, history_mode, inherited, opaque


def _scan(path: Path, uid: int, thread_id: str, mode: str, output=None) -> tuple[dict, dict, os.stat_result]:
    """Only one bounded JSONL record is decoded at a time, never the whole file."""
    with os.fdopen(_open(path, os.O_RDONLY, uid), "rb") as source:
        before = os.fstat(source.fileno())
        check(before.st_size <= ROLLOUT_LIMIT, "Rollout exceeds the repair budget", "thread_history_limit")
        digest = hashlib.sha256(); size = count = reasoning = changed = 0; history_mode = None; inherited = opaque = False
        while line := source.readline(LINE_LIMIT + 1):
            count += 1; size += len(line)
            check(count <= LINE_COUNT_LIMIT and len(line) <= LINE_LIMIT and size <= ROLLOUT_LIMIT,
                  "Rollout exceeds the repair budget", "thread_history_limit")
            check(line.endswith(b"\n"), "Rollout is incomplete", "thread_history_changed")
            digest.update(line)
            transformed, found, removed, record_mode, record_inherited, record_opaque = _transform_line(line, thread_id, mode, count - 1)
            reasoning += found; changed += removed
            opaque |= record_opaque
            if count == 1: history_mode = record_mode; inherited = record_inherited
            if output is not None: output.write(transformed)
        check(count > 0 and size == before.st_size and _identity(before) == _identity(os.fstat(source.fileno())),
              "History changed during inspection", "thread_history_changed")
    return _witness(before, digest.hexdigest()), {"needsRepair": changed > 0,
            "reasoningItems": reasoning, "changedItems": changed, "historyMode": history_mode,
            "hasHistoryBase": inherited, "hasOpaqueCompaction": opaque}, before


def _inherited_plaintext(home: Path, path: Path, uid: int) -> dict:
    """Inspect plain frozen prefixes only, never replay or modify an ancestor.

    Missing/compressed/compacted lineage is deliberately not a compatibility
    proof. Native same-provider loading remains available in that case.
    """
    result = {"hasInheritedPlaintext": False, "inspectionUnsupported": False}
    try:
        with os.fdopen(_open(path, os.O_RDONLY, uid), "rb") as source:
            base = _decode(source.readline(LINE_LIMIT + 1))["payload"].get("history_base")
        if base is None:
            return result
        entries = []
        for root in (home / "sessions", home / "archived_sessions"):
            if not root.exists(): continue
            pending = [root]
            while pending:
                directory = pending.pop(); _safe(directory.lstat(), uid, directory=True)
                with os.scandir(directory) as listing:
                    for entry in listing:
                        entries.append(Path(entry.path))
                        check(len(entries) <= LOOKUP_ENTRY_LIMIT, "Ancestor lookup exceeds budget")
                        if entry.is_dir(follow_symlinks=False): pending.append(Path(entry.path))
        seen = set(); consumed = 0; found = False
        while base is not None:
            check(isinstance(base, dict) and isinstance(base.get("thread_id"), str) and
                  re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", base["thread_id"]) and
                  type(base.get("end_byte_offset")) is int and base["end_byte_offset"] > 0 and
                  type(base.get("end_ordinal_exclusive")) is int and base["end_ordinal_exclusive"] >= 0,
                  "Unsupported ancestor position")
            identity = base["thread_id"]; cutoff = base["end_byte_offset"]
            check(identity not in seen and len(seen) < ANCESTOR_LIMIT, "Ancestor lineage exceeds budget")
            seen.add(identity)
            matches = [entry for entry in entries if entry.name.endswith((identity + ".jsonl", identity + ".jsonl.zst"))]
            check(len(matches) == 1 and matches[0].suffix == ".jsonl", "Ancestor is unavailable or compressed")
            ancestor = _path(home, str(matches[0]), uid)
            with os.fdopen(_open(ancestor, os.O_RDONLY, uid), "rb") as source:
                before = os.fstat(source.fileno()); count = size = 0; next_base = None
                check(cutoff <= before.st_size and consumed + cutoff <= ROLLOUT_LIMIT, "Ancestor prefix exceeds budget")
                while size < cutoff:
                    raw = source.readline(min(LINE_LIMIT + 1, cutoff - size)); size += len(raw); count += 1
                    check(raw.endswith(b"\n") and len(raw) <= LINE_LIMIT and count <= LINE_COUNT_LIMIT,
                          "Ancestor prefix is incomplete")
                    value = _decode(raw); payload = value.get("payload")
                    check(isinstance(payload, dict), "Unsupported ancestor record")
                    if count == 1:
                        check(value.get("type") == "session_meta" and payload.get("history_mode") == "paginated",
                              "Unsupported ancestor metadata")
                        next_base = payload.get("history_base")
                    # Do not reimplement compaction/rollback replay. These cases
                    # are an explicit inspection limitation, not a clean proof.
                    check(value.get("type") != "compacted" and payload.get("type") not in
                          ("compaction", "context_compaction", "thread_rolled_back"), "Ancestor requires native replay")
                    if (value.get("type") == "response_item" and payload.get("type") == "reasoning" and
                            isinstance(payload.get("content"), list) and payload["content"]):
                        found = True
                check(_identity(before) == _identity(os.fstat(source.fileno())) and
                      os.path.samestat(before, ancestor.lstat()), "Ancestor changed during inspection")
                consumed += size; base = next_base
        result["hasInheritedPlaintext"] = found
    except (OSError, ValueError, TypeError, KeyError, HistoryError):
        result["inspectionUnsupported"] = True
    return result


@contextlib.contextmanager
def _lock(fd: int):
    """Use the same OS locks as Rust std::fs::File::{lock,try_lock}."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        import msvcrt
        class Overlapped(ctypes.Structure):
            _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t),
                        ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD), ("hEvent", wintypes.HANDLE)]
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.LockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                     wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped)]
        kernel.UnlockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                       wintypes.DWORD, ctypes.POINTER(Overlapped)]
        lock = Overlapped()
        handle = msvcrt.get_osfhandle(fd)
        if not kernel.LockFileEx(handle, 3, 0, 0xffffffff, 0xffffffff, ctypes.byref(lock)):
            raise HistoryError("thread_history_busy", "Native thread writer or history publication is still active")
        try:
            yield
        finally:
            if not kernel.UnlockFileEx(handle, 0, 0xffffffff, 0xffffffff, ctypes.byref(lock)):
                raise OSError(ctypes.get_last_error(), "Cannot release history coordination lock")
    else:
        import fcntl
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise HistoryError("thread_history_busy", "Native thread writer or history publication is still active") from None
        try:
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)


@contextlib.contextmanager
def _publication(home: Path, uid: int, thread_id: str, *other_threads: str):
    directory = home / "thread-writer-locks"
    directory.mkdir(mode=0o700, exist_ok=True)
    _safe(directory.lstat(), uid, directory=True)
    fd = _open(directory / ".coordination.lock", os.O_RDWR | os.O_CREAT, uid, create=True)
    try:
        with _lock(fd):
            for identity in (thread_id, *other_threads):
                thread_path = directory / (identity + ".lock")
                try:
                    writer = _open(thread_path, os.O_RDWR, uid)
                except FileNotFoundError:
                    writer = None
                if writer is not None:
                    try:
                        with _lock(writer):
                            pass
                    finally:
                        os.close(writer)
            # Every official writer takes coordination before opening its lock.
            # Keep coordination held until the replacement and fsync finish.
            yield
    finally:
        os.close(fd)


def _verify_backup(path: Path, uid: int, witness: dict) -> None:
    with os.fdopen(_open(path, os.O_RDONLY, uid), "rb") as compressed:
        info = os.fstat(compressed.fileno())
        check(os.name != "posix" or stat.S_IMODE(info.st_mode) == 0o600, "History backup must remain private")
        digest = hashlib.sha256(); size = 0
        with gzip.GzipFile(fileobj=compressed, mode="rb") as source:
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                check(size <= int(witness["size"]), "Original history backup exceeds its recorded size")
                digest.update(chunk)
        check(size == int(witness["size"]) and digest.hexdigest() == witness["sha256"],
              "Original history backup is not intact")


def _backup(home: Path, uid: int, thread_id: str, source_path: Path, witness: dict) -> None:
    directory = home / "harness-history-backups"
    directory.mkdir(mode=0o700, exist_ok=True)
    _safe(directory.lstat(), uid, directory=True)
    if os.name == "posix":
        check(stat.S_IMODE(directory.stat().st_mode) == 0o700, "History backups must remain private")
    path = directory / (thread_id + "-" + witness["sha256"] + ".jsonl.gz")
    if path.exists() or path.is_symlink():
        _verify_backup(path, uid, witness)
        return
    size = count = 0
    for entry in directory.iterdir():
        info = entry.lstat(); _safe(info, uid)
        count += 1; size += info.st_size
        check(count < BACKUP_COUNT_LIMIT and size < BACKUP_LIMIT,
              "History backup capacity is full; preserve or archive existing backups before retrying", "thread_history_backup_limit")
    fd, temporary = tempfile.mkstemp(prefix=".backup-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as output, os.fdopen(_open(source_path, os.O_RDONLY, uid), "rb") as source:
            before = os.fstat(source.fileno()); digest = hashlib.sha256(); consumed = 0
            check(_witness(before, witness["sha256"]) == witness, "History changed before backup", "thread_history_changed")
            with gzip.GzipFile(filename="", mode="wb", fileobj=output, compresslevel=1, mtime=0) as archive:
                while chunk := source.read(1024 * 1024):
                    consumed += len(chunk); digest.update(chunk)
                    check(consumed <= ROLLOUT_LIMIT, "Rollout exceeds the repair budget", "thread_history_limit")
                    archive.write(chunk)
                    check(size + output.tell() <= BACKUP_LIMIT,
                          "History backup capacity is full; preserve or archive existing backups before retrying", "thread_history_backup_limit")
            check(consumed == int(witness["size"]) and digest.hexdigest() == witness["sha256"] and
                  _identity(before) == _identity(os.fstat(source.fileno())), "History changed during backup", "thread_history_changed")
            check(size + output.tell() <= BACKUP_LIMIT, "History backup exceeds capacity", "thread_history_backup_limit")
            output.flush(); os.fsync(output.fileno())
        # Publication is exclusive and never overwrites an earlier original.
        os.link(temporary, path); os.unlink(temporary); temporary = None
        fsync_directory(directory); fsync_directory(home)
    finally:
        if temporary is not None:
            with contextlib.suppress(FileNotFoundError): os.unlink(temporary)


def _copy_scan(path: Path, uid: int, thread_id: str, *, output=None, target_header=None) -> tuple:
    """Read canonical records without replaying or changing their payloads."""
    with os.fdopen(_open(path, os.O_RDONLY, uid), "rb") as source:
        before = os.fstat(source.fileno())
        check(before.st_size <= ROLLOUT_LIMIT, "Rollout exceeds the copy budget", "thread_history_limit")
        digest = hashlib.sha256(); size = count = 0; ordinal = -1
        metadata = {"serviceTier": None}; latest = {}; header = None
        while raw := source.readline(LINE_LIMIT + 1):
            count += 1; size += len(raw)
            check(count <= LINE_COUNT_LIMIT and len(raw) <= LINE_LIMIT and size <= ROLLOUT_LIMIT,
                  "Rollout exceeds the copy budget", "thread_history_limit")
            check(raw.endswith(b"\n"), "Rollout is incomplete", "thread_history_changed")
            value = _decode(raw)
            check(isinstance(value, dict) and isinstance(value.get("payload"), dict), "Invalid rollout record")
            payload = value["payload"]; position = value.get("ordinal")
            check(type(position) is int and position > ordinal, "Recovery copy requires canonical paginated records")
            ordinal = position
            if count == 1:
                check(value.get("type") == "session_meta" and payload.get("id") == thread_id and position == 0,
                      "Rollout thread identity does not match")
                check(payload.get("history_mode") == "paginated" and payload.get("history_base") is None,
                      "Recovery copy requires independent paginated history", "thread_history_inherited")
                header = payload
                instructions = payload.get("base_instructions")
                check(instructions is None or isinstance(instructions, dict) and isinstance(instructions.get("text"), str),
                      "Unsupported base instructions")
                if instructions is not None: metadata["baseInstructions"] = instructions["text"]
                for original, exposed in (("dynamic_tools", "dynamicTools"), ("selected_capability_roots", "selectedCapabilityRoots")):
                    if original in payload:
                        check(payload[original] is None or isinstance(payload[original], list), "Unsupported recovery metadata")
                        metadata[exposed] = payload[original]
            else:
                check(value.get("type") != "session_meta", "Repeated rollout identity")
                if value.get("type") == "event_msg" and payload.get("type") == "thread_settings_applied" and payload.get("thread_id") == thread_id:
                    settings = payload.get("thread_settings")
                    check(isinstance(settings, dict), "Invalid thread settings record")
                    latest = {key: settings[key] for key in ("cwd", "model_provider_id") if key in settings}
                    check(settings.get("service_tier") is None or isinstance(settings["service_tier"], str), "Invalid service tier")
                    metadata["serviceTier"] = settings.get("service_tier")
                    if "reasoning_summary" in settings:
                        check(settings["reasoning_summary"] is None or isinstance(settings["reasoning_summary"], str), "Invalid reasoning summary")
                        metadata["summary"] = settings["reasoning_summary"]
                    else:
                        metadata.pop("summary", None)
            digest.update(raw)
            if output is not None:
                output.write(target_header if count == 1 else raw)
                check(output.tell() <= ROLLOUT_LIMIT, "Recovery copy exceeds the rollout budget", "thread_history_limit")
        check(count > 0 and size == before.st_size and _identity(before) == _identity(os.fstat(source.fileno())) and
              os.path.samestat(before, path.lstat()), "History changed during inspection", "thread_history_changed")
    check(len(json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) <= COPY_METADATA_LIMIT,
          "Recovery metadata exceeds the copy budget", "thread_history_limit")
    return _witness(before, digest.hexdigest()), header, metadata, latest, count


def _recovery_copy(home: Path, uid: int, request: dict, source_path: Path) -> dict:
    target = request.get("target")
    check(isinstance(target, dict) and set(target) == {"threadId", "path", "expected"}, "Invalid recovery target")
    target_id = target["threadId"]
    check(isinstance(target_id, str) and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", target_id) and
          target_id != request["threadId"], "Recovery copy requires a new native thread identity")
    provider = request.get("sourceProvider"); cwd = request.get("cwd")
    check(isinstance(provider, str) and 0 < len(provider) <= 128 and "\x00" not in provider and
          isinstance(cwd, str) and 0 < len(cwd) <= 4096 and "\x00" not in cwd and _local_path(cwd).is_absolute(),
          "Invalid recovery source settings")
    target_path = _path(home, target["path"], uid)
    check(target_path.relative_to(home).parts[0] == "sessions", "Recovery target must be an unarchived native thread")
    check(not os.path.samestat(source_path.stat(), target_path.stat()), "Recovery source and target must be independent files")
    temporary = None; replaced = False
    try:
        with _publication(home, uid, request["threadId"], target_id):
            _path(home, str(source_path), uid); _path(home, str(target_path), uid)
            source_witness, source_header, _, latest, _ = _copy_scan(source_path, uid, request["threadId"])
            target_witness, target_header, _, _, count = _copy_scan(target_path, uid, target_id)
            check(request.get("expected") == source_witness and target["expected"] == target_witness,
                  "History identity or content changed after inspection", "thread_history_changed")
            check(count == 1, "Recovery target is no longer empty", "thread_history_target_not_empty")
            check(target_header.get("model_provider") == provider and target_header.get("cwd") == cwd and
                  latest.get("model_provider_id", source_header.get("model_provider")) == provider and
                  latest.get("cwd", source_header.get("cwd")) == cwd,
                  "Recovery source settings changed", "thread_history_changed")
            check((source_header.get("base_instructions") or {}).get("text") ==
                  (target_header.get("base_instructions") or {}).get("text"), "Recovery target does not preserve base instructions")
            for key in ("dynamic_tools", "selected_capability_roots"):
                check(source_header.get(key) == target_header.get(key), "Recovery target does not preserve source settings")
            with os.fdopen(_open(target_path, os.O_RDONLY, uid), "rb") as stream:
                target_raw = stream.read(LINE_LIMIT + 1)
            check(len(target_raw) <= LINE_LIMIT and hashlib.sha256(target_raw).hexdigest() == target_witness["sha256"],
                  "Recovery target changed", "thread_history_changed")
            fd, temporary = tempfile.mkstemp(prefix=".harness-history-copy-", dir=target_path.parent)
            with os.fdopen(fd, "wb") as output:
                copied_witness, _, _, _, _ = _copy_scan(source_path, uid, request["threadId"], output=output, target_header=target_raw)
                check(copied_witness == source_witness, "Source changed during recovery copy", "thread_history_changed")
                output.flush(); os.fsync(output.fileno())
            _path(home, str(source_path), uid); _path(home, str(target_path), uid)
            check(_read_witness(source_path, uid) == source_witness and _read_witness(target_path, uid) == target_witness,
                  "History changed before recovery publication", "thread_history_changed")
            os.replace(temporary, target_path); replaced = True; temporary = None
            fsync_directory(target_path.parent)
            return {"copied": True, "sourcePreserved": True, "expected": source_witness,
                    "target": {"threadId": target_id, "expected": _read_witness(target_path, uid)}}
    except BaseException as error:
        if replaced:
            raise HistoryError("thread_history_unknown", "Recovery copy was published but confirmation failed; inspect the named recovery thread before continuing", "unknown") from None
        raise
    finally:
        if temporary is not None:
            with contextlib.suppress(FileNotFoundError): os.unlink(temporary)


def operate(home: Path, uid: int, request: object) -> dict:
    replaced = False
    temporary = None
    try:
        check(isinstance(request, dict), "Invalid history request")
        allowed = {"action", "threadId", "path", "mode", "expected"}
        if request.get("action") == "recovery-copy": allowed |= {"target", "sourceProvider", "cwd"}
        check(set(request) <= allowed, "Invalid history request")
        check(request.get("action") in ("inspect", "repair", "copy-inspect", "recovery-copy") and request.get("mode") in ("foreign", "plaintext"), "Unsupported history operation")
        thread_id = request.get("threadId")
        check(isinstance(thread_id, str) and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", thread_id) is not None, "Invalid history thread identity")
        home = _local_path(str(home))
        path = _path(home, request.get("path"), uid, inspect_compressed=request["action"] == "inspect")
        if request["action"] == "copy-inspect":
            check("expected" not in request, "Inspection does not accept replacement proof")
            witness, _, metadata, _, _ = _copy_scan(path, uid, thread_id)
            return {"expected": witness, "sourceMetadata": metadata}
        if request["action"] == "recovery-copy":
            return _recovery_copy(home, uid, request, path)
        if path.name.endswith(".jsonl.zst"):
            check("expected" not in request, "Inspection does not accept replacement proof")
            return {"expected": _read_witness(path, uid), "needsRepair": False, "reasoningItems": 0,
                    "changedItems": 0, "historyMode": None, "hasHistoryBase": False, "hasOpaqueCompaction": False,
                    "hasInheritedPlaintext": False, "inspectionUnsupported": True}
        witness, summary, info = _scan(path, uid, thread_id, request["mode"])
        result = {"expected": witness, **summary}
        if request["action"] == "inspect":
            check("expected" not in request, "Inspection does not accept replacement proof")
            return {**result, **(_inherited_plaintext(home, path, uid) if summary["hasHistoryBase"] and request["mode"] == "plaintext"
                               else {"hasInheritedPlaintext": False, "inspectionUnsupported": False})}
        check(not summary["hasHistoryBase"], "Inherited history needs independent materialization before repair", "thread_history_inherited")
        check(request["mode"] != "foreign" or not summary["hasOpaqueCompaction"],
              "Provider-specific compaction cannot be safely converted", "thread_history_opaque")
        check(request.get("expected") == witness, "History identity or content changed after inspection", "thread_history_changed")
        with _publication(home, uid, thread_id):
            _path(home, str(path), uid)
            check(_read_witness(path, uid) == witness, "History changed before publication", "thread_history_changed")
            if not summary["needsRepair"]:
                return {**result, "repaired": False, "backupPreserved": False}
            _backup(home, uid, thread_id, path, witness)
            fd, temporary = tempfile.mkstemp(prefix=".harness-history-", dir=path.parent)
            with os.fdopen(fd, "wb") as output:
                written_witness, written_summary, _ = _scan(path, uid, thread_id, request["mode"], output)
                check(written_witness == witness and written_summary == summary, "History changed during encoding", "thread_history_changed")
                output.flush()
                if os.name == "posix":
                    os.fchmod(output.fileno(), stat.S_IMODE(info.st_mode))
                os.fsync(output.fileno())
            # Coordination excludes native writers; this second comparison also
            # detects unrelated changes while the backup and temp file were made.
            _path(home, str(path), uid)
            check(_read_witness(path, uid) == witness, "History changed during publication", "thread_history_changed")
            os.replace(temporary, path); replaced = True; temporary = None
            fsync_directory(path.parent)
            return {**summary, "needsRepair": False, "expected": _read_witness(path, uid), "repaired": True, "backupPreserved": True}
    except BaseException as error:
        if replaced:
            raise HistoryError("thread_history_unknown", "History replacement completed but confirmation failed; inspect the original operation and preserved backup", "unknown") from None
        if isinstance(error, HistoryError):
            raise
        raise HistoryError("thread_history_unavailable", "Native history could not be safely inspected or repaired") from None
    finally:
        if temporary is not None:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary)


def history_main(home: Path, uid: int) -> None:
    try:
        raw = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
        check(len(raw) <= REQUEST_LIMIT, "History request exceeds budget")
        result = operate(home, uid, _decode(raw))
        # Metadata can contain Unicode base instructions. Bind the budget to
        # actual UTF-8 stdout bytes instead of ASCII escapes or console locale.
        encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        check(len(encoded) <= COPY_METADATA_LIMIT + REQUEST_LIMIT, "History response exceeds budget", "thread_history_limit")
        sys.stdout.buffer.write(encoded); sys.stdout.buffer.flush()
    except (ValueError, HistoryError) as error:
        if not isinstance(error, HistoryError):
            error = HistoryError("thread_history_invalid", "Invalid history request JSON")
        print(json.dumps({"error": {"code": error.code, "message": str(error), "delivery": error.delivery}}))
        raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Same-identity development history helper; no privilege changes")
    parser.add_argument("--home", type=Path, required=True)
    arguments = parser.parse_args()
    history_main(arguments.home, os.geteuid() if os.name == "posix" else 0)
