"""Fixed AWS endpoints and root-managed bearer auth for native Bedrock providers."""
from __future__ import annotations

import re

from .common import Layout, require

KINDS = {"bedrock-runtime": "amazon-bedrock-runtime", "bedrock-mantle": "amazon-bedrock"}


def validate_bedrock(params: dict, current: dict) -> dict:
    from .provider import small_text
    require(not {"baseUrl", "allowInsecureHttp", "gatewayOAuth", "confirmGatewayCredentials"} & set(params),
            "Bedrock uses fixed regional AWS endpoints and managed bearer credentials")
    region = small_text(params.get("region"), "AWS region", 64)
    require(re.fullmatch(r"[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+", region) is not None and not region.startswith(("cn-", "us-gov-", "us-iso")),
            "Select a commercial AWS region; other partitions require an operator-controlled configuration")
    unchanged = params["kind"] == current.get("kind") and region == current.get("region")
    key = params.get("apiKey", current.get("apiKey") if unchanged else None)
    key = small_text(key, "Bedrock bearer token", 8192)
    require(key == key.strip() and "\x7f" not in key, "Invalid Bedrock bearer token")
    return {"region": region, "apiKey": key}


def definition(value: dict, layout: Layout) -> dict:
    region = value["region"]
    host = f"bedrock-runtime.{region}.amazonaws.com" if value["kind"] == "bedrock-runtime" else f"bedrock-mantle.{region}.api.aws"
    # The pinned builtin accepts only selected override fields. Requirements
    # replace this complete table, so user aws/profile/header/command values do
    # not merge. The fixed command outranks cached native Bedrock credentials.
    return {"base_url": f"https://{host}/openai/v1", "auth": {
        "command": str(layout.control / "native-launch"), "args": ["bedrock-token"], "timeout_ms": 5000, "refresh_interval_ms": 300000}}


def environment(value: dict) -> dict:
    return {"AWS_BEARER_TOKEN_BEDROCK": value["apiKey"], "AWS_REGION": value["region"]}
