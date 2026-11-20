"""Exact known server-managed secrets for bounded diagnostic redaction."""
from __future__ import annotations
import hashlib
import json
import re
from .common import DeployError, read_json, require
from .dns_providers import PROVIDERS
from .safe_fs import bounded_names
from .service_proxy import private_file


def retained_secrets(layout):
    token = (layout.config / "gateway-token").read_text().strip()
    values = [hashlib.sha256(("codex-harness-edge-client-v1\0" + token).encode()).hexdigest()]
    from .accounts import probe_signature
    key = hashlib.sha256(token.encode()).digest()
    values.extend(probe_signature(key, route) for route in ("/health", "/api/account/proof"))
    dns = layout.config / "dns"
    if dns.exists():
        for name in bounded_names(dns, 131):
            require(re.fullmatch(r"[0-9a-f]{32}", name), "Unknown DNS credential material", "integrity")
            data = private_file(dns / name / "credentials.env").decode("ascii")
            for line in data.splitlines():
                require("=" in line, "Invalid DNS diagnostic credential source", "integrity")
                key, value = line.split("=", 1)
                public = next((field for provider in PROVIDERS.values() for field in provider.fields
                               if field.environment == key and field.kind == "region"), None)
                if public is None or not public.accepts(value):
                    values.append(value)
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


def log_result(layout, provider_root, text):
    from .provider_lifecycle import Profiles
    from .provider_registry import entries
    known = []
    unreadable = []
    errors = (DeployError, OSError, ValueError, KeyError, TypeError)
    try:
        known.append((layout.config / "gateway-token").read_text().strip())
        known.extend(retained_secrets(layout))
    except errors:
        unreadable.append("本机凭据索引")
    try:
        for profile in Profiles(layout).records():
            known.extend(row["settings"].get("apiKey") for row in entries(profile["settings"]))
    except errors:
        unreadable.append("已保存的供应商配置档")
    try:
        for name in bounded_names(provider_root, 132):
            if not re.fullmatch(r"[0-9a-f]{32}", name):
                continue
            try:
                generation = read_json(provider_root / name / "settings.json", 4 * 1024 * 1024)
                known.extend(row["settings"].get("apiKey") for row in entries(generation))
            except errors:
                unreadable.append("提供商代际 " + name)
    except errors:
        unreadable.append("提供商代际索引")
    if unreadable:
        # Without a complete credential inventory arbitrary log lines cannot
        # safely be quoted, even if the currently selected credentials are known.
        codes = re.findall(r"(?i)\b(?:http_status|statuscode|status)\s*[:=]\s*([1-5]\d\d)\b", text)
        summary = "本次日志共 " + str(len(text.splitlines())) + " 行。"
        if codes:
            from collections import Counter
            summary += "HTTP 状态统计：" + "，".join(code + " × " + str(count) for code, count in sorted(Counter(codes).items())) + "。"
        return {"text": summary + "原文已保留在服务日志中。",
                "truncated": False, "redactionNotice": "无法完整核对脱敏来源：" + "、".join(unreadable) + "。修复该来源后可重新读取。"}
    for secret in sorted({item for item in known if isinstance(item, str) and item}, key=len, reverse=True):
        if len(secret) >= 8:
            text = text.replace(secret, "[redacted]")
        else:
            # Short historical credentials should not destroy longer, unrelated
            # identifiers or timestamps. An exact token remains confidential.
            # A complete diagnostic field or an embedded IP octet can be
            # identified as public; protect standalone credentials everywhere else.
            pattern = re.compile(r"(?<![\w])" + re.escape(secret) + r"(?![\w])")
            def redact(match):
                left, right = text[max(0, match.start() - 48):match.start()], text[match.end():match.end() + 24]
                if re.search(r"(?i)\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*(?:bearer\s+)?$", left):
                    return "[redacted]"
                if secret.isdecimal() and re.search(r"\b[a-z]{2}(?:-[a-z][a-z0-9]*)+-$", left):
                    return match.group()
                if re.search(r"(?i)\b(?:status|http_status|statuscode|exitcode|port|pid|count|attempt)[\s\x22]*[:=][\s\x22]*$", left):
                    return match.group()
                if secret.isdecimal() and (re.search(r"\d[.:/-]$", left) or re.match(r"[.:/-]\d", right)):
                    return match.group()
                return "[redacted]"
            text = pattern.sub(redact, text)
    return {"text": text[-131072:], "truncated": len(text) > 131072, "redactionNotice": "已按凭据来源和短值边界遮蔽日志。"}
