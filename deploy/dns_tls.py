"""Immutable DNS-01 credentials; only the edge service receives their values."""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
import uuid
from pathlib import Path

from .common import DeployError, atomic_write, mkdir, require
from .dns_providers import PROVIDERS, credential_fields, dns_provider
from .safe_fs import stable_identity

# Keep the original AliDNS public helpers and byte order for retained generations.
FIELDS = credential_fields("alidns")
SELECTION_FIELDS = ("dnsProvider", "dnsCredentialsRevision", "dnsCredentialsSha256", "dnsBinaryRevision", "dnsBinarySha256")


def _read_private(path: Path) -> bytes:
    require(path.is_absolute() and not path.is_symlink(), "DNS credentials require an absolute regular file", "invalid_input")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 4096 and
                (os.name != "posix" or info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600),
                "DNS credentials must be a root-owned mode 0600 regular file", "integrity")
        data = os.read(fd, 4097)
        require(len(data) <= 4096 and len(data) == info.st_size and
                stable_identity(info) == stable_identity(os.fstat(fd)), "DNS credentials changed while reading", "integrity")
        return data
    finally:
        os.close(fd)


def read_dns_credentials(path: Path, provider: str = "alidns") -> bytes:
    schema = dns_provider(provider)
    fields = credential_fields(provider)
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate DNS credential field", "invalid_input")
            result[key] = value
        return result

    try:
        value = json.loads(_read_private(path).decode("utf-8"), object_pairs_hook=unique)
    except (ValueError, UnicodeError) as exc:
        raise DeployError("invalid_input", "DNS credentials must be a UTF-8 JSON object") from exc
    require(isinstance(value, dict) and set(value) == set(fields),
            schema.label + " credentials require exactly: " + ", ".join(fields), "invalid_input")
    # Restrict the alphabet so systemd EnvironmentFile and the validator agree;
    # no quoting, interpolation, newline or shell syntax is accepted.
    require(all(field.accepts(value[field.name]) for field in schema.fields),
            "Invalid DNS credential value", "invalid_input")
    return "".join(fields[key] + "=" + value[key] + "\n" for key in fields).encode("ascii")


def stage_dns_credentials(layout, data: bytes) -> dict:
    root = layout.config / "dns"
    mkdir(root, 0o700, 0, 0)
    require(len(list(root.iterdir())) < 130, "DNS credential generations reached retention budget", "budget")
    revision = uuid.uuid4().hex
    directory = root / revision
    require(not directory.exists() and not directory.is_symlink(), "DNS generation collision", "collision")
    mkdir(directory, 0o700, 0, 0)
    atomic_write(directory / "credentials.env", data, 0o600, 0, 0)
    return {"dnsCredentialsRevision": revision, "dnsCredentialsSha256": hashlib.sha256(data).hexdigest()}


def dns_credentials_path(layout, metadata: dict) -> Path:
    require(isinstance(metadata.get("dnsProvider"), str) and metadata["dnsProvider"] in PROVIDERS and metadata.get("tls") == "acme" and
            metadata.get("authentication") == "builtin", "Invalid DNS TLS selection", "integrity")
    revision = metadata.get("dnsCredentialsRevision")
    require(isinstance(revision, str) and re.fullmatch(r"[0-9a-f]{32}", revision), "Invalid DNS credential revision", "integrity")
    root = layout.config / "dns"
    for directory in (root, root / revision):
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and (os.name != "posix" or info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700),
                "Unsafe DNS credential directory", "integrity")
    path = root / revision / "credentials.env"
    data = _read_private(path)
    require(hashlib.sha256(data).hexdigest() == metadata.get("dnsCredentialsSha256"), "Retained DNS credentials changed", "integrity")
    _environment(data, metadata["dnsProvider"])
    return path


def _environment(data: bytes, provider: str = "alidns") -> dict[str, str]:
    schema = dns_provider(provider)
    try:
        lines = data.decode("ascii").splitlines()
        values = dict(line.split("=", 1) for line in lines)
    except (UnicodeError, ValueError) as exc:
        raise DeployError("integrity", "Invalid managed DNS credentials") from exc
    require(len(lines) == len(schema.fields) and set(values) == {field.environment for field in schema.fields} and
            all(field.accepts(values[field.environment]) for field in schema.fields),
            "Invalid managed DNS credentials", "integrity")
    return values


def validate_dns_selection(layout, metadata: dict) -> None:
    if metadata.get("dnsProvider") is None:
        require(not any(key in metadata for key in SELECTION_FIELDS), "Incomplete DNS TLS selection", "integrity")
        return
    dns_credentials_path(layout, metadata)
    from .dns_caddy_build import dns_caddy_path
    dns_caddy_path(layout, metadata)


def dns_unit_settings(layout, metadata: dict) -> tuple[Path, Path]:
    # This is deterministic rendering, not file validation: recovery must be
    # able to recognize an owned unit even when its selected material is broken.
    require(isinstance(metadata.get("dnsProvider"), str) and metadata["dnsProvider"] in PROVIDERS and metadata.get("authentication") == "builtin" and
            metadata.get("tls") == "acme", "Invalid DNS TLS selection", "integrity")
    binary, credentials = metadata.get("dnsBinaryRevision"), metadata.get("dnsCredentialsRevision")
    require(isinstance(binary, str) and re.fullmatch(r"[0-9a-f]{64}", binary) and isinstance(credentials, str) and
            re.fullmatch(r"[0-9a-f]{32}", credentials), "Invalid DNS TLS revisions", "integrity")
    return (layout.control / "edge/caddy/dns" / binary / "caddy",
            layout.config / "dns" / credentials / "credentials.env")


def validate_dns_caddy(layout, metadata: dict, binary: Path, config: Path, uid: int, gid: int) -> None:
    credentials = _environment(_read_private(dns_credentials_path(layout, metadata)), metadata.get("dnsProvider", "alidns"))
    environment = {"PATH": "/usr/bin:/bin", "HOME": str(layout.state / "caddy"), "LANG": "C.UTF-8", **credentials}
    # Values travel only in the child's environment, never argv or output.
    try:
        result = subprocess.run(["/usr/bin/setpriv", "--reuid", str(uid), "--regid", str(gid), "--clear-groups", "--no-new-privs",
                                 str(binary), "validate", "--config", str(config), "--adapter", "caddyfile"],
                                env=environment, cwd="/", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                close_fds=True, timeout=120, check=False)
    except subprocess.TimeoutExpired as exc:
        raise DeployError("command_failed", "DNS Caddy validation timed out") from exc
    require(result.returncode == 0, "DNS Caddy configuration validation failed", "command_failed")
