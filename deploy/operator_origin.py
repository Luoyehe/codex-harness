"""Keep the root authorization workflow outside this application's process tree.

This is a provenance check for direct use, not a boundary against an already
host-root process that deliberately escapes its cgroup or rewrites the host.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

from .common import DeployError, require

MANAGED = re.compile(r"(?:^|/)codex-harness-[a-z0-9-]+-(?:worker|gateway|manage-[0-9a-f]+)\.service(?:/|$)")


def require_external_operator(config: dict | None = None, *, proc: Path = Path("/proc"), pid: int | None = None) -> None:
    require(os.name == "posix" and os.getuid() == os.geteuid() == 0,
            "Root authorization requires an independent administrator SSH or console session", "operator_required")
    # Full host root has already been explicitly enabled. The administrator's
    # root tools remain real root; this workflow guard is for the closed mode.
    if config is not None:
        from .execution_identity import state
        current = state(config)
        if current["mode"] == "root" and current["rootAllowed"]:
            return
    current, visited = os.getpid() if pid is None else pid, set()
    try:
        while current > 0:
            require(current not in visited and len(visited) < 128, "Cannot establish administrator process ancestry", "operator_origin_unknown")
            visited.add(current)
            directory = proc / str(current)
            first = (directory / "stat").read_text()
            tail = first.rsplit(")", 1)[1].split()
            require(len(tail) >= 20, "Cannot establish administrator process ancestry", "operator_origin_unknown")
            parent, started = int(tail[1]), tail[19]
            cgroups = (directory / "cgroup").read_text()
            require(len(cgroups) <= 65536 and not any(MANAGED.search(line.split(":", 2)[-1]) for line in cgroups.splitlines()),
                    "不能从网页终端或 Agent 执行链授权或撤销 root；请使用独立的服务器 SSH/控制台。", "operator_origin_forbidden")
            again = (directory / "stat").read_text().rsplit(")", 1)[1].split()
            require(len(again) >= 20 and int(again[1]) == parent and again[19] == started,
                    "Administrator process ancestry changed", "operator_origin_unknown")
            if current == 1:
                break
            require(0 < parent < 2**31, "Cannot establish administrator process ancestry", "operator_origin_unknown")
            current = parent
    except (OSError, ValueError, IndexError) as exc:
        raise DeployError("operator_origin_unknown", "无法确认独立管理会话；请从服务器 SSH/控制台运行 root 授权操作。") from exc
