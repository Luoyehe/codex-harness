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
import tomllib

from atomic_write import atomic_write


def load_config(path):
    try:
        with open(path, "rb") as stream:
            return tomllib.load(stream)
    except FileNotFoundError:
        return {}


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
