"""Provider settings are a single immutable generation, selected by one pointer."""
from __future__ import annotations

import os
import ipaddress
import re
import secrets
from pathlib import Path
from urllib.parse import urlsplit

from .common import DeployError, Layout, atomic_write, canonical, digest, fsync_directory, mkdir, read_json, require, write_json

KINDS = ("chatgpt", "chatgpt-gateway", "responses", "zhipu-coding", "bedrock-runtime", "bedrock-mantle")
ZHIPU_URL = "https://open.bigmodel.cn/api/v1"


def require_provider_layer(settings: dict, *, layered: bool) -> None:
    require(layered or settings.get("kind") in ("chatgpt", "responses", "zhipu-coding"),
            "This provider requires the managed system configuration layer", "configuration_conflict")


def provider_url(base: str, api_key: str, allow_insecure: bool = False) -> str:
    parsed = urlsplit(base)
    require(parsed.scheme in ("https", "http") and bool(parsed.hostname) and not parsed.username and not parsed.password and
            not parsed.query and not parsed.fragment and not any(c.isspace() for c in base), "Invalid Responses base URL")
    try:
        require(parsed.port is None or 1 <= parsed.port <= 65535, "Invalid provider port")
    except ValueError:
        require(False, "Invalid provider port")
    if parsed.scheme == "http":
        try:
            address = ipaddress.ip_address(parsed.hostname)
        except ValueError:
            raise DeployError("invalid_input", "HTTP providers require an explicit private IP literal; use HTTPS for DNS names")
        networks = ("127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "::1/128", "fc00::/7")
        require(any(address in ipaddress.ip_network(network) for network in networks), "Public HTTP provider endpoints are prohibited")
        require(not api_key or allow_insecure, "Sending an API key over private HTTP requires allowInsecureHttp=true")
    return base.rstrip("/")


def small_text(value, name: str, maximum: int = 256) -> str:
    require(isinstance(value, str) and 0 < len(value.encode()) <= maximum and not any(ord(c) < 32 or ord(c) == 127 for c in value),
            f"Invalid {name}")
    return value


def validate_provider(params: dict, current: dict) -> dict:
    require(isinstance(params, dict) and not set(params) - {"expectedRevision", "kind", "baseUrl", "model", "effort", "apiKey", "allowInsecureHttp", "gatewayOAuth", "confirmGatewayCredentials", "region"},
            "Unknown provider field")
    require(params.get("expectedRevision") == current.get("revision"), "Provider changed; read again", "revision_conflict")
    kind = params.get("kind")
    require(kind in KINDS, "Unknown provider kind")
    require(kind == "chatgpt-gateway" or not {"gatewayOAuth", "confirmGatewayCredentials"} & set(params), "Gateway fields require the ChatGPT gateway provider")
    require(kind.startswith("bedrock-") or "region" not in params, "AWS region requires a Bedrock provider")
    result = {"kind": kind, "models": current.get("models", []) if kind == current.get("kind") else []}
    if kind.startswith("bedrock-"):
        from .provider_bedrock import validate_bedrock
        result.update(validate_bedrock(params, current))
        if kind != current.get("kind") or result["region"] != current.get("region"):
            result["models"] = []
        elif current.get("nativeCatalog"):
            result["nativeCatalog"] = current["nativeCatalog"]
    elif kind == "chatgpt-gateway":
        from .provider_gateway import validate_gateway
        result.update(validate_gateway(params, current))
        if result["baseUrl"] != current.get("baseUrl") or result["gatewayOAuth"] != current.get("gatewayOAuth"):
            result["models"] = []
        elif current.get("nativeCatalog"):
            result["nativeCatalog"] = current["nativeCatalog"]
    elif kind == "chatgpt":
        require(not any(params.get(field) for field in ("baseUrl", "apiKey")), "ChatGPT uses the device-code login workflow")
    else:
        base = ZHIPU_URL if kind == "zhipu-coding" else small_text(params.get("baseUrl"), "Responses base URL", 2048)
        result["baseUrl"] = base.rstrip("/")
        result["model"] = small_text(params.get("model"), "model")
        # Never reuse a credential across endpoint/provider changes.
        unchanged = kind == current.get("kind") and result["baseUrl"] == current.get("baseUrl")
        if not unchanged:
            result["models"] = []
        elif current.get("nativeCatalog"):
            result["nativeCatalog"] = current["nativeCatalog"]
        key = params.get("apiKey", current.get("apiKey", "") if unchanged else "")
        require(isinstance(key, str), "API key must be a string; empty explicitly means no authentication")
        result["apiKey"] = small_text(key, "API key", 8192) if key else ""
        require(kind != "zhipu-coding" or bool(key), "Zhipu Coding Plan requires an API key")
        require("\x7f" not in result["apiKey"], "Invalid API key")
        insecure = params.get("allowInsecureHttp", current.get("allowInsecureHttp", False) if unchanged else False)
        require(type(insecure) is bool, "allowInsecureHttp must be a boolean")
        result["baseUrl"] = provider_url(base, result["apiKey"], insecure)
        if insecure:
            result["allowInsecureHttp"] = True
    if params.get("model"):
        result["model"] = small_text(params["model"], "model")
    if params.get("effort"):
        result["effort"] = small_text(params["effort"], "reasoning effort", 64)
    result["revision"] = secrets.token_hex(16)
    return result


def validate_catalog(params: dict, current: dict) -> dict:
    require(isinstance(params, dict) and set(params) == {"expectedRevision", "models"}, "Invalid catalog parameters")
    require(params["expectedRevision"] == current["revision"], "Provider changed; read again", "revision_conflict")
    models = params["models"]
    require(isinstance(models, list) and len(models) <= 1000, "Invalid model catalog")
    seen = set()
    cleaned = []
    for model in models:
        require(isinstance(model, dict) and {"id", "defaultEffort", "efforts"} <= set(model) and not set(model) -
                {"id", "defaultEffort", "efforts", "inputModalities", "contextWindow", "supportsTools", "instructions"}, "Invalid model metadata")
        ident = small_text(model["id"], "model id")
        require(ident not in seen, "Duplicate model id")
        seen.add(ident)
        default = model["defaultEffort"]
        require(default is None or isinstance(default, str), "Invalid native default")
        if default:
            small_text(default, "native default", 64)
        efforts = model["efforts"]
        require(isinstance(efforts, list) and len(efforts) <= 32, "Invalid effort list")
        efforts = sorted({small_text(effort, "effort", 64) for effort in efforts})
        modalities = model.get("inputModalities", ["text"])
        require(isinstance(modalities, list) and 1 <= len(modalities) <= 3 and "text" in modalities and
                all(item in ("text", "image", "audio") for item in modalities), "Invalid confirmed input modalities")
        context = model.get("contextWindow")
        require(context is None or type(context) is int and 4096 <= context <= 10_000_000, "Invalid confirmed context window")
        tools = model.get("supportsTools", False)
        require(type(tools) is bool, "supportsTools must be a boolean")
        instructions = model.get("instructions", "Assist the user with the requested task. Follow their instructions and respect tool approval decisions.")
        require(isinstance(instructions, str) and 0 < len(instructions.encode()) <= 65536 and "\x00" not in instructions, "Invalid model instructions")
        cleaned.append({"id": ident, "defaultEffort": default, "efforts": efforts,
                        "inputModalities": sorted(set(modalities)), "contextWindow": context, "supportsTools": tools, "instructions": instructions})
    cleaned.sort(key=lambda model: model["id"])
    selected = next((model for model in cleaned if model["id"] == current.get("model")), None)
    if current.get("effort") and selected:
        require(current["effort"] == selected["defaultEffort"] or current["effort"] in selected["efforts"],
                "Selected effort is neither native default nor supported override", "unsupported_effort")
    # A native default may be absent from the override list. Empty is also a valid native default.
    native = {"models": [{"slug": item["id"], "display_name": item["id"], "description": "Administrator-confirmed provider settings",
                           "default_reasoning_level": item["defaultEffort"] or "none",
                           "supported_reasoning_levels": [{"effort": effort, "description": "Administrator-confirmed override"} for effort in item["efforts"]],
                           "shell_type": "unified_exec" if item["supportsTools"] else "disabled", "visibility": "list", "supported_in_api": True,
                           "priority": index, "support_verbosity": False, "truncation_policy": {"mode": "bytes", "limit": 8192},
                           "context_window": item["contextWindow"], "experimental_supported_tools": [], "input_modalities": item["inputModalities"],
                           "supports_reasoning_summary_parameter": False, "include_apps_usage_instructions": False,
                           "node_repl_disabled": True, "base_instructions": item["instructions"]} for index, item in enumerate(cleaned)]}
    require(len(canonical(native)) <= 1024 * 1024, "Confirmed native catalog exceeds 1 MiB", "catalog_budget")
    result = {**current, "models": cleaned, "nativeCatalog": native}
    if cleaned != current.get("models", []) or native != current.get("nativeCatalog"):
        result["revision"] = secrets.token_hex(16)
    return result


def redacted(value: dict) -> dict:
    public = {"kind", "revision", "baseUrl", "model", "effort", "models", "allowInsecureHttp", "gatewayOAuth", "region"}
    return {**{key: item for key, item in value.items() if key in public}, "hasApiKey": bool(value.get("apiKey"))}


def quote_toml(value: str) -> str:
    import json
    return json.dumps(value, ensure_ascii=False)


def native_config(value: dict, layout: Layout | None = None) -> bytes:
    lines = ["# Managed provider generation; credentials are supplied by systemd."]
    if value.get("model"):
        lines.append("model = " + quote_toml(value["model"]))
    if value.get("effort"):
        lines.append("model_reasoning_effort = " + quote_toml(value["effort"]))
    if value.get("nativeCatalog"):
        require(layout is not None, "Catalog requires an installed layout")
        lines.append("model_catalog_json = " + quote_toml(str(layout.config / "providers" / value["revision"] / "models.json")))
    if value["kind"].startswith("bedrock-"):
        from .provider_bedrock import KINDS as BEDROCK, definition
        from .provider_layers import serialize_toml
        require(layout is not None, "Bedrock requires the fixed installed native launcher")
        provider = BEDROCK[value["kind"]]
        return ("\n".join(lines) + "\n").encode() + serialize_toml({"model_provider": provider, "web_search": "disabled" if value["kind"] == "bedrock-runtime" else "cached", "model_providers": {provider: definition(value, layout)}})
    if value["kind"] == "chatgpt-gateway":
        from .provider_gateway import definition
        from .provider_layers import serialize_toml
        return ("\n".join(lines) + "\n").encode() + serialize_toml({"model_provider": "harness_chatgpt_gateway", "model_providers": {"harness_chatgpt_gateway": definition(value)}})
    if value["kind"] != "chatgpt":
        lines += ['model_provider = "harness_responses"', '[model_providers.harness_responses]',
                  'name = "Harness Responses"', 'base_url = ' + quote_toml(value["baseUrl"]), 'wire_api = "responses"']
        if value.get("apiKey"):
            lines.append('env_key = "HARNESS_PROVIDER_API_KEY"')
    if value["kind"] == "zhipu-coding":
        require(layout is not None, "Zhipu configuration requires an installed layout")
        for name, url in (("web-search-prime", "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp"),
                          ("web-reader", "https://open.bigmodel.cn/api/mcp/web_reader/mcp"),
                          ("zread", "https://open.bigmodel.cn/api/mcp/zread/mcp")):
            lines += ["", "[mcp_servers." + quote_toml(name) + "]", "url = " + quote_toml(url),
                      'bearer_token_env_var = "HARNESS_PROVIDER_API_KEY"']
        base = layout.app / "current"
        lines += ["", '[mcp_servers."zai-mcp-server"]', "command = " + quote_toml(str(base / "node/bin/node")),
                  "args = [" + quote_toml(str(base / "app/node_modules/@z_ai/mcp-server/build/index.js")) + "]",
                  'env_vars = ["Z_AI_API_KEY", "Z_AI_MODE"]']
    return ("\n".join(lines) + "\n").encode()


class ProviderStore:
    def __init__(self, layout: Layout, worker_gid: int):
        self.layout = layout
        self.root = layout.config / "providers"
        self.gid = worker_gid

    def read(self) -> dict:
        return read_json(self.root / "current/settings.json", 4 * 1024 * 1024)

    def public(self, settings: dict | None = None) -> dict:
        from .provider_lifecycle import Profiles, generations, KEEP_HISTORY, MAX_GENERATIONS
        return {**redacted(settings if settings is not None else self.read()), "profiles": Profiles(self.layout).public(),
                "retention": {"generations": len(generations(self.root)), "limit": MAX_GENERATIONS, "retainedHistory": KEEP_HISTORY}}

    def validate_change(self, params: dict, current: dict) -> tuple[str, dict | str]:
        from .provider_lifecycle import Profiles
        profiles = Profiles(self.layout)
        actions = set(params) & {"saveProfileName", "profileId", "deleteProfileId"}
        if not actions:
            return "provider", validate_provider(params, current)
        require(len(actions) == 1 and set(params) == {"expectedRevision", *actions},
                "Profile actions cannot be mixed with provider fields")
        require(params.get("expectedRevision") == current.get("revision"), "Provider changed; read again", "revision_conflict")
        action = next(iter(actions))
        if action == "saveProfileName":
            return action, profiles.validate_save(params[action])
        saved = profiles.read(params[action])
        if action == "deleteProfileId":
            return action, saved["id"]
        settings = saved["settings"]
        # Restore a complete immutable endpoint-bound profile; the browser cannot
        # substitute an endpoint while asking to reuse its stored credential.
        allowed = {"kind", "baseUrl", "model", "effort", "apiKey", "allowInsecureHttp", "gatewayOAuth", "region"}
        restore = {key: value for key, value in settings.items() if key in allowed}
        if settings.get("kind") == "chatgpt-gateway":
            restore["confirmGatewayCredentials"] = True
        restored = validate_provider({**restore, "expectedRevision": settings.get("revision")}, settings)
        if settings.get("nativeCatalog"):
            restored = validate_catalog({"expectedRevision": restored["revision"], "models": restored["models"]}, restored)
        return "provider", restored

    def prepare(self, settings: dict, *, layered: bool | None = None) -> str:
        generation = settings["revision"]
        require(bool(re.fullmatch(r"[0-9a-f]{32}", generation)), "Invalid provider generation")
        from .provider_layers import LAYER_MODE, generation_layers
        if layered is None:
            instance = read_json(self.layout.config / "instance.json") if (self.layout.config / "instance.json").exists() else {}
            require(instance.get("providerConfigLayer") in (None, LAYER_MODE), "Invalid provider configuration layer", "corrupt_state")
            layered = instance.get("providerConfigLayer") == LAYER_MODE
        require_provider_layer(settings, layered=layered)
        layers = manifest = None
        if layered:
            layers, manifest = generation_layers(settings, self.layout, self.gid)
        mkdir(self.root, 0o750, 0, self.gid)
        target = self.root / generation
        require(not target.exists() and not target.is_symlink(), "Provider generation collision", "collision")
        from .provider_lifecycle import collect_generations
        collect_generations(self.layout, self.root)
        require(len([path for path in self.root.iterdir() if re.fullmatch(r"[0-9a-f]{32}", path.name)]) < 128,
                "Provider generation retention budget reached; inspect old recovery records", "budget")
        mkdir(target, 0o750, 0, self.gid)
        write_json(target / "settings.json", settings, mode=0o600)
        if settings.get("nativeCatalog"):
            write_json(target / "models.json", settings["nativeCatalog"], mode=0o640, uid=0, gid=self.gid)
        atomic_write(target / "config.toml", native_config(settings, self.layout), mode=0o640, uid=0, gid=self.gid)
        if layers is not None:
            for name, content in layers.items():
                atomic_write(target / name, content, mode=0o640, uid=0, gid=self.gid)
            write_json(target / "host-layers.json", manifest)
        # systemd EnvironmentFile uses its own escaping; a quoted literal has no expansion.
        native_env = {"HARNESS_PROVIDER_API_KEY": settings.get("apiKey", "") if not settings["kind"].startswith("bedrock-") else ""}
        if settings["kind"] == "zhipu-coding":
            native_env.update(Z_AI_API_KEY=settings["apiKey"], Z_AI_MODE="ZHIPU")
        if settings["kind"].startswith("bedrock-"):
            from .provider_bedrock import environment as bedrock_environment
            native_env.update(bedrock_environment(settings))
        environment = "".join(key + '="' + value.replace("\\", "\\\\").replace('"', '\\"') + '"\n' for key, value in native_env.items())
        atomic_write(target / "provider.env", environment.encode(), mode=0o600)
        write_json(target / "native-env.json", native_env, mode=0o640, uid=0, gid=self.gid)
        return generation

    def select(self, generation: str) -> None:
        require(bool(re.fullmatch(r"[0-9a-f]{32}", generation)) and (self.root / generation).is_dir(), "Missing provider generation")
        temporary = self.root / (".select-" + secrets.token_hex(8))
        os.symlink(generation, temporary)
        os.replace(temporary, self.root / "current")
        fsync_directory(self.root)
