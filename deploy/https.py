"""Caddy HTTPS for built-in accounts, with reversible legacy identity migration."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import stat
import urllib.request
import uuid
from pathlib import Path

from .build import architecture
from .common import DeployError, Layout, atomic_write, canonical, fsync_directory, mkdir, read_json, require, write_json
from .install import ensure_account
from .safe_fs import extract_tar, stable_identity
from .system import run
from .units import render_units, render_edge_units
from .ownership import require_owned, regular, present
from .accounts import verify_account_login

CADDY_VERSION = "2.11.7"
EDGE_HASHES = {
    ("caddy", "amd64"): "727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b",
    ("caddy", "arm64"): "d8fc6d179a5d283028a472a5618564f6ad8a86fed513e64f032b3b0b7cc45e42",
}


def domain_name(value: str) -> str:
    require(isinstance(value, str) and len(value) <= 253 and bool(re.fullmatch(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", value)),
            "A lowercase DNS hostname is required")
    return value


def site_origin(host: str, port: int) -> str:
    require(type(port) is int and 1 <= port <= 65535, "Invalid HTTPS port")
    return "https://" + host + (":" + str(port) if port != 443 else "")


def render_caddy(host: str, auth_host: str | None, gateway_port: int, auth_port: int, *, tls: str = "acme",
                 http_port: int = 80, https_port: int = 443, certificate: str | None = None, private_key: str | None = None) -> str:
    domain_name(host)
    if auth_host is not None:
        domain_name(auth_host)
    require(type(gateway_port) is int and 1024 <= gateway_port <= 65535, "Invalid gateway port")
    require(tls in ("acme", "internal", "provided"), "Unknown TLS mode")
    require(type(http_port) is int and 1 <= http_port <= 65535 and http_port != https_port, "Invalid HTTP port")
    tls_line = ""
    if tls == "internal":
        tls_line = "    tls internal\n"
    elif tls == "provided":
        require(certificate is not None and private_key is not None and
                all(re.fullmatch(r"/[a-zA-Z0-9/_.-]+", path) for path in (certificate, private_key)), "Invalid managed TLS paths")
        tls_line = f"    tls {certificate} {private_key}\n"
    trust_line = "    skip_install_trust\n" if tls == "internal" else ""
    if auth_host is None:
        return f"""{{
    admin off
    http_port {http_port}
    https_port {https_port}
{trust_line}}}
{site_origin(host, https_port)} {{
{tls_line}    route {{
        request_header -Remote-User
        request_header -Remote-Groups
        request_header -Remote-Email
        request_header -Remote-Name
        reverse_proxy 127.0.0.1:{gateway_port}
    }}
}}
"""
    return f"""{{
    admin off
    http_port {http_port}
    https_port {https_port}
{trust_line}}}
{site_origin(auth_host, https_port)} {{
{tls_line}    reverse_proxy 127.0.0.1:{auth_port}
}}
{site_origin(host, https_port)} {{
{tls_line}    route {{
        request_header -Remote-User
        request_header -Remote-Groups
        request_header -Remote-Email
        request_header -Remote-Name
        forward_auth 127.0.0.1:{auth_port} {{
            uri /api/authz/forward-auth
            copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
        }}
        reverse_proxy 127.0.0.1:{gateway_port}
    }}
}}
"""


def edge_binary(layout: Layout, kind: str) -> Path:
    require(kind == "caddy", "Only Caddy is provisioned for built-in account authentication")
    arch = "amd64" if architecture() == "x64" else "arm64"
    root = layout.control / "edge" / kind
    target = root / kind
    manifest_path = layout.config / (kind + "-binary.json")
    if target.exists():
        require(not target.is_symlink() and target.stat().st_uid == 0 and not target.stat().st_mode & 0o022,
                "Unsafe edge binary", "integrity")
        require(hashlib.sha256(target.read_bytes()).hexdigest() == read_json(manifest_path)["sha256"], "Edge binary changed", "integrity")
        return target
    version = CADDY_VERSION
    asset = f"caddy_{version}_linux_{arch}.tar.gz"
    repository = "caddyserver/caddy"
    url = f"https://github.com/{repository}/releases/download/v{version}/{asset}"
    archive = layout.work / asset
    require(not archive.exists() and not root.exists(), "Partial edge preparation retained; inspect before retry", "recovery_required")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    sha = hashlib.sha256()
    total = 0
    with opener.open(url, timeout=60) as response, archive.open("xb") as output:
        require(response.url.startswith(("https://github.com/", "https://release-assets.githubusercontent.com/")), "Unexpected edge download origin")
        while data := response.read(1024**2):
            total += len(data)
            require(total <= 256 * 1024**2, "Edge download exceeds budget", "budget")
            output.write(data)
            sha.update(data)
    require(sha.hexdigest() == EDGE_HASHES[kind, arch], "Official edge distribution hash mismatch", "integrity")
    mkdir(root.parent)
    extract_tar(archive, root)
    require(target.is_file() and not target.is_symlink(), "Expected edge executable absent", "integrity")
    write_json(manifest_path, {"version": version, "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
    return target


def read_pem(path: Path, *, private: bool) -> bytes:
    require(path.is_absolute(), "TLS material paths must be absolute")
    resolved = path.resolve(strict=True)
    descriptor = os.open(resolved, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        import stat
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_size <= 1024 * 1024, "Invalid TLS material file")
        data = os.read(descriptor, 1024 * 1024 + 1)
        require(stable_identity(os.fstat(descriptor)) == stable_identity(before) and len(data) <= 1024 * 1024, "TLS material changed during import")
    finally:
        os.close(descriptor)
    marker = b"PRIVATE KEY-----" if private else b"-----BEGIN CERTIFICATE-----"
    require(marker in data, "Expected PEM TLS material")
    return data


EDGE_ROLES = ("worker", "gateway", "authelia", "caddy")


def transaction_paths(layout: Layout) -> dict[str, Path]:
    return {"instance": layout.config / "instance.json", "metadata": layout.config / "https.json",
            "caddyConfig": layout.config / "Caddyfile",
            **{role: layout.units / layout.unit(role) for role in EDGE_ROLES}}


def snapshot_configuration(layout: Layout) -> dict:
    result = {}
    for name, path in transaction_paths(layout).items():
        if not path.exists() and not path.is_symlink():
            require(name in ("caddyConfig", "authelia", "caddy"), "Required configuration is absent", "recovery_required")
            result[name] = None
            continue
        details = path.lstat()
        require(stat.S_ISREG(details.st_mode) and details.st_size <= 1024 * 1024 and
                (os.name != "posix" or details.st_uid == 0 and not details.st_mode & 0o022),
                "Unsafe managed HTTPS configuration", "integrity")
        result[name] = {"data": base64.b64encode(path.read_bytes()).decode(), "mode": stat.S_IMODE(details.st_mode)}
    require(len(canonical(result)) <= 512 * 1024, "HTTPS recovery snapshot exceeds budget", "budget")
    return result


def prior_service_state(manager) -> tuple[list[str], list[str]]:
    active, enabled = [], []
    for role in EDGE_ROLES:
        unit = manager.layout.unit(role)
        state = manager.system.state(unit)
        running = state["ActiveState"] == "active" and state["SubState"] == "running" and state["MainPID"] != "0" and state["ControlPID"] == "0"
        require(state["stopped"] or running, "HTTPS requires stable prior service state", "stop_unknown")
        if running:
            active.append(role)
        if (manager.layout.units / unit).exists():
            result = run(["/usr/bin/systemctl", "is-enabled", unit], check=False)
            require(result.stdout.strip() in ("enabled", "disabled") and result.returncode == (0 if result.stdout.strip() == "enabled" else 1),
                    "Cannot preserve HTTPS service enablement", "stop_unknown")
            if result.stdout.strip() == "enabled":
                enabled.append(role)
    return active, enabled


def confirm_service_state(manager, active: list[str]) -> None:
    if "gateway" in active and "worker" in active:
        manager.healthy()
    for role in EDGE_ROLES:
        state = manager.system.state(manager.layout.unit(role))
        if role in active:
            require(state["ActiveState"] == "active" and state["SubState"] == "running" and state["MainPID"] != "0",
                    "HTTPS service restoration was not confirmed", "health")
        else:
            require(state["stopped"], "Previously stopped HTTPS service is running", "health")


def recovery_barriers(manager, active: list[str] | None = None) -> Path:
    """Persist separate Conditions; never reuse control-update's markers."""
    layout = manager.layout
    barriers = layout.config / "https-recovery"
    dropins = []
    for role in EDGE_ROLES:
        directory = layout.units / (layout.unit(role) + ".d")
        require(not directory.is_symlink() and (not directory.exists() or directory.is_dir()),
                "Unsafe HTTPS recovery drop-in directory", "ownership_conflict")
        path = directory / "91-codex-harness-https-recovery.conf"
        content = f"[Unit]\nConditionPathExists=!{barriers / role}\n".encode()
        if present(path):
            regular(path, {content})
        dropins.append((directory, path, content))
    mkdir(barriers, 0o700)
    for role in EDGE_ROLES:
        if active is not None and role in active:
            (barriers / role).unlink(missing_ok=True)
        else:
            atomic_write(barriers / role, b"HTTPS recovery pending\n")
    fsync_directory(barriers)
    for directory, path, content in dropins:
        mkdir(directory, 0o755)
        if not present(path):
            atomic_write(path, content, 0o644)
    manager.system.reload()
    return barriers


def recover_https_transaction(manager, journal_path: Path, journal: dict) -> None:
    """Restore only fixed configuration paths after every involved cgroup stops."""
    paths = transaction_paths(manager.layout)
    before = journal.get("before")
    active, enabled = journal.get("active"), journal.get("enabled")
    require(journal.get("kind") == "https" and isinstance(before, dict) and set(before) == set(paths) and
            isinstance(active, list) and isinstance(enabled, list) and set(active) <= set(EDGE_ROLES) and set(enabled) <= set(EDGE_ROLES),
            "Invalid HTTPS recovery record", "corrupt_state")
    decoded = {}
    for name, value in before.items():
        if value is None:
            require(name in ("caddyConfig", "authelia", "caddy"), "Missing required HTTPS snapshot", "corrupt_state")
            decoded[name] = None
        else:
            require(isinstance(value, dict) and set(value) == {"data", "mode"} and type(value["mode"]) is int and
                    0 <= value["mode"] <= 0o777 and (os.name != "posix" or not value["mode"] & 0o022),
                    "Invalid HTTPS snapshot permissions", "corrupt_state")
            data = base64.b64decode(value["data"], validate=True)
            require(len(data) <= 1024 * 1024, "HTTPS snapshot exceeds budget", "corrupt_state")
            decoded[name] = data
    old_config = json.loads(decoded["instance"])
    candidate_config = journal.get("candidateConfig")
    if candidate_config is None:
        # Pre-gate journals may have crashed after writing a new unit but before
        # instance.json. Their retained HTTPS metadata identifies that origin.
        metadata = read_json(manager.layout.config / "https.json")
        candidate_config = {**old_config, "origin": site_origin(metadata["host"], metadata.get("httpsPort", 443))}
    require(isinstance(candidate_config, dict) and {key: value for key, value in candidate_config.items() if key != "origin"} ==
            {key: value for key, value in old_config.items() if key != "origin"}, "Invalid HTTPS candidate configuration", "corrupt_state")
    require_owned(manager.layout, candidate_config, prior_units={role: decoded[role] for role in EDGE_ROLES})
    barriers = recovery_barriers(manager)
    manager.system.stop([manager.layout.unit(role) for role in EDGE_ROLES])
    manager.recover_control()
    journal["phase"] = "recovering"
    write_json(journal_path, journal)
    # Remove any enablement created by a partially completed enable command while
    # candidate unit files still exist. Restore the exact earlier set below.
    present = [manager.layout.unit(role) for role in EDGE_ROLES if paths[role].exists()]
    if present:
        run(["/usr/bin/systemctl", "disable", *present])
    for name, path in paths.items():
        if decoded[name] is None:
            path.unlink(missing_ok=True)
        else:
            atomic_write(path, decoded[name], before[name]["mode"])
    fsync_directory(manager.layout.units)
    fsync_directory(manager.layout.config)
    manager.system.reload()
    if enabled:
        manager.system.enable([manager.layout.unit(role) for role in EDGE_ROLES if role in enabled])
    manager.config = old_config
    try:
        recovery_barriers(manager, active)
        if active:
            manager.system.start([manager.layout.unit(role) for role in EDGE_ROLES if role in active])
        confirm_service_state(manager, active)
        _, restored_enabled = prior_service_state(manager)
        require(set(restored_enabled) == set(enabled), "HTTPS service enablement was not restored", "recovery_required")
    except Exception:
        recovery_barriers(manager)
        manager.system.stop([manager.layout.unit(role) for role in EDGE_ROLES])
        raise
    for role in EDGE_ROLES:
        (barriers / role).unlink(missing_ok=True)
    fsync_directory(barriers)
    journal["phase"] = "recovered"
    write_json(journal_path, journal)


def tls_paths(layout: Layout, metadata: dict) -> tuple[Path, Path]:
    root = layout.config / "tls"
    revision = metadata.get("tlsRevision")
    if revision is not None:
        require(isinstance(revision, str) and re.fullmatch(r"[0-9a-f]{32}", revision), "Invalid TLS revision", "corrupt_state")
        root /= revision
    return root / "certificate.pem", root / "private-key.pem"


def stage_tls(layout: Layout, certificate: bytes, private_key: bytes, gid: int) -> dict:
    root = layout.config / "tls"
    mkdir(root, 0o750, 0, gid)
    require(len(list(root.iterdir())) < 130, "TLS recovery generations reached retention budget", "budget")
    revision = uuid.uuid4().hex
    directory = root / revision
    require(not directory.exists(), "TLS generation collision", "collision")
    mkdir(directory, 0o750, 0, gid)
    atomic_write(directory / "certificate.pem", certificate, 0o640, 0, gid)
    atomic_write(directory / "private-key.pem", private_key, 0o640, 0, gid)
    return {"tlsRevision": revision, "certificateSha256": hashlib.sha256(certificate).hexdigest(),
            "privateKeySha256": hashlib.sha256(private_key).hexdigest()}


def setup_https(manager, *, host: str, auth_host: str | None = None, domain: str | None = None,
                username: str = "admin", email: str | None = None, auth_port: int | None = None,
                password: str | None = None, otp: str | None = None,
                tls: str = "acme", certificate: Path | None = None, private_key: Path | None = None,
                http_port: int = 80, https_port: int = 443) -> dict:
    layout = manager.layout
    manager.require_recovered_transactions(None)
    manager.require_service_ownership()
    domain_name(host)
    require(tls in ("acme", "internal", "provided"), "Unknown TLS mode")
    require(type(http_port) is int and type(https_port) is int and 1 <= http_port <= 65535 and 1 <= https_port <= 65535 and
            len({http_port, https_port, manager.config["port"]}) == 3, "Edge and backend ports must be distinct")
    metadata_path = layout.config / "https.json"
    wanted = {"host": host, "tls": tls, "httpPort": http_port, "httpsPort": https_port}
    reused = metadata_path.exists()
    metadata = read_json(metadata_path) if reused else {**wanted, "authentication": "builtin", "phase": "prepared"}
    require(all(metadata.get(key) == value for key, value in wanted.items()),
            "Existing HTTPS address is preserved; address changes require an explicit migration", "identity_conflict")
    require(metadata.get("authentication") in (None, "builtin"), "Unknown HTTPS authentication mode", "integrity")
    legacy = reused and metadata.get("authentication") != "builtin"
    # Old CLI arguments may be supplied during migration, but may not point at a
    # different retained identity. No new Authelia identity is ever provisioned.
    if reused and metadata.get("authHost") is not None:
        require((auth_host is None or auth_host == metadata.get("authHost")) and
                (domain is None or domain == metadata.get("domain")) and
                (auth_port is None or auth_port == metadata.get("authPort")),
                "Legacy identity arguments differ from the retained identity", "identity_conflict")
    else:
        require(auth_host is None and domain is None and email is None and auth_port is None,
                "Built-in HTTPS needs only --host; legacy identity options are for migration only")
    cert_data = key_data = None
    if tls == "provided":
        require((certificate is None) == (private_key is None), "Supply both --certificate and --private-key")
        require(reused or certificate is not None, "Provided TLS requires --certificate and --private-key")
        if certificate is not None:
            cert_data, key_data = read_pem(certificate, private=False), read_pem(private_key, private=True)
    else:
        require(certificate is None and private_key is None, "Certificate paths are only valid with --tls provided")
    # A ready endpoint alone is insufficient: prove that the operator can log in
    # before removing the external gate, then revoke that temporary session.
    require(password is not None, "Account password verification is required before HTTPS activation", "account_required")
    verify_account_login(manager, username, password, otp)
    caddy = edge_binary(layout, "caddy")
    caddy_uid, caddy_gid = ensure_account(layout.prefix + "-edge", layout.state / "caddy")
    mkdir(layout.state / "caddy", 0o700, caddy_uid, caddy_gid)
    selected_metadata = {**metadata, "authentication": "builtin"}
    if tls == "provided":
        if reused:
            old_cert, old_key = tls_paths(layout, metadata)
            for path, field in ((old_cert, "certificateSha256"), (old_key, "privateKeySha256")):
                require(hashlib.sha256(read_pem(path, private=field == "privateKeySha256")).hexdigest() == metadata.get(field),
                        "Retained TLS material changed", "integrity")
        if not reused or cert_data is not None and (hashlib.sha256(cert_data).hexdigest() != metadata["certificateSha256"] or
                                                    hashlib.sha256(key_data).hexdigest() != metadata["privateKeySha256"]):
            selected_metadata.update(stage_tls(layout, cert_data, key_data, caddy_gid))
    if not reused:
        # Persist first-setup TLS selection before validators create any state.
        metadata = dict(selected_metadata)
        write_json(metadata_path, metadata)
    def caddy_configuration(selected):
        certificate_path, key_path = tls_paths(layout, selected) if tls == "provided" else (None, None)
        identity_host = selected.get("authHost") if selected.get("authentication") != "builtin" else None
        return render_caddy(host, identity_host, manager.config["port"], selected.get("authPort", 9091), tls=tls,
                            http_port=http_port, https_port=https_port,
                            certificate=str(certificate_path) if certificate_path else None,
                            private_key=str(key_path) if key_path else None)
    rendered = caddy_configuration(selected_metadata)
    caddy_file = layout.config / "Caddyfile"
    if caddy_file.exists():
        require(caddy_file.read_text() == caddy_configuration(metadata),
                "Existing HTTPS configuration differs; inspect before replacing", "identity_conflict")
    pending_caddy = layout.config / "Caddyfile.pending"
    atomic_write(pending_caddy, rendered.encode(), 0o644)
    run(["/usr/bin/setpriv", "--reuid", str(caddy_uid), "--regid", str(caddy_gid), "--clear-groups", "--no-new-privs",
         "/usr/bin/env", "-i", "HOME=" + str(layout.state / "caddy"), "PATH=/usr/bin:/bin",
         str(caddy), "validate", "--config", str(pending_caddy), "--adapter", "caddyfile"])
    old_config = dict(manager.config)
    new_config = {**old_config, "origin": site_origin(host, https_port)}
    edge_units = render_edge_units(layout, builtin=True)
    active, enabled = prior_service_state(manager)
    before = snapshot_configuration(layout)
    transaction = layout.state / "transactions" / uuid.uuid4().hex
    mkdir(transaction, 0o700)
    journal_path = transaction / "state.json"
    journal = {"kind": "https", "phase": "prepared", "before": before, "active": active, "enabled": enabled, "candidateConfig": new_config}
    write_json(journal_path, journal)
    stop_units = [layout.unit(role) for role in EDGE_ROLES]
    active_roles = ["worker", "gateway", "caddy"]
    units = [layout.unit(role) for role in active_roles]
    try:
        manager.system.stop(stop_units)
        manager.recover_control()
        journal["phase"] = "stopped"
        write_json(journal_path, journal)
        # Disable before removing the old unit so systemd removes enablement links.
        old_auth_unit = layout.units / layout.unit("authelia")
        if old_auth_unit.exists():
            run(["/usr/bin/systemctl", "disable", layout.unit("authelia")])
            old_auth_unit.unlink()
            fsync_directory(layout.units)
        for name, content in render_units(layout, new_config, old_config["codexRelative"]).items():
            atomic_write(layout.units / name, content.encode(), 0o644)
        for name, content in edge_units.items():
            atomic_write(layout.units / name, content.encode(), 0o644)
        atomic_write(caddy_file, rendered.encode(), 0o644)
        write_json(layout.config / "instance.json", new_config)
        selected_metadata["phase"] = "starting"
        write_json(metadata_path, selected_metadata)
        journal["phase"] = "selected"
        write_json(journal_path, journal)
        manager.system.reload()
        manager.system.start(units)
        manager.config = new_config
        confirm_service_state(manager, active_roles)
        # Verify account support again after the gateway and its origin changed.
        from .accounts import account_request
        status, _ = account_request(manager, "GET")
        require(status.get("authenticationMode") == "account" and status.get("initialized") is True,
                "Built-in account was not restored after HTTPS activation", "account_required")
        manager.system.enable(units)
        selected_metadata["phase"] = "active"
        write_json(metadata_path, selected_metadata)
        journal["phase"] = "committed"
        write_json(journal_path, journal)
    except Exception:
        try:
            recover_https_transaction(manager, journal_path, journal)
        except Exception as recovery:
            raise DeployError("recovery_required", "HTTPS recovery is unconfirmed; configuration, identity and TLS pairs are retained. Run repair.") from recovery
        raise
    return {"origin": new_config["origin"], "authentication": "builtin", "autheliaStopped": True,
            "identityPreserved": True, "migratedFromAuthelia": legacy,
            "login": "Sign in directly with the Harness administrator account. Model account authorization remains separate.",
            "tlsMode": tls, "certificateChanged": tls == "provided" and (not reused or
                selected_metadata.get("certificateSha256") != metadata.get("certificateSha256") or
                selected_metadata.get("privateKeySha256") != metadata.get("privateKeySha256")),
            "internalCaFile": str(layout.state / "caddy/.local/share/caddy/pki/authorities/local/root.crt") if tls == "internal" else None,
            "tlsAcceptance": "Verify DNS/host mappings, client certificate trust and real browser login from the intended client network."}
