"""Operator-only archival of verified completed build workspaces, never releases."""
from __future__ import annotations

import http.client
import json
import os
import re
import socket
import stat
from pathlib import Path

from .common import DeployError, digest, fsync_directory, mkdir, require, write_json
from .control_update import ControlSystem
from .install import trusted_ancestors
from .install_recovery import initialization_lock, management_lock
from .manager import Manager
from .ownership import ROLES, present
from .service_lifecycle import (read_private, read_record, require_only_transaction,
                                restore_services, service_paths, uninstall_services, verify_retained)
from .system import run
from .transactions import require_initialization_complete, require_recovered

IDENTITY = re.compile(r"[0-9a-f]{32}\Z")
HASH = re.compile(r"[0-9a-f]{64}\Z")
STAGES = ("fetch", "install", "tsc", "web", "gateway-check", "worker-check", "runtime-probe", "sandbox")
PROBES = ("nativeInitializationProbe", "offlineBoundaryProbe", "nativeSandboxProbe")


def identity(value: str) -> str:
    require(isinstance(value, str) and IDENTITY.fullmatch(value) is not None, "Choose one exact 32-hex candidate ID")
    return value


def archive_root(layout) -> Path:
    return layout.work.parent / "operator-archives" / layout.instance


def ordinary_directory(path: Path) -> tuple[int, int]:
    trusted_ancestors(path)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and
            (os.name != "posix" or info.st_uid == 0 and not info.st_mode & 0o022), "Unsafe candidate directory", "integrity")
    return info.st_dev, info.st_ino


def unmounted(path: Path) -> None:
    # Decode mountinfo's escaped bytes before comparing complete path components.
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        fields = line.split()
        require(len(fields) >= 6, "Cannot inspect mount table", "stop_unknown")
        mounted = Path(re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), fields[4]))
        require(mounted != path and not mounted.is_relative_to(path), "Candidate still has mounted filesystems", "candidate_not_complete")
    require(not any(present(path / name) for name in ("fetch.ext4", "build.ext4")),
            "Candidate retains an image; inspect its interrupted cleanup", "candidate_not_complete")


def stopped_units(manager, candidate: str) -> None:
    for stage in STAGES:
        unit = f"codex-harness-{manager.layout.instance}-{stage}-{candidate}.service"
        require(manager.system.state(unit)["stopped"], "Candidate transient unit is still active", "stop_unknown")
        group = run(["/usr/bin/systemctl", "show", unit, "--property=ControlGroup", "--value"])
        name = group.stdout.strip()
        if name:
            require(name.startswith("/") and ".." not in name.split("/") and not any(char.isspace() for char in name),
                    "Invalid candidate cgroup", "stop_unknown")
            directory = Path("/sys/fs/cgroup") / name.lstrip("/")
            if directory.exists():
                events = dict(line.split() for line in (directory / "cgroup.events").read_text().splitlines())
                require(events.get("populated") == "0", "Candidate cgroup is populated", "stop_unknown")


def inspect_candidate(manager, candidate: str, *, path: Path | None = None) -> dict:
    candidate = identity(candidate)
    path = path or manager.layout.work / ("candidate-" + candidate)
    inode = ordinary_directory(path)
    record = manager.layout.state / "transactions" / candidate / "prepared.json"
    trusted_ancestors(record.parent)
    require(present(record), "Candidate has no successful preparation record", "candidate_not_complete")
    prepared = read_private(record)
    release = prepared.get("release")
    require(isinstance(release, str) and HASH.fullmatch(release) is not None and prepared.get("manifestDigest") == release and
            all(prepared.get(name) is True for name in PROBES), "Candidate has incomplete successful probe evidence", "candidate_not_complete")
    manager.verify_release(release)
    unmounted(path)
    stopped_units(manager, candidate)
    return {"id": candidate, "release": release, "preparedDigest": digest(prepared), "inode": list(inode)}


def list_candidates(manager) -> dict:
    rows = []
    trusted_ancestors(manager.layout.work)
    for path in sorted(manager.layout.work.glob("candidate-*")):
        candidate = path.name.removeprefix("candidate-")
        try:
            item = inspect_candidate(manager, candidate)
            rows.append({"id": candidate, "release": item["release"], "eligible": True})
        except (DeployError, OSError, ValueError) as exc:
            rows.append({"id": candidate, "eligible": False,
                         "reason": str(exc) if isinstance(exc, DeployError) else "Candidate evidence could not be verified"})
    count = len(rows)
    root = archive_root(manager.layout)
    if present(root):
        ordinary_directory(root)
        for record in sorted(root.glob("*.json")):
            candidate = record.stem
            saved = read_private(record)
            validate_inventory(saved, manager.layout, candidate)
            if saved["phase"] == "complete":
                continue
            existing = next((row for row in rows if row["id"] == candidate), None)
            if existing is not None:
                existing["resume"] = True
                continue
            try:
                check = inspect_candidate(manager, candidate, path=root / ("candidate-" + candidate))
                require(all(saved[key] == check[key] for key in ("id", "release", "preparedDigest", "inode")), "Archive binding changed", "integrity")
                rows.append({"id": candidate, "release": check["release"], "eligible": True, "resume": True})
            except (DeployError, OSError, ValueError):
                rows.append({"id": candidate, "eligible": False, "resume": True, "reason": "Retained archive requires inspection"})
    return {"candidates": rows, "count": count, "limit": 8, "archiveDirectory": str(root)}


def require_idle(manager) -> None:
    state = manager.system.state(manager.layout.unit("worker"))
    if state["stopped"]:
        require(manager.system.state(manager.layout.unit("gateway"))["stopped"], "Gateway still runs without the worker", "stop_unknown")
        return
    require(state["ActiveState"] == "active" and state["SubState"] == "running", "Worker activity is not stable", "stop_unknown")
    connection = http.client.HTTPConnection("localhost", timeout=3)
    try:
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(3)
        connection.sock.connect(str(manager.layout.run / "worker.sock"))
        connection.request("GET", "/status")
        response = connection.getresponse()
        raw = response.read(65537)
        require(response.status == 200 and len(raw) <= 65536, "Cannot inspect worker activity", "stop_unknown")
        status = json.loads(raw).get("result", {})
        activity = status.get("activity", {})
        require(status.get("connected") is True and status.get("restarting", False) is False and
                activity.get("activeThreads") == [] and activity.get("unknown") is False and
                all(type(activity.get(key)) is int and activity[key] == 0 for key in ("pendingStarts", "terminals", "subscriptions", "processes")),
                "Tasks are active or their state is unknown; finish them or recover/restart services before archival", "busy")
    except (OSError, ValueError, AttributeError) as exc:
        raise DeployError("stop_unknown", "Cannot establish idle worker activity") from exc
    finally:
        connection.close()


def validate_inventory(value: dict, layout, candidate: str) -> None:
    identity(candidate)
    require(set(value) == {"format", "instance", "id", "release", "preparedDigest", "inode", "phase", "lifecycle"} and
            value["format"] == 1 and value["instance"] == layout.instance and value["id"] == candidate and
            isinstance(value["release"], str) and HASH.fullmatch(value["release"]) is not None and
            isinstance(value["preparedDigest"], str) and HASH.fullmatch(value["preparedDigest"]) is not None and
            isinstance(value["inode"], list) and len(value["inode"]) == 2 and all(type(item) is int and item >= 0 for item in value["inode"]) and
            value["phase"] in ("prepared", "stopped", "moving", "archived", "complete") and
            (value["lifecycle"] is None if value["phase"] == "prepared" else
             isinstance(value["lifecycle"], str) and IDENTITY.fullmatch(value["lifecycle"]) is not None),
            "Invalid candidate archive inventory", "integrity")


def archive_locked(manager, candidate: str) -> dict:
    """Caller holds initialization then management lock throughout removal/move/restore."""
    layout = manager.layout
    candidate = identity(candidate)
    source = layout.work / ("candidate-" + candidate)
    root = archive_root(layout)
    target = root / source.name
    inventory = root / (candidate + ".json")
    # A root-private fixed destination cannot be selected through a CLI path.
    for directory in (root.parent, root):
        if present(directory):
            ordinary_directory(directory)
            require(os.name != "posix" or stat.S_IMODE(directory.stat().st_mode) == 0o700, "Archive directory must be private", "integrity")
        else:
            trusted_ancestors(directory.parent)
            mkdir(directory, 0o700)
            fsync_directory(directory.parent)
    require(root.stat().st_dev == layout.work.stat().st_dev, "Archive must be on the candidate filesystem", "unsafe_path")
    saved = read_private(inventory) if present(inventory) else None
    if saved is not None:
        validate_inventory(saved, layout, candidate)
    moved = present(target)
    require(not moved or saved is not None and saved["phase"] in ("moving", "archived", "complete") and not present(source),
            "Archive destination already exists or movement is ambiguous; nothing overwritten", "collision")
    current = inspect_candidate(manager, candidate, path=target if moved else source)
    if saved is not None:
        require(all(saved[key] == current[key] for key in ("id", "release", "preparedDigest", "inode")),
                "Candidate archive binding changed", "integrity")
    if saved is not None and saved["phase"] == "complete":
        require(moved, "Completed archive disappeared", "integrity")
        return {"archived": True, "alreadyArchived": True, "candidate": candidate, "archive": str(target)}
    if saved is not None and not moved and saved["phase"] != "prepared":
        previous_journal, previous_lifecycle = read_record(layout)
        require(previous_journal.parent.name == saved["lifecycle"], "Archive maintenance transaction changed", "recovery_required")
        if previous_lifecycle["phase"] == "recovered":
            # An operator may explicitly restore services after a failed stop or
            # move. A new invocation must acquire a fresh stopped window.
            saved.update(phase="prepared", lifecycle=None)
    if saved is None or saved["phase"] == "prepared":
        require_recovered(layout)
        manager.require_service_ownership()
        require_idle(manager)
        saved = {"format": 1, "instance": layout.instance, **current, "phase": "prepared", "lifecycle": None}
        write_json(inventory, saved)
        result = uninstall_services(manager)
        require(result.get("servicesRemoved") is True, "Service maintenance did not complete", "recovery_required")
        saved.update(phase="stopped", lifecycle=result["transaction"])
        write_json(inventory, saved)
    journal, lifecycle = read_record(layout)
    require(journal.parent.name == saved["lifecycle"], "Archive belongs to a different service maintenance transaction", "recovery_required")
    require_only_transaction(layout, journal)
    verify_retained(manager, lifecycle)
    if not moved:
        require(lifecycle["phase"] == "removed", "Restore pending services before retrying archival", "recovery_required")
        require(all(not present(path) for path in service_paths(layout).values()), "A removed service definition reappeared", "ownership_conflict")
        units = list(dict.fromkeys([layout.unit(role) for role in ROLES] + manager.system.instance_units(layout)))
        manager.system.stop(units)
        manager.system.stop(units)
        manager.system.no_instance_processes(layout, manager.config)
        check = inspect_candidate(manager, candidate)
        require(all(saved[key] == check[key] for key in ("id", "release", "preparedDigest", "inode")), "Candidate changed during maintenance", "integrity")
        require(not present(target) and root.stat().st_dev == source.stat().st_dev, "Archive destination changed", "collision")
        saved["phase"] = "moving"
        write_json(inventory, saved)
        os.rename(source, target)
        fsync_directory(source.parent)
        fsync_directory(target.parent)
    saved["phase"] = "archived"
    write_json(inventory, saved)
    restore_services(manager)
    saved["phase"] = "complete"
    write_json(inventory, saved)
    return {"archived": True, "candidate": candidate, "archive": str(target), "inventory": str(inventory),
            "release": saved["release"], "dataPreserved": True, "servicesRestored": True}


def archive_candidate(layout, candidate: str, *, confirm_stop: bool) -> dict:
    identity(candidate)
    require(confirm_stop, "Archival briefly stops this instance; pass --confirm-stop after reviewing candidate-list")
    require_initialization_complete(layout)
    with initialization_lock(layout), management_lock(layout):
        manager = Manager(layout, ControlSystem())
        try:
            return archive_locked(manager, candidate)
        except Exception as exc:
            raise DeployError(getattr(exc, "code", "archive_failed"),
                "Candidate archival did not complete; all data and inventory are retained. "
                "Inspect candidate-list and retry the same candidate. If service maintenance is pending, use restore-services; "
                "never remove candidate directories or journals to bypass this check. " +
                (str(exc) if isinstance(exc, DeployError) else "Inspect the retained inventory.")) from exc
