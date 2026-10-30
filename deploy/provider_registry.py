"""Enabled providers share a generation, never their endpoint-bound credentials."""
from __future__ import annotations

import copy
import re
import secrets
import tomllib

from .common import require
from .provider import KINDS, _single_native_config, redacted, small_text, validate_provider

MAX_CONNECTIONS = 16
LABELS = {"chatgpt": "ChatGPT", "chatgpt-gateway": "ChatGPT 企业网关", "responses": "OpenAI 兼容服务",
          "zhipu-coding": "智谱 Coding Plan", "bedrock-runtime": "Amazon Bedrock Runtime", "bedrock-mantle": "Amazon Bedrock Mantle"}


def identity(value: object) -> str:
    require(isinstance(value, str) and (value == "default" or re.fullmatch(r"[0-9a-f]{32}", value)), "Invalid provider identity")
    return value


def entries(current: dict) -> list[dict]:
    rows = current.get("connections")
    if rows is None:
        return [{"id": "default", "name": LABELS[current["kind"]], "enabled": True,
                 "settings": {key: value for key, value in current.items() if key not in ("connections", "defaultProviderId")}}]
    require(isinstance(rows, list) and 1 <= len(rows) <= MAX_CONNECTIONS, "Invalid provider registry", "corrupt_state")
    seen = set()
    for row in rows:
        require(isinstance(row, dict) and set(row) == {"id", "name", "enabled", "settings"}, "Invalid provider record", "corrupt_state")
        ident = identity(row["id"])
        require(ident not in seen and type(row["enabled"]) is bool and isinstance(row["settings"], dict)
                and row["settings"].get("kind") in KINDS, "Invalid provider record", "corrupt_state")
        small_text(row["name"], "provider name", 256)
        seen.add(ident)
    return copy.deepcopy(rows)


def provider_id(row: dict) -> str:
    # Keep the old default's native identity stable so saved threads resume.
    if row["settings"]["kind"].startswith("bedrock-"):
        from .provider_bedrock import KINDS as BEDROCK
        return BEDROCK[row["settings"]["kind"]]
    if row["id"] == "default":
        return {"chatgpt": "harness_chatgpt", "chatgpt-gateway": "harness_chatgpt_gateway",
                "bedrock-runtime": "amazon-bedrock-runtime", "bedrock-mantle": "amazon-bedrock"}.get(row["settings"]["kind"], "harness_responses")
    return "harness_" + identity(row["id"])


def selected(current: dict, ident: object = None) -> dict:
    wanted = current.get("defaultProviderId", "default") if ident is None else identity(ident)
    result = next((row for row in entries(current) if row["id"] == wanted), None)
    require(result is not None, "Provider no longer exists", "provider_missing")
    return result


def combine(current: dict, rows: list[dict], default: str) -> dict:
    bedrock = [row for row in rows if row["settings"]["kind"].startswith("bedrock-")]
    require(len({row["settings"]["kind"] for row in bedrock}) == len(bedrock),
            "Bedrock Runtime and Mantle each support one saved connection")
    require(len({row["settings"].get("region") for row in bedrock if row["enabled"]}) <= 1,
            "Enabled native Bedrock connections must use the same AWS region")
    enabled = [row for row in rows if row["enabled"]]
    require(enabled, "Keep at least one provider enabled")
    if not any(row["id"] == default and row["enabled"] for row in rows):
        default = enabled[0]["id"]
    chosen = next(row for row in rows if row["id"] == default)
    return {**chosen["settings"], "revision": secrets.token_hex(16), "connections": rows, "defaultProviderId": default}


def change(params: dict, current: dict) -> dict:
    require(params.get("expectedRevision") == current["revision"], "Provider changed; read again", "revision_conflict")
    rows = entries(current)
    default = current.get("defaultProviderId", "default")
    if "removeProviderId" in params:
        require(set(params) == {"expectedRevision", "removeProviderId"}, "Invalid provider removal")
        ident = identity(params["removeProviderId"])
        require(any(row["id"] == ident for row in rows), "Provider no longer exists", "provider_missing")
        return combine(current, [row for row in rows if row["id"] != ident], default)
    if "defaultProviderId" in params:
        require(set(params) == {"expectedRevision", "defaultProviderId"}, "Invalid default provider change")
        ident = identity(params["defaultProviderId"])
        require(any(row["id"] == ident and row["enabled"] for row in rows), "Default provider must be enabled")
        return combine(current, rows, ident)
    ident = params.get("providerId", default)
    if ident == "new":
        require(len(rows) < MAX_CONNECTIONS, "At most 16 model providers can be saved", "budget")
        ident = secrets.token_hex(16)
        existing = {"kind": params.get("kind"), "revision": current["revision"], "models": []}
        row = {"id": ident, "name": LABELS.get(params.get("kind"), "模型供应商"), "enabled": True, "settings": existing}
        rows.append(row)
    else:
        ident = identity(ident)
        row = next((row for row in rows if row["id"] == ident), None)
        require(row is not None, "Provider no longer exists", "provider_missing")
        existing = row["settings"]
    if "name" in params:
        name = small_text(params["name"], "provider name", 256).strip()
        require(0 < len(name) <= 64, "Provider name must contain 1 to 64 characters")
        row["name"] = name
    if "enabled" in params:
        require(type(params["enabled"]) is bool, "enabled must be a boolean")
        row["enabled"] = params["enabled"]
    values = {key: value for key, value in params.items() if key not in ("providerId", "name", "enabled")}
    if set(values) != {"expectedRevision"}:
        values["expectedRevision"] = existing["revision"]
        row["settings"] = validate_provider(values, existing)
    return combine(current, rows, default)


def replace_settings(current: dict, ident: object, settings: dict) -> dict:
    rows = entries(current)
    target = selected(current, ident)["id"]
    for row in rows:
        if row["id"] == target:
            row["settings"] = settings
    return combine(current, rows, current.get("defaultProviderId", "default"))


def public_registry(current: dict) -> dict:
    return {"defaultProviderId": current.get("defaultProviderId", "default"),
            "connections": [{**redacted(row["settings"]), "id": row["id"], "name": row["name"],
                             "enabled": row["enabled"], "modelProvider": provider_id(row),
                             **({"providerAliases": ["openai"]} if row["id"] == "default" and row["settings"]["kind"] == "chatgpt" else {}),
                             **({"catalogSource": row["settings"]["catalogSource"]} if "catalogSource" in row["settings"] else {}),
                             **({"catalogError": row["settings"]["catalogError"]} if "catalogError" in row["settings"] else {})}
                            for row in entries(current)]}


def key_name(row: dict) -> str:
    return "HARNESS_PROVIDER_KEY_" + row["id"].upper()


def catalog_files(current: dict) -> dict:
    return {"catalog-" + row["id"] + ".json": row["settings"]["nativeCatalog"]
            for row in entries(current) if row["enabled"] and row["settings"].get("nativeCatalog")}


def runtime_registry(current: dict, layout) -> dict:
    rows = public_registry(current)["connections"]
    for row in rows:
        if row["enabled"] and "catalog-" + row["id"] + ".json" in catalog_files(current):
            row["catalogPath"] = str(layout.config / "providers" / current["revision"] / ("catalog-" + row["id"] + ".json"))
    return {"defaultProviderId": current.get("defaultProviderId", "default"), "connections": rows,
            "nativeCatalogProvider": provider_id(selected(current))}


def configuration(current: dict, layout) -> dict:
    selected_row = selected(current)
    selected_config = tomllib.loads(_single_native_config(selected_row["settings"], layout).decode())
    # Catalogs are selected per thread. A global file would replace ChatGPT's
    # live directory and mix capability records of equal IDs on other services.
    selected_config.pop("model_catalog_json", None)
    definitions = {}
    mcp = {}
    for row in entries(current):
        if not row["enabled"]:
            continue
        value = row["settings"]
        config = tomllib.loads(_single_native_config(value, layout).decode())
        if value["kind"] == "chatgpt":
            definition = {"name": row["name"], "base_url": "https://chatgpt.com/backend-api/codex",
                          "wire_api": "responses", "requires_openai_auth": True, "supports_websockets": True}
        else:
            definition = next(iter(config["model_providers"].values()))
            if not value["kind"].startswith("bedrock-"):
                definition["name"] = row["name"]
            if value["kind"] in ("responses", "zhipu-coding"):
                definition.pop("env_key", None)
                if value.get("apiKey"):
                    definition["env_key"] = key_name(row)
            elif value["kind"].startswith("bedrock-"):
                # Preserve native AWS catalog/auth semantics and select only
                # this connection's bearer inside the fixed launcher.
                definition["auth"]["args"] = ["bedrock-token", row["id"]]
        definitions[provider_id(row)] = definition
        for name, server in config.get("mcp_servers", {}).items():
            if "bearer_token_env_var" in server:
                server["bearer_token_env_var"] = key_name(row)
            if name == "zai-mcp-server":
                server = {"command": str(layout.control / "native-launch"), "args": ["zai-server", row["id"]]}
            # A second Coding Plan should not overwrite the first one's tools.
            mcp[name if name not in mcp else name + "-" + row["id"]] = server
    selected_config["model_provider"] = provider_id(selected_row)
    selected_config["model_providers"] = definitions
    if mcp:
        selected_config["mcp_servers"] = mcp
    else:
        selected_config.pop("mcp_servers", None)
    return selected_config


def environment(current: dict) -> dict:
    result = {}
    for row in entries(current):
        if not row["enabled"]:
            continue
        value = row["settings"]
        if value.get("apiKey"):
            result[key_name(row)] = value["apiKey"]
        if value["kind"] == "zhipu-coding" and "Z_AI_API_KEY" not in result:
            result.update(Z_AI_API_KEY=value["apiKey"], Z_AI_MODE="ZHIPU")
        if value["kind"].startswith("bedrock-") and "AWS_REGION" not in result:
            result.update(AWS_REGION=value["region"], AWS_BEARER_TOKEN_BEDROCK=value["apiKey"])
    return result
