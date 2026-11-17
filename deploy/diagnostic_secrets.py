"""Exact known server-managed secrets for bounded diagnostic redaction."""
from __future__ import annotations
import hashlib
import json
import re
from .common import require
from .safe_fs import bounded_names
from .service_proxy import private_file


def retained_secrets(layout):
    token = (layout.config / "gateway-token").read_text().strip()
    values = [hashlib.sha256(("codex-harness-edge-client-v1\0" + token).encode()).hexdigest()]
    dns = layout.config / "dns"
    if dns.exists():
        for name in bounded_names(dns, 131):
            require(re.fullmatch(r"[0-9a-f]{32}", name), "Unknown DNS credential material", "integrity")
            data = private_file(dns / name / "credentials.env").decode("ascii")
            for line in data.splitlines():
                require("=" in line, "Invalid DNS diagnostic credential source", "integrity")
                values.append(line.split("=", 1)[1])
    configurations = layout.config / "proxy/configurations"
    if configurations.exists():
        def visit(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if key in ("id", "password", "privateKey", "secret") and isinstance(item, str):
                        values.append(item)
                    else:
                        visit(item)
            elif isinstance(value, list):
                for item in value: visit(item)
        for name in bounded_names(configurations, 129):
            require(re.fullmatch(r"[0-9a-f]{64}", name), "Unknown proxy credential material", "integrity")
            visit(json.loads(private_file(configurations / name / "xray.json")))
    return values
