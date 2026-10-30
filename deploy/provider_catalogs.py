"""Catalog metadata comes from provider responses or the vendor's Codex guide."""
from __future__ import annotations

from .common import DeployError
from .provider import validate_catalog

ZHIPU_SOURCE = "https://docs.bigmodel.cn/cn/coding-plan/tool/codex"


def zhipu_documented_models() -> list[dict]:
    # Official Codex integration guide, verified 2026-10-30. These entries
    # describe provider capability, not a successful account entitlement check.
    return [
        {"id": "glm-5.3", "defaultEffort": "max", "efforts": ["low", "high", "max"],
         "inputModalities": ["text"], "contextWindow": 1048576, "supportsTools": True},
        {"id": "glm-5-turbo", "defaultEffort": "max", "efforts": [],
         "inputModalities": ["text"], "contextWindow": 204800, "supportsTools": True},
    ]


def discover(settings: dict) -> tuple[list[dict], str]:
    from .catalog import fetch_ids
    if settings["kind"] != "zhipu-coding":
        return [{**row, "toolsSource": "provider"} if "supportsTools" in row else
                {**row, "supportsTools": settings.get("supportsTools", True), "toolsSource": "configured"}
                for row in fetch_ids(settings)], "provider"
    # Coding Plan documents models.json, not an OpenAI /models discovery API.
    # Display this source explicitly; this is not a credential entitlement test.
    return zhipu_documented_models(), "vendor-documentation"


def apply_discovery(settings: dict) -> dict:
    rows, source = discover(settings)
    result = validate_catalog({"expectedRevision": settings["revision"], "models": rows}, settings)
    if not result.get("model") and rows:
        result["model"] = rows[0]["id"]
    result["catalogSource"] = ZHIPU_SOURCE if source == "vendor-documentation" else "provider"
    result.pop("catalogError", None)
    return result


def initialize(settings: dict) -> dict:
    """Save configuration even when discovery is unavailable; never fake IDs."""
    if settings["kind"] not in ("responses", "zhipu-coding"):
        return settings
    if settings.get("models"):
        return settings if settings.get("model") else {**settings, "model": settings["models"][0]["id"]}
    try:
        return apply_discovery(settings)
    except DeployError as error:
        return {**settings, "catalogError": str(error)}
