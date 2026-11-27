"""Caddy HTTPS for built-in accounts, with reversible legacy identity migration."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import ssl
import stat
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from .build import architecture
from .edge_defaults import DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT
from .dns_providers import PROVIDERS, caddy_dns_block
from .common import DeployError, Layout, atomic_write, canonical, fsync_directory, mkdir, read_json, require, write_json
from .install import ensure_account
from .safe_fs import durable_tree, stable_identity
from .system import run
from .units import main_unit_templates, render_units, render_edge_units, validate_origin
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


def browser_origin(host: str, https_port: int, public_origin: str | None = None) -> str:
    origin = site_origin(host, https_port) if public_origin is None else validate_origin(public_origin)
    parsed = urlsplit(origin)
    require(parsed.scheme == "https" and parsed.hostname == host,
            "Public origin must use HTTPS and the exact --host hostname")
    return origin


def render_caddy(host: str, auth_host: str | None, gateway_port: int, auth_port: int, *, tls: str = "acme",
                 http_port: int = DEFAULT_HTTP_PORT, https_port: int = DEFAULT_HTTPS_PORT, certificate: str | None = None, private_key: str | None = None,
                 public_origin: str | None = None, explicit_redirect: bool = False, dns_provider: str | None = None, client_identity: bool = False, hsts: bool = False) -> str:
    domain_name(host)
    if auth_host is not None:
        domain_name(auth_host)
    require(type(gateway_port) is int and 1024 <= gateway_port <= 65535, "Invalid gateway port")
    require(tls in ("acme", "internal", "provided"), "Unknown TLS mode")
    require((dns_provider is None or isinstance(dns_provider, str) and dns_provider in PROVIDERS) and
            (dns_provider is None or tls == "acme" and auth_host is None),
            "DNS validation requires built-in ACME HTTPS")
    require(type(http_port) is int and 1 <= http_port <= 65535 and http_port != https_port, "Invalid HTTP port")
    origin = browser_origin(host, https_port, public_origin)
    redirected = explicit_redirect or origin != site_origin(host, https_port)
    require(not redirected or auth_host is None, "Explicit origin redirects require built-in authentication")
    tls_line = ""
    if dns_provider is not None:
        tls_line = "    tls {\n        issuer acme {\n" + caddy_dns_block(dns_provider) + """\
            disable_http_challenge
            disable_tlsalpn_challenge
        }
    }
"""
    elif tls == "internal":
        tls_line = "    tls internal\n"
    elif tls == "provided":
        require(certificate is not None and private_key is not None and
                all(re.fullmatch(r"/[a-zA-Z0-9/_.-]+", path) for path in (certificate, private_key)), "Invalid managed TLS paths")
        tls_line = f"    tls {certificate} {private_key}\n"
    trust_line = "    skip_install_trust\n" if tls == "internal" else ""
    redirect_option = "    auto_https disable_redirects\n" if redirected else ""
    redirect_site = (f"http://{host}:{http_port} {{\n    redir {origin}{{uri}} 308\n}}\n" if redirected else "")
    identity_headers = ('        header_up X-Harness-Client-IP {remote_host}\n'
                        '        header_up X-Harness-Proxy-Token {$HARNESS_EDGE_PROXY_TOKEN}\n') if client_identity else ''
    proxy = ('reverse_proxy 127.0.0.1:' + str(gateway_port) + ' {\n' + identity_headers + '        }') if client_identity else 'reverse_proxy 127.0.0.1:' + str(gateway_port)
    hsts_header = '    header Strict-Transport-Security "max-age=86400"\n' if hsts else ''
    if auth_host is None:
        return f"""{{
    admin off
    http_port {http_port}
    https_port {https_port}
{trust_line}{redirect_option}}}
{site_origin(host, https_port)} {{
{tls_line}{hsts_header}    route {{
        request_header -Remote-User
        request_header -Remote-Groups
        request_header -Remote-Email
        request_header -Remote-Name
        {proxy}
    }}
}}
{redirect_site}\
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


def validate_plain_caddy(layout, binary, config, uid, gid):
    require(type(uid) is int and type(gid) is int and uid > 0 and gid > 0, "Edge validation requires its unprivileged account", "integrity")
    return run(["/usr/bin/setpriv", "--reuid", str(uid), "--regid", str(gid), "--clear-groups", "--no-new-privs",
                "/usr/bin/env", "-i", "HOME=" + str(layout.state / "caddy"), "PATH=/usr/bin:/bin", "HARNESS_EDGE_PROXY_TOKEN=validation-only",
                str(binary), "validate", "--config", str(config), "--adapter", "caddyfile"])


def edge_binary(layout: Layout, kind: str, *, download_proxy: str | None = None) -> Path:
    require(kind == "caddy", "Only Caddy is provisioned for built-in account authentication")
    arch = "amd64" if architecture() == "x64" else "arm64"
    root = layout.control / "edge" / kind
    target = root / kind
    manifest_path = layout.config / (kind + "-binary.json")
    from .install import trusted_ancestors
    from .archive import open_archive
    limit = 256 * 1024**2

    def file_hash(path):
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and
                not info.st_mode & 0o022 and info.st_size <= limit, "Unsafe edge preparation file", "integrity")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            require(os.path.samestat(info, os.fstat(fd)), "Edge file changed", "integrity")
            result = hashlib.file_digest(source, "sha256").hexdigest()
            require(os.fstat(fd).st_ctime_ns == info.st_ctime_ns and os.path.samestat(info, path.lstat()),
                    "Edge file changed during verification", "integrity")
        return result

    trusted_ancestors(root)
    if present(manifest_path):
        manifest = read_json(manifest_path)
        require(present(target) and file_hash(target) == manifest.get("sha256") and target.stat().st_mode & 0o100, "Edge binary changed", "integrity")
        durable_tree(root)
        fsync_directory(root.parent)
        fsync_directory(root.parent.parent)
        return target
    version = CADDY_VERSION
    asset = f"caddy_{version}_linux_{arch}.tar.gz"
    url = f"https://github.com/caddyserver/caddy/releases/download/v{version}/{asset}"
    archive = layout.work / asset
    trusted_ancestors(layout.work)
    expected = EDGE_HASHES[kind, arch]
    if present(archive):
        old_hash = file_hash(archive)
        if old_hash != expected:
            retained = layout.work / (asset + ".interrupted-" + old_hash)
            if present(retained):
                require(file_hash(retained) == old_hash, "Edge recovery evidence changed; prior files retained", "recovery_required")
                archive.unlink()
            else:
                require(sum(1 for _ in layout.work.glob(asset + ".interrupted-*")) < 4,
                        "Four interrupted edge distributions are retained; archive their exact .interrupted-SHA256 files before retrying", "budget")
                os.rename(archive, retained)
            fsync_directory(layout.work)
    if not present(archive):
        from .dns_caddy_build import validate_download_proxy
        proxy = validate_download_proxy(download_proxy)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy} if proxy else {}))
        sha, total = hashlib.sha256(), 0
        with opener.open(url, timeout=60) as response, archive.open("xb") as output:
            require(response.url.startswith(("https://github.com/", "https://release-assets.githubusercontent.com/")), "Unexpected edge download origin")
            while data := response.read(1024**2):
                total += len(data)
                require(total <= limit, "Edge download exceeds budget", "budget")
                output.write(data)
                sha.update(data)
            output.flush()
            os.fsync(output.fileno())
        fsync_directory(layout.work)
        require(sha.hexdigest() == expected, "Official edge distribution hash mismatch", "integrity")
    # Read the single artifact from the pinned archive. An interruption leaves
    # only the original, identifiable download or the atomically published binary.
    binary = None
    with open_archive(archive, max_file=limit, max_members=128, max_bytes=2*limit) as package:
        while entry := package.next():
            if entry.name not in (kind, "./" + kind):
                continue
            require(binary is None and entry.isfile() and entry.mode & 0o100 and 0 < entry.size <= limit,
                    "Expected a single regular executable in the edge archive", "integrity")
            with package.extractfile(entry) as source:
                binary = source.read(entry.size)
            require(len(binary) == entry.size, "Incomplete edge executable", "integrity")
    require(binary is not None, "Expected edge executable absent", "integrity")
    sha = hashlib.sha256(binary).hexdigest()
    mkdir(root.parent)
    if not present(root):
        mkdir(root)
    trusted_ancestors(root)
    if present(target):
        require(file_hash(target) == sha and target.stat().st_mode & 0o100,
                "Existing edge executable differs from verified distribution; retained", "recovery_required")
    else:
        atomic_write(target, binary, 0o755)
    fsync_directory(root)
    fsync_directory(root.parent)
    fsync_directory(root.parent.parent)
    write_json(manifest_path, {"version": version, "sha256": sha})
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
            require(name in ("metadata", "caddyConfig", "authelia", "caddy"), "Required configuration is absent", "recovery_required")
            result[name] = None
            continue
        details = path.lstat()
        require(stat.S_ISREG(details.st_mode) and details.st_size <= 1024 * 1024 and
                (details.st_uid == 0 and not details.st_mode & 0o022),
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
            require(name in ("metadata", "caddyConfig", "authelia", "caddy"), "Missing required HTTPS snapshot", "corrupt_state")
            decoded[name] = None
        else:
            require(isinstance(value, dict) and set(value) == {"data", "mode"} and type(value["mode"]) is int and
                    0 <= value["mode"] <= 0o777 and (not value["mode"] & 0o022),
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
    candidate_https = journal.get("candidateHttps")
    if candidate_https is not None:
        require(isinstance(candidate_https, dict) and candidate_https.get("authentication") == "builtin" and
                candidate_config["origin"] == browser_origin(candidate_https["host"], candidate_https["httpsPort"],
                                                              candidate_https.get("publicOrigin")),
                "Invalid HTTPS candidate metadata", "corrupt_state")
    candidate_dns = candidate_https if candidate_https is not None and candidate_https.get("dnsProvider") is not None else None
    prior_units = {role: decoded[role] for role in EDGE_ROLES}
    for role, templates in main_unit_templates(manager.layout, old_config).items():
        data = decoded[role]
        require(data in templates, "Retained HTTPS service unit is not a generated definition", "corrupt_state")
        decoded[role] = templates[data]
        prior_units[role] = {data, decoded[role]}
    require_owned(manager.layout, candidate_config, prior_units=prior_units, candidate_dns=candidate_dns)
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


def tls_ca_path(layout: Layout, metadata: dict) -> Path | None:
    revision = metadata.get("tlsCaRevision")
    if revision is None:
        require("tlsCaSha256" not in metadata, "Incomplete TLS CA selection", "integrity")
        return None
    require(isinstance(revision, str) and bool(re.fullmatch(r"[0-9a-f]{32}", revision)),
            "Invalid TLS CA revision", "integrity")
    root = layout.config / "tls-ca"
    for directory in (root, root / revision):
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and (info.st_uid == 0 and not info.st_mode & 0o022),
                "Unsafe managed TLS CA directory", "integrity")
    path = root / revision / "ca.pem"
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
            (info.st_uid == 0 and not info.st_mode & 0o022),
            "Unsafe managed TLS CA", "integrity")
    require(hashlib.sha256(read_pem(path, private=False)).hexdigest() == metadata.get("tlsCaSha256"),
            "Retained TLS CA changed", "integrity")
    return path


def stage_tls_ca(layout: Layout, data: bytes) -> dict:
    # Parse before creating a generation. The public trust anchor is copied;
    # subsequent checks never follow the operator's mutable input file.
    require(b"PRIVATE KEY-----" not in data, "TLS CA input must contain only public certificates", "invalid_input")
    try:
        ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT).load_verify_locations(cadata=data.decode("ascii"))
    except (UnicodeError, ssl.SSLError) as exc:
        raise DeployError("invalid_input", "TLS CA certificate is not a valid PEM trust bundle") from exc
    root = layout.config / "tls-ca"
    mkdir(root, 0o755, 0, 0)
    require(len(list(root.iterdir())) < 130, "TLS CA generations reached retention budget", "budget")
    revision = uuid.uuid4().hex
    directory = root / revision
    require(not present(directory), "TLS CA generation collision", "collision")
    mkdir(directory, 0o755, 0, 0)
    atomic_write(directory / "ca.pem", data, 0o644, 0, 0)
    return {"tlsCaRevision": revision, "tlsCaSha256": hashlib.sha256(data).hexdigest()}


def read_https_metadata(layout: Layout) -> dict:
    path = layout.config / "https.json"
    require(present(path), "This instance has no HTTPS configuration", "not_installed")
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 1024 * 1024 and
            (info.st_uid == 0 and not info.st_mode & 0o022),
            "Unsafe HTTPS metadata", "integrity")
    value = read_json(path)
    require(isinstance(value, dict), "Invalid HTTPS metadata", "integrity")
    return value


def https_revision(metadata: dict) -> str:
    # Bind every retained TLS and identity field, without printing private-key
    # fingerprints or relying on the JSON file's whitespace/key ordering.
    return hashlib.sha256(canonical(metadata)).hexdigest()


def read_https(manager) -> dict:
    manager.require_service_ownership()
    metadata = read_https_metadata(manager.layout)
    from .https_guidance import certificate_guidance
    return {"origin": manager.config["origin"], "httpsRevision": https_revision(metadata),
            "settings": {key: metadata.get(key) for key in
                         ("host", "tls", "httpPort", "httpsPort", "publicOrigin", "redirectPolicy", "authentication", "phase", "dnsProvider", "hsts", "clientIdentity")},
            **certificate_guidance(tls=metadata.get("tls"), dns_provider=metadata.get("dnsProvider"),
                                   http_port=metadata.get("httpPort", 80), https_port=metadata.get("httpsPort", 443))}


def caddy_configuration(layout: Layout, config: dict, metadata: dict) -> str:
    certificate, private_key = tls_paths(layout, metadata) if metadata["tls"] == "provided" else (None, None)
    identity_host = metadata.get("authHost") if metadata.get("authentication") != "builtin" else None
    translated = {"public_origin": metadata["publicOrigin"]} if "publicOrigin" in metadata else {}
    require(metadata.get("redirectPolicy") in (None, "origin-v1"), "Unknown HTTPS redirect policy", "integrity")
    if metadata.get("redirectPolicy") == "origin-v1":
        translated["explicit_redirect"] = True
    if metadata.get("dnsProvider") is not None:
        translated["dns_provider"] = metadata["dnsProvider"]
    translated["client_identity"] = metadata.get("clientIdentity") == 1
    translated["hsts"] = metadata.get("hsts") is True
    return render_caddy(metadata["host"], identity_host, config["port"], metadata.get("authPort", 9091),
                        tls=metadata["tls"], http_port=metadata["httpPort"], https_port=metadata["httpsPort"],
                        certificate=str(certificate) if certificate else None,
                        private_key=str(private_key) if private_key else None, **translated)


def setup_https(manager, *, host: str, auth_host: str | None = None, domain: str | None = None,
                username: str = "admin", email: str | None = None, auth_port: int | None = None,
                password: str | None = None, otp: str | None = None,
                tls: str = "acme", certificate: Path | None = None, private_key: Path | None = None,
                http_port: int = DEFAULT_HTTP_PORT, https_port: int = DEFAULT_HTTPS_PORT,
                public_origin: str | None = None, tls_ca_certificate: Path | None = None, tls_system_ca: bool = False,
                dns_provider: str | None = None, dns_credentials: Path | None = None,
                download_proxy: str | None = None, progress=None,
                expected_origin: str | None = None, expected_https_revision: str | None = None, hsts: bool | None = None) -> dict:
    layout = manager.layout
    manager.require_recovered_transactions(None)
    manager.require_service_ownership()
    domain_name(host)
    require(tls in ("acme", "internal", "provided"), "Unknown TLS mode")
    require(hsts is None or type(hsts) is bool and (not hsts or tls in ("acme", "provided")),
            "HSTS requires trusted public TLS")
    require(type(tls_system_ca) is bool and not (tls_system_ca and tls_ca_certificate is not None),
            "Choose either the system trust store or an explicit TLS CA certificate")
    require(type(http_port) is int and type(https_port) is int and 1 <= http_port <= 65535 and 1 <= https_port <= 65535 and
            len({http_port, https_port, manager.config["port"]}) == 3, "Edge and backend ports must be distinct")
    metadata_path = layout.config / "https.json"
    origin = browser_origin(host, https_port, public_origin)
    wanted = {"host": host, "tls": tls, "httpPort": http_port, "httpsPort": https_port}
    if public_origin is not None:
        wanted["publicOrigin"] = origin
    reused = present(metadata_path)
    metadata = read_https_metadata(layout) if reused else {**wanted, "authentication": "builtin", "phase": "prepared"}
    selected_hsts = False if tls == "internal" else (metadata.get("hsts") is True if hsts is None else hsts)
    from .dns_tls import (SELECTION_FIELDS, read_dns_credentials, stage_dns_credentials,
                          validate_dns_caddy, validate_dns_selection)
    require(dns_provider is None or isinstance(dns_provider, str) and dns_provider in (*PROVIDERS, "none"), "Unknown DNS validation provider")
    selected_dns = metadata.get("dnsProvider") if dns_provider is None and tls == "acme" else dns_provider
    if selected_dns == "none":
        selected_dns = None
    require(selected_dns is None or tls == "acme", "DNS validation applies only to ACME TLS")
    require(dns_credentials is None or selected_dns is not None, "Choose --dns-provider before supplying DNS credentials")
    if selected_dns is not None:
        wanted["dnsProvider"] = selected_dns
    if not reused:
        metadata.update(wanted)
    migration = expected_origin is not None or expected_https_revision is not None
    if migration:
        require(reused and isinstance(expected_origin, str) and isinstance(expected_https_revision, str) and
                bool(re.fullmatch(r"[0-9a-f]{64}", expected_https_revision)),
                "HTTPS migration requires the current origin and HTTPS revision from https-read")
        require(expected_origin == manager.config["origin"] and expected_https_revision == https_revision(metadata),
                "HTTPS configuration changed; inspect https-read before migrating", "conflict")
        require(metadata.get("authentication") == "builtin" and metadata.get("phase") == "active",
                "Address migration requires an active built-in HTTPS configuration", "identity_conflict")
        require(manager.config["origin"] == browser_origin(metadata["host"], metadata["httpsPort"], metadata.get("publicOrigin")),
                "Existing HTTPS origin differs from its retained configuration", "identity_conflict")
        require(present(layout.config / "Caddyfile") and present(layout.units / layout.unit("caddy")),
                "Existing HTTPS configuration is incomplete", "identity_conflict")
    else:
        require(all(metadata.get(key) == value for key, value in wanted.items()) and
                metadata.get("publicOrigin") == wanted.get("publicOrigin") and
                metadata.get("dnsProvider") == selected_dns,
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
    cert_data = key_data = ca_data = None
    dns_data = read_dns_credentials(dns_credentials, selected_dns) if dns_credentials is not None else None
    if selected_dns is not None:
        require(dns_data is not None or reused and metadata.get("dnsProvider") == selected_dns,
                "DNS validation requires --dns-credentials with a protected JSON file")
    if reused:
        validate_dns_selection(layout, metadata)
    previous_provided = reused and metadata.get("tls") == "provided"
    if tls == "provided":
        require((certificate is None) == (private_key is None), "Supply both --certificate and --private-key")
        require(previous_provided or certificate is not None, "Provided TLS requires --certificate and --private-key")
        if certificate is not None:
            cert_data, key_data = read_pem(certificate, private=False), read_pem(private_key, private=True)
        if tls_ca_certificate is not None:
            ca_data = read_pem(tls_ca_certificate, private=False)
    else:
        require(certificate is None and private_key is None and tls_ca_certificate is None and not tls_system_ca,
                "Certificate paths are only valid with --tls provided")
    # Verify the retained edge and TLS pair before staging anything. In a
    # migration these use the OLD host/mode/ports, never candidate arguments.
    caddy_file = layout.config / "Caddyfile"
    if present(caddy_file):
        regular(caddy_file, {caddy_configuration(layout, manager.config, metadata).encode()})
    if previous_provided:
        old_cert, old_key = tls_paths(layout, metadata)
        for path, field in ((old_cert, "certificateSha256"), (old_key, "privateKeySha256")):
            require(hashlib.sha256(read_pem(path, private=field == "privateKeySha256")).hexdigest() == metadata.get(field),
                    "Retained TLS material changed", "integrity")
        tls_ca_path(layout, metadata)
    from .ports import require_edge_ports_available
    require_edge_ports_available(manager, http_port=http_port, https_port=https_port)
    # A ready endpoint alone is insufficient: prove that the operator can log in
    # before removing the external gate, then revoke that temporary session.
    require(password is not None, "Account password verification is required before HTTPS activation", "account_required")
    verify_account_login(manager, username, password, otp)
    caddy = edge_binary(layout, "caddy", download_proxy=download_proxy) if selected_dns is None else None
    caddy_uid, caddy_gid = ensure_account(layout.prefix + "-edge", layout.state / "caddy")
    mkdir(layout.state / "caddy", 0o700, caddy_uid, caddy_gid)
    selected_metadata = {**metadata, **wanted, "authentication": "builtin", "redirectPolicy": "origin-v1", "clientIdentity": 1}
    if hsts is not None or "hsts" in metadata:
        selected_metadata["hsts"] = selected_hsts
    if selected_dns is None:
        for field in SELECTION_FIELDS:
            selected_metadata.pop(field, None)
    else:
        from .dns_caddy_build import dns_caddy_path, provision_dns_caddy
        selected_metadata.update(provision_dns_caddy(manager, download_proxy=download_proxy, progress=progress))
        selected_metadata["dnsProvider"] = selected_dns
        if dns_data is not None and hashlib.sha256(dns_data).hexdigest() != metadata.get("dnsCredentialsSha256"):
            selected_metadata.update(stage_dns_credentials(layout, dns_data))
        validate_dns_selection(layout, selected_metadata)
        caddy = dns_caddy_path(layout, selected_metadata)
    if public_origin is None:
        selected_metadata.pop("publicOrigin", None)
    if tls != "provided":
        for field in ("tlsRevision", "certificateSha256", "privateKeySha256", "tlsCaRevision", "tlsCaSha256"):
            selected_metadata.pop(field, None)
    if tls == "provided":
        if not previous_provided or cert_data is not None and (hashlib.sha256(cert_data).hexdigest() != metadata["certificateSha256"] or
                                                    hashlib.sha256(key_data).hexdigest() != metadata["privateKeySha256"]):
            selected_metadata.update(stage_tls(layout, cert_data, key_data, caddy_gid))
        if ca_data is not None and hashlib.sha256(ca_data).hexdigest() != metadata.get("tlsCaSha256"):
            selected_metadata.update(stage_tls_ca(layout, ca_data))
        if tls_system_ca:
            selected_metadata.pop("tlsCaRevision", None)
            selected_metadata.pop("tlsCaSha256", None)
    proxy_token = hashlib.sha256(("codex-harness-edge-client-v1\0" + (layout.config / "gateway-token").read_text().strip()).encode()).hexdigest()
    proxy_environment = ("HARNESS_EDGE_PROXY_TOKEN=" + proxy_token + "\n").encode()
    proxy_path = layout.config / "edge-proxy.env"
    if proxy_path.exists() or proxy_path.is_symlink():
        regular(proxy_path, {proxy_environment})
    else:
        atomic_write(proxy_path, proxy_environment, 0o600)
    rendered = caddy_configuration(layout, manager.config, selected_metadata)
    pending_caddy = layout.config / "Caddyfile.pending"
    atomic_write(pending_caddy, rendered.encode(), 0o644)
    if selected_dns is not None:
        validate_dns_caddy(layout, selected_metadata, caddy, pending_caddy, caddy_uid, caddy_gid)
    else:
        validate_plain_caddy(layout, caddy, pending_caddy, caddy_uid, caddy_gid)
    require_edge_ports_available(manager, http_port=http_port, https_port=https_port)
    old_config = dict(manager.config)
    new_config = {**old_config, "origin": origin}
    edge_units = render_edge_units(layout, builtin=True, dns_metadata=selected_metadata if selected_dns is not None else None, client_identity=True)
    active, enabled = prior_service_state(manager)
    before = snapshot_configuration(layout)
    transaction = layout.state / "transactions" / uuid.uuid4().hex
    mkdir(transaction, 0o700)
    journal_path = transaction / "state.json"
    journal = {"kind": "https", "phase": "prepared", "before": before, "active": active, "enabled": enabled,
               "candidateConfig": new_config, "candidateHttps": dict(selected_metadata)}
    write_json(journal_path, journal)
    stop_units = [layout.unit(role) for role in EDGE_ROLES]
    active_roles = ["worker", "gateway", "caddy"]
    units = [layout.unit(role) for role in active_roles]
    try:
        recovery_barriers(manager)
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
        recovery_barriers(manager, active_roles)
        manager.system.start(units)
        manager.config = new_config
        confirm_service_state(manager, active_roles)
        # Verify account support again after the gateway and its origin changed.
        from .accounts import account_request
        status, _ = account_request(manager, "GET")
        require(status.get("authenticationMode") == "account" and status.get("initialized") is True,
                "Built-in account was not restored after HTTPS activation", "account_required")
        from .https_health import require_https_ready
        https_health = require_https_ready(manager, timeout=300 if selected_dns is not None else 120 if tls == "acme" else 30)
        if not migration:
            manager.system.enable(units)
        else:
            # An address change must not undo an operator's disabled-on-boot
            # choice. Startup above is explicit; enablement is independent.
            _, selected_enabled = prior_service_state(manager)
            require(set(selected_enabled) == set(enabled), "HTTPS migration changed service enablement", "health")
        selected_metadata["phase"] = "active"
        write_json(metadata_path, selected_metadata)
        for role in EDGE_ROLES:
            (layout.config / "https-recovery" / role).unlink(missing_ok=True)
        fsync_directory(layout.config / "https-recovery")
    except Exception:
        try:
            recover_https_transaction(manager, journal_path, journal)
        except Exception as recovery:
            raise DeployError("recovery_required", "HTTPS recovery is unconfirmed; configuration, identity and TLS pairs are retained. Run repair.") from recovery
        raise
    # A directory-fsync error can follow successful terminal publication. The
    # healthy candidate must stay running whether the retained phase is selected
    # or committed; inspection/recovery decides the next action.
    journal["phase"] = "committed"
    write_json(journal_path, journal)
    return {"origin": new_config["origin"], "authentication": "builtin", "autheliaStopped": True,
            "identityPreserved": True, "migratedFromAuthelia": legacy,
            "addressMigrated": migration, "previousOrigin": old_config["origin"],
            "loginRequired": old_config["origin"] != new_config["origin"],
            "httpsRevision": https_revision(selected_metadata),
            "httpsHealth": https_health,
            "login": "Sign in directly with the Harness administrator account. Model account authorization remains separate.",
            "tlsMode": tls, "certificateChanged": tls == "provided" and (not reused or
                selected_metadata.get("certificateSha256") != metadata.get("certificateSha256") or
                selected_metadata.get("privateKeySha256") != metadata.get("privateKeySha256")),
            "internalCaFile": str(layout.state / "caddy/.local/share/caddy/pki/authorities/local/root.crt") if tls == "internal" else None,
            "tlsAcceptance": "Verify DNS/host mappings, client certificate trust and real browser login from the intended client network."}


def reset_prepared(manager, *, expected_revision: str, confirm: bool) -> dict:
    """Retire only the exact recovered, never-active legacy first-setup metadata."""
    require(confirm, "Confirm retiring the retained first-setup HTTPS metadata")
    manager.require_recovered_transactions(None)
    metadata = read_https_metadata(manager.layout)
    require(https_revision(metadata) == expected_revision and metadata.get("phase") == "prepared" and
            manager.config["origin"].startswith("http://"), "Only an unchanged recovered first HTTPS setup can be reset", "conflict")
    paths = transaction_paths(manager.layout)
    require(all(not path.exists() and not path.is_symlink() for name, path in paths.items() if name in ("caddyConfig", "authelia", "caddy")),
            "HTTPS service definitions are still present; recover their original transaction first", "recovery_required")
    require(all(manager.system.state(manager.layout.unit(role))["stopped"] for role in ("caddy", "authelia")),
            "HTTPS services must be confirmed stopped", "stop_unknown")
    raw = (manager.layout.config / "https.json").read_bytes()
    from .execution_identity import FIELDS as execution_fields, state as execution_state
    from .config_layer import LAYER_MODE
    from .service_proxy import private_file, selection
    from .install import trusted_ancestors
    paths = manager.layout.state / "transactions"
    origins, transitions = set(), {}
    for path in paths.glob("*/state.json"):
        if not re.fullmatch(r"[0-9a-f]{32}", path.parent.name):
            continue
        trusted_ancestors(path.parent)
        journal = json.loads(private_file(path, limit=16 * 1024**2))
        before = journal.get("before", {})
        if not isinstance(before, dict):
            continue
        kind, phase = journal.get("kind"), journal.get("phase")
        if (kind, phase) != ("https", "recovered") and not (phase == "committed" and kind in ("config-layer", "execution-mode", "service-proxy")):
            continue
        snapshot = before.get("instance")
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("data"), str):
            continue
        original = json.loads(base64.b64decode(snapshot["data"], validate=True))
        if not isinstance(original, dict) or not str(original.get("origin", "")).startswith("http://"):
            continue
        source = canonical(original)
        if kind == "https":
            meta = before.get("metadata")
            if isinstance(meta, dict) and all(before.get(name) is None for name in ("caddyConfig", "authelia", "caddy")) and base64.b64decode(meta["data"], validate=True) == raw:
                origins.add(source)
            continue
        candidate = journal.get("candidateConfig")
        fields = {"config-layer": {"providerConfigLayer"}, "execution-mode": set(execution_fields), "service-proxy": {"serviceProxy"}}[kind]
        if not isinstance(candidate, dict) or {k: v for k, v in original.items() if k not in fields} != {k: v for k, v in candidate.items() if k not in fields}:
            continue
        if kind == "config-layer" and (journal.get("targetMode") not in ("legacy", LAYER_MODE) or
                candidate.get("providerConfigLayer") != (None if journal["targetMode"] == "legacy" else LAYER_MODE)):
            continue
        if kind == "execution-mode":
            execution_state(original)
            execution_state(candidate)
        if kind == "service-proxy":
            selection(original)
            selection(candidate)
        transitions.setdefault(source, set()).add(canonical(candidate))
    goal = canonical(manager.config)
    remaining = list(origins)
    while remaining:
        source = remaining.pop()
        for target in transitions.get(source, ()):
            if target not in origins:
                origins.add(target)
                remaining.append(target)
    matched = goal in origins
    require(matched, "No exact recovered first-setup transaction attests this metadata; nothing removed", "recovery_required")
    (manager.layout.config / "https.json").unlink()
    fsync_directory(manager.layout.config)
    return {"reset": True, "dataPreserved": True, "message": "已解除旧首次 HTTPS 准备状态；证书、密钥和恢复记录均已保留，可重新配置。"}


def refresh_client_identity(manager) -> dict:
    """Upgrade an existing managed edge without asking for account credentials."""
    layout = manager.layout
    if not present(layout.config / "https.json"):
        return {"changed": False, "configured": False}
    manager.require_recovered_transactions(None)
    metadata = read_https_metadata(layout)
    require(metadata.get("phase") == "active", "Recover the existing HTTPS transaction first", "recovery_required")
    builtin = metadata.get("authentication") == "builtin"
    if not builtin or metadata.get("clientIdentity") == 1:
        manager.verify_https(probe=False)
        expected = render_edge_units(layout, builtin=builtin, dns_metadata=metadata if metadata.get("dnsProvider") else None,
                                     client_identity=metadata.get("clientIdentity") == 1)
        from .units import edge_unit_variants
        pending = {}
        for unit, text in expected.items():
            path = layout.units / unit
            regular(path, edge_unit_variants(text.encode()))
            if path.read_bytes() != text.encode():
                pending[path] = text.encode()
        # File publication and PID 1's reload are separate changes. Preserve
        # the reload obligation when an upgrade is interrupted between them.
        marker = layout.config / "edge-network-order.pending"
        marker_data = b"edge-network-order-v1\n"
        needs_reload = present(marker)
        if needs_reload:
            from .service_proxy import private_file
            require(private_file(marker, limit=64) == marker_data, "Unrecognized edge unit reload record", "integrity")
        elif pending:
            atomic_write(marker, marker_data, 0o600)
            needs_reload = True
        for path, data in pending.items():
            atomic_write(path, data, 0o644)
        if needs_reload:
            manager.system.reload()
            marker.unlink()
            fsync_directory(layout.config)
        return {"changed": needs_reload, "configured": True, **({"requiresAuthenticationMigration": True} if not builtin else {})}
    from .candidate_archive import require_idle
    require_idle(manager)
    manager.verify(https_probe=False)
    candidate = {**metadata, "clientIdentity": 1}
    rendered = caddy_configuration(layout, manager.config, candidate)
    token = (layout.config / "gateway-token").read_text().strip()
    environment = ("HARNESS_EDGE_PROXY_TOKEN=" + hashlib.sha256(("codex-harness-edge-client-v1\0" + token).encode()).hexdigest() + "\n").encode()
    env_path = layout.config / "edge-proxy.env"
    if present(env_path): regular(env_path, {environment})
    else: atomic_write(env_path, environment, 0o600)
    pending = layout.config / "Caddyfile.client-identity.pending"
    atomic_write(pending, rendered.encode(), 0o644)
    import pwd
    account = pwd.getpwnam(layout.prefix + "-edge")
    if metadata.get("dnsProvider"):
        from .dns_tls import validate_dns_caddy
        from .dns_caddy_build import dns_caddy_path
        validate_dns_caddy(layout, candidate, dns_caddy_path(layout, candidate), pending, account.pw_uid, account.pw_gid)
    else:
        binary = edge_binary(layout, "caddy")
        validate_plain_caddy(layout, binary, pending, account.pw_uid, account.pw_gid)
    active, enabled = prior_service_state(manager)
    before = snapshot_configuration(layout)
    journal_path = layout.state / "transactions" / uuid.uuid4().hex / "state.json"
    mkdir(journal_path.parent, 0o700)
    journal = {"kind": "https", "phase": "prepared", "before": before, "active": active, "enabled": enabled,
               "candidateConfig": dict(manager.config), "candidateHttps": candidate}
    write_json(journal_path, journal)
    try:
        recovery_barriers(manager)
        manager.system.stop([layout.unit(role) for role in EDGE_ROLES])
        manager.recover_control()
        journal["phase"] = "stopped"; write_json(journal_path, journal)
        atomic_write(layout.config / "Caddyfile", rendered.encode(), 0o644)
        units = render_edge_units(layout, builtin=True, dns_metadata=candidate if candidate.get("dnsProvider") else None, client_identity=True)
        for name, content in units.items(): atomic_write(layout.units / name, content.encode(), 0o644)
        write_json(layout.config / "https.json", candidate)
        journal["phase"] = "selected"; write_json(journal_path, journal)
        manager.system.reload()
        recovery_barriers(manager, active)
        if active: manager.system.start([layout.unit(role) for role in active])
        confirm_service_state(manager, active)
        _, actual_enabled = prior_service_state(manager)
        require(set(actual_enabled) == set(enabled), "Edge identity refresh changed enablement", "health")
        manager.verify(https_probe="caddy" in active and "gateway" in active)
        for role in EDGE_ROLES: (layout.config / "https-recovery" / role).unlink(missing_ok=True)
        fsync_directory(layout.config / "https-recovery")
    except Exception:
        recover_https_transaction(manager, journal_path, journal)
        raise
    journal["phase"] = "committed"; write_json(journal_path, journal)
    pending.unlink(missing_ok=True)
    fsync_directory(layout.config)
    return {"changed": True, "configured": True, "clientIdentity": 1, "transaction": journal_path.parent.name}
