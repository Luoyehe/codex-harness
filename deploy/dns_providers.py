"""Reviewed DNS provider schemas shared by credentials, rendering and guidance."""
from __future__ import annotations

from dataclasses import dataclass
import re
from types import MappingProxyType

from .common import require


@dataclass(frozen=True)
class CredentialField:
    name: str
    caddy_name: str
    environment: str
    kind: str = "secret"

    def accepts(self, value) -> bool:
        if not isinstance(value, str):
            return False
        if self.kind == "region":
            return len(value) <= 64 and bool(re.fullmatch(r"[a-z]{2}(?:-[a-z0-9]+)+-[0-9]{1,2}", value))
        return bool(re.fullmatch(r"[A-Za-z0-9/_.+=-]{8,256}", value))


@dataclass(frozen=True)
class DnsProvider:
    label: str
    fields: tuple[CredentialField, ...]
    credential_description: str
    documentation: str


PROVIDERS = MappingProxyType({
    "alidns": DnsProvider("Alibaba Cloud DNS (AliDNS)", (
        CredentialField("accessKeyId", "access_key_id", "HARNESS_ALIDNS_ACCESS_KEY_ID"),
        CredentialField("accessKeySecret", "access_key_secret", "HARNESS_ALIDNS_ACCESS_KEY_SECRET"),
    ), "A dedicated RAM AccessKey with DNS discovery and challenge record permissions.",
        "https://help.aliyun.com/zh/dns/alibaba-cloud-dns-custom-permission-policy-reference-dns"),
    "tencentcloud": DnsProvider("Tencent Cloud DNSPod", (
        CredentialField("secretId", "secret_id", "HARNESS_TENCENTCLOUD_SECRET_ID"),
        CredentialField("secretKey", "secret_key", "HARNESS_TENCENTCLOUD_SECRET_KEY"),
    ), "Tencent Cloud CAM SecretId/SecretKey for DNSPod; legacy DNSPod ID/Token credentials are not accepted.",
        "https://cloud.tencent.com/document/product/302/105690"),
    "cloudflare": DnsProvider("Cloudflare", (
        CredentialField("apiToken", "api_token", "HARNESS_CLOUDFLARE_API_TOKEN"),
    ), "An API Token with Zone Read and DNS Edit scoped to the intended zone; not a Global API Key.",
        "https://developers.cloudflare.com/fundamentals/api/get-started/create-token/"),
    "huaweicloud": DnsProvider("Huawei Cloud DNS", (
        CredentialField("accessKeyId", "access_key_id", "HARNESS_HUAWEICLOUD_ACCESS_KEY_ID"),
        CredentialField("secretAccessKey", "secret_access_key", "HARNESS_HUAWEICLOUD_SECRET_ACCESS_KEY"),
    ), "An IAM access key (AK/SK) with public-zone discovery and record-set permissions; this integration uses the pinned cn-south-1 DNS endpoint.",
        "https://support.huaweicloud.com/api-dns/Permission.html"),
    "route53": DnsProvider("Amazon Route 53", (
        CredentialField("accessKeyId", "access_key_id", "HARNESS_ROUTE53_ACCESS_KEY_ID"),
        CredentialField("secretAccessKey", "secret_access_key", "HARNESS_ROUTE53_SECRET_ACCESS_KEY"),
        CredentialField("region", "region", "HARNESS_ROUTE53_REGION", "region"),
    ), "Explicit IAM access key and region (for example us-east-1); host IAM roles, profiles and temporary session credentials are not imported.",
        "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/specifying-conditions-route53.html"),
    "digitalocean": DnsProvider("DigitalOcean DNS", (
        CredentialField("apiToken", "api_token", "HARNESS_DIGITALOCEAN_API_TOKEN"),
    ), "A Personal Access Token with the required domain read/create/delete scopes.",
        "https://docs.digitalocean.com/reference/api/scopes/"),
})


def dns_provider(name: str) -> DnsProvider:
    require(isinstance(name, str) and name in PROVIDERS, "Unknown DNS validation provider")
    return PROVIDERS[name]


def credential_fields(name: str) -> dict[str, str]:
    return {field.name: field.environment for field in dns_provider(name).fields}


def provider_guidance(name: str) -> dict:
    provider = dns_provider(name)
    return {"name": name, "label": provider.label, "credentialFields": [field.name for field in provider.fields],
            "credentials": provider.credential_description, "documentation": provider.documentation,
            "credentialFile": "Absolute UTF-8 JSON file, root-owned mode 0600; never put values in argv or logs."}


def caddy_dns_block(name: str) -> str:
    provider = dns_provider(name)
    lines = "".join(f"                {field.caddy_name} {{env.{field.environment}}}\n" for field in provider.fields)
    return f"            dns {name} {{\n" + lines + "            }\n"
