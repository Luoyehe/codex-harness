from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

from .common import DeployError, Layout, require


def run(argv: list[str], *, timeout: int = 120, input: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(argv, input=input, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "HOME": "/nonexistent"},
                            cwd="/", close_fds=True)
    if check and result.returncode:
        # Do not echo argv/input or arbitrary subprocess stderr: these can contain credentials.
        raise DeployError("command_failed", f"{Path(argv[0]).name} failed (exit {result.returncode})")
    return result


def parse_unit_state(text: str, returncode: int = 0) -> dict:
    """An empty/failed query is unknown, never synonymous with stopped."""
    require(returncode == 0, "Cannot establish systemd unit state", "stop_unknown")
    values = {}
    for line in text.splitlines():
        if not line:
            continue
        require("=" in line, "Malformed unit state", "stop_unknown")
        key, value = line.split("=", 1)
        require(key not in values and value != "", "Duplicate or empty unit state", "stop_unknown")
        values[key] = value
    required = {"LoadState", "ActiveState", "SubState", "MainPID", "ControlPID"}
    require(set(values) == required, "Incomplete unit state", "stop_unknown")
    require(values["MainPID"].isdigit() and values["ControlPID"].isdigit(), "Invalid PID state", "stop_unknown")
    stopped = (values["MainPID"] == "0" and values["ControlPID"] == "0" and
               ((values["LoadState"] == "loaded" and values["ActiveState"] in ("inactive", "failed") and
                 values["SubState"] in ("dead", "failed")) or
                (values["LoadState"] == "not-found" and values["ActiveState"] == "inactive" and values["SubState"] == "dead")))
    return {**values, "stopped": stopped}


class System:
    def state(self, unit: str) -> dict:
        result = run(["/usr/bin/systemctl", "show", unit, "--property=LoadState,ActiveState,SubState,MainPID,ControlPID"], check=False)
        return parse_unit_state(result.stdout, result.returncode)

    def stop(self, units: list[str]) -> None:
        run(["/usr/bin/systemctl", "stop", *units], check=False)
        for unit in units:
            require(self.state(unit)["stopped"], "Service stop was not confirmed; recovery materials retained", "stop_unknown")
            group = run(["/usr/bin/systemctl", "show", unit, "--property=ControlGroup", "--value"], check=False)
            require(group.returncode == 0, "Cannot establish stopped service cgroup", "stop_unknown")
            name = group.stdout.strip()
            if name:
                require(name.startswith("/") and ".." not in name.split("/") and not any(char.isspace() for char in name),
                        "Invalid service cgroup path", "stop_unknown")
                directory = Path("/sys/fs/cgroup") / name.lstrip("/")
                if directory.exists():
                    try:
                        events = dict(line.split() for line in (directory / "cgroup.events").read_text().splitlines())
                    except (OSError, ValueError) as exc:
                        raise DeployError("stop_unknown", "Cannot establish cgroup population") from exc
                    require(events.get("populated") == "0", "Service cgroup still contains processes", "stop_unknown")

    def start(self, units: list[str]) -> None:
        run(["/usr/bin/systemctl", "start", *units])

    def reload(self) -> None:
        run(["/usr/bin/systemctl", "daemon-reload"])

    def enable(self, units: list[str]) -> None:
        run(["/usr/bin/systemctl", "enable", *units])

    def logs(self, unit: str, lines: int) -> str:
        require(type(lines) is int and 1 <= lines <= 500, "Log lines must be between 1 and 500")
        result = run(["/usr/bin/journalctl", "--unit", unit, "--lines", str(lines), "--no-pager", "--output=cat"], timeout=15)
        return result.stdout[-131072:]

    def isolated(self, layout: Layout, name: str, argv: list[str], cwd: Path, writable: Path,
                 *, network: bool, timeout: int = 900) -> None:
        require(bool(re.fullmatch(r"[a-z0-9-]+", name)), "Invalid isolated stage")
        unit = f"codex-harness-{layout.instance}-{name}.service"
        properties = {
            "User": layout.prefix + "-build", "Group": layout.prefix + "-build",
            "WorkingDirectory": str(cwd), "UMask": "0022", "NoNewPrivileges": "yes",
            "CapabilityBoundingSet": "", "AmbientCapabilities": "", "PrivateTmp": "yes",
            "TemporaryFileSystem": "/tmp:rw,nosuid,nodev,size=128M /var/tmp:rw,nosuid,nodev,size=128M",
            "ProtectSystem": "strict", "ProtectHome": "yes", "PrivateDevices": "yes",
            "ProtectKernelTunables": "yes", "ProtectKernelModules": "yes", "ProtectControlGroups": "yes",
            "RestrictSUIDSGID": "yes", "LockPersonality": "yes", "RemoveIPC": "yes",
            "RestrictRealtime": "yes", "MemoryMax": "2G", "MemorySwapMax": "0", "TasksMax": "128",
            "CPUQuota": "200%", "LimitNOFILE": "4096", "LimitFSIZE": "536870912",
            "RuntimeMaxSec": str(timeout), "TimeoutStopSec": "15", "KillMode": "control-group",
            "SendSIGKILL": "yes", "ReadWritePaths": str(writable),
            "InaccessiblePaths": f"-{layout.config} -{layout.state} -/run/user -/run/codex-harness-{layout.instance}",
            "PrivateNetwork": "no" if network else "yes",
            "RestrictAddressFamilies": "AF_UNIX AF_INET AF_INET6" if network else "AF_UNIX",
            # pnpm reports policy/install failures on stdout. Keep stage logs in
            # the operator journal under the same rate limit as stderr; these
            # stages receive only the credential-free environment below.
            "StandardOutput": "journal", "StandardError": "journal", "LogRateLimitIntervalSec": "30s",
            "LogRateLimitBurst": "100",
        }
        command = ["/usr/bin/systemd-run", "--quiet", "--wait", "--unit=" + unit]
        for key, value in properties.items():
            command += ["--property=" + key + "=" + value]
        command += ["--", "/usr/bin/env", "-i", f"HOME={writable}/home", "CI=1", "LANG=C.UTF-8",
                    "NPM_CONFIG_USERCONFIG=/dev/null", "NPM_CONFIG_GLOBALCONFIG=/dev/null",
                    f"PNPM_HOME={writable}/pnpm-home", f"PATH={layout.work}/toolchain/node/bin:/usr/bin:/bin", *argv]
        failure = None
        try:
            run(command, timeout=timeout + 45)
        except (DeployError, subprocess.TimeoutExpired) as exc:
            failure = exc
        # Even a timeout/error cannot release or import its writable directory yet.
        self.stop([unit])
        if failure:
            raise DeployError("candidate_failed", f"Isolated {name} stage failed; candidate retained") from failure


def require_linux() -> None:
    require(os.name == "posix" and hasattr(os, "geteuid") and os.geteuid() == 0,
            "Installation and management require Linux root", "unsupported_platform")
    import platform
    require(platform.system() == "Linux", "Linux is required", "unsupported_platform")
    require(Path("/sys/fs/cgroup/cgroup.controllers").is_file(), "A unified cgroup v2 systemd host is required", "prerequisite")
    release = {}
    for line in Path("/etc/os-release").read_text().splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            release[key] = value.strip('"')
    require((release.get("ID"), release.get("VERSION_ID")) in (("ubuntu", "24.04"), ("debian", "12")),
            "Supported systems are Ubuntu 24.04 and Debian 12", "unsupported_platform")
    for binary in ("/usr/bin/systemctl", "/usr/bin/systemd-run", "/usr/sbin/useradd", "/usr/bin/sudo",
                   "/usr/sbin/visudo", "/usr/sbin/mkfs.ext4", "/usr/bin/mount", "/usr/bin/umount", "/usr/bin/setpriv"):
        require(Path(binary).is_file(), f"Required operating system tool is absent: {binary}", "prerequisite")
