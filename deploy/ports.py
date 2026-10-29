"""Read-only, bounded Linux listener preflight; never stop another service."""
from __future__ import annotations

import os
import re
from pathlib import Path

from .common import DeployError, require


def require_ports_available(*, tcp_ports: tuple[int, ...], udp_ports: tuple[int, ...] = (),
                            allowed_pid: int | None = None, proc_root: Path = Path("/proc")) -> None:
    """Reject listeners on any local interface, except verified owning PID FDs.

    This is a conservative preflight, not a reservation: a later bind can still
    race and must be handled by the caller's startup/rollback transaction.
    proc_root is fixture-only; no operator or gateway API exposes it.
    """
    require(all(type(port) is int and 1 <= port <= 65535 for port in (*tcp_ports, *udp_ports)), "Invalid port")
    require(allowed_pid is None or type(allowed_pid) is int and allowed_pid > 0, "Invalid listener owner")
    owned = set()
    try:
        if allowed_pid is not None:
            with os.scandir(proc_root / str(allowed_pid) / "fd") as entries:
                for count, entry in enumerate(entries):
                    require(count < 65536, "Listener owner descriptor budget exceeded", "port_unknown")
                    try:
                        target = os.readlink(entry.path)
                    except FileNotFoundError:
                        continue  # A concurrently closed descriptor cannot own a listener now.
                    match = re.fullmatch(r"socket:\[(\d+)\]", target)
                    if match:
                        owned.add(match[1])
        for protocol, ports, state in (("tcp", tcp_ports, "0A"), ("udp", udp_ports, "07")):
            if not ports:
                continue
            for suffix in ("", "6"):
                path = proc_root / "net" / (protocol + suffix)
                try:
                    with path.open("rb") as stream:
                        data = stream.read(4 * 1024 * 1024 + 1)
                except FileNotFoundError:
                    if suffix:
                        continue  # IPv6 can be disabled on the host.
                    raise
                require(len(data) <= 4 * 1024 * 1024, "Listener table exceeds inspection budget", "port_unknown")
                lines = data.decode("ascii").splitlines()
                require(lines and "local_address" in lines[0], "Invalid kernel listener table", "port_unknown")
                for line in lines[1:]:
                    fields = line.split()
                    require(len(fields) >= 10, "Invalid kernel listener row", "port_unknown")
                    if fields[3] != state:
                        continue
                    local_port = fields[1].rsplit(":", 1)[1]
                    require(bool(re.fullmatch(r"[0-9A-Fa-f]{4}", local_port)) and fields[9].isdigit(),
                            "Invalid kernel listener address", "port_unknown")
                    port = int(local_port, 16)
                    require(port not in ports or fields[9] in owned,
                            f"Port {port}/{protocol} is already used by another or unknown process", "port_conflict")
    except (OSError, UnicodeError, IndexError) as exc:
        raise DeployError("port_unknown", "Cannot establish listener ownership before changing services") from exc


def require_edge_ports_available(manager, *, http_port: int, https_port: int) -> None:
    unit = manager.layout.unit("caddy")
    state = manager.system.state(unit)
    running = state["ActiveState"] == "active" and state["SubState"] == "running" and state["ControlPID"] == "0"
    require(state["stopped"] or running and state["MainPID"] != "0", "Caddy listener ownership is not stable", "port_unknown")
    require_ports_available(tcp_ports=(http_port, https_port), udp_ports=(https_port,),
                            allowed_pid=int(state["MainPID"]) if running else None)
    require(manager.system.state(unit) == state, "Caddy changed during listener inspection", "port_unknown")
