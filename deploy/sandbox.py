"""Credential-free Codex sandbox admission using the actual native identity."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

from .common import DeployError, Layout, read_json, require
from .system import run


def command(layout: Layout, identity: str, binary: Path, uid: int, gid: int) -> tuple[str, list[str]]:
    require(re.fullmatch("[0-9a-f]{32}", identity) is not None, "Invalid sandbox probe identity")
    require(type(uid) is int and uid > 0 and type(gid) is int and gid > 0, "Native sandbox identity must be unprivileged", "prerequisite")
    require(binary.is_absolute(), "Sandbox binary must be absolute")
    name = f"codex-harness-{layout.instance}-sandbox-{identity}"
    home = "/run/" + name
    properties = {
        "User": str(uid), "Group": str(gid), "SupplementaryGroups": "",
        "WorkingDirectory": home, "RuntimeDirectory": name, "RuntimeDirectoryMode": "0700",
        "RuntimeDirectoryPreserve": "no", "UMask": "0077", "NoNewPrivileges": "yes",
        "CapabilityBoundingSet": "", "AmbientCapabilities": "", "PrivateNetwork": "yes",
        "PrivateTmp": "yes", "ProtectKernelTunables": "yes", "ProtectKernelModules": "yes",
        "ProtectControlGroups": "yes", "RestrictRealtime": "yes", "LockPersonality": "yes",
        "MemoryMax": "512M", "MemorySwapMax": "0", "TasksMax": "64", "LimitNOFILE": "1024",
        "LimitFSIZE": "16777216", "RuntimeMaxSec": "30", "TimeoutStopSec": "10",
        "KillMode": "control-group", "SendSIGKILL": "yes", "StandardOutput": "journal",
        "StandardError": "journal", "LogRateLimitIntervalSec": "30s", "LogRateLimitBurst": "50",
    }
    argv = ["/usr/bin/systemd-run", "--quiet", "--wait", "--unit=" + name + ".service"]
    argv.extend("--property=" + key + "=" + value for key, value in properties.items())
    argv += ["--", "/usr/bin/env", "-i", "HOME=" + home, "CODEX_HOME=" + home,
             "PATH=/usr/bin:/bin", "LANG=C.UTF-8", str(binary), "sandbox", "-c", 'sandbox_mode="read-only"', "--", "/usr/bin/true"]
    return name + ".service", argv


def require_host() -> None:
    require(Path("/usr/bin/bwrap").is_file(),
            "Codex sandbox requires bubblewrap (/usr/bin/bwrap); install the distribution bubblewrap package before retrying", "prerequisite")


def preflight(layout: Layout, system, identity: str, binary: Path) -> None:
    require_host()
    config = read_json(layout.config / "instance.json")
    unit, argv = command(layout, identity, binary, config["workerUid"], config["workerGid"])
    failure = None
    try:
        run(argv, timeout=60)
    except (DeployError, subprocess.TimeoutExpired) as exc:
        failure = exc
    # A failed or timed-out admission never makes a candidate publishable. Stop
    # verification also precedes systemd's private-runtime-directory cleanup.
    system.stop([unit])
    if failure is not None:
        raise DeployError("sandbox_prerequisite", "Codex sandbox failed under the native UID. Check this probe unit's journal, bubblewrap and per-program user-namespace/AppArmor policy; no global security policy was changed") from failure
