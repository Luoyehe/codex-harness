"""Administrator-reviewed gateway OAuth policy; tokens remain native-owned."""
from __future__ import annotations

import re
from urllib.parse import urlsplit

from .common import require


def https_url(value, label: str, *, base: bool = False) -> str:
    from .provider import small_text
    text = small_text(value, label, 2048)
    parsed = urlsplit(text)
    require(parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username and not parsed.password and
            not parsed.query and not parsed.fragment and not any(char.isspace() for char in text) and "\x7f" not in text,
            f"{label} must be an HTTPS URL without credentials, query or fragment")
    try:
        require(parsed.port is None or 1 <= parsed.port <= 65535, f"Invalid {label} port")
    except ValueError:
        require(False, f"Invalid {label} port")
    return text.rstrip("/") if base else text


def validate_gateway(params: dict, current: dict) -> dict:
    from .provider import small_text
    require("apiKey" not in params and "allowInsecureHttp" not in params, "ChatGPT gateway uses separate native ChatGPT and gateway OAuth credentials")
    oauth = params.get("gatewayOAuth")
    require(isinstance(oauth, dict) and {"authorizationUrl", "tokenUrl", "clientId", "cookieName"} <= set(oauth) and
            not set(oauth) - {"authorizationUrl", "tokenUrl", "clientId", "cookieName", "redirectPort"}, "Invalid gateway OAuth fields")
    cleaned = {"authorizationUrl": https_url(oauth["authorizationUrl"], "Gateway authorization URL"),
               "tokenUrl": https_url(oauth["tokenUrl"], "Gateway token URL"), "clientId": small_text(oauth["clientId"], "OAuth public client id", 512),
               "cookieName": small_text(oauth["cookieName"], "Gateway cookie name", 128)}
    require("\x7f" not in cleaned["clientId"], "Invalid OAuth public client id")
    require(re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", cleaned["cookieName"]) is not None, "Invalid gateway cookie name")
    if "redirectPort" in oauth:
        require(type(oauth["redirectPort"]) is int and 1024 <= oauth["redirectPort"] <= 65535, "Gateway redirect port must be between 1024 and 65535")
        cleaned["redirectPort"] = oauth["redirectPort"]
    result = {"baseUrl": https_url(params.get("baseUrl"), "Gateway Responses URL", base=True), "gatewayOAuth": cleaned}
    changed = current.get("kind") != "chatgpt-gateway" or any(result[key] != current.get(key) for key in result)
    if "confirmGatewayCredentials" in params:
        require(type(params["confirmGatewayCredentials"]) is bool, "Gateway credential confirmation must be a boolean")
    require(not changed or params.get("confirmGatewayCredentials") is True,
            "Confirm that ChatGPT credentials and requests may be sent through the selected gateway and OAuth targets", "confirmation_required")
    return result


def definition(value: dict) -> dict:
    oauth = value["gatewayOAuth"]
    policy = {"authorization_url": oauth["authorizationUrl"], "token_url": oauth["tokenUrl"], "client_id": oauth["clientId"],
              "delivery": {"kind": "cookie", "name": oauth["cookieName"]}}
    if "redirectPort" in oauth: policy["redirect_port"] = oauth["redirectPort"]
    return {"name": "ChatGPT through managed gateway", "base_url": value["baseUrl"], "wire_api": "responses",
            "requires_openai_auth": True, "supports_websockets": True, "gateway_oauth": policy}
