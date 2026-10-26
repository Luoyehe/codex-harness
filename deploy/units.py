from __future__ import annotations

import ipaddress
import re
from urllib.parse import urlsplit

from .common import Layout, require


def validate_origin(origin: str) -> str:
    require(isinstance(origin, str), "Origin must be text")
    try:
        parsed = urlsplit(origin)
    except ValueError:
        require(False, "Invalid origin hostname")
    require(parsed.scheme in ("http", "https") and bool(parsed.hostname) and not parsed.username and not parsed.password
            and parsed.path in ("", "/") and not parsed.query and not parsed.fragment and not any(c.isspace() for c in origin),
            "Origin must be an HTTP(S) origin without a path")
    require(bool(re.fullmatch(r"[A-Za-z0-9.:[\]-]+", parsed.netloc)), "Invalid origin hostname")
    try:
        require(parsed.port is None or 1 <= parsed.port <= 65535, "Invalid origin port")
    except ValueError:
        require(False, "Invalid origin port")
    host = parsed.hostname.lower()
    try:
        address = ipaddress.ip_address(host)
        host = address.compressed
    except ValueError:
        address = None
    if address is None:
        require("[" not in parsed.netloc and len(host) <= 253 and all(
            re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split("."))
            and not re.fullmatch(r"(?:[0-9]+|0x[0-9a-f]+)", host.split(".")[-1]),
            "Use a canonical DNS hostname or IP address")
    require(parsed.scheme != "http" or host in ("127.0.0.1", "localhost", "::1"),
            "Plain HTTP requires a loopback browser origin; use SSH forwarding or HTTPS")
    if address is not None and address.version == 6:
        host = "[" + host + "]"
    # Match browser URL.origin normalization so health checks, cookies and
    # exact Origin/Host checks use the same default-port spelling.
    port = parsed.port
    suffix = "" if port is None or port == (80 if parsed.scheme == "http" else 443) else ":" + str(port)
    return parsed.scheme + "://" + host + suffix


def render_units(layout: Layout, config: dict, codex_relative: str, *, legacy_runtime_directory: bool = False, legacy_native_home: bool = False) -> dict[str, str]:
    origin = validate_origin(config["origin"])
    port = config["port"]
    require(type(port) is int and 1024 <= port <= 65535, "Port must be 1024-65535")
    require(type(config.get("workerGid")) is int and config["workerGid"] > 0, "Native identity group is required")
    base = layout.app / "current"
    node = base / "node/bin/node"
    app = base / "app"
    worker = layout.state / "worker"
    supervisor = layout.state / "supervisor"
    require(config.get("providerConfigLayer") in (None, "system-v1"), "Invalid provider configuration layer")
    layered = config.get("providerConfigLayer") == "system-v1"
    provider_bind = (f"BindReadOnlyPaths={layout.config}/providers/current/system-config.toml:{layout.root / 'etc/codex/config.toml'}\n"
                     f"BindReadOnlyPaths={layout.config}/providers/current/requirements.toml:{layout.root / 'etc/codex/requirements.toml'}") if layered else (
                     f"BindReadOnlyPaths={layout.config}/providers/current/config.toml:{worker}/codex/config.toml")
    config_check = f"ExecStartPre=+/usr/bin/systemctl start {layout.unit('config-check')}\n" if layered else ""
    native_home = "" if legacy_native_home else f"Environment=HARNESS_NATIVE_HOME={worker}\n"
    worker_group = layout.prefix + ("-control" if legacy_runtime_directory else "-ipc")
    supplementary = layout.prefix + ("-ipc" if legacy_runtime_directory else "-control") + " " + layout.prefix + "-worker"
    # Kept solely to identify the exact previous managed unit for a safe,
    # stop-confirmed migration. systemd resets RuntimeDirectory to Group= before
    # every Exec command, so the old chgrp/chmod sequence never established IPC.
    legacy_prestart = (f"ExecStartPre=+/usr/bin/chgrp {layout.prefix}-ipc {layout.run}\n"
                       f"ExecStartPre=+/usr/bin/chmod 2750 {layout.run}\n") if legacy_runtime_directory else ""
    common = """Restart=on-failure
RestartSec=3
TimeoutStopSec=25
KillMode=control-group
SendSIGKILL=yes
UMask=0077
LimitNOFILE=8192
TasksMax=256
MemoryMax=3G
MemorySwapMax=0
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictRealtime=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
"""
    worker_unit = f"""[Unit]
Description=Codex Harness {layout.instance} worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={layout.prefix}-control
Group={worker_group}
SupplementaryGroups={supplementary}
RuntimeDirectory=codex-harness-{layout.instance}
RuntimeDirectoryMode=2750
{legacy_prestart}{config_check}WorkingDirectory={supervisor}
ExecStart={node} --disable-sigusr1 {app}/dist/src/runtime/main.js
Environment=HOME={supervisor}
Environment=PATH={base}/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=HARNESS_WORKER_HOME={supervisor}
{native_home}Environment=HARNESS_CODEX_HOME={worker}/codex
Environment=HARNESS_CODEX_BIN={base}/codex/{codex_relative}
Environment=HARNESS_NATIVE_LAUNCHER={layout.control}/native-launch
Environment=HARNESS_NATIVE_USER={layout.prefix}-worker
Environment=HARNESS_ATTACHMENT_GID={config['workerGid']}
Environment=HARNESS_WORKER_SOCKET={layout.run}/worker.sock
EnvironmentFile={layout.config}/providers/current/provider.env
{provider_bind}
InaccessiblePaths={layout.state}/gateway {layout.state}/transactions {layout.config}/gateway-token
ProtectProc=invisible
NoNewPrivileges=no
CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_AUDIT_WRITE
{common}"""
    # The sole sudo RPC must retain host write namespaces. DAC ownership, rather
    # than ProtectSystem, separates gateway from root-managed configuration/code.
    gateway_unit = f"""[Unit]
Description=Codex Harness {layout.instance} gateway
After={layout.unit('worker')}
Wants={layout.unit('worker')}

[Service]
Type=simple
User={layout.prefix}-gateway
Group={layout.prefix}-gateway
SupplementaryGroups={layout.prefix}-ipc
WorkingDirectory={layout.state}/gateway
ExecStart={node} --disable-sigusr1 {app}/dist/src/gateway/main.js
Environment=HOME={layout.state}/gateway
Environment=HARNESS_TOKEN_FILE={layout.config}/gateway-token
Environment=HARNESS_STATE_DIR={layout.state}/gateway
Environment=HARNESS_STATIC_DIR={app}/web/dist
Environment=HARNESS_WORKER_SOCKET={layout.run}/worker.sock
Environment=HARNESS_MANAGE_COMMAND={layout.control}/manage
Environment=HARNESS_ORIGIN={origin}
Environment=HARNESS_LISTEN_HOST=127.0.0.1
Environment=HARNESS_LISTEN_PORT={port}
NoNewPrivileges=no
{common}"""
    result = {layout.unit("worker"): worker_unit, layout.unit("gateway"): gateway_unit}
    if layered:
        result[layout.unit("config-check")] = render_config_check(layout)
    return result


def sudo_rule(layout: Layout, *, workspace: bool = True) -> str:
    return (f"Defaults:{layout.prefix}-gateway env_reset,!setenv\n"
            f"{layout.prefix}-gateway ALL=(root) NOPASSWD: {layout.control}/manage rpc\n"
            f"Defaults:{layout.prefix}-control env_reset,!setenv,!use_pty\n"
            f"{layout.prefix}-control ALL=({layout.prefix}-worker) NOPASSWD: {layout.control}/native-launch version, "
            f"{layout.control}/native-launch app-server, {layout.control}/native-launch resolve-project" +
            (f", {layout.control}/native-launch workspace" if workspace else "") + "\n")


def render_config_check(layout: Layout) -> str:
    # A separate PID1-created unit observes the host namespace. '+' on the
    # worker's ExecStartPre does not bypass its BindReadOnlyPaths on supported
    # hosts. This unit has no file binds, writes, shell, caller input or lock.
    return (f"[Unit]\nDescription=Codex Harness {layout.instance} host policy check\n[Service]\nType=oneshot\nUser=root\n"
            f"ExecStart={layout.control}/manage config-check\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\n"
            "PrivateNetwork=yes\nRestrictAddressFamilies=AF_UNIX\nProtectKernelTunables=yes\nProtectKernelModules=yes\n"
            "ProtectControlGroups=yes\nMemoryMax=128M\nMemorySwapMax=0\nTasksMax=16\nTimeoutStartSec=15\n"
            "TimeoutStopSec=5\nKillMode=control-group\nUMask=0077\n")


def render_edge_units(layout: Layout, *, builtin: bool = False) -> dict[str, str]:
    data = layout.state / "identity"
    common = "Restart=on-failure\nRestartSec=3\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nTimeoutStopSec=25\nKillMode=control-group\nMemoryMax=512M\nTasksMax=64\n\n[Install]\nWantedBy=multi-user.target\n"
    auth = (f"[Unit]\nDescription=Codex Harness {layout.instance} identity\nAfter=network-online.target\n\n[Service]\n"
            f"User={layout.prefix}-auth\nGroup={layout.prefix}-auth\nExecStart={layout.control}/edge/authelia/authelia --config {layout.config}/identity/configuration.json\n"
            f"ReadWritePaths={data}\nCapabilityBoundingSet=\n" + common)
    after = layout.unit('gateway' if builtin else 'authelia')
    caddy = (f"[Unit]\nDescription=Codex Harness {layout.instance} HTTPS\nAfter={after}\n\n[Service]\n"
             f"User={layout.prefix}-edge\nGroup={layout.prefix}-edge\nEnvironment=HOME={layout.state}/caddy\n"
             f"ExecStart={layout.control}/edge/caddy/caddy run --config {layout.config}/Caddyfile --adapter caddyfile\n"
             f"ReadWritePaths={layout.state}/caddy\nAmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n" + common)
    return {layout.unit("caddy"): caddy} if builtin else {layout.unit("authelia"): auth, layout.unit("caddy"): caddy}
