"""Stop-confirmed service removal and restoration of a retained instance."""
from __future__ import annotations

import base64
import hashlib
import os
import re
import stat
import uuid

from .common import DeployError, atomic_write, digest, fsync_directory, mkdir, read_json, require, write_json
from .ownership import ROLES, present, regular
from .safe_fs import inspect_tree
from .system import run

DROPIN = "93-codex-harness-service-lifecycle.conf"
TERMINAL = ("committed", "recovered")


def service_paths(layout):
    return {**{role: layout.units / layout.unit(role) for role in ROLES},
            "sudo": layout.root / "etc/sudoers.d" / ("codex-harness-" + layout.instance)}


def read_private(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 4 * 1024**2 and
            (os.name != "posix" or info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600),
            "Unsafe service lifecycle record", "integrity")
    return read_json(path, 4 * 1024**2)


def identity_state(layout):
    import pwd
    import grp
    result = {}
    users, groups = pwd.getpwall(), grp.getgrall()
    for role in ("gateway", "worker", "control", "build", "ipc", "edge", "auth"):
        name = layout.prefix + "-" + role
        try: group = grp.getgrnam(name)
        except KeyError: group = None
        try: user = pwd.getpwnam(name)
        except KeyError: user = None
        if group is not None or user is not None:
            result[role] = {"group": None if group is None else [group.gr_gid, sorted(group.gr_mem)],
                            "user": None if user is None else [user.pw_uid, user.pw_gid, user.pw_dir, user.pw_shell],
                            "relatedUsers": sorted([item.pw_name, item.pw_uid, item.pw_gid, item.pw_dir, item.pw_shell] for item in users
                                                   if user is not None and item.pw_uid == user.pw_uid or group is not None and item.pw_gid == group.gr_gid),
                            "relatedGroups": sorted([item.gr_name, item.gr_gid, sorted(item.gr_mem)] for item in groups
                                                    if name in item.gr_mem or group is not None and item.gr_gid == group.gr_gid)}
    return result


def bindings(manager):
    layout = manager.layout
    if present(layout.config / "https.json"):
        from .https import read_https_metadata
        from .dns_tls import validate_dns_selection
        validate_dns_selection(layout, read_https_metadata(layout))
    files = {}
    for name in ("instance.json", "native.json", "gateway-token", "auth-bootstrap.json", "https.json", "Caddyfile"):
        path = layout.config / name
        if not present(path):
            files[name] = None
            continue
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 1024 * 1024 and
                (os.name != "posix" or info.st_uid == 0 and not info.st_mode & 0o022),
                "Unsafe retained instance configuration", "integrity")
        files[name] = {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "mode": stat.S_IMODE(info.st_mode),
                       "uid": info.st_uid, "gid": info.st_gid}
    return {"configuration": files, "release": manager.selected(), "previous": manager.selected("previous"),
            "control": digest(inspect_tree(layout.control, root_owned=True)), "identities": identity_state(layout)}


def activity(manager):
    active, enabled = [], []
    for role in ROLES:
        unit = manager.layout.unit(role)
        state = manager.system.state(unit)
        running = state["ActiveState"] == "active" and state["SubState"] == "running" and state["MainPID"] != "0" and state["ControlPID"] == "0"
        require(state["stopped"] or running, "Service lifecycle requires stable activity", "stop_unknown")
        if running: active.append(role)
        if present(manager.layout.units / unit):
            value = run(["/usr/bin/systemctl", "is-enabled", unit], check=False)
            answer = value.stdout.strip()
            require(answer in ("enabled", "disabled", "static") and value.returncode == (0 if answer in ("enabled", "static") else 1),
                    "Cannot establish service enablement", "stop_unknown")
            if answer == "enabled": enabled.append(role)
    return active, enabled


def barriers(manager, allowed=()):
    layout = manager.layout
    root = layout.config / "service-lifecycle"
    if present(root):
        info = root.lstat()
        require(stat.S_ISDIR(info.st_mode) and (os.name != "posix" or info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700),
                "Unsafe service lifecycle barrier directory", "integrity")
    mkdir(root, 0o700)
    for role in ROLES:
        marker = root / role
        if role in allowed:
            marker.unlink(missing_ok=True)
        else:
            atomic_write(marker, b"Service lifecycle recovery pending\n")
        directory = layout.units / (layout.unit(role) + ".d")
        if present(directory):
            info = directory.lstat()
            require(stat.S_ISDIR(info.st_mode) and (os.name != "posix" or info.st_uid == 0 and not info.st_mode & 0o022),
                    "Unsafe service lifecycle drop-in directory", "ownership_conflict")
        mkdir(directory, 0o755)
        target = directory / DROPIN
        expected = f"[Unit]\nConditionPathExists=!{root / role}\n".encode()
        if present(target): regular(target, {expected})
        else: atomic_write(target, expected, 0o644)
    fsync_directory(root)
    manager.system.reload()


def require_only_transaction(layout, selected):
    from .control_update import require_no_pending_control
    require_no_pending_control(layout)
    for path in (layout.state / "transactions").glob("*/state.json"):
        if path == selected: continue
        value = read_json(path)
        require(value.get("phase") in TERMINAL or value.get("kind") == "release" and value.get("old") is None and
                value.get("phase") == "failed_first_start", "Another transaction requires recovery first", "recovery_required")


def read_record(layout):
    marker_path = layout.config / "uninstalled.json"
    pending = []
    for item in (layout.state / "transactions").glob("*/state.json"):
        candidate = read_private(item)
        if candidate.get("kind") == "service-lifecycle" and candidate.get("phase") not in TERMINAL:
            pending.append((item, candidate))
    require(len(pending) <= 1, "Multiple retained service removals require inspection", "recovery_required")
    marker = read_private(marker_path) if present(marker_path) else None
    if pending and (marker is None or marker.get("transaction") != pending[0][0].parent.name):
        if marker is not None:
            old_id = marker.get("transaction")
            require(isinstance(old_id, str) and re.fullmatch(r"[0-9a-f]{32}", old_id) is not None,
                    "Unrecognized old service restoration marker", "recovery_required")
            old = read_private(layout.state / "transactions" / old_id / "state.json")
            require(old.get("phase") == "recovered" and old.get("kind") == "service-lifecycle" and old.get("instance") == layout.instance and
                    marker.get("snapshotDigest") == digest({key: old[key] for key in ("before", "active", "enabled", "bindings")}),
                    "An unresolved service marker cannot be superseded", "recovery_required")
        item, candidate = pending[0]
        require(candidate.get("instance") == layout.instance and candidate.get("format") == 1 and
                re.fullmatch(r"[0-9a-f]{32}", item.parent.name) is not None,
                "Invalid retained service removal record", "corrupt_state")
        marker = {"transaction": item.parent.name, "snapshotDigest": digest({key: candidate[key] for key in ("before", "active", "enabled", "bindings")}),
                  "servicesRemoved": candidate.get("phase") == "removed", "dataPreserved": True}
        # The private journal is the first durable intent; a crash before its
        # convenience marker is recoverable without claiming any new state.
        write_json(marker_path, marker)
    require(marker is not None, "No retained service removal record", "recovery_required")
    identity = marker.get("transaction")
    require(isinstance(identity, str) and re.fullmatch(r"[0-9a-f]{32}", identity) is not None,
            "This retained uninstall has no bound restoration record; do not recreate identities", "recovery_required")
    path = layout.state / "transactions" / identity / "state.json"
    value = read_private(path)
    require(value.get("format") == 1 and value.get("kind") == "service-lifecycle" and value.get("instance") == layout.instance and
            value.get("phase") in ("prepared", "stopped", "removed", "restoring", "committed", "recovered") and
            marker.get("snapshotDigest") == digest({key: value[key] for key in ("before", "active", "enabled", "bindings")}),
            "Invalid service lifecycle recovery binding", "corrupt_state")
    require(set(value["before"]) == set(service_paths(layout)) and isinstance(value["active"], list) and isinstance(value["enabled"], list) and
            set(value["active"]) <= set(ROLES) and set(value["enabled"]) <= set(ROLES), "Invalid service lifecycle snapshot", "corrupt_state")
    return path, value


def verify_retained(manager, value):
    require(bindings(manager) == value["bindings"], "Retained instance identity, configuration, control code or selection changed", "integrity")
    for release in (value["bindings"]["release"], value["bindings"]["previous"]):
        if release is not None: manager.verify_release(release)
    manager.require_service_ownership(allow_absent=True)
    for name, path in service_paths(manager.layout).items():
        saved = value["before"][name]
        if present(path):
            require(saved is not None, "A previously absent service definition appeared", "ownership_conflict")
            regular(path, {base64.b64decode(saved["data"], validate=True)})


def verify_retained_definition(manager, journal, role):
    """Recognize supported old definitions only while restoring their bound snapshot."""
    from .units import render_units, sudo_rule
    require(role in ("worker", "sudo"), "Unsupported retained service compatibility", "integrity")
    path, value = read_record(manager.layout)
    require(path == journal and value["phase"] == "restoring",
            "Legacy verification requires the active restoration record", "recovery_required")
    require_only_transaction(manager.layout, path)
    verify_retained(manager, value)
    manager.require_service_ownership()
    saved = value["before"][role]
    require(saved is not None, "Retained service definition is missing", "corrupt_state")
    data = base64.b64decode(saved["data"], validate=True)
    if role == "sudo":
        allowed = {sudo_rule(manager.layout, workspace=workspace, legacy_catalog_server=True).encode()
                   for workspace in (False, True)}
    else:
        allowed = {render_units(manager.layout, manager.config, manager.config["codexRelative"],
                                legacy_runtime_directory=runtime, legacy_native_home=home)[manager.layout.unit("worker")].encode()
                   for runtime in (False, True) for home in (False, True)}
    require(data in allowed, "Retained service is not an exact supported definition", "integrity")
    target = service_paths(manager.layout)[role]
    regular(target, {data})
    require(type(saved["mode"]) is int and stat.S_IMODE(target.lstat().st_mode) == saved["mode"],
            "Retained service permissions changed", "integrity")


def uninstall_services(manager):
    layout = manager.layout
    marker = layout.config / "uninstalled.json"
    pending_lifecycle = any(read_json(path).get("kind") == "service-lifecycle" and read_json(path).get("phase") not in TERMINAL
                            for path in (layout.state / "transactions").glob("*/state.json"))
    if present(marker) or pending_lifecycle:
        journal, value = read_record(layout)
        if value["phase"] == "recovered":
            # A restored instance may be explicitly uninstalled again.
            manager.require_recovered_transactions(None)
        else:
            require_only_transaction(layout, journal)
            verify_retained(manager, value)
            return finish_uninstall(manager, journal, value)
    manager.require_recovered_transactions(None)
    manager.require_service_ownership(allow_absent=True)
    active, enabled = activity(manager)
    before = {}
    for name, path in service_paths(layout).items():
        if present(path):
            info = path.lstat()
            before[name] = {"data": base64.b64encode(path.read_bytes()).decode(), "mode": stat.S_IMODE(info.st_mode)}
        else: before[name] = None
    require(before["gateway"] is not None and before["worker"] is not None and before["sudo"] is not None,
            "Uninstall needs complete owned service definitions or its existing recovery record", "recovery_required")
    saved_bindings = bindings(manager)
    identity = uuid.uuid4().hex
    journal = layout.state / "transactions" / identity / "state.json"
    mkdir(journal.parent, 0o700)
    value = {"format": 1, "kind": "service-lifecycle", "instance": layout.instance, "phase": "prepared",
             "before": before, "active": active, "enabled": enabled, "bindings": saved_bindings}
    write_json(journal, value)
    write_json(marker, {"transaction": identity, "snapshotDigest": digest({key: value[key] for key in ("before", "active", "enabled", "bindings")}),
                        "servicesRemoved": False, "dataPreserved": True})
    return finish_uninstall(manager, journal, value)


def finish_uninstall(manager, journal, value):
    layout = manager.layout
    barriers(manager)
    manager.system.stop([layout.unit(role) for role in ROLES])
    value["phase"] = "stopped"
    write_json(journal, value)
    available = [layout.unit(role) for role in ROLES if present(layout.units / layout.unit(role))]
    if available: run(["/usr/bin/systemctl", "disable", *available])
    for path in service_paths(layout).values(): path.unlink(missing_ok=True)
    fsync_directory(layout.units)
    fsync_directory(layout.root / "etc/sudoers.d")
    manager.system.reload()
    require(all(manager.system.state(layout.unit(role))["stopped"] for role in ROLES), "Removed service is not stopped", "stop_unknown")
    # Keep the transaction pending while uninstalled, so no other mutation can
    # bypass the retained definition/identity binding or its start barriers.
    value["phase"] = "removed"
    write_json(journal, value)
    marker = read_private(layout.config / "uninstalled.json")
    write_json(layout.config / "uninstalled.json", {**marker, "servicesRemoved": True})
    return {"servicesRemoved": True, "dataPreserved": True, "dataPath": str(layout.state), "configPath": str(layout.config),
            "restoreCommand": "restore-services", "transaction": journal.parent.name}


def restore_services(manager):
    layout = manager.layout
    journal, value = read_record(layout)
    require_only_transaction(layout, journal)
    verify_retained(manager, value)
    if value["phase"] == "recovered":
        return {"servicesRestored": True, "alreadyRestored": True, "transaction": journal.parent.name}
    barriers(manager)
    manager.system.stop([layout.unit(role) for role in ROLES])
    manager.recover_control()
    value["phase"] = "restoring"
    write_json(journal, value)
    paths = service_paths(layout)
    for name, saved in value["before"].items():
        if saved is None: continue
        data = base64.b64decode(saved["data"], validate=True)
        require(type(saved["mode"]) is int and not saved["mode"] & 0o022 and len(data) <= 1024 * 1024,
                "Unsafe retained service definition", "corrupt_state")
        if present(paths[name]): regular(paths[name], {data})
        else: atomic_write(paths[name], data, saved["mode"])
    run(["/usr/sbin/visudo", "-cf", str(paths["sudo"])])
    manager.system.reload()
    available = [layout.unit(role) for role in ROLES if value["before"][role] is not None]
    if available: run(["/usr/bin/systemctl", "disable", *available])
    if value["enabled"]: manager.system.enable([layout.unit(role) for role in value["enabled"]])
    sudo_policy = unit_policy = None
    try:
        allowed = set(value["active"]) | {"config-check"}
        barriers(manager, allowed)
        if value["active"]: manager.system.start([layout.unit(role) for role in ROLES if role in value["active"]])
        actual_active, actual_enabled = activity(manager)
        require(set(actual_active) == set(value["active"]) and set(actual_enabled) == set(value["enabled"]),
                "Original service activity or enablement was not restored", "recovery_required")
        if {"gateway", "worker"} <= set(value["active"]): manager.healthy()
        if value["bindings"]["release"] is not None:
            verification = manager.verify(https_probe={"caddy", "gateway"} <= set(value["active"]), service_recovery=journal)
            sudo_policy = verification.get("sudoPolicy")
            unit_policy = verification.get("unitPolicy")
        else:
            require(not value["active"], "An uninstalled instance without a release cannot restore active services", "integrity")
            manager.require_service_ownership()
        marker = read_private(layout.config / "uninstalled.json")
        write_json(layout.config / "uninstalled.json", {**marker, "servicesRemoved": False, "servicesRestored": True})
        # All original services have been checked. Clear every condition before
        # the terminal journal so a lost completion remains safely retryable.
        barriers(manager, ROLES)
    except Exception as exc:
        barriers(manager)
        manager.system.stop([layout.unit(role) for role in ROLES])
        raise DeployError("recovery_required", "Service restoration is incomplete; retained services remain blocked. Retry restore-services.") from exc
    # There must be no compensation after terminal publication: atomic_write
    # can publish bytes and then report a directory-fsync failure. In either
    # case services have passed verification; a retry inspects the saved phase.
    value["phase"] = "recovered"
    write_json(journal, value)
    return {"servicesRestored": True, "dataPreserved": True, "sudoPolicy": sudo_policy, "unitPolicy": unit_policy,
            "activeServices": value["active"],
            "enabledServices": value["enabled"], "transaction": journal.parent.name, "origin": manager.config["origin"]}
