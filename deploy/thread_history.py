"""Bounded native-identity rollout compatibility repair; never emits history text.

The 0.164 writer coordination lock excludes both existing and newly opened
writers. Every rewritten JSONL record keeps its original byte length, newline
and ordinal, including frozen fork-prefix offsets. Originals are never deleted.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import contextlib
import hashlib
import gzip
from functools import lru_cache
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import tempfile
import time

from .common import DeployError, fsync_directory

REQUEST_LIMIT = 72 * 1024
ROLLOUT_LIMIT = 1024 * 1024 * 1024
LINE_LIMIT = 32 * 1024 * 1024
LINE_COUNT_LIMIT = 1000000
BACKUP_LIMIT = 512 * 1024 * 1024
BACKUP_COUNT_LIMIT = 4096
ANCESTOR_LIMIT = 16
LOOKUP_ENTRY_LIMIT = 1000000
ATTACHMENT_CHECKPOINT_BYTES = 8 * 1024 * 1024
COPY_METADATA_LIMIT = 2 * 1024 * 1024
ATTACHMENT_REFERENCE_LIMIT = 32768


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


def _rollout_index(home: Path, uid: int, target: str | None = None) -> dict[str, list[Path]]:
    """One bounded directory pass, reused for every ancestor in an inspection."""
    index = {}; count = 0
    _safe(home.lstat(), uid, directory=True)
    for root in (home / "sessions", home / "archived_sessions"):
        if not root.exists(): continue
        pending = [root]
        while pending:
            directory = pending.pop(); _safe(directory.lstat(), uid, directory=True)
            with os.scandir(directory) as listing:
                for entry in listing:
                    count += 1
                    check(count <= LOOKUP_ENTRY_LIMIT, "History directory lookup exceeds its traversal budget; reconciliation remains incomplete", "thread_history_limit")
                    if entry.is_dir(follow_symlinks=False): pending.append(Path(entry.path))
                    else:
                        match = re.search(r"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl(?:\.zst)?$", entry.name)
                        if match:
                            if target is None or match[1] == target: index.setdefault(match[1], []).append(Path(entry.path))
                        elif target is None: check(not entry.name.endswith((".jsonl", ".jsonl.zst")), "Unrecognized history filename; attachment reconciliation remains incomplete", "thread_history_unsupported")
    return index


INLINE_IMAGE_BYTES = 4 * 1024 * 1024
INLINE_IMAGE_MIMES = {"image/jpeg", "image/png", "image/gif", "image/webp"}


def _image_reference(value, active=None):
    if not isinstance(value, str) or value[:5].lower() != "data:":
        return None
    end = value.find(",", 0, 96)
    check(end > 0, "Invalid inline image header")
    _, separator, encoding = value[5:end].lower().partition(";")
    check(separator and encoding == "base64", "Unrecognized inline image encoding")
    size = len(value) - end - 1
    check(0 < size <= ((INLINE_IMAGE_BYTES + 2) // 3) * 4, "Inline image exceeds attachment budget", "thread_history_limit")
    try:
        raw = base64.b64decode(value[end + 1:], validate=True)
    except (binascii.Error, ValueError) as error:
        raise HistoryError("thread_history_invalid", "Invalid inline image encoding") from error
    check(0 < len(raw) <= INLINE_IMAGE_BYTES, "Inline image exceeds attachment budget", "thread_history_limit")
    digest = hashlib.sha256(raw).hexdigest()
    if active is not None and digest not in active: return None
    if raw.startswith(b"\x89PNG\r\n\x1a\n"): actual = "image/png"
    elif raw.startswith(b"\xff\xd8\xff"): actual = "image/jpeg"
    elif raw[:6] in (b"GIF87a", b"GIF89a"): actual = "image/gif"
    elif raw[:4] == b"RIFF" and raw[8:12] == b"WEBP": actual = "image/webp"
    else: raise HistoryError("thread_history_invalid", "Unrecognized inline image data")
    return actual, digest, len(raw)


def _reference_record(paths, images):
    result = {"paths": sorted(paths)}
    if images:
        result["images"] = [{"mimeType": mime, "sha256": digest} for mime, digest in sorted(images)]
    return result


def _active_image_digests(request):
    encoded = request.get("activeImageDigests")
    if encoded is None: return None
    check(isinstance(encoded, str) and len(encoded) <= ((32 * 1280 + 2) // 3) * 4, "Invalid active image digest list")
    try: raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError): raise HistoryError("thread_history_invalid", "Invalid active image digest list") from None
    check(len(raw) <= 32 * 1280 and len(raw) % 32 == 0, "Invalid active image digest length")
    return frozenset(raw[start:start + 32].hex() for start in range(0, len(raw), 32))


@lru_cache(maxsize=4)
def _digest_filter_stamp(active):
    if active is None: return None
    return hashlib.sha256(b"".join(bytes.fromhex(value) for value in sorted(active))).hexdigest()


def _managed_references(root: str, active=None, unmatched=None):
    found = set()
    images = set()
    attachment_root = _local_path(root)
    check(attachment_root.is_absolute() and ".." not in attachment_root.parts, "Invalid attachment root")
    def collect(value, depth=0):
        check(depth <= 64, "Attachment record nesting exceeds budget", "thread_history_limit")
        if isinstance(value, dict):
            kind = value.get("type")
            # Native queue JSON, Responses input_image, and rollout user_message
            # carry the same file in different input fields. Ignore plain text
            # that merely mentions a data URI.
            candidates = []
            if kind == "image": candidates = [value.get("url"), value.get("image_url")]
            elif kind == "input_image":
                url = value.get("image_url")
                candidates = [url.get("url") if isinstance(url, dict) else url]
            elif kind == "user_message" and isinstance(value.get("images"), list):
                candidates = value["images"]
            for candidate in candidates:
                if unmatched is not None:
                    ref = _image_reference(candidate)
                    if ref and active is not None and ref[1] not in active:
                        unmatched.add(ref[:2])
                        check(len(unmatched) <= 128, "Unmatched inline image evidence exceeds per-thread budget", "thread_history_limit")
                        continue
                else:
                    ref = _image_reference(candidate, active) if active is None or active else None
                if ref: images.add(ref[:2])
            check(len(images) <= ATTACHMENT_REFERENCE_LIMIT, "Inline image reference budget exceeded", "thread_history_limit")
            for item in value.values(): collect(item, depth + 1)
        elif isinstance(value, list):
            for item in value: collect(item, depth + 1)
        elif isinstance(value, str):
            candidates = [value]
            reference = value.removesuffix('\nDecide whether an available and authorized vision tool can read this file. If the image was not read successfully, say so. Answer any independent text request normally.')
            match = re.fullmatch(r'Attached file "(?:[^"\\]|\\.)*" is available at ("(?:[^"\\]|\\.)*")\.', reference)
            if match: candidates.append(json.loads(match[1]))
            for candidate in candidates:
                if len(candidate) > 8192 or not candidate or "\x00" in candidate: continue
                name = _local_path(candidate)
                if name.parent == attachment_root and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\.(wav|mp3|m4a|webm|ogg|jpg|png|gif|webp|mp4|mov))?", name.name):
                    found.add(str(name)); check(len(found) <= 128, "Attachment reference budget exceeded", "thread_history_limit")
    return collect, found, images


@contextlib.contextmanager
def _scan_checkpoints(home: Path, uid: int):
    """Resume large immutable rollout prefixes. Each checkpoint is tied to
    path, owner, file identity, size, ctime, mtime and the requested cutoff."""
    filename = home / "harness-attachment-checkpoints.sqlite"
    fd = os.open(filename, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try: _safe(os.fstat(fd), uid)
    finally: os.close(fd)
    for suffix in ("", "-journal", "-wal", "-shm"):
        sidecar = Path(str(filename) + suffix)
        if sidecar.exists() or sidecar.is_symlink(): _safe(sidecar.lstat(), uid)
    db = sqlite3.connect(filename)
    try:
        db.execute("PRAGMA trusted_schema=OFF")
        db.execute("PRAGMA synchronous=FULL")
        db.execute("CREATE TABLE IF NOT EXISTS checkpoints(key TEXT PRIMARY KEY, offset INTEGER NOT NULL, lines INTEGER NOT NULL, paths TEXT NOT NULL, stamp INTEGER NOT NULL)")
        db.execute("DELETE FROM checkpoints WHERE key IN (SELECT key FROM checkpoints ORDER BY stamp DESC LIMIT -1 OFFSET 1024)")
        db.commit()
        yield db
    finally: db.close()


def _attachment_paths(home: Path, uid: int, path: Path, thread_id: str, root: str, index: dict, budget: list[int], checkpoints=None, active=None):
    """Collect exact managed paths in persisted records, including frozen fork prefixes.

    This does not open attachment paths or grant arbitrary filesystem access.
    The supervisor subsequently matches them against its private immutable index.
    """
    all_paths = set(); all_images = set(); all_unmatched = set()
    seen = set()
    def scan(filename, identity, cutoff=None):
        check(identity not in seen and len(seen) < ANCESTOR_LIMIT, "Attachment ancestor lineage exceeds budget", "thread_history_limit")
        seen.add(identity); filename = _path(home, str(filename), uid)
        missing = set()
        collect, found, images = _managed_references(root, active, missing if active else None)
        with os.fdopen(_open(filename, os.O_RDONLY, uid), "rb") as stream:
            before = os.fstat(stream.fileno()); maximum = before.st_size if cutoff is None else cutoff
            check(type(maximum) is int and 0 < maximum <= before.st_size and
                  (checkpoints is not None or budget[0] + maximum <= ROLLOUT_LIMIT), "Attachment history inspection exceeds budget", "thread_history_limit")
            header = stream.readline(min(LINE_LIMIT + 1, maximum))
            value = _decode(header)
            check(header.endswith(b"\n") and len(header) <= LINE_LIMIT and value.get("type") == "session_meta" and value["payload"].get("id") == identity, "Attachment history identity mismatch")
            base = value["payload"].get("history_base"); size = len(header); count = 1
            key = None
            if checkpoints is not None and maximum >= ATTACHMENT_CHECKPOINT_BYTES:
                witness = ["inline-refs-v4", _digest_filter_stamp(active), str(filename), identity, root, *_identity(before), before.st_ctime_ns, maximum]
                key = hashlib.sha256(json.dumps(witness).encode()).hexdigest()
                saved = checkpoints.execute("SELECT offset,lines,paths FROM checkpoints WHERE key=?", (key,)).fetchone()
                if saved:
                    size, count, paths = saved
                    check(len(header) <= size <= maximum and count >= 1 and len(paths) <= 1024 * 1024, "Invalid history checkpoint")
                    recorded = _decode(paths)
                    check(isinstance(recorded, dict) and isinstance(recorded.get("paths"), list), "Invalid attachment checkpoint")
                    for item in recorded["paths"]: collect(item)
                    for field, destination in (("images", images), ("unmatched", missing)):
                        for image in recorded.get(field, []):
                            check(isinstance(image, dict) and image.get("mimeType") in INLINE_IMAGE_MIMES and
                                  isinstance(image.get("sha256"), str) and re.fullmatch("[0-9a-f]{64}", image["sha256"]), "Invalid image checkpoint")
                            destination.add((image["mimeType"], image["sha256"]))
                    stream.seek(size)
            checkpoint = size
            while size < maximum:
                raw = stream.readline(min(LINE_LIMIT + 1, maximum - size)); size += len(raw); count += 1
                check(raw.endswith(b"\n") and len(raw) <= LINE_LIMIT, "Incomplete attachment history", "thread_history_changed")
                value = _decode(raw); check(isinstance(value, dict) and isinstance(value.get("payload"), dict), "Invalid attachment record")
                collect(value["payload"])
                if key and (size - checkpoint >= ATTACHMENT_CHECKPOINT_BYTES or size == maximum):
                    check(_identity(before) == _identity(os.fstat(stream.fileno())) and before.st_ctime_ns == os.fstat(stream.fileno()).st_ctime_ns,
                          "Attachment history changed", "thread_history_changed")
                    record = _reference_record(found, images)
                    if missing: record["unmatched"] = _reference_record([], missing)["images"]
                    checkpoints.execute("INSERT OR REPLACE INTO checkpoints VALUES(?,?,?,?,?)", (key, size, count, json.dumps(record), time.time_ns()))
                    checkpoints.commit(); checkpoint = size
            check(_identity(before) == _identity(os.fstat(stream.fileno())) and os.path.samestat(before, filename.lstat()), "Attachment history changed", "thread_history_changed")
            budget[0] += size; all_paths.update(found); all_images.update(images); all_unmatched.update(missing)
            check(len(all_unmatched) <= 128, "Unmatched history images exceed per-thread budget", "thread_history_limit")
        if base is not None:
            check(isinstance(base, dict) and isinstance(base.get("thread_id"), str) and type(base.get("end_byte_offset")) is int, "Unsupported attachment ancestor")
            matches = index.get(base["thread_id"], [])
            check(len(matches) == 1 and matches[0].suffix == ".jsonl", "Attachment ancestor unavailable or compressed", "thread_history_inherited")
            scan(matches[0], base["thread_id"], base["end_byte_offset"])
    scan(path, thread_id)
    return all_paths, all_images, all_unmatched


@contextlib.contextmanager
def _queue_store(home: Path, uid: int):
    """Hold a native queue read transaction and verify its identity through the complete read."""
    configured = os.environ.get("CODEX_SQLITE_HOME")
    native_config = home / "config.toml"
    if not configured and native_config.exists():
        # Native configuration may redirect the durable stores. Parse only when
        # the setting is present, so older Python installations remain usable.
        with native_config.open("rb") as stream:
            raw_config = stream.read(2 * 1024 * 1024 + 1)
        check(len(raw_config) <= 2 * 1024 * 1024, "Native configuration exceeds the queue lookup budget")
        if b"sqlite_home" in raw_config:
            from tomllib import loads
            configured = loads(raw_config.decode("utf-8")).get("sqlite_home")
    dbroot = _local_path(configured) if configured else home
    check(dbroot.is_absolute() and ".." not in dbroot.parts, "Cannot establish the native queue location")
    _safe(dbroot.lstat(), uid, directory=True)
    dbpath = dbroot / "queue_1.sqlite"
    if not dbpath.exists() and not dbpath.is_symlink():
        check(not any(dbroot.glob("queue_*.sqlite")), "Unknown native queue version")
        yield None
        check(not dbpath.exists(), "Native queue appeared during inspection", "thread_history_changed")
        return
    _safe(dbpath.lstat(), uid)
    initial = dbpath.lstat()
    with contextlib.closing(sqlite3.connect(dbpath.as_uri() + "?mode=ro", uri=True, timeout=1)) as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("PRAGMA trusted_schema=OFF")
        check(db.execute("SELECT type FROM sqlite_schema WHERE name='queued_items'").fetchone() == ("table",),
              "Unrecognized native queue schema")
        version = db.execute("PRAGMA data_version").fetchone()
        db.execute("BEGIN")
        yield db
        db.rollback()
        check(db.execute("PRAGMA data_version").fetchone() == version and os.path.samestat(initial, dbpath.lstat()),
              "Native queue changed during reconciliation", "thread_history_changed")



@contextlib.contextmanager
def _queue_snapshot(home: Path, uid: int, root: str, active=None):
    with _queue_store(home, uid) as db:
        if db is None:
            yield {}, set()
            return
        found = {}; unresolved = set(); total = 0
        for number, (identity, payload) in enumerate(db.execute(
                "SELECT thread_id, CASE WHEN length(CAST(payload_json AS BLOB)) <= ? THEN payload_json END FROM queued_items", (LINE_LIMIT,))):
            check(number < ATTACHMENT_REFERENCE_LIMIT and isinstance(identity, str) and 0 < len(identity) <= 256,
                  "Queue inventory exceeds limits", "thread_history_limit")
            if not isinstance(payload, str):
                unresolved.add(identity); continue
            total += len(payload.encode("utf-8"))
            check(total <= ROLLOUT_LIMIT, "Queue inventory exceeds its read budget", "thread_history_limit")
            unmatched = set()
            collect, paths, images = _managed_references(root, active, unmatched)
            try:
                item = _decode(payload)
                check(isinstance(item, (dict, list)), "Unsupported queue payload")
                collect(item)
                existing_paths, existing_images, missing = found.setdefault(identity, (set(), set(), set()))
                existing_paths.update(paths); existing_images.update(images); missing.update(unmatched)
            except (ValueError, TypeError, HistoryError, RecursionError):
                unresolved.add(identity)
        yield found, unresolved


QUEUE_DETAIL_LIMIT = 6 * 1024 * 1024


def _queue_inputs(payload):
    item = _decode(payload)
    body = item.get("UserInput") if isinstance(item, dict) else None
    check(isinstance(body, dict) and isinstance(body.get("content"), list) and len(body["content"]) <= 8192 and
          isinstance(body.get("client_id"), str) and 0 < len(body["client_id"]) <= 256, "无法识别原生待办输入。")
    result = []
    for atom in body["content"]:
        check(isinstance(atom, dict) and isinstance(atom.get("type"), str), "无法识别原生待办内容。")
        kind = atom["type"]
        if kind == "text":
            elements = atom.get("text_elements", [])
            check(isinstance(atom.get("text"), str) and isinstance(elements, list) and len(elements) <= 8192,
                  "无法核对原生待办的文字标记。")
            public = []
            for element in elements:
                check(isinstance(element, dict), "无法核对原生待办的文字标记。")
                span = element.get("byte_range", element.get("byteRange")); placeholder = element.get("placeholder")
                check(isinstance(span, dict) and type(span.get("start")) is int and type(span.get("end")) is int and
                      0 <= span["start"] <= span["end"] and (placeholder is None or isinstance(placeholder, str)),
                      "无法核对原生待办的文字位置。")
                public.append({"byteRange": {"start": span["start"], "end": span["end"]}, "placeholder": placeholder})
            part = {"type": "text", "text": atom["text"], "text_elements": public}
        elif kind in ("skill", "mention"): part = atom.copy()
        elif kind in ("image", "audio"):
            part = {"type": kind}
            url = atom.get(kind + "_url", atom.get("url"))
            file_id = atom.get("file_id", atom.get("fileId"))
            check(isinstance(url, str) != isinstance(file_id, str), "无法识别原生待办媒体位置。")
            if isinstance(url, str): part["url"] = url
            else: part["fileId"] = file_id
            if atom.get("detail") is not None: part["detail"] = atom["detail"]
        elif kind in ("local_image", "localImage", "local_audio", "localAudio"):
            check(isinstance(atom.get("path"), str), "无法识别原生待办文件。")
            part = {"type": "localImage" if kind in ("local_image", "localImage") else "localAudio", "path": atom["path"]}
            if atom.get("detail") is not None: part["detail"] = atom["detail"]
        else: raise HistoryError("thread_history_unsupported", "该待办包含尚未识别的输入类型。")
        result.append(part)
    return result, body["client_id"], body.get("responsesapi_client_metadata")


def _queue_summary(row_id, size, payload, attachment_root):
    row = {"id": row_id, "bytes": size, "oversized": size > QUEUE_DETAIL_LIMIT,
           "clientUserMessageId": None, "preview": "", "media": []}
    if payload is None:
        row["metadataIncomplete"] = True
        return row
    try:
        parts, client_id, _ = _queue_inputs(payload)
        media = []; seen = set(); preview = ""
        for part in parts:
            kind = part["type"]
            if kind == "text":
                value = part.get("text")
                check(isinstance(value, str), "无法识别原生待办文字。")
                if len(value) <= 8192 and value.startswith("Attached file "):
                    collect, paths, _ = _managed_references(attachment_root)
                    collect(value)
                    if paths:
                        check(len(value.encode("utf-8")) <= 2048, "受管待办引用过长。")
                        if value not in seen: media.append({"type": "text", "text": value}); seen.add(value)
                        continue
                if not preview: preview = value[:160]
            elif kind in ("image", "audio", "localImage", "localAudio") and kind not in seen:
                media.append({"type": kind}); seen.add(kind)
            check(len(media) <= 128, "待办媒体总数超出核对范围。")
        row.update(clientUserMessageId=client_id, preview=preview, media=media)
    except (HistoryError, ValueError, TypeError, KeyError, RecursionError):
        row["metadataIncomplete"] = True
    return row


def _queue_inspect(home, uid, request):
    image = request["action"] == "queue-image"
    single = request["action"] in ("queue-item", "queue-image")
    check(set(request) <= ({"action", "threadId", "attachmentRoot", "queuedSubmissionId"} | ({"ordinal", "expectedSha256", "expectedBytes"} if image else set())) and
          isinstance(request.get("threadId"), str) and re.fullmatch("[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", request["threadId"]),
          "待办会话编号无效。")
    root = request.get("attachmentRoot")
    check(isinstance(root, str) and _local_path(root).is_absolute() and ".." not in _local_path(root).parts,
          "待办附件目录无效。")
    row_id = request.get("queuedSubmissionId")
    check(row_id is None and not single or isinstance(row_id, str) and 0 < len(row_id) <= 256, "待办编号无效。")
    if image:
        check(type(request.get("ordinal")) is int and 0 <= request["ordinal"] < 8192 and
              isinstance(request.get("expectedSha256"), str) and re.fullmatch("[0-9a-f]{64}", request["expectedSha256"]) and
              type(request.get("expectedBytes")) is int and 0 < request["expectedBytes"] <= INLINE_IMAGE_BYTES, "待办图片核对凭据无效。")
    empty = {"queuedSubmission": None} if single else {"large": False, "data": [], "complete": True}
    with _queue_store(home, uid) as db:
        if db is None:
            check(not image, "待办图片已经变化。", "thread_history_changed")
            return empty
        identity = request["threadId"]
        if image:
            field = f'$.UserInput.content[{request["ordinal"]}]'
            stored = db.execute("SELECT CASE WHEN length(CAST(payload_json AS BLOB))<=? THEN json_extract(payload_json,?) END "
                                "FROM queued_items WHERE thread_id=? AND id=?", (LINE_LIMIT, field, identity, row_id)).fetchone()
            check(stored and isinstance(stored[0], str) and len(stored[0]) <= 6 * 1024 * 1024, "待办图片已经变化。", "thread_history_changed")
            part = _decode(stored[0]); url = part.get("image_url", part.get("url")) if isinstance(part, dict) and part.get("type") == "image" else None
            ref = _image_reference(url)
            check(ref and ref[1] == request["expectedSha256"] and ref[2] == request["expectedBytes"],
                  "待办图片已经变化，请重新读取。", "thread_history_changed")
            return {"mimeType": ref[0], "sha256": ref[1], "bytes": ref[2], "base64": url[url.index(",") + 1:]}
        if single:
            row = db.execute("SELECT length(CAST(payload_json AS BLOB)),"
                             "CASE WHEN length(CAST(payload_json AS BLOB))<=? THEN payload_json END "
                             "FROM queued_items WHERE thread_id=? AND id=?", (LINE_LIMIT, identity, row_id)).fetchone()
            if row is None: return empty
            check(row[0] <= LINE_LIMIT and isinstance(row[1], str), "该待办超过可核对的容量，可在列表按编号核对或删除。", "thread_history_limit")
            parts, client_id, metadata = _queue_inputs(row[1])
            if row[0] > QUEUE_DETAIL_LIMIT:
                for i, part in enumerate(parts):
                    if part["type"] != "image": continue
                    ref = _image_reference(part.get("url"))
                    if ref:
                        mime, digest, size = ref
                        parts[i] = {"type": "harnessInlineImageDigest", "mimeType": mime, "sha256": digest, "bytes": size,
                                    "urlSha256": hashlib.sha256(part["url"].encode("utf-8")).hexdigest(),
                                    **({"detail": part["detail"]} if "detail" in part else {})}
            result = {"queuedSubmission": {"id": row_id, "clientUserMessageId": client_id, "input": parts, "responsesapiClientMetadata": metadata}}
            check(len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) <= QUEUE_DETAIL_LIMIT,
                  "该待办剩余输入超过容量，可在列表按编号核对或删除。", "thread_history_limit")
            return result
        count, total = db.execute("SELECT count(*),sum(length(CAST(payload_json AS BLOB))) FROM queued_items WHERE thread_id=?", (identity,)).fetchone()
        if not count or total <= QUEUE_DETAIL_LIMIT: return empty
        check(row_id is not None or count <= 4096, "待办数量超出单次核对范围。", "thread_history_limit")
        query = "SELECT id,length(CAST(payload_json AS BLOB)) FROM queued_items WHERE thread_id=?"
        args = [identity]
        if row_id is not None: query += " AND id=?"; args.append(row_id)
        rows = []; inspected = 0; response_bytes = 0
        for key, size in db.execute(query + " ORDER BY queue_order,id", args):
            check(isinstance(key, str) and 0 < len(key) <= 256 and type(size) is int, "待办元数据无效。")
            payload = None
            if size <= LINE_LIMIT and inspected + size <= 128 * 1024 * 1024:
                payload = db.execute("SELECT payload_json FROM queued_items WHERE thread_id=? AND id=?", (identity, key)).fetchone()[0]
                inspected += size
            summary = _queue_summary(key, size, payload, root)
            response_bytes += len(json.dumps(summary, ensure_ascii=False).encode("utf-8"))
            if response_bytes >= COPY_METADATA_LIMIT:
                summary = _queue_summary(key, size, None, root)
            rows.append(summary)
        return {"large": True, "data": rows, "complete": True}


def _attachment_index(home: Path, uid: int, root: str, active=None) -> dict:
    index = _rollout_index(home, uid); references = []; count = 0
    with _queue_snapshot(home, uid, root, active) as (queued, unresolved), _scan_checkpoints(home, uid) as checkpoints:
        identities = set(index) | set(queued) | unresolved
        for identity in sorted(identities):
            if identity in unresolved: continue
            matches, images, missing = queued.get(identity, (set(), set(), set()))
            queue_images = sorted(images); history_missing = set()
            paths = index.get(identity, [])
            if paths:
                if len(paths) != 1 or paths[0].suffix != ".jsonl":
                    unresolved.add(identity); continue
                try:
                    history_paths, history_images, history_missing = _attachment_paths(home, uid, paths[0], identity, root, index, [0], checkpoints, active)
                    matches.update(history_paths); images.update(history_images)
                except (HistoryError, OSError, ValueError, TypeError, KeyError):
                    unresolved.add(identity); continue
            if len(missing) > 128 or len(history_missing | missing) > 128:
                unresolved.add(identity); continue
            if matches or images or missing or history_missing:
                count += len(matches) + len(images) + len(history_missing | missing); check(count <= ATTACHMENT_REFERENCE_LIMIT, "Attachment index exceeds reference budget", "thread_history_limit")
                entry = {"threadId": identity, **_reference_record(matches, images)}
                if active is not None and queue_images:
                    entry["queuedImages"] = _reference_record([], queue_images)["images"]
                if missing:
                    entry["unmatchedQueuedImage"] = True
                    entry["unmatchedQueuedImages"] = _reference_record([], missing)["images"]
                if history_missing: entry["unmatchedHistoryImages"] = _reference_record([], history_missing)["images"]
                references.append(entry)
        # Only owners with references or unresolved evidence are material to GC.
        reported = identities if len(identities) <= 10000 else unresolved | {row["threadId"] for row in references}
        return {"threadIds": sorted(reported), "references": references, "unresolvedThreadIds": sorted(unresolved)}


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
            matches = _rollout_index(home, uid, identity).get(identity, [])
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
    except (OSError, ValueError, TypeError, KeyError, HistoryError) as error:
        result["inspectionUnsupported"] = True
        if isinstance(error, HistoryError): result["inspectionIssue"] = {"code": error.code, "message": str(error)}
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
    provider = request.get("sourceProvider"); target_provider = request.get("targetProvider", provider); cwd = request.get("cwd")
    check(isinstance(provider, str) and 0 < len(provider) <= 128 and "\x00" not in provider and
          isinstance(target_provider, str) and 0 < len(target_provider) <= 128 and "\x00" not in target_provider and
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
            check(target_header.get("model_provider") == target_provider and target_header.get("cwd") == cwd and
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
        if request.get("action") in ("queue-item", "queue-capacity", "queue-image"):
            return _queue_inspect(_local_path(str(home)), uid, request)
        if request == {"action": "mcp-enabled-read"}:
            from .mcp_enabled_override import read
            return read(home)
        if request == {"action": "mcp-enabled-launch"}:
            from .mcp_enabled_override import launch_arguments
            return {"args": launch_arguments(home)}
        if request.get("action") == "mcp-enabled-override":
            from .mcp_enabled_override import apply
            try: return apply(home, {key: value for key, value in request.items() if key != "action"})
            except DeployError as error: raise HistoryError("thread_history_config_conflict", str(error)) from None
        if request.get("action") == "attachment-index":
            check(set(request) <= {"action", "attachmentRoot", "activeImageDigests"} and isinstance(request.get("attachmentRoot"), str), "Invalid attachment reconciliation request")
            return _attachment_index(_local_path(str(home)), uid, request["attachmentRoot"], _active_image_digests(request))
        allowed = {"action", "threadId", "path", "mode", "expected"}
        if request.get("action") == "recovery-copy": allowed |= {"target", "sourceProvider", "targetProvider", "cwd"}
        if request.get("action") == "attachment-inspect": allowed |= {"attachmentRoot", "activeImageDigests"}
        check(set(request) <= allowed, "Invalid history request")
        check(request.get("action") in ("inspect", "repair", "copy-inspect", "recovery-copy", "attachment-inspect") and request.get("mode") in ("foreign", "plaintext"), "Unsupported history operation")
        thread_id = request.get("threadId")
        check(isinstance(thread_id, str) and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", thread_id) is not None, "Invalid history thread identity")
        home = _local_path(str(home))
        path = _path(home, request.get("path"), uid, inspect_compressed=request["action"] == "inspect")
        if request["action"] == "attachment-inspect":
            check(isinstance(request.get("attachmentRoot"), str), "Invalid attachment root")
            found, images, _ = _attachment_paths(home, uid, path, thread_id, request["attachmentRoot"], _rollout_index(home, uid), [0], active=_active_image_digests(request))
            return _reference_record(found, images)
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
        request = _decode(raw)
        if not isinstance(request, dict) or request.get("action") not in ("attachment-index", "attachment-inspect"):
            check(len(raw) <= 8192, "History request exceeds budget")
        result = operate(home, uid, request)
        # Metadata can contain Unicode base instructions. Bind the budget to
        # actual UTF-8 stdout bytes instead of ASCII escapes or console locale.
        encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        output_limit = QUEUE_DETAIL_LIMIT if request.get("action") in ("queue-item", "queue-capacity", "queue-image") else COPY_METADATA_LIMIT
        check(len(encoded) <= output_limit + 16384, "History response exceeds budget", "thread_history_limit")
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
