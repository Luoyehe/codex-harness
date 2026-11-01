"""Fixed execution identities derived only from administrator-owned configuration."""
from __future__ import annotations

import re
import os
from .common import digest, read_json, require

FIELDS = {"executionMode", "rootAllowed", "executionGeneration"}


def managed(config: dict) -> bool:
    return bool(FIELDS & config.keys())


def state(config: dict) -> dict:
    if managed(config):
        require(FIELDS <= config.keys() and config["executionMode"] in ("native", "root") and
                type(config["rootAllowed"]) is bool and isinstance(config["executionGeneration"], str) and
                re.fullmatch(r"[0-9a-f]{32}", config["executionGeneration"]) is not None,
                "Invalid execution identity policy", "integrity")
    mode, allowed = config.get("executionMode", "native"), config.get("rootAllowed", False)
    require(mode != "root" or allowed, "Root execution is not authorized", "integrity")
    require(type(config.get("workerUid")) is int and config["workerUid"] > 0 and
            type(config.get("workerGid")) is int and config["workerGid"] > 0,
            "Invalid fixed native identity", "integrity")
    revision = digest({"mode": mode, "rootAllowed": allowed, "generation": config.get("executionGeneration"),
                       "uid": config["workerUid"], "gid": config["workerGid"]})
    return {"mode": mode, "rootAllowed": allowed, "revision": revision,
            "effectiveUid": 0 if mode == "root" else config["workerUid"], "requiresRestart": True}


def native_settings(layout, config: dict) -> dict:
    selected = state(config)
    root = selected["mode"] == "root"
    home = layout.state / ("worker-root" if root else "worker")
    value = {"uid": selected["effectiveUid"], "gid": 0 if root else config["workerGid"],
             "cwd": str(home), "home": str(home / "codex"),
             "bin": str(layout.app / "current/codex" / config["codexRelative"])}
    if managed(config):
        value.update(executionMode=selected["mode"], rootAllowed=selected["rootAllowed"],
                     executionRevision=selected["revision"], providerGid=config["workerGid"])
    return value


def require_application(layout, release: str | None, config: dict, *, enabling: bool = False) -> None:
    if release is not None:
        package = read_json(layout.app / "releases" / release / "app/package.json")
        if package.get("codexHarnessThreadHistory") is not None:
            capability = read_json(layout.control / "capabilities.json", 4096)
            require_history_control(layout, capability, release=release)
    if not enabling and config.get("executionMode", "native") != "root":
        return
    require(release is not None, "Install the application before changing execution permissions", "not_installed")
    package = read_json(layout.app / "releases" / release / "app/package.json")
    require(package.get("codexHarnessExecutionMode") == 1,
            "Update the application before enabling root; this release does not support execution identities", "execution_unsupported")


def require_control(capabilities: dict, config: dict, *, enabling: bool = False) -> None:
    if enabling or managed(config):
        require(capabilities.get("executionMode") == 1,
                "Update trusted control tools before enabling root; this generation does not support execution identities", "execution_unsupported")


def supports_history_control(capabilities: dict, version: int = 1) -> bool:
    # Version 2 retains inspection/repair and adds independently verified recovery
    # copies. Unknown future versions are not an implicit compatibility promise.
    actual = capabilities.get("threadHistoryRepair")
    return type(actual) is int and actual in (1, 2) and actual >= version


def require_history_control(layout, capabilities: dict, *, release: str | None = None) -> None:
    if release is None:
        pointer = layout.app / "current"
        if not pointer.is_symlink():
            require(not pointer.exists(), "Release pointer is not a symlink", "corrupt_state")
            return
        target = os.readlink(pointer)
        require(re.fullmatch(r"releases/[0-9a-f]{64}", target) is not None, "Invalid release pointer", "corrupt_state")
        release = target.split("/")[1]
    package = read_json(layout.app / "releases" / release / "app/package.json")
    if package.get("codexHarnessThreadHistory") is not None:
        version = package["codexHarnessThreadHistory"]
        require(type(version) is int and version in (1, 2),
                "Unsupported application history helper contract", "history_unsupported")
        require(supports_history_control(capabilities, version),
                "This application requires compatible history repair and recovery-copy support; update control tools first or restore a compatible application before selecting old control tools",
                "history_unsupported")
