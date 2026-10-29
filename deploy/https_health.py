"""Bounded, read-only TLS and instance-identity checks for the selected edge."""
from __future__ import annotations

import hashlib
import hmac
import http.client
import io
import ipaddress
import json
import math
import os
import re
import secrets
import socket
import ssl
import stat
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from .accounts import instance_proof_key
from .common import DeployError, require
from .https_guidance import certificate_guidance, failure_guidance
from .safe_fs import stable_identity


_DNS_SLOTS = threading.BoundedSemaphore(4)
_MAX_WIRE_BYTES = 32768


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("HTTPS probe deadline expired")
    return remaining


def _addresses(host: str, port: int, deadline: float) -> list:
    """A stuck system resolver cannot hold the probe or grow unlimited threads."""
    try:
        address = ipaddress.ip_address(host)
        return [(socket.AF_INET6 if address.version == 6 else socket.AF_INET, socket.SOCK_STREAM,
                 socket.IPPROTO_TCP, "", (host, port, 0, 0) if address.version == 6 else (host, port))]
    except ValueError:
        pass
    if not _DNS_SLOTS.acquire(blocking=False):
        raise TimeoutError("HTTPS resolver budget exhausted")
    done, result = threading.Event(), []

    def resolve():
        try:
            result.append(socket.getaddrinfo(host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP))
        except OSError:
            result.append(None)
        finally:
            _DNS_SLOTS.release()
            done.set()

    threading.Thread(target=resolve, name="https-probe-dns", daemon=True).start()
    if not done.wait(_remaining(deadline)):
        raise TimeoutError("HTTPS resolver deadline expired")
    if not result[0]:
        raise OSError("HTTPS name resolution failed")
    return result[0][:16]


def _connect(host: str, port: int, deadline: float) -> socket.socket:
    last = None
    for family, kind, protocol, _, address in _addresses(host, port, deadline):
        connection = socket.socket(family, kind, protocol)
        try:
            connection.settimeout(_remaining(deadline))
            connection.connect(address)
            return connection
        except TimeoutError:
            connection.close()
            raise
        except OSError as error:
            last = error
            connection.close()
    raise OSError("HTTPS connection failed") from last


class _DeadlineReader(io.RawIOBase):
    def __init__(self, connection: ssl.SSLSocket, deadline: float):
        super().__init__()
        self.connection, self.deadline, self.budget = connection, deadline, _MAX_WIRE_BYTES

    def readable(self):
        return True

    def readinto(self, buffer):
        require(self.budget > 0, "HTTPS response exceeds budget", "https_response_budget")
        self.connection.settimeout(_remaining(self.deadline))
        data = self.connection.recv(min(len(buffer), self.budget))
        buffer[:len(data)] = data
        self.budget -= len(data)
        return len(data)


class _ResponseSocket:
    def __init__(self, connection: ssl.SSLSocket, deadline: float):
        self.connection, self.deadline = connection, deadline

    def makefile(self, mode):
        return io.BufferedReader(_DeadlineReader(self.connection, self.deadline), buffer_size=4096)


def _ca_data(path: Path) -> str:
    require(path.is_absolute() and not path.is_symlink(), "Unsafe HTTPS CA certificate", "integrity")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 1024 * 1024,
                "Unsafe HTTPS CA certificate", "integrity")
        data = os.read(descriptor, 1024 * 1024 + 1)
        require(stable_identity(info) == stable_identity(os.fstat(descriptor)) and len(data) <= 1024 * 1024,
                "HTTPS CA certificate changed", "integrity")
        require(b"-----BEGIN CERTIFICATE-----" in data and b"PRIVATE KEY-----" not in data,
                "Invalid HTTPS CA certificate", "integrity")
        return data.decode("ascii")
    finally:
        os.close(descriptor)


def _context(manager, metadata: dict, ca_file: Path | None) -> tuple[ssl.SSLContext, str]:
    mode = metadata["tls"]
    require(ca_file is None or mode == "provided", "Explicit CA certificates apply only to provided TLS")
    if mode == "internal":
        ca_file = manager.layout.state / "caddy/.local/share/caddy/pki/authorities/local/root.crt"
        trust = "instance-caddy-ca"
    elif mode == "provided":
        if ca_file is None:
            from .https import tls_ca_path
            ca_file = tls_ca_path(manager.layout, metadata)
        trust = "provided-ca" if ca_file is not None else "system-ca"
    else:
        trust = "system-ca"
    context = ssl.create_default_context(cadata=_ca_data(Path(ca_file))) if ca_file is not None else ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.check_hostname = True
    context.hostname_checks_common_name = False
    context.verify_mode = ssl.CERT_REQUIRED
    return context, trust


def _certificate(connection: ssl.SSLSocket) -> dict:
    certificate = connection.getpeercert()
    expiry = ssl.cert_time_to_seconds(certificate["notAfter"])
    start = ssl.cert_time_to_seconds(certificate["notBefore"])

    def safe(value):
        return isinstance(value, str) and len(value) <= 256 and all(32 <= ord(char) <= 126 for char in value)

    return {"notAfter": datetime.fromtimestamp(expiry, timezone.utc).isoformat(),
            "notBefore": datetime.fromtimestamp(start, timezone.utc).isoformat(),
            "daysRemaining": round((expiry - time.time()) / 86400, 2),
            "issuer": [{"name": name, "value": value} for group in certificate.get("issuer", ()) for name, value in group
                       if name in ("commonName", "organizationName", "organizationalUnitName", "countryName", "stateOrProvinceName", "localityName") and safe(value)][:32],
            "subjectAlternativeNames": [{"type": name, "value": value} for name, value in certificate.get("subjectAltName", ())
                                        if name in ("DNS", "IP Address") and safe(value)][:64]}


def _proof(connection: ssl.SSLSocket, manager, origin: str, host: str, deadline: float) -> None:
    nonce = secrets.token_hex(32)
    expected = hmac.new(instance_proof_key(manager), ("codex-harness-account-proof-v1\0" + origin + "\0" + nonce).encode(), hashlib.sha256).hexdigest()
    request = ("GET /api/account/proof?nonce=" + nonce + " HTTP/1.1\r\nHost: " + host + "\r\nOrigin: " + origin +
               "\r\nAccept: application/json\r\nConnection: close\r\n\r\n").encode("ascii")
    connection.settimeout(_remaining(deadline))
    connection.sendall(request)
    response = http.client.HTTPResponse(_ResponseSocket(connection, deadline))
    try:
        response.begin()
        body = response.read(4097)
        require(response.status == 200 and len(body) <= 4096, "HTTPS instance proof failed", "https_instance_proof")
        value = json.loads(body)
        require(isinstance(value, dict) and value.get("nonce") == nonce and isinstance(value.get("proof"), str) and
                bool(re.fullmatch(r"[0-9a-f]{64}", value["proof"])) and hmac.compare_digest(value["proof"], expected),
                "HTTPS instance proof failed", "https_instance_proof")
    finally:
        response.close()


def https_health(manager, *, connect_address: str | None = None, connect_port: int | None = None,
                 ca_file: Path | None = None, timeout: float = 5.0) -> dict:
    """Return allowlisted diagnostics; never return keys, responses or exception text.

    The origin always selects SNI, Host and Origin. A connection override selects
    only the network route. Every observation originates on the deployment host,
    so even a DNS-routed probe is not an independent public-network acceptance.
    """
    require(type(timeout) in (int, float) and math.isfinite(timeout) and 0 < timeout <= 120, "Invalid HTTPS probe timeout")
    require(connect_address is None or isinstance(connect_address, str) and 0 < len(connect_address) <= 253 and
            not any(char.isspace() or ord(char) < 32 for char in connect_address), "Invalid HTTPS connection address")
    require(connect_port is None or type(connect_port) is int and 1 <= connect_port <= 65535, "Invalid HTTPS connection port")
    deadline = time.monotonic() + timeout
    result = {"configured": False, "ready": False, "tlsVerified": False, "instanceVerified": False,
              "certificate": None, "failure": None, "vantage": {"source": "deployment-host", "independentPublicAcceptance": False,
              "route": "fixed-address" if connect_address is not None else "configured-hostname"}}
    connection = None
    try:
        from .https import browser_origin, domain_name, read_https_metadata
        metadata = read_https_metadata(manager.layout)
        result["configured"] = True
        mode = metadata.get("tls")
        require(mode in ("acme", "internal", "provided"), "Invalid HTTPS mode", "integrity")
        from .dns_tls import validate_dns_selection
        validate_dns_selection(manager.layout, metadata)
        require(metadata.get("authentication") in (None, "builtin"), "Invalid HTTPS authentication mode", "integrity")
        origin = manager.config["origin"]
        parsed = urlsplit(origin)
        require(parsed.scheme == "https" and parsed.hostname == domain_name(metadata["host"]) and not parsed.username and
                not parsed.password and not parsed.path and not parsed.query and not parsed.fragment and parsed.port != 0 and
                origin.isascii() and not any(char.isspace() or ord(char) < 32 for char in origin), "Invalid selected HTTPS origin", "integrity")
        listener = metadata.get("httpsPort", 443)
        require(type(listener) is int and 1 <= listener <= 65535, "Invalid HTTPS listener port", "integrity")
        require(origin == browser_origin(metadata["host"], listener, metadata.get("publicOrigin")),
                "Selected HTTPS origin differs from retained configuration", "integrity")
        port = connect_port if connect_port is not None else listener if connect_address is not None else parsed.port or 443
        result.update({"origin": origin, "tlsMode": mode, "connectionPort": port,
                       **certificate_guidance(tls=mode, dns_provider=metadata.get("dnsProvider"),
                                              http_port=metadata.get("httpPort", 80), https_port=listener)})
        context, trust = _context(manager, metadata, ca_file)
        result["trust"] = trust
        connection = _connect(connect_address or parsed.hostname, port, deadline)
        connection.settimeout(_remaining(deadline))
        connection = context.wrap_socket(connection, server_hostname=parsed.hostname)
        result["certificate"] = _certificate(connection)
        result["tlsVerified"] = True
        if metadata.get("authentication") != "builtin":
            result["failure"] = "legacy_identity_requires_migration"
            result["diagnostics"] = failure_guidance(result)
            return result
        _proof(connection, manager, origin, parsed.netloc, deadline)
        result["instanceVerified"] = result["ready"] = True
    except ssl.SSLCertVerificationError:
        result["failure"] = "certificate_validation_failed"
    except (TimeoutError, socket.timeout):
        result["failure"] = "timeout"
    except DeployError as error:
        result["failure"] = {"not_installed": "not_configured", "https_instance_proof": "instance_proof_failed",
                             "https_response_budget": "response_budget_exceeded"}.get(error.code, "configuration_invalid")
    except (json.JSONDecodeError, UnicodeError, http.client.HTTPException):
        result["failure"] = "instance_proof_failed"
    except ssl.SSLError:
        result["failure"] = "tls_handshake_failed"
    except OSError:
        result["failure"] = "connection_or_trust_unavailable"
    except (ValueError, TypeError, KeyError):
        result["failure"] = "configuration_invalid"
    finally:
        if connection is not None:
            connection.close()
    result["diagnostics"] = failure_guidance(result)
    return result


def require_https_ready(manager, *, timeout: float = 30.0, connect_address: str = "127.0.0.1",
                        connect_port: int | None = None, ca_file: Path | None = None) -> dict:
    """Wait only for read-only proof checks, bounded across every retry."""
    require(type(timeout) in (int, float) and math.isfinite(timeout) and 0 < timeout <= 300, "Invalid HTTPS readiness timeout")
    deadline = time.monotonic() + timeout
    last = None
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        last = https_health(manager, connect_address=connect_address, connect_port=connect_port,
                            ca_file=ca_file, timeout=min(5.0, remaining))
        if last["ready"]:
            return last
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(0.25, remaining))
    failure = last["failure"] if last is not None else "timeout"
    hints = " ".join(last.get("diagnostics", [])) if last is not None else "Inspect status and logs --service caddy."
    raise DeployError("https_health", "HTTPS readiness failed (" + failure + "). " + hints)
