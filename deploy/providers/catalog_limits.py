"""Bound model catalogs before they enter shell variables or managed state."""
import json
import os
import stat
import sys


MAX_CATALOG_BYTES = 1024 * 1024
MAX_CATALOG_ENTRIES = 256
MAX_MODEL_ID_CHARS = 256
MAX_MODEL_IDS_BYTES = 64 * 1024


def _model_id(value):
    if (not isinstance(value, str) or not 0 < len(value) <= MAX_MODEL_ID_CHARS
            or any(ord(character) < 32 or ord(character) == 127 for character in value)):
        raise ValueError("invalid model identifier")
    return value


def validate_model_ids(values, *, require_nonempty=True):
    if not isinstance(values, list) or len(values) > MAX_CATALOG_ENTRIES:
        raise ValueError("invalid model catalog entry count")
    if require_nonempty and not values:
        raise ValueError("empty model catalog")
    normalized = []
    seen = set()
    total = 0
    for value in values:
        value = _model_id(value)
        if value in seen:
            raise ValueError("duplicate model identifier")
        seen.add(value)
        total += len(value.encode("utf-8")) + 1
        if total > MAX_MODEL_IDS_BYTES:
            raise ValueError("model identifiers exceed the aggregate byte limit")
        normalized.append(value)
    return normalized


def load_json_stream(stream):
    raw = stream.read(MAX_CATALOG_BYTES + 1)
    if len(raw) > MAX_CATALOG_BYTES:
        raise ValueError("model catalog exceeds the byte limit")
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, UnicodeError, RecursionError):
        raise ValueError("invalid model catalog JSON") from None
    if not isinstance(value, dict):
        raise ValueError("model catalog must be an object")
    return value


def _stable_metadata(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def load_json_path(path):
    before = os.lstat(path)
    if (not stat.S_ISREG(before.st_mode) or before.st_size > MAX_CATALOG_BYTES):
        raise ValueError("model catalog must be a bounded regular file")
    flags = (os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
             | getattr(os, "O_BINARY", 0))
    fd = os.open(path, flags)
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if (not stat.S_ISREG(opened.st_mode) or opened.st_size > MAX_CATALOG_BYTES
                or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)):
            raise ValueError("model catalog must be a bounded regular file")
        raw = stream.read(MAX_CATALOG_BYTES + 1)
        after = os.fstat(stream.fileno())
    current = os.lstat(path)
    # Windows Python versions can report creation time for path stat and change
    # time for fd stat. Compare ctime within each API, not between the two; all
    # identity, type, link, size and mtime checks still apply across both APIs.
    path_metadata, fd_metadata = _stable_metadata(before), _stable_metadata(opened)
    cross_metadata_matches = (path_metadata[:-1] == fd_metadata[:-1]
                              if os.name == "nt" else path_metadata == fd_metadata)
    if (len(raw) != before.st_size or not cross_metadata_matches
            or fd_metadata != _stable_metadata(after)
            or path_metadata != _stable_metadata(current)):
        raise ValueError("model catalog changed while it was being read")
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, UnicodeError, RecursionError):
        raise ValueError("invalid model catalog JSON") from None
    if not isinstance(value, dict):
        raise ValueError("model catalog must be an object")
    return value


def custom_response_ids(catalog):
    entries = catalog.get("data")
    if not isinstance(entries, list) or len(entries) > MAX_CATALOG_ENTRIES:
        raise ValueError("invalid model catalog entry count")
    ids = []
    for entry in entries:
        if not isinstance(entry, dict) or "id" not in entry:
            raise ValueError("invalid model catalog entry")
        ids.append(entry["id"])
    return validate_model_ids(ids)


def validate_models_catalog(catalog, *, allow_empty=False, include_unconfigured=False):
    entries = catalog.get("models")
    if not isinstance(entries, list):
        raise ValueError("invalid models catalog")
    ids = []
    for entry in entries:
        if not isinstance(entry, dict) or "slug" not in entry:
            raise ValueError("invalid model catalog entry")
        ids.append(entry["slug"])
    if include_unconfigured:
        discoveries = catalog.get("unconfigured_models", [])
        if not isinstance(discoveries, list):
            raise ValueError("invalid unconfigured model catalog")
        for entry in discoveries:
            if not isinstance(entry, dict) or "id" not in entry:
                raise ValueError("invalid unconfigured model entry")
            ids.append(entry["id"])
    if len(ids) > MAX_CATALOG_ENTRIES:
        raise ValueError("invalid model catalog entry count")
    validate_model_ids(ids, require_nonempty=not allow_empty)
    return catalog


def dump_json_limited(value, *, indent=None):
    try:
        text = json.dumps(value, ensure_ascii=False, indent=indent,
                          separators=None if indent is not None else (",", ":")) + "\n"
        encoded = text.encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise ValueError("model catalog cannot be serialized") from None
    if len(encoded) > MAX_CATALOG_BYTES:
        raise ValueError("serialized model catalog exceeds the byte limit")
    return text


def normalize_zhipu(source, destination):
    catalog = validate_models_catalog(load_json_path(source))
    encoded = dump_json_limited(catalog).encode("utf-8")
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow, 0o600)
    except FileExistsError:
        fd = os.open(destination, os.O_WRONLY | nofollow)
    with os.fdopen(fd, "wb") as stream:
        info = os.fstat(stream.fileno())
        effective_uid = os.geteuid() if hasattr(os, "geteuid") else info.st_uid
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != effective_uid):
            raise ValueError("catalog destination has an unsafe identity")
        os.ftruncate(stream.fileno(), 0)
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())


def main(argv):
    try:
        if argv == ["custom-ids"]:
            ids = custom_response_ids(load_json_stream(sys.stdin.buffer))
            sys.stdout.write("\n".join(ids) + "\n")
            return 0
        if len(argv) == 3 and argv[0] == "normalize-zhipu":
            normalize_zhipu(argv[1], argv[2])
            return 0
        raise ValueError("invalid catalog-limits invocation")
    except (OSError, ValueError):
        print("[catalog-limits] invalid or oversized model catalog", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
