"""Declarative certificate requirements; no network, credentials or host changes."""
from __future__ import annotations

from urllib.parse import urlsplit

from .common import require
from .edge_defaults import DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT
from .dns_providers import PROVIDERS, dns_provider as provider_schema, provider_guidance


def certificate_guidance(*, tls: str, dns_provider: str | None, http_port: int, https_port: int) -> dict:
    require(tls in ("acme", "internal", "provided"), "Unknown TLS mode")
    require(dns_provider is None or isinstance(dns_provider, str) and dns_provider in (*PROVIDERS, "none"), "Unknown DNS validation provider")
    dns_provider = None if dns_provider == "none" else dns_provider
    require(dns_provider is None or tls == "acme", "DNS validation applies only to ACME TLS")
    require(type(http_port) is int and type(https_port) is int and
            1 <= http_port <= 65535 and 1 <= https_port <= 65535 and http_port != https_port,
            "HTTP and HTTPS listener ports must be valid and distinct")
    routes = []
    if tls == "acme" and dns_provider is None:
        challenge = "http-01-or-tls-alpn-01"
        routes = [{"challenge": "http-01", "publicPort": 80, "localPort": http_port, "transport": "tcp"},
                  {"challenge": "tls-alpn-01", "publicPort": 443, "localPort": https_port, "transport": "tcp"}]
        requirement = (f"At least one public validation route must reach Caddy: TCP 80 to local {http_port} "
                       f"for HTTP-01, or TCP 443 to local {https_port} with TLS passthrough for TLS-ALPN-01. "
                       "A high browser port does not replace public ACME validation ports. "
                       "If both public ports are blocked, select a supported DNS-01 provider or operator-managed certificates.")
        renewal_requirements = ["Keep the domain's A/AAAA records and at least one public validation route working.",
                                "Keep Caddy running, its data directory persistent and writable, and outbound DNS/HTTPS available."]
    elif tls == "acme":
        challenge = "dns-01"
        label = provider_schema(dns_provider).label
        requirement = ("The authoritative DNS zone must be managed by the selected " + label + " account. Caddy creates and removes "
                       "temporary _acme-challenge TXT records through its retained DNS API credentials. Public inbound 80/443 "
                       "are not required for validation; outbound DNS, the provider API and CA HTTPS access are required.")
        renewal_requirements = ["Keep the selected DNS API credentials active with the required zone permissions.",
                                "Keep Caddy running, its data directory persistent and writable, and outbound DNS/HTTPS available.",
                                "A working cached certificate does not validate a new DNS key; confirm API permissions and later issuance/renewal logs."]
    elif tls == "internal":
        challenge = None
        requirement = "Caddy uses this instance's local CA; each client must explicitly trust it. This is not public CA trust."
        renewal_requirements = ["Keep Caddy running and its local CA and certificate data persistent and writable.",
                                "Keep this instance's CA trusted on the intended clients."]
    else:
        challenge = None
        requirement = "Provide a matching certificate and private key valid for the hostname and the selected trust store."
        renewal_requirements = ["The operator must renew and replace both PEM files through the managed HTTPS command before expiry."]
    return {
        "validation": {"challenge": challenge, "dnsProvider": dns_provider, "publicRoutes": routes,
                       "requiredPublicRoutes": "at-least-one" if routes else "none",
                       "requirements": requirement, "publicReachabilityVerified": False,
                       "dnsApiAccessVerified": False if dns_provider else None,
                       "provider": provider_guidance(dns_provider) if dns_provider else None},
        "renewal": {"manager": "operator" if tls == "provided" else "caddy", "automatic": tls != "provided",
                    "challenge": challenge, "dnsProvider": dns_provider, "mechanism": tls,
                    "futureSuccessVerified": False, "evidence": "configuration-only",
                    "requirements": renewal_requirements},
    }


def https_plan(*, host: str, tls: str = "acme", dns_provider: str | None = None,
               http_port: int = DEFAULT_HTTP_PORT, https_port: int = DEFAULT_HTTPS_PORT,
               public_origin: str | None = None) -> dict:
    from .https import browser_origin, domain_name
    domain_name(host)
    guidance = certificate_guidance(tls=tls, dns_provider=dns_provider, http_port=http_port, https_port=https_port)
    origin = browser_origin(host, https_port, public_origin)
    return {"planOnly": True, "configuredInstanceInspected": False, "networkChecksPerformed": False,
            "credentialsChecked": False, "certificateIssuanceProven": False,
            "origin": origin, "tlsMode": tls,
            "listeners": {"httpPort": http_port, "httpsPort": https_port},
            "browserIngress": {"publicPort": urlsplit(origin).port or 443, "localTlsPort": https_port,
                               "transport": "tcp", "requirements": "Point browser DNS at the actual ingress and route the public browser port to Caddy."},
            **guidance,
            "acceptance": "After activation, open this origin from another network and verify browser certificate trust and administrator login.",
            "existingInstance": "This plan uses only supplied options. Read https-read before changing an existing instance; address, mode or DNS-provider changes require https-migrate."}


def failure_guidance(result: dict) -> list[str]:
    failure = result.get("failure")
    if not failure:
        return []
    messages = {
        "not_configured": "Configure HTTPS first; use https-plan to inspect certificate requirements without changing the instance.",
        "configuration_invalid": "Inspect https-read and verify the retained HTTPS configuration and protected certificate/DNS generations.",
        "certificate_validation_failed": "Check the certificate hostname/SAN, validity period and trust chain; do not bypass TLS verification.",
        "instance_proof_failed": "Check the reverse-proxy target and selected origin; the response did not prove this instance.",
        "legacy_identity_requires_migration": "TLS passed, but the legacy identity gate requires migration to built-in authentication.",
        "response_budget_exceeded": "Check the reverse-proxy target; its response exceeded the bounded instance-proof budget.",
    }
    guidance = [messages.get(failure, "Check the Caddy listener, port conflicts and service state.")]
    if result.get("tlsMode") == "acme" and not result.get("tlsVerified"):
        requirements = result.get("validation", {}).get("requirements")
        if requirements:
            guidance.append(requirements)
        guidance.append("Check Caddy logs for the exact CA/DNS error, including authorization, propagation, CAA policy or rate limits; correct it before retrying.")
    guidance.append("Inspect status and logs --service caddy --lines 100. Local readiness is not independent public-network acceptance.")
    return guidance
