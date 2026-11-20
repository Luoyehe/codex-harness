"""Publish a credential-free inventory for private, per-identity MCP switch stores."""
from __future__ import annotations

import os
import re
import time
import tomllib

from .common import read_json, require, write_json
from .provider_lifecycle import MAX_PROFILES, PROVIDER_JSON_LIMIT, Profiles
from .provider_registry import MAX_CONNECTIONS, entries

INVENTORY = "mcp-switch-owners.json"
ORIGINS = "mcp-switch-origins.json"
OWNER = r"(?:default|[0-9a-f]{32})"


def capture_origins(layout):
    """Freeze the pre-upgrade ownership evidence once, before names can move."""
    from .mcp_enabled_override import DISPLAY, _identity
    root = layout.config / "providers"
    if (root / ORIGINS).exists() or not (root / "current").is_symlink():
        return
    cutoff = time.time_ns()
    selected = os.readlink(root / "current")
    revisions = {selected}
    # A restored, removed or reassigned connection may precede the currently
    # selected view. A collected generation cannot establish an old binding.
    for path in (layout.state / "transactions").glob("*/state.json"):
        record = read_json(path)
        if record.get("kind") == "provider":
            revisions.update((record["old"], record["candidate"]))
        elif record.get("kind") == "config-layer":
            revisions.update((record["oldProvider"], record["candidateProvider"]))
    choices = {}
    earliest = {}
    for revision in sorted(revisions):
        require(isinstance(revision, str) and re.fullmatch("[0-9a-f]{32}", revision), "Invalid provider history", "corrupt_state")
        directory = root / revision
        if not directory.is_dir():
            choices.clear()
            break
        source = directory / "settings.json"
        value = read_json(source, PROVIDER_JSON_LIMIT)
        created = source.stat().st_mtime_ns
        active = [row["id"] for row in entries(value) if row["enabled"] and row["settings"]["kind"] == "zhipu-coding"]
        view = directory / "system-config.toml"
        if not view.exists():
            view = directory / "config.toml"
        with view.open("rb") as stream:
            servers = tomllib.load(stream).get("mcp_servers", {})
        for name, entry in servers.items():
            if not DISPLAY.fullmatch(name):
                continue
            key, _ = _identity(name, entry, active, "connections" not in value and value["kind"] == "zhipu-coding")
            choices.setdefault(name, set()).add(key)
            earliest[name] = min(earliest.get(name, created), created)
            if len(choices) > 4096:
                break
        if len(choices) > 4096:
            # Never treat a truncated account of past ownership as authoritative.
            choices.clear()
            break
    bindings = {name: [next(iter(keys)), earliest[name]] for name, keys in choices.items() if len(keys) == 1}
    # The inventory is immutable; restarting, saving profiles and restoring a
    # different registry cannot relabel an unvisited identity's old files.
    write_json(root / ORIGINS, {"before": cutoff, "bindings": bindings}, mode=0o644)


def initial_origins(root):
    """A newly installed, as-yet unmanaged legacy generation can still be read."""
    from .mcp_enabled_override import DISPLAY, _identity
    from .provider import ZHIPU_URL
    try:
        selected = os.readlink(root / "current")
        generations = [entry.name for entry in root.iterdir() if re.fullmatch("[0-9a-f]{32}", entry.name)]
        if generations != [selected]:
            return None
        source = root / selected / "config.toml"
        with source.open("rb") as handle:
            created = os.fstat(handle.fileno()).st_mtime_ns
            document = tomllib.load(handle)
    except FileNotFoundError:
        return None
    model = document.get("model_providers", {}).get("harness_responses", {})
    if model.get("env_key") != "HARNESS_PROVIDER_API_KEY" or model.get("base_url") != ZHIPU_URL:
        return None
    bindings = {}
    for name, entry in document.get("mcp_servers", {}).items():
        if DISPLAY.fullmatch(name):
            key, _ = _identity(name, entry, ["default"], True)
            bindings[name] = [key, created]
    return {"before": time.time_ns(), "bindings": bindings}


def origins(root):
    if root is None:
        return None
    try:
        value = read_json(root / ORIGINS, 1024 * 1024)
    except FileNotFoundError:
        return None
    require(isinstance(value, dict) and type(value.get("before")) is int and isinstance(value.get("bindings"), dict)
            and all(isinstance(key, str) and isinstance(attribution, list) and len(attribution) == 2
                    and isinstance(attribution[0], str) and type(attribution[1]) is int for key, attribution in value["bindings"].items()),
            "Invalid managed legacy MCP inventory", "config_conflict")
    return value


def publish(layout, *settings):
    root = layout.config / "providers"
    if not settings:
        # Older installed generations acquire an inventory on control update.
        if not (root / "current").is_symlink():
            return
        settings = (read_json(root / "current/settings.json", PROVIDER_JSON_LIMIT),)
    capture_origins(layout)
    if not any("connections" in value for value in settings) and not (root / INVENTORY).exists():
        return
    profiles = Profiles(layout).records()
    owners = {row["id"] for value in [*settings, *(record["settings"] for record in profiles)]
              for row in entries(value) if row["settings"]["kind"] == "zhipu-coding"}
    # The first enabled plan owns the plain names. This order distinguishes a
    # host-managed lookalike from a generated builtin, even with identical URLs.
    active = {value["revision"]: [row["id"] for row in entries(value)
                                  if row["enabled"] and row["settings"]["kind"] == "zhipu-coding"]
              for value in settings}
    snapshot = {"active": active, "owners": sorted(owners)}
    write_json(root / INVENTORY, snapshot, mode=0o644)


def retained(root):
    # The installed launcher supplies the root-managed directory. Standalone
    # helpers and older control generations have no authoritative deletion data.
    if root is None:
        return None, None
    try:
        value = read_json(root / INVENTORY, 16384)
        selected = os.readlink(root / "current")
    except FileNotFoundError:
        return None, None
    require(isinstance(value, dict) and set(value) == {"owners", "active"}
            and isinstance(value["owners"], list) and len(value["owners"]) <= (MAX_PROFILES + 2) * MAX_CONNECTIONS
            and all(isinstance(item, str) and re.fullmatch(OWNER, item) for item in value["owners"])
            and isinstance(value["active"], dict) and 1 <= len(value["active"]) <= 2
            and all(re.fullmatch("[0-9a-f]{32}", generation) and isinstance(ids, list) and len(ids) <= MAX_CONNECTIONS
                    and all(isinstance(item, str) and item in value["owners"] for item in ids)
                    for generation, ids in value["active"].items()),
            "Invalid managed MCP switch inventory", "config_conflict")
    return (set(value["owners"]), value["active"][selected]) if selected in value["active"] else (None, None)
