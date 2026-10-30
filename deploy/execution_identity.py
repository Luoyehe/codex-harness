"""Fixed execution identities derived only from administrator-owned configuration."""
from __future__ import annotations

import re
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
