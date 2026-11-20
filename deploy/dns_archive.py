"""Retain stopped, unmounted DNS build evidence outside the eight-build pool."""
from __future__ import annotations
import os
from .common import DeployError, fsync_directory, mkdir, read_json, require, write_json
from .candidate_archive import identity, ordinary_directory, unmounted
from .ownership import present
from .system import run
from .dns_caddy_build import fetch_suffixes


def producer_units(manager, build, location):
    prefix = f"codex-harness-{manager.layout.instance}-dns-fetch-"
    suffixes = fetch_suffixes(build)
    marker = location / "fetch-units.json"
    if present(marker):
        from .service_lifecycle import read_private
        record = read_private(marker)
        started = record.get("started")
        require(isinstance(started, list) and len(started) <= len(suffixes) and started == suffixes[:len(started)] and
                record == {"format": 1, "suffixes": suffixes, "started": started}, "DNS fetch producer inventory changed", "integrity")
    else:
        # Historical retries used random suffixes. Never stop another build's
        # ambiguous producer; wait for every such live fetch/cgroup to quiesce.
        from .control_update import ControlSystem
        for unit in ControlSystem().instance_units(manager.layout):
            if unit.startswith(prefix) and unit != prefix + build + ".service":
                require(manager.system.state(unit)["stopped"], "An unidentified historical DNS fetch is still active", "stop_unknown")
                group = run(["/usr/bin/systemctl", "show", unit, "--property=ControlGroup", "--value"]).stdout.strip()
                if group:
                    from pathlib import Path
                    require(group.startswith("/") and ".." not in group.split("/") and not any(c.isspace() for c in group), "Invalid DNS cgroup", "stop_unknown")
                    directory = Path("/sys/fs/cgroup") / group.lstrip("/")
                    require(not directory.exists() or "populated 0" in (directory / "cgroup.events").read_text().splitlines(), "Historical DNS fetch is populated", "stop_unknown")
        suffixes = [build]
    return [prefix + suffix + ".service" for suffix in suffixes] + [
        f"codex-harness-{manager.layout.instance}-{stage}-{build}.service" for stage in ("dns-verify", "dns-test", "dns-build", "dns-probe")]


def list_dns(manager):
    paths = {path.name.removeprefix("dns-build-"): path for path in manager.layout.work.glob("dns-build-*")}
    root = manager.layout.work.parent / "operator-archives" / manager.layout.instance / "dns"
    if present(root):
        ordinary_directory(root)
        for path in root.glob("*.json"):
            if read_json(path).get("phase") == "prepared" and path.stem not in paths:
                paths[path.stem] = root / ("dns-build-" + path.stem)
    rows = []
    for build, path in sorted(paths.items()):
        try:
            identity(build)
            ordinary_directory(path)
            units = producer_units(manager, build, path)
            needs_stop = any(not manager.system.state(unit)["stopped"] for unit in units)
            unmounted(path, retained_images=True, inspect_only=True, dns=True)
            rows.append({"id": build, "dns": True, "eligible": True, "requiresProducerStop": needs_stop})
        except (DeployError, OSError, ValueError) as exc:
            rows.append({"id": build, "dns": True, "eligible": False, "reason": str(exc)})
    return rows


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
    for unit in producer_units(manager, build, location):
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
    unmounted(location, retained_images=True, allow_cleanup=True, dns=True)
    if location == source:
        require(root.stat().st_dev == source.stat().st_dev, "DNS archive requires the same filesystem", "unsafe_path")
        write_json(record, {"format": 1, "id": build, "inode": inode, "phase": "prepared"})
        require(list(ordinary_directory(source)) == inode and not present(target), "DNS archive identity changed", "conflict")
        os.rename(source, target)
        fsync_directory(source.parent)
        fsync_directory(root)
    write_json(record, {"format": 1, "id": build, "inode": inode, "phase": "complete"})
    return {"archived": True, "build": build, "archive": str(target), "dataPreserved": True}
