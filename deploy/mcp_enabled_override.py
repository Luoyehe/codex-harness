"""Edit only the enabled flag of a separately inherited native MCP server."""
from __future__ import annotations

import contextlib
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile

from .common import DeployError, fsync_directory, require


def version(value: dict) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=lambda item: item.isoformat())
    return "sha256:" + hashlib.sha256(canonical.encode()).hexdigest()


def edited(text: str, name: str, enabled: bool | None, initial: dict) -> str:
    import tomllib
    wanted = copy.deepcopy(initial)
    servers = wanted.setdefault("mcp_servers", {})
    require(isinstance(servers, dict), "Invalid native MCP configuration", "config_conflict")
    old = servers.get(name)
    require(old is None or isinstance(old, dict) and set(old) <= {"enabled"}, "Only an inherited server may be overridden", "config_conflict")
    if enabled is None: servers.pop(name, None)
    else: servers[name] = {"enabled": enabled}
    if initial == wanted or enabled is None and old is None: return text
    key = re.escape(name); quoted = json.dumps(name, ensure_ascii=False)
    def field(key): return rf'(?:{key}|"{key}"|\'{key}\')'
    entry = field(key); registry = field("mcp_servers"); flag = field("enabled")
    nl = "\r\n" if "\r\n" in text else "\n"
    value = "true" if enabled else "false"
    def candidates():
        if enabled is not None and old is None:
            yield text + (nl if text and not text.endswith("\n") else "") + f"[mcp_servers.{quoted}]{nl}enabled = {value}{nl}"
            # Inline tables cannot be extended by reopening a TOML section.
            for match in re.finditer(rf'(?m)^\s*{registry}\s*=\s*\{{', text):
                at = match.end(); comma = "" if text[at:].lstrip().startswith("}") else ", "
                yield text[:at] + f"{quoted} = {{enabled = {value}}}" + comma + text[at:]
            return
        if enabled is not None:
            for match in re.finditer(rf'{flag}\s*=\s*(true|false)', text):
                yield text[:match.start(1)] + value + text[match.end(1):]
            return
        # Recognize both Codex-emitted sections and equivalent inline/dotted
        # forms. Parse the entire candidate before publishing it: strings and
        # similarly named servers cannot be mistaken for the intended field.
        for line in re.finditer(rf'(?m)^[ \t]*\[[ \t]*{registry}\s*\.\s*{entry}\s*\][^\n]*(?:\n|$)', text):
            pos = line.end()
            for setting in re.finditer(rf'(?m)^[ \t]*{flag}\s*=\s*(true|false)[^\n]*(?:\n|$)', text[pos:]):
                begin, end = pos + setting.start(), pos + setting.end()
                yield text[:line.start()] + text[pos:begin] + text[end:]
        for expr in (rf'{entry}\s*=\s*\{{\s*{flag}\s*=\s*(?:true|false)\s*\}}',
                     rf'{registry}\s*\.\s*{entry}\s*\.\s*{flag}\s*=\s*(?:true|false)',
                     rf'{entry}\s*\.\s*{flag}\s*=\s*(?:true|false)'):
            for match in re.finditer(expr, text):
                a, b = match.span()
                yield text[:a] + text[b:]
                comma = re.match(r'\s*,\s*', text[b:])
                if comma: yield text[:a] + text[b + comma.end():]
                comma = re.search(r',\s*$', text[:a])
                if comma: yield text[:comma.start()] + text[b:]
    for candidate in candidates():
        try: actual = tomllib.loads(candidate)
        except tomllib.TOMLDecodeError: continue
        if actual == wanted or (not servers and "mcp_servers" not in actual and {**actual, "mcp_servers": {}} == wanted): return candidate
    raise DeployError("config_conflict", "The native MCP flag could not be updated without changing unrelated settings")


SYSTEM = (Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "OpenAI" / "Codex" / "config.toml"
          if os.name == "nt" else Path("/etc/codex/config.toml"))
STORE = "harness-mcp-enabled.json"


def _name(value):
    return isinstance(value, str) and 0 < len(value.encode()) <= 128 and all(ord(c) >= 32 and ord(c) != 127 for c in value)


def _safe(info, directory=False):
    require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
            and (os.name != "posix" or info.st_uid == os.geteuid() and not info.st_mode & 0o022),
            "Unsafe native configuration entry", "config_conflict")


def _read(path, *, limit, private=True):
    flags = getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try: fd = os.open(path, os.O_RDONLY | flags)
    except FileNotFoundError: return b"", None
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(fd)
        if private: _safe(info)
        else: require(stat.S_ISREG(info.st_mode), "Expected an ordinary system configuration file", "config_conflict")
        data = handle.read(limit + 1)
        require(len(data) <= limit, "Native configuration exceeds the size limit", "capacity")
        return data, (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _replace(path, data, before, limit):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".mcp-enabled-")
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data); out.flush(); os.fsync(out.fileno())
        require(_read(path, limit=limit) == before, "Configuration changed while saving", "config_conflict")
        os.replace(tmp, path); fsync_directory(path.parent)
    finally:
        with contextlib.suppress(FileNotFoundError): os.unlink(tmp)


def _flags(home):
    before = _read(home / STORE, limit=65536)
    flags = json.loads(before[0]) if before[1] is not None else {}
    require(isinstance(flags, dict) and len(flags) <= 128 and all(isinstance(k, str) and len(k.encode()) <= 192 and all(ord(c) >= 32 and ord(c) != 127 for c in k) and type(v) is bool for k, v in flags.items()),
            "Invalid stored MCP switches", "config_conflict")
    return flags, before


def _save(home, flags, before):
    _replace(home / STORE, (json.dumps(flags, sort_keys=True, ensure_ascii=False) + "\n").encode(), before, 65536)


def _binding(name, entry):
    # The first enabled Coding Plan may acquire the unsuffixed display name
    # after a provider is disabled. Use the immutable connection id already
    # present in the trusted launcher args/credential variable. Never retain
    # any actual command, endpoint or credential in the user switch store.
    name = name.replace("@", "@@")
    if isinstance(entry, dict):
        args = entry.get("args")
        if isinstance(args, list) and len(args) == 2 and args[0] == "zai-server" and isinstance(args[1], str) and re.fullmatch("default|[a-f0-9]{32}", args[1]):
            return name + "@provider:" + args[1]
        key = entry.get("bearer_token_env_var")
        if isinstance(key, str) and re.fullmatch("HARNESS_PROVIDER_KEY_(DEFAULT|[A-F0-9]{32})", key):
            return name + "@provider:" + key.removeprefix("HARNESS_PROVIDER_KEY_").lower()
    return name


def _state(home, flags, servers):
    bindings = {name: _binding(name, entry) for name, entry in servers.items()}
    visible = {name: flags[key] for name, key in bindings.items() if key in flags}
    return {"flags": visible, "version": version({"flags": flags, "bindings": bindings}), "filePath": str(home / STORE)}


def read(home, *, system=None):
    import tomllib
    _safe(home.lstat(), True)
    flags, _ = _flags(home)
    data, _ = _read(system or SYSTEM, limit=4 * 1024 * 1024, private=False)
    return _state(home, flags, tomllib.loads(data.decode()).get("mcp_servers", {}))


@contextlib.contextmanager
def _exclusive(home):
    from .thread_history import _lock
    _safe(home.lstat(), True)
    lock = os.open(home / ".harness-mcp-override.lock", os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0), 0o600)
    try:
        _safe(os.fstat(lock))
        with _lock(lock): yield
    finally: os.close(lock)


def _native_layers(home, system):
    import tomllib
    # Some deployments mount a root-owned base file read-only. Reading it
    # does not grant permission to replace it; migration checks ownership again.
    base = _read(home / "config.toml", limit=1024 * 1024, private=False)
    settings = tomllib.loads(base[0].decode())
    system_bytes, _ = _read(system, limit=4 * 1024 * 1024, private=False)
    servers = tomllib.loads(system_bytes.decode()).get("mcp_servers", {})
    return base, settings, servers


def apply(home: Path, params: dict, *, system=None) -> dict:
    name, enabled = params.get("name"), params.get("enabled")
    require(set(params) == {"name", "enabled", "expectedVersion", "expectedFlags"} and _name(name)
            and (enabled is None or type(enabled) is bool), "Invalid MCP enabled override", "invalid_params")
    with _exclusive(home):
        base, settings, system_servers = _native_layers(home, system or SYSTEM)
        flags, before = _flags(home)
        require(params["expectedFlags"] == _state(home, flags, system_servers)["version"] and
                (params["expectedVersion"] == version(settings) or base[1] is None and params["expectedVersion"] is None),
                "User configuration changed; reload before saving", "config_conflict")
        require(name in system_servers and name not in settings.get("mcp_servers", {}),
                "The inherited system server changed; reload before saving", "config_conflict")
        key = _binding(name, system_servers[name])
        if enabled is None: flags.pop(key, None)
        else: flags[key] = enabled
        require(len(flags) <= 128, "Too many MCP switches", "capacity")
        if flags != (json.loads(before[0]) if before[1] else {}): _save(home, flags, before)
        state = read(home, system=system)
        require(state == _state(home, flags, system_servers), "MCP switch readback changed", "config_conflict")
        return {**state, "written": True}


def launch_arguments(home: Path, *, system=None) -> list[str]:
    """The application's private user switch layer never enters Codex's writable base config."""
    system = system or SYSTEM
    # No switches and no system layer is the normal development/default setup.
    if not system.exists(): return []
    import tomllib
    with _exclusive(home):
        base, settings, servers = _native_layers(home, system)
        flags, before = _flags(home)
        entries = settings.get("mcp_servers", {})
        legacy = {key: row["enabled"] for key, row in entries.items() if key in servers and _name(key)
                  and isinstance(row, dict) and set(row) == {"enabled"} and type(row["enabled"]) is bool}
        if legacy:
            # Publish the switches before removing old enabled-only TOML. Either
            # halfway state represents the same intent and is safe to retry.
            new_flags = {**{_binding(k, servers[k]): v for k, v in legacy.items()}, **flags}
            require(len(new_flags) <= 128, "Too many MCP switches", "capacity")
            if new_flags != flags: _save(home, new_flags, before)
            text = base[0].decode()
            for key in legacy:
                text = edited(text, key, None, tomllib.loads(text))
            _replace(home / "config.toml", text.encode(), base, 1024 * 1024)
            flags, entries = new_flags, tomllib.loads(text).get("mcp_servers", {})
        active = {name: value for name, value in _state(home, flags, servers)["flags"].items() if name not in entries}
        if not active: return []
        # A single TOML inline table preserves literal server names containing dots.
        values = ", ".join(json.dumps(k, ensure_ascii=False) + " = {enabled = " + str(v).lower() + "}" for k, v in sorted(active.items()))
        return ["-c", "mcp_servers={" + values + "}"]
