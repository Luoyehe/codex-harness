"""Publish a credential-free inventory for private, per-identity MCP switch stores."""
from __future__ import annotations

import os
import re

from .common import read_json, require, write_json
from .provider_lifecycle import MAX_PROFILES, PROVIDER_JSON_LIMIT, Profiles
from .provider_registry import MAX_CONNECTIONS, entries

INVENTORY = "mcp-switch-owners.json"
OWNER = r"(?:default|[0-9a-f]{32})"


def publish(layout, *settings):
    root = layout.config / "providers"
    if not settings:
        # Older installed generations acquire an inventory on control update.
        if not (root / "current").is_symlink():
            return
        settings = (read_json(root / "current/settings.json", PROVIDER_JSON_LIMIT),)
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
