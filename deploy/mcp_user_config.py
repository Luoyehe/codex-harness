"""Write one authenticated user's MCP server without exposing other configuration."""
from __future__ import annotations

import os
import re
import stat

from . import native_toml
from .common import DeployError, require
from .mcp_enabled_override import _exclusive, _file_version, _name, _read, _replace, _safe, _unconfirmed

LIMIT = 1024 * 1024
TEXT_FIELDS = {"command", "url", "bearer_token_env_var"}
MAP_FIELDS = {"env", "http_headers", "env_http_headers"}
REMOVE_ONLY = {"bearer_token", "env_vars", "cwd", "http_headers_helper", "auth", "oauth", "oauth_resource"}


def _check_reparse(path):
    if os.name == "nt":
        try:
            info = path.lstat()
        except FileNotFoundError:
            return
        require(not info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT, "Unsafe native configuration entry", "config_conflict")


def state(home):
    _check_reparse(home)
    _check_reparse(home / "config.toml")
    _safe(home.lstat(), True)
    before = _read(home / "config.toml", limit=LIMIT, private=False)
    return {"fileVersion": _file_version(before), "userConfigEdits": 1}


def validate(params):
    require(isinstance(params, dict) and set(params) == {"name", "expectedVersion", "changes"} and _name(params["name"])
            and params["name"] not in {"constructor", "prototype", "__proto__"}, "Invalid user MCP edit")
    version = params["expectedVersion"]
    require(version is None or isinstance(version, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", version),
            "Invalid user MCP file version")
    changes = params["changes"]
    if changes is None:
        return
    require(isinstance(changes, dict) and not changes.keys() - TEXT_FIELDS - MAP_FIELDS - REMOVE_ONLY - {"enabled", "args"},
            "Invalid user MCP fields")
    for key, value in changes.items():
        if value is None:
            continue
        if key in TEXT_FIELDS:
            valid = isinstance(value, str) and value and "\x00" not in value
        elif key in MAP_FIELDS:
            valid = isinstance(value, dict) and len(value) <= 64 and all(isinstance(k, str) and isinstance(v, str) for k, v in value.items())
        elif key == "args":
            valid = isinstance(value, list) and len(value) <= 256 and all(isinstance(v, str) and "\x00" not in v for v in value)
        else:
            valid = key == "enabled" and type(value) is bool
        require(valid, "Invalid user MCP field value")


def apply(home, params):
    from .mcp_user_toml import edit_server
    validate(params)
    path = home / "config.toml"
    _check_reparse(home)
    _check_reparse(home / ".harness-mcp-override.lock")
    published = False
    try:
        with _exclusive(home):
            _check_reparse(path)
            before = _read(path, limit=LIMIT)
            require(_file_version(before) == params["expectedVersion"], "User configuration changed; reload before saving", "config_conflict")
            try:
                text = edit_server(before[0].decode(), params["name"], params["changes"])
                if params["changes"] is not None:
                    row = native_toml.loads(text)["mcp_servers"][params["name"]]
                    stdio = isinstance(row.get("command"), str) and bool(row["command"])
                    http = isinstance(row.get("url"), str) and bool(row["url"])
                    require(stdio != http, "User MCP server requires one transport")
                data = text.encode()
            except (ValueError, RecursionError):
                raise DeployError("config_conflict", "The user MCP configuration could not be edited safely") from None
            require(len(data) <= LIMIT, "User configuration exceeds its size limit", "capacity")
            if data != before[0]:
                _replace(path, data, before, LIMIT)
                published = True
            after = _read(path, limit=LIMIT)
            require(after[0] == data, "User configuration changed during confirmation", "config_conflict")
            return {"fileVersion": _file_version(after)}
    except Exception as error:
        if published:
            raise _unconfirmed() from None
        if not hasattr(error, "delivery"):
            error.delivery = "not_sent"
        raise
