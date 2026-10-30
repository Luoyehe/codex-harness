"""Optional, instance-scoped Xray policy; never a host-wide UID proxy."""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import socket
import ssl
import stat
import time
import uuid
from pathlib import Path

from .common import atomic_write, canonical, fsync_directory, mkdir, read_json, require
from .system import run

PROXY_ROLES = ("proxy", "proxy-routes")
HEX = re.compile(r"[0-9a-f]{64}")
PRIVATE4 = ("0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/3")
PRIVATE6 = ("::/127", "fc00::/7", "fe80::/10", "ff00::/8")
UPSTREAM_TIMEOUT = 12


def selection(config):
    value = config.get("serviceProxy")
    if value is None:
        return None
    require(isinstance(value, dict) and set(value) == {"enabled", "port", "core", "configuration"} and
            type(value["enabled"]) is bool and type(value["port"]) is int and 1024 <= value["port"] <= 65534 and
            all(isinstance(value[k], str) and HEX.fullmatch(value[k]) for k in ("core", "configuration")),
            "Invalid service proxy selection", "integrity")
    return value


def enabled(config):
    value = selection(config)
    return value is not None and value["enabled"]


def roles(config, base=()):
    return tuple(base) + (PROXY_ROLES if selection(config) is not None else ())


def table_name(layout):
    # systemd255's identifier validator is stricter than nft's parser.
    return "chp" + hashlib.sha256(layout.instance.encode()).hexdigest()[:12]


def private_file(path: Path, *, limit=256 * 1024):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= limit and
            (os.name != "posix" or info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600),
            "Proxy input must be a bounded root-owned mode0600 regular file", "integrity")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as source:
        opened = os.fstat(source.fileno())
        data = source.read(limit + 1)
        require(os.path.samestat(info, opened) and len(data) <= limit and
                os.path.samestat(opened, path.lstat()) and opened.st_size == len(data) and
                os.fstat(source.fileno()).st_mtime_ns == opened.st_mtime_ns,
                "Proxy input changed while reading", "integrity")
    return data


def outbound(value):
    require(isinstance(value, dict), "Proxy configuration must be an object")
    if "outbounds" in value:
        rows = value["outbounds"]
        require(isinstance(rows, list) and len(rows) <= 16, "Invalid proxy outbounds")
        choices = [row for row in rows if isinstance(row, dict) and row.get("protocol") == "vless"]
        require(len(choices) == 1, "Import exactly one VLESS outbound")
        value = choices[0]
    elif "outbound" in value:
        require(set(value) == {"outbound"}, "Invalid VLESS import fields")
        value = value["outbound"]
    require(isinstance(value, dict) and not set(value) - {"tag", "protocol", "settings", "streamSettings", "mux"} and
            value.get("protocol") == "vless" and isinstance(value.get("settings"), dict) and
            isinstance(value.get("streamSettings", {}), dict) and isinstance(value.get("mux", {}), dict),
            "Import a VLESS outbound, without unrelated routing or listeners")
    # Only JSON data reaches Xray, which runs as a private DynamicUser. Do not
    # import logging, API, reverse-proxy or arbitrary inbound definitions.
    require(len(canonical(value)) <= 128 * 1024, "Proxy outbound exceeds budget", "budget")
    return {**value, "tag": "proxy"}


def configuration(value, port):
    require(type(port) is int and 1024 <= port <= 65534, "Proxy port must leave room for its adjacent HTTP listener")
    sniff = {"enabled": True, "destOverride": ["http", "tls"], "routeOnly": True}
    return {"log": {"loglevel": "none", "access": "none", "error": "none"},
            "inbounds": [{"tag": "tcp4", "listen": "127.0.0.1", "port": port, "protocol": "dokodemo-door",
                          "settings": {"network": "tcp", "followRedirect": True}, "sniffing": sniff},
                         {"tag": "tcp6", "listen": "::1", "port": port, "protocol": "dokodemo-door",
                          "settings": {"network": "tcp", "followRedirect": True}, "sniffing": sniff},
                         {"tag": "http", "listen": "127.0.0.1", "port": port + 1, "protocol": "http", "settings": {}}],
            "outbounds": [outbound(value), {"tag": "direct", "protocol": "freedom", "settings": {}}],
            "routing": {"domainStrategy": "IPIfNonMatch", "rules": [
                {"type": "field", "domain": ["domain:localhost", "domain:bigmodel.cn"], "outboundTag": "direct"},
                {"type": "field", "domain": ["geosite:cn"], "outboundTag": "direct"},
                {"type": "field", "ip": ["geoip:private", "geoip:cn"], "outboundTag": "direct"}]}}


def config_path(layout, identity):
    require(isinstance(identity, str) and HEX.fullmatch(identity), "Invalid proxy configuration identity", "integrity")
    return layout.config / "proxy/configurations" / identity / "xray.json"


def prepare_configuration(layout, path, port):
    try:
        value = json.loads(private_file(path))
    except (ValueError, UnicodeError) as error:
        from .common import DeployError
        raise DeployError("invalid_input", "Proxy input must be valid JSON") from error
    data = canonical(configuration(value, port)) + b"\n"
    identity = hashlib.sha256(data).hexdigest()
    target = config_path(layout, identity)
    if target.exists() or target.is_symlink():
        require(private_file(target) == data, "Retained proxy configuration changed", "integrity")
    else:
        for directory in (layout.config / "proxy", layout.config / "proxy/configurations", target.parent):
            if directory.exists() or directory.is_symlink():
                info = directory.lstat()
                require(stat.S_ISDIR(info.st_mode) and (os.name != "posix" or info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700),
                        "Unsafe proxy configuration directory", "integrity")
            else:
                mkdir(directory, 0o700)
                fsync_directory(directory.parent)
        atomic_write(target, data)
    return identity


def verify_configuration(layout, value):
    data = private_file(config_path(layout, value["configuration"]))
    require(hashlib.sha256(data).hexdigest() == value["configuration"], "Proxy configuration digest changed", "integrity")
    document = json.loads(data)
    require(canonical(configuration(document, value["port"])) + b"\n" == data,
            "Proxy configuration is not the fixed generated policy", "integrity")


def verify_selection(layout, config):
    value = selection(config)
    if value is None:
        return None
    from .proxy_core import verify_core
    metadata = verify_core(layout, value["core"])
    verify_configuration(layout, value)
    return metadata


def render_proxy_units(layout, config):
    value = selection(config)
    if value is None:
        return {}
    from .proxy_core import core_path
    core = core_path(layout, value["core"])
    proxy, routes_unit, worker = (layout.unit(name) for name in ("proxy", "proxy-routes", "worker"))
    common = "TimeoutStopSec=15\nKillMode=control-group\nSendSIGKILL=yes\nUMask=0077\n"
    return {proxy: f"""[Unit]
Description=Codex Harness {layout.instance} service proxy
Before={worker}

[Service]
Type=exec
DynamicUser=yes
LoadCredential=proxy-config.json:{config_path(layout, value['configuration'])}
ExecStartPre=+{layout.control}/manage proxy-core-check
ExecStart={core}/xray run -config %d/proxy-config.json
Environment=XRAY_LOCATION_ASSET={core}
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
MemoryMax=256M
MemorySwapMax=0
TasksMax=64
StandardOutput=null
StandardError=null
{common}""",
            routes_unit: f"""[Unit]
Description=Codex Harness {layout.instance} service proxy routing
Requires={proxy}
After={proxy}
Before={worker}

[Service]
Type=oneshot
RemainAfterExit=yes
User=root
ExecStart={layout.control}/manage proxy-routes-start
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
RestrictAddressFamilies=AF_UNIX AF_NETLINK
CapabilityBoundingSet=CAP_NET_ADMIN
MemoryMax=64M
TasksMax=16
{common}"""}


def worker_unit_fields(layout, config):
    if not enabled(config):
        return "", ""
    proxy, routes_unit = (layout.unit(name) for name in PROXY_ROLES)
    unit = f"Requires={routes_unit}\nBindsTo={proxy}\nAfter={proxy} {routes_unit}\n"
    service = f"NFTSet=cgroup:inet:{table_name(layout)}:workers\nExecStartPre=+{layout.control}/manage proxy-ready\n"
    return unit, service


def routing_objects(layout, value):
    table = table_name(layout)
    objects = [{"table": {"family": "inet", "name": table, "comment": "CodexHarnessServiceProxy:" + layout.instance + ":1"}},
               {"set": {"family": "inet", "table": table, "name": "workers", "type": "cgroupsv2"}},
               {"chain": {"family": "inet", "table": table, "name": "output", "type": "nat", "hook": "output", "prio": -105, "policy": "accept"}},
               {"chain": {"family": "inet", "table": table, "name": "scoped"}}]
    def rule(chain, expressions):
        return {"rule": {"family": "inet", "table": table, "chain": chain, "expr": expressions}}
    objects.append(rule("output", [{"match": {"op": "==", "left": {"socket": {"key": "cgroupv2", "level": 2}}, "right": "@workers"}}, {"jump": {"target": "scoped"}}]))
    for protocol, addresses in (("ip", PRIVATE4), ("ip6", PRIVATE6)):
        prefixes = [{"prefix": {"addr": address.split("/")[0], "len": int(address.split("/")[1])}} for address in addresses]
        objects.append(rule("scoped", [{"match": {"op": "==", "left": {"payload": {"protocol": protocol, "field": "daddr"}}, "right": {"set": prefixes}}}, {"return": None}]))
    objects.append(rule("scoped", [{"match": {"op": "==", "left": {"meta": {"key": "l4proto"}}, "right": "tcp"}}, {"redirect": {"port": value["port"]}}]))
    return objects


def normalize_nft(objects):
    # Kernel-assigned handles and PID1-maintained set elements are not policy.
    result, rules = [], {}
    for row in objects:
        if "metainfo" in row:
            continue
        require(len(row) == 1 and next(iter(row)) in ("table", "set", "chain", "rule"), "Unexpected proxy firewall object", "integrity")
        kind, value = next(iter(row.items()))
        item = {kind: {key: item for key, item in value.items() if key not in ("handle", "elem")}}
        if kind == "rule":
            rules.setdefault(value["chain"], []).append(item)
        else:
            result.append(item)
    return {"objects": sorted(result, key=lambda row: canonical(row)), "rules": rules}


def read_routes(layout):
    result = run(["/usr/sbin/nft", "-j", "list", "table", "inet", table_name(layout)], check=False)
    if result.returncode:
        # Distinguish an absent owned table from an unavailable/failed nft query.
        tables = json.loads(run(["/usr/sbin/nft", "-j", "list", "tables"]).stdout)["nftables"]
        require(not any(v.get("table", {}).get("family") == "inet" and v.get("table", {}).get("name") == table_name(layout) for v in tables),
                "Cannot inspect service proxy routing", "integrity")
        return None
    objects = json.loads(result.stdout)["nftables"]
    # nft1.0.9's JSON output omits the socket ancestor level. Attest that
    # missing field against its textual output rather than silently ignoring it.
    raw = run(["/usr/sbin/nft", "list", "chain", "inet", table_name(layout), "output"]).stdout
    require(sum(bool(re.fullmatch(r"\s*socket cgroupv2 level 2 @workers jump scoped\s*", line)) for line in raw.splitlines()) == 1,
            "Proxy socket cgroup level differs from its fixed policy", "integrity")
    for row in objects:
        for expression in row.get("rule", {}).get("expr", []):
            item = expression.get("match", {}).get("left", {}).get("socket")
            if isinstance(item, dict) and item.get("key") == "cgroupv2":
                require(item.get("level", 2) == 2, "Unexpected proxy cgroup level", "integrity")
                item["level"] = 2
    return objects


def verify_routes(layout, value, objects=None):
    objects = read_routes(layout) if objects is None else objects
    require(objects is not None and normalize_nft(objects) == normalize_nft(routing_objects(layout, value)),
            "Service proxy firewall policy differs from its generated definition", "integrity")
    sets = [row["set"] for row in objects if "set" in row]
    require(len(sets) == 1, "Unexpected proxy cgroup sets", "integrity")
    elements = sets[0].get("elem", [])
    require(isinstance(elements, list) and len(elements) <= 34 and all(isinstance(item, str) for item in elements) and len(set(elements)) == len(elements),
            "Proxy cgroup membership is not instance-exclusive", "integrity")
    prefix = "system.slice/codex-harness-" + re.escape(layout.instance) + "-"
    require(all(isinstance(item, str) and re.fullmatch(prefix + r"(?:worker|gateway|manage-[0-9a-f]{32})\.service", item) for item in elements),
            "Proxy cgroup membership belongs to another service", "integrity")
    return elements


def apply_routes(layout, value, *, prior=None):
    old = read_routes(layout)
    objects = routing_objects(layout, value)
    if old is None:
        commands = [f'add table inet {table_name(layout)} {{ comment "CodexHarnessServiceProxy:{layout.instance}:1"; }}',
                    f"add set inet {table_name(layout)} workers {{ type cgroupsv2; }}",
                    f"add chain inet {table_name(layout)} output {{ type nat hook output priority -105; policy accept; }}",
                    f"add chain inet {table_name(layout)} scoped"]
    else:
        expected = [value] + ([prior] if prior is not None else [])
        require(any(normalize_nft(old) == normalize_nft(routing_objects(layout, option)) for option in expected),
                "Proxy firewall collision; existing rules were preserved", "ownership_conflict")
        verify_routes(layout, next(option for option in expected if normalize_nft(old) == normalize_nft(routing_objects(layout, option))), old)
        if normalize_nft(old) == normalize_nft(objects):
            return
        # Only chains change, in one batch. Never flush or replace the cgroup set.
        commands = [f"flush chain inet {table_name(layout)} {name}" for name in ("output", "scoped")]
    # nft1.0.9 accepts cgroupv2 in its textual parser but not its JSON input
    # parser. Every interpolated field is fixed/validated, never caller text.
    table = table_name(layout)
    commands += [f"add rule inet {table} output socket cgroupv2 level 2 @workers jump scoped",
                 f"add rule inet {table} scoped ip daddr {{ " + ", ".join(PRIVATE4) + " } return",
                 f"add rule inet {table} scoped ip6 daddr {{ " + ", ".join(PRIVATE6) + " } return",
                 f"add rule inet {table} scoped meta l4proto tcp redirect to :{value['port']}"]
    data = "\n".join(commands) + "\n"
    run(["/usr/sbin/nft", "--check", "-f", "-"], input=data)
    run(["/usr/sbin/nft", "-f", "-"], input=data)
    verify_routes(layout, value)


def remove_routes(layout, value):
    objects = read_routes(layout)
    if objects is None:
        return
    require(not verify_routes(layout, value, objects), "Stop the worker before removing proxy routing", "stop_unknown")
    run(["/usr/sbin/nft", "delete", "table", "inet", table_name(layout)])


def prerequisites():
    version = run(["/usr/bin/systemctl", "--version"]).stdout.splitlines()[0].split()
    require(len(version) >= 2 and version[1].isdigit() and int(version[1]) >= 255 and
            Path("/sys/fs/cgroup/cgroup.controllers").is_file() and Path("/usr/sbin/nft").is_file(),
            "Service proxy requires systemd255+, nftables and unified cgroup v2; disabled instances do not", "proxy_unsupported")


def active(state, role):
    return (state["ActiveState"] == "active" and state["ControlPID"] == "0" and
            (state["SubState"] == "exited" and state["MainPID"] == "0" if role == "proxy-routes" else
             state["SubState"] == "running" and state["MainPID"] != "0"))


def check_core_config(layout, value):
    from .proxy_core import core_path, verify_core
    verify_core(layout, value["core"])
    verify_configuration(layout, value)
    core = core_path(layout, value["core"])
    # The fixed input is imported JSON, never argv containing the VLESS secret.
    from .system import System
    unit = "codex-harness-" + layout.instance + "-proxy-check-" + uuid.uuid4().hex + ".service"
    command = ["/usr/bin/systemd-run", "--quiet", "--wait", "--unit=" + unit, "--property=Type=exec", "--property=DynamicUser=yes",
         "--property=NoNewPrivileges=yes", "--property=CapabilityBoundingSet=", "--property=PrivateNetwork=yes",
         "--property=RestrictAddressFamilies=AF_UNIX", "--property=ProtectSystem=strict", "--property=ProtectHome=yes",
         "--property=RuntimeMaxSec=20", "--property=KillMode=control-group", "--property=MemoryMax=256M",
         "--property=StandardOutput=null", "--property=StandardError=null",
         "--property=LoadCredential=proxy-config.json:" + str(config_path(layout, value["configuration"])),
         "--setenv=XRAY_LOCATION_ASSET=" + str(core), "--", str(core / "xray"), "run", "-test", "-config",
         "/run/credentials/" + unit + "/proxy-config.json"]
    try:
        run(command, timeout=30)
    finally:
        # Timeout of the waiting client never proves that its child stopped.
        System().stop([unit])


def current_cgroup():
    return next((line[3:].lstrip("/") for line in Path("/proc/self/cgroup").read_text().splitlines()
                 if line.startswith("0::")), None)


def require_management_membership(manager, request_id):
    if enabled(manager.config):
        expected = "system.slice/codex-harness-" + manager.layout.instance + "-manage-" + request_id + ".service"
        require(current_cgroup() == expected and expected in verify_routes(manager.layout, selection(manager.config)),
                "Management proxy cgroup membership is missing", "proxy_health")


def wait_listeners(manager, value, *, timeout=10):
    deadline = time.monotonic() + timeout
    while True:
        require(active(manager.system.state(manager.layout.unit("proxy")), "proxy"),
                "Service proxy core stopped before its listeners were ready", "proxy_health")
        try:
            for address, port in (("127.0.0.1", value["port"]), ("::1", value["port"]), ("127.0.0.1", value["port"] + 1)):
                remaining = deadline - time.monotonic()
                require(remaining > 0, "Service proxy listener readiness timed out", "proxy_health")
                with socket.create_connection((address, port), timeout=min(1, remaining)):
                    pass
            return
        except OSError:
            remaining = deadline - time.monotonic()
            require(remaining > 0, "Service proxy listener readiness timed out", "proxy_health")
            time.sleep(min(0.1, remaining))


def ready(manager, *, starting=False, upstream=False):
    value = selection(manager.config)
    if value is None or not value["enabled"]:
        return {"enabled": False, "ready": False}
    require(active(manager.system.state(manager.layout.unit("proxy")), "proxy"), "Service proxy core is not running", "proxy_health")
    members = verify_routes(manager.layout, value)
    if starting:
        current = current_cgroup()
        require(current in ["system.slice/" + manager.layout.unit(role) for role in ("worker", "gateway")] and current in members,
                "Starting service proxy cgroup membership is missing", "proxy_health")
    else:
        for role in ("worker", "gateway"):
            current = manager.system.state(manager.layout.unit(role))
            if not current["stopped"]:
                require("system.slice/" + manager.layout.unit(role) in members,
                        "Service proxy cgroup membership is missing", "proxy_health")
    wait_listeners(manager, value)
    if upstream:
        from .proxy_core import network_deadline
        with network_deadline(UPSTREAM_TIMEOUT, "proxy_timeout", "Service proxy HTTPS deadline exceeded"):
            connection = http.client.HTTPSConnection("127.0.0.1", value["port"] + 1, timeout=UPSTREAM_TIMEOUT, context=ssl.create_default_context())
            try:
                connection.set_tunnel("chatgpt.com", 443)
                connection.request("HEAD", "/", headers={"Host": "chatgpt.com"})
                response = connection.getresponse()
                try:
                    require(100 <= response.status <= 599, "Proxy TLS response is invalid", "proxy_health")
                finally:
                    response.close()
            finally:
                connection.close()
    return {"enabled": True, "ready": True, "cgroupScoped": True, "upstreamTlsVerified": upstream}


def status(manager):
    value = selection(manager.config)
    if value is None:
        return {"configured": False, "enabled": False, "coreVersion": None}
    from .proxy_core import verify_core
    metadata = verify_core(manager.layout, value["core"])
    return {"configured": True, "enabled": value["enabled"], "coreVersion": metadata["version"],
            "core": value["core"], "configuration": value["configuration"], "port": value["port"],
            "transport": "tcp", "scope": "instance-worker-gateway-management-cgroups", "directDomain": "bigmodel.cn",
            "services": {role: manager.system.state(manager.layout.unit(role)) for role in PROXY_ROLES}}


def helper(layout, action):
    from .manager import Manager
    allowed = {"proxy-core-check": ("proxy",), "proxy-routes-start": ("proxy-routes",), "proxy-ready": ("worker", "gateway")}
    require(action in allowed and hasattr(os, "geteuid") and os.geteuid() == 0 and
            current_cgroup() in ["system.slice/" + layout.unit(role) for role in allowed[action]],
            "Proxy helpers require their fixed root systemd service context", "permission")
    manager = Manager(layout)
    value = selection(manager.config)
    require(value is not None and value["enabled"], "Service proxy is not enabled", "proxy_disabled")
    if action == "proxy-core-check":
        verify_selection(layout, manager.config)
        return {"proxyHelper": action, "verified": True}
    if action == "proxy-routes-start":
        apply_routes(layout, value)
    else:
        require(action == "proxy-ready", "Unsupported proxy helper")
        ready(manager, starting=True)
    return {"proxyHelper": action, "ready": True}
