"""Retain stopped, unmounted DNS build evidence outside the eight-build pool."""
from __future__ import annotations
import os
from .common import fsync_directory, mkdir, read_json, require, write_json
from .candidate_archive import identity, ordinary_directory, unmounted
from .ownership import present
from .system import run


def archive(manager, build, *, confirm=False):
    require(confirm, "确认停止所选 DNS 构建并保留其文件；不会删除凭据或已选核心。")
    identity(build)
    manager.require_recovered_transactions(None)
    manager.require_service_ownership()
    manager.verify(https_probe=False)
    source = manager.layout.work / ("dns-build-" + build)
    root = manager.layout.work.parent / "operator-archives" / manager.layout.instance / "dns"
    for directory in (root.parent.parent, root.parent, root):
        if present(directory):
            ordinary_directory(directory)
        else:
            mkdir(directory, 0o700)
            fsync_directory(directory.parent)
    target, record = root / source.name, root / (build + ".json")
    saved = read_json(record) if present(record) else None
    if saved is not None:
        require(set(saved) == {"format", "id", "inode", "phase"} and saved["format"] == 1 and saved["id"] == build and saved["phase"] in ("prepared", "complete"), "Invalid DNS archive binding", "integrity")
    require(not present(target) or saved is not None and not present(source), "DNS archive destination is occupied or ambiguous", "collision")
    location = target if present(target) else source
    inode = list(ordinary_directory(location))
    require(saved is None or saved["inode"] == inode, "DNS build directory identity changed", "integrity")
    for stage in ("dns-fetch", "dns-verify", "dns-test", "dns-build", "dns-probe"):
        unit = f"codex-harness-{manager.layout.instance}-{stage}-{build}.service"
        manager.system.stop([unit])
        require(manager.system.state(unit)["stopped"], "DNS build unit stop could not be confirmed", "stop_unknown")
        result = run(["/usr/bin/systemctl", "show", unit, "--property=ControlGroup", "--value"])
        group = result.stdout.strip()
        if group:
            from pathlib import Path
            require(group.startswith("/") and ".." not in group.split("/") and not any(c.isspace() for c in group), "Invalid DNS build cgroup", "stop_unknown")
            directory = Path("/sys/fs/cgroup") / group.lstrip("/")
            if directory.exists():
                events = dict(line.split() for line in (directory / "cgroup.events").read_text().splitlines())
                require(events.get("populated") == "0", "DNS build cgroup is populated", "stop_unknown")
    unmounted(location, retained_images=True)
    if location == source:
        require(root.stat().st_dev == source.stat().st_dev, "DNS archive requires the same filesystem", "unsafe_path")
        write_json(record, {"format": 1, "id": build, "inode": inode, "phase": "prepared"})
        require(list(ordinary_directory(source)) == inode and not present(target), "DNS archive identity changed", "conflict")
        os.rename(source, target)
        fsync_directory(source.parent)
        fsync_directory(root)
    write_json(record, {"format": 1, "id": build, "inode": inode, "phase": "complete"})
    return {"archived": True, "build": build, "archive": str(target), "dataPreserved": True}
