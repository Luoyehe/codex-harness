"""Immutable per-instance system layers that preserve the host configuration.

Only same-path file binds are used: /etc/codex remains the origin for relative
references, and unrelated host files (including managed_config.toml) stay live.
"""
from __future__ import annotations

import copy
import datetime
import hashlib
import json
import math
import os
import stat
import tomllib
from pathlib import Path

from .common import DeployError, Layout, fsync_directory, read_json, require

HOST_NAMES = ("config.toml", "requirements.toml", "managed_config.toml")
HOST_LIMIT = 1024 * 1024
LAYER_LIMIT = 4 * 1024 * 1024
LAYER_MODE = "system-v1"


def provider_documents(value: dict, layout: Layout) -> tuple[dict, dict]:
    from .provider import native_config
    defaults = tomllib.loads(native_config(value, layout).decode())
    if value["kind"] in ("chatgpt", "chatgpt-gateway"):
        provider = "harness_chatgpt" if value["kind"] == "chatgpt" else "harness_chatgpt_gateway"
        if value["kind"] == "chatgpt-gateway":
            from .provider_gateway import definition as gateway_definition
            definition = gateway_definition(value)
        else:
            definition = {"name": "OpenAI", "base_url": "https://chatgpt.com/backend-api/codex", "wire_api": "responses",
                          "requires_openai_auth": True, "supports_websockets": True}
        # The built-in `openai` definition cannot be overridden by requirements;
        # a separate complete definition also excludes user openai_base_url.
        defaults.update(model_provider=provider, model_providers={provider: definition})
        required = {"model_provider": provider, "model_providers": {provider: definition},
                    "allowed_login_methods": ["chatgpt"], "chatgpt_base_url": "https://chatgpt.com/backend-api/"}
    elif value["kind"].startswith("bedrock-"):
        from .provider_bedrock import KINDS as BEDROCK
        provider = BEDROCK[value["kind"]]
        required = {"model_provider": provider, "model_providers": {provider: copy.deepcopy(defaults["model_providers"][provider])},
                    "allowed_login_methods": ["api"], "allowed_web_search_modes": ["disabled"] if value["kind"] == "bedrock-runtime" else ["disabled", "cached"]}
    else:
        provider = "harness_responses"
        required = {"model_provider": provider, "model_providers": {provider: copy.deepcopy(defaults["model_providers"][provider])}}
    if "model_catalog_json" in defaults:
        required["model_catalog_json"] = defaults["model_catalog_json"]
    return defaults, required


def generation_layers(value: dict, layout: Layout, worker_gid: int) -> tuple[dict[str, bytes], dict]:
    host, manifest = read_host_layers(layout, worker_gid)
    require(all(manifest["files"][name]["exists"] for name in ("config.toml", "requirements.toml")),
            "Prepare the system layer mount targets through config-layer-migrate first", "configuration_conflict")
    defaults, required = provider_documents(value, layout)
    return compose_layers(defaults, required, host), manifest


def prepare_host_targets(value: dict, layout: Layout, worker_gid: int) -> None:
    documents, manifest = read_host_layers(layout, worker_gid)
    defaults, required = provider_documents(value, layout)
    compose_layers(defaults, required, documents)  # No host writes before all policy conflicts are checked.
    ensure_mount_targets(layout, manifest)
    generation_layers(value, layout, worker_gid)  # Re-read policy after creating only empty missing targets.


def preflight_host_policy(value: dict, layout: Layout, worker_gid: int) -> None:
    documents, _ = read_host_layers(layout, worker_gid)
    defaults, required = provider_documents(value, layout)
    compose_layers(defaults, required, documents)


def verify_system_layers(layout: Layout) -> dict:
    import re
    config = read_json(layout.config / "instance.json")
    require(config.get("providerConfigLayer") == LAYER_MODE, "System provider layer is not selected", "configuration_conflict")
    selected = os.readlink(layout.config / "providers/current")
    require(re.fullmatch("[0-9a-f]{32}", selected) is not None, "Invalid provider selection", "corrupt_state")
    directory = layout.config / "providers" / selected
    settings = read_json(directory / "settings.json", 4 * 1024 * 1024)
    require(settings.get("revision") == selected, "Provider generation identity mismatch", "integrity")
    expected, manifest = generation_layers(settings, layout, config["workerGid"])
    record = directory / "host-layers.json"
    details = record.lstat()
    require(stat.S_ISREG(details.st_mode) and details.st_nlink == 1 and details.st_size <= HOST_LIMIT and
            (os.name != "posix" or details.st_uid == 0 and stat.S_IMODE(details.st_mode) == 0o600), "Unsafe host layer fingerprint", "integrity")
    require(read_json(record) == manifest, "Host Codex policy changed; refresh the configuration layer before starting", "configuration_conflict")
    for name, content in expected.items():
        path = directory / name
        details = path.lstat()
        require(stat.S_ISREG(details.st_mode) and details.st_nlink == 1 and details.st_size <= LAYER_LIMIT and
                (os.name != "posix" or details.st_uid == 0 and details.st_gid == config["workerGid"] and stat.S_IMODE(details.st_mode) == 0o640) and
                path.read_bytes() == content, "Generated system provider layer changed", "integrity")
    require(os.readlink(layout.config / "providers/current") == selected, "Provider changed during host policy check", "configuration_conflict")
    return {"providerConfigLayer": LAYER_MODE, "providerRevision": selected, "hostPolicyVerified": True}


def toml_value(value, depth: int = 0) -> str:
    require(depth <= 32, "Host TOML nesting exceeds budget", "budget")
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) in (int, float):
        return repr(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(item, depth + 1) for item in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(toml_value(key, depth + 1) + " = " + toml_value(item, depth + 1) for key, item in value.items()) + " }"
    raise DeployError("invalid_input", "Unsupported host TOML value")


def equivalent(left, right) -> bool:
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(equivalent(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(equivalent(a, b) for a, b in zip(left, right))
    return left == right or isinstance(left, float) and math.isnan(left) and math.isnan(right)


def serialize_toml(value: dict) -> bytes:
    text = "# Instance view of host configuration plus managed provider settings.\n" + "\n".join(
        toml_value(key) + " = " + toml_value(item) for key, item in value.items()) + "\n"
    data = text.encode()
    require(len(data) <= LAYER_LIMIT, "Merged system layer exceeds budget", "budget")
    require(equivalent(value, tomllib.loads(text)), "Host TOML could not be preserved", "configuration_conflict")
    return data


def merge_preserving_host(host: dict, managed: dict, *, prefix: str = "") -> dict:
    result = copy.deepcopy(host)
    for key, value in managed.items():
        location = prefix + key
        if key not in result:
            result[key] = copy.deepcopy(value)
        elif isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = merge_preserving_host(result[key], value, prefix=location + ".")
        else:
            require(equivalent(result[key], value), "Host configuration conflicts at " + location, "configuration_conflict")
    return result


def compose_layers(defaults: dict, requirements: dict, host: dict[str, dict]) -> dict[str, bytes]:
    require(set(host) == set(HOST_NAMES), "Incomplete host configuration snapshot")
    provider = requirements.get("model_provider")
    require(isinstance(provider, str) and isinstance(requirements.get("model_providers"), dict) and
            isinstance(requirements["model_providers"].get(provider), dict), "Complete enforced provider definition is required")
    enforced = requirements["model_providers"][provider]
    for name in HOST_NAMES:
        document = host[name]
        require(isinstance(document, dict), "Invalid host configuration snapshot")
        if "model_provider" in document:
            require(document["model_provider"] == provider, "Host provider selection conflicts in " + name, "configuration_conflict")
        definitions = document.get("model_providers", {})
        require(isinstance(definitions, dict), "Invalid host provider table", "configuration_conflict")
        if provider in definitions:
            # A requirements provider replaces the complete ordinary definition.
            # Do not silently erase an administrator's extra auth/header fields.
            require(equivalent(definitions[provider], enforced), "Host provider definition conflicts in " + name, "configuration_conflict")
        for field in ("model_catalog_json", "chatgpt_base_url"):
            if field in requirements and field in document:
                require(equivalent(requirements[field], document[field]), "Host provider constraint conflicts in " + name, "configuration_conflict")
    # Legacy managed defaults have higher priority. An overlapping different
    # value is an explicit conflict, rather than a hidden change of defaults.
    merge_preserving_host(host["managed_config.toml"], defaults)
    config = merge_preserving_host(host["config.toml"], defaults)
    required = merge_preserving_host(host["requirements.toml"], requirements)
    return {"system-config.toml": serialize_toml(config), "requirements.toml": serialize_toml(required)}


def _ancestors(layout: Layout, directory: Path) -> None:
    current = directory
    while True:
        try:
            info = current.lstat()
        except FileNotFoundError:
            info = None
        if info is not None:
            require(stat.S_ISDIR(info.st_mode) and (os.name != "posix" or info.st_uid == 0 and not info.st_mode & 0o022),
                    "Host Codex configuration has an unsafe ancestor", "configuration_conflict")
        if current == layout.root:
            break
        require(current != current.parent, "Host configuration escaped the installation root", "unsafe_path")
        current = current.parent


def read_host_layers(layout: Layout, worker_gid: int) -> tuple[dict[str, dict], dict]:
    folder = layout.root / "etc/codex"
    _ancestors(layout, folder)
    parent = folder
    while parent != layout.root:
        if parent.exists():
            info = parent.stat()
            require(os.name != "posix" or info.st_mode & 0o001 or info.st_gid == worker_gid and info.st_mode & 0o010,
                    "Host Codex configuration parent is not native-traversable", "configuration_conflict")
        parent = parent.parent
    documents, records = {}, {}
    for name in HOST_NAMES:
        path = folder / name
        try:
            info = path.lstat()
        except FileNotFoundError:
            documents[name], records[name] = {}, {"exists": False}
            continue
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= HOST_LIMIT and
                (os.name != "posix" or info.st_uid == 0 and not info.st_mode & 0o022 and
                 (info.st_mode & 0o004 or info.st_gid == worker_gid and info.st_mode & 0o040)),
                "Host Codex configuration must be ordinary, immutable to native, and already native-readable", "configuration_conflict")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            before = os.fstat(fd)
            require((info.st_dev, info.st_ino) == (before.st_dev, before.st_ino), "Host configuration changed during inspection", "configuration_conflict")
            require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= HOST_LIMIT,
                    "Host configuration type changed during inspection", "configuration_conflict")
            require(os.name != "posix" or before.st_uid == 0 and not before.st_mode & 0o022 and
                    (before.st_mode & 0o004 or before.st_gid == worker_gid and before.st_mode & 0o040),
                    "Host configuration permissions changed during inspection", "configuration_conflict")
            data = bytearray()
            while len(data) <= HOST_LIMIT:
                block = os.read(fd, min(65536, HOST_LIMIT + 1 - len(data)))
                if not block:
                    break
                data.extend(block)
            after = os.fstat(fd)
        finally:
            os.close(fd)
        require(len(data) <= HOST_LIMIT and (before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_size, after.st_mtime_ns, after.st_ctime_ns), "Host configuration changed or exceeded budget", "configuration_conflict")
        try:
            documents[name] = tomllib.loads(bytes(data).decode("utf-8"))
        except (ValueError, UnicodeError) as exc:
            raise DeployError("configuration_conflict", "Host Codex TOML is invalid in " + name) from exc
        records[name] = {"exists": True, "sha256": hashlib.sha256(data).hexdigest(), "mode": stat.S_IMODE(after.st_mode),
                         "uid": after.st_uid, "gid": after.st_gid}
    return documents, {"format": 1, "files": records}


def ensure_mount_targets(layout: Layout, expected: dict) -> None:
    """Create only missing empty targets. Never rewrite or remove host files."""
    folder = layout.root / "etc/codex"
    _ancestors(layout, folder)
    for directory in (layout.root / "etc", folder):
        try:
            directory.mkdir(mode=0o755)
        except FileExistsError:
            pass
        else:
            os.chmod(directory, 0o755)
            fsync_directory(directory.parent)
    _ancestors(layout, folder)
    for name in ("config.toml", "requirements.toml"):
        if expected["files"][name]["exists"]:
            continue
        try:
            fd = os.open(folder / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
        except FileExistsError as exc:
            raise DeployError("configuration_conflict", "Host mount target appeared during preparation") from exc
        try:
            if os.name == "posix":
                os.fchmod(fd, 0o644)
            os.fsync(fd)
        finally:
            os.close(fd)
        fsync_directory(folder)
