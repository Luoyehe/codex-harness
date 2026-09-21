"""Semantic TOML edits for provider-owned configuration snapshots.

tomllib validates all input before editing. Serialization preserves values,
including quoted/dotted keys, nested/array tables, dates and multiline text.
Formatting and comments are not retained; the transaction retains the previous
snapshot. Never try to repair invalid TOML by deleting suspicious-looking lines.
"""
import datetime
import json
import math
import os
import stat
import tomllib

from atomic_write import atomic_write


MAX_CONFIG_BYTES = 1024 * 1024


def load_config(path):
    try:
        flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0)
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        return {}
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_CONFIG_BYTES:
            raise ValueError("provider config must be a bounded singly linked regular file")
        raw = stream.read(MAX_CONFIG_BYTES + 1)
        after = os.fstat(stream.fileno())
    if len(raw) > MAX_CONFIG_BYTES or len(raw) != before.st_size:
        raise ValueError("provider config exceeds its byte limit or changed while reading")
    stable = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_uid,
                            value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    if stable(before) != stable(after):
        raise RuntimeError("provider config changed while reading")
    return tomllib.loads(raw.decode("utf-8"))


def _quote(value):
    # JSON and TOML share these escapes, except TOML also forbids a literal DEL.
    return json.dumps(value, ensure_ascii=False).replace("\x7f", "\\u007f")


def _value(value):
    if isinstance(value, str):
        return _quote(value)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return "nan"
        if math.isinf(value):
            return "-inf" if value < 0 else "inf"
        return repr(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, list):
        return "[" + ", ".join(_value(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{_quote(key)} = {_value(item)}" for key, item in value.items()) + " }"
    raise TypeError(f"unsupported TOML value type: {type(value).__name__}")


def dump_config(config):
    text = "".join(f"{_quote(key)} = {_value(value)}\n" for key, value in config.items())
    tomllib.loads(text)
    return text


def save_config(path, config):
    atomic_write(path, dump_config(config))


def table(config, name):
    value = config.setdefault(name, {})
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be a TOML table")
    return value


def remove_legacy_tokens(value):
    if isinstance(value, dict):
        value.pop("experimental_bearer_token", None)
        for child in value.values():
            remove_legacy_tokens(child)
    elif isinstance(value, list):
        for child in value:
            remove_legacy_tokens(child)


def archive_config(source, destination):
    config = load_config(source)
    remove_legacy_tokens(config)
    save_config(destination, config)


def rebase_catalog(config, old_directory, new_directory):
    declared = config.get("model_catalog_json")
    if isinstance(declared, str) and os.path.isabs(declared):
        if os.path.normcase(os.path.realpath(declared)) == os.path.normcase(os.path.realpath(os.path.join(old_directory, "models.json"))):
            config["model_catalog_json"] = os.path.join(new_directory, "models.json")
