"""Server-only proxy changes share the existing stop/recovery transaction gate."""
from __future__ import annotations

import base64
import json
import os
import re
import stat
import uuid

from .common import atomic_write, canonical, fsync_directory, mkdir, read_json, require, write_json
from .ownership import present, regular, require_owned
from .service_proxy import (PROXY_ROLES, active, apply_routes, check_core_config, config_path,
                            enabled, prepare_configuration, prerequisites, private_file,
                            ready, remove_routes, selection, status, verify_configuration)
from .units import render_units

PHASES = ("prepared", "stopped", "selected", "recovering", "recovering-candidate", "committed", "recovered")


def paths(layout):
    return {"instance": layout.config / "instance.json",
            **{role: layout.units / layout.unit(role) for role in ("worker", "gateway", *PROXY_ROLES)}}


def snapshot(manager):
    result = {}
    for name, path in paths(manager.layout).items():
        if not present(path):
            require(name in PROXY_ROLES and selection(manager.config) is None, "Proxy snapshot lacks a managed definition", "integrity")
            result[name] = None
        else:
            info = path.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 128 * 1024 and
                    (os.name != "posix" or info.st_uid == 0 and not info.st_mode & 0o022), "Unsafe proxy snapshot", "integrity")
            result[name] = {"data": base64.b64encode(path.read_bytes()).decode(), "mode": stat.S_IMODE(info.st_mode)}
    return result


def proxy_activity(manager, config):
    result = []
    if selection(config) is None:
        return result
    for role in PROXY_ROLES:
        value = manager.system.state(manager.layout.unit(role))
        running = active(value, role)
        require(running or value["stopped"], "Proxy operation requires stable service activity", "stop_unknown")
        if running:
            result.append(role)
    return result


def require_capability(manager):
    require(read_json(manager.layout.control / "capabilities.json").get("serviceProxy") == 1,
            "Update trusted control tools before configuring the service proxy", "proxy_unsupported")


def validate_journal(manager, path, journal):
    require(path.parent.parent == manager.layout.state / "transactions" and path.name == "state.json" and
            re.fullmatch(r"[0-9a-f]{32}", path.parent.name), "Invalid proxy recovery path", "integrity")
    require(json.loads(private_file(path, limit=1024 * 1024)) == journal and journal.get("kind") == "service-proxy" and
            journal.get("phase") in PHASES and isinstance(journal.get("before"), dict) and
            set(journal["before"]) == set(paths(manager.layout)), "Invalid proxy recovery journal", "corrupt_state")
    before = {}
    for name, item in journal["before"].items():
        if item is None:
            require(name in PROXY_ROLES, "Invalid absent proxy snapshot", "corrupt_state")
            before[name] = None
        else:
            require(isinstance(item, dict) and set(item) == {"data", "mode"} and type(item["mode"]) is int and
                    0 <= item["mode"] <= 0o777 and not item["mode"] & 0o022, "Invalid proxy snapshot mode", "corrupt_state")
            before[name] = base64.b64decode(item["data"], validate=True)
            require(len(before[name]) <= 128 * 1024, "Proxy snapshot exceeds budget", "budget")
    old, candidate = json.loads(before["instance"]), journal.get("candidateConfig")
    require(isinstance(candidate, dict) and {k: v for k, v in old.items() if k != "serviceProxy"} ==
            {k: v for k, v in candidate.items() if k != "serviceProxy"}, "Proxy journal changed unrelated instance configuration", "corrupt_state")
    for config in (old, candidate):
        selected = selection(config)
        if selected is not None:
            from .proxy_core import verify_core
            verify_core(manager.layout, selected["core"])
            verify_configuration(manager.layout, selected)
    require(manager.config in (old, candidate), "Proxy journal no longer binds this instance", "integrity")
    for field, allowed in (("mainActive", {"worker", "gateway"}), ("proxyActive", set(PROXY_ROLES))):
        value = journal.get(field)
        require(isinstance(value, list) and len(value) == len(set(value)) and set(value) <= allowed,
                "Invalid retained proxy activity", "corrupt_state")
    require(selection(old) is not None or not journal["proxyActive"], "Absent proxy had saved activity", "corrupt_state")
    generated_old = render_units(manager.layout, old, old["codexRelative"])
    generated_new = render_units(manager.layout, candidate, candidate["codexRelative"])
    for role in ("worker", "gateway", *PROXY_ROLES):
        name = manager.layout.unit(role)
        expected = generated_old.get(name)
        require(before[role] == (expected.encode() if expected is not None else None), "Proxy snapshot is not a generated service definition", "corrupt_state")
    alternate = candidate if manager.config == old else old
    rendered = render_units(manager.layout, alternate, alternate["codexRelative"])
    require_owned(manager.layout, manager.config, allow_absent=True,
                  prior_units={role: rendered.get(manager.layout.unit(role), "").encode() or None for role in ("worker", "gateway", *PROXY_ROLES)})
    for name, current_path in paths(manager.layout).items():
        new = canonical(candidate) + b"\n" if name == "instance" else generated_new.get(manager.layout.unit(name))
        if isinstance(new, str):
            new = new.encode()
        allowed = {data for data in (before[name], new) if data is not None}
        if present(current_path):
            regular(current_path, allowed)
        else:
            require(before[name] is None or new is None, "Managed proxy transaction file disappeared", "integrity")
    return old, candidate, before


def stop(manager, configs):
    from .config_layer import barriers, stop as stop_main
    barriers(manager)
    stop_main(manager)
    if any(selection(config) is not None for config in configs):
        # Stop main cgroups before changing a listener or any firewall chain.
        manager.system.stop([manager.layout.unit(role) for role in reversed(PROXY_ROLES)])


def publish(manager, target, previous, *, retained=None, snapshot_record=None):
    layout = manager.layout
    if retained is None:
        generated = render_units(layout, target, target["codexRelative"])
        write_json(paths(layout)["instance"], target)
        for role in ("worker", "gateway", *PROXY_ROLES):
            path = paths(layout)[role]
            if path.name in generated:
                atomic_write(path, generated[path.name].encode(), 0o644)
            else:
                path.unlink(missing_ok=True)
    else:
        for name, path in paths(layout).items():
            if retained[name] is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, retained[name], snapshot_record[name]["mode"])
    fsync_directory(layout.units)
    manager.config = target
    manager.system.reload()
    current, old = selection(target), selection(previous)
    if current is not None and current["enabled"]:
        apply_routes(layout, current, prior=old)
    elif old is not None:
        remove_routes(layout, old)


def restore(manager, journal, *, old=False, upstream=False):
    from .config_layer import restore_activity
    desired = journal["proxyActive"] if old else (list(PROXY_ROLES) if enabled(manager.config) and
               (journal["mainActive"] or journal["proxyActive"]) else [])
    if desired:
        manager.system.start([manager.layout.unit(role) for role in PROXY_ROLES if role in desired])
    restore_activity(manager, journal["mainActive"])
    require(set(proxy_activity(manager, manager.config)) == set(desired), "Proxy service activity was not restored", "proxy_health")
    manager.verify(https_probe=set(journal["mainActive"]) == {"worker", "gateway"})
    if enabled(manager.config) and journal["mainActive"]:
        ready(manager, upstream=upstream)


def recover(manager, path, journal, *, candidate=False):
    old, following, before = validate_journal(manager, path, journal)
    pending = [item for item in (manager.layout.state / "transactions").glob("*/state.json")
               if read_json(item).get("phase") not in ("committed", "recovered", "failed_first_start")]
    require(pending == [path], "Proxy recovery requires its sole unfinished transaction", "recovery_required")
    require_capability(manager)
    target = following if candidate else old
    if enabled(target):
        prerequisites()
        check_core_config(manager.layout, selection(target))
    stop(manager, (old, following))
    journal["phase"] = "recovering-candidate" if candidate else "recovering"
    write_json(path, journal)
    try:
        publish(manager, target, old if candidate else following,
                retained=None if candidate else before, snapshot_record=journal["before"])
        restore(manager, journal, old=not candidate, upstream=candidate)
    except Exception:
        stop(manager, (old, following))
        raise
    journal["phase"] = "committed" if candidate else "recovered"
    write_json(path, journal)
    return {**status(manager), "recovered": True, "direction": "candidate" if candidate else "old",
            "transaction": path.parent.name, "servicesRestored": True}


def previous_selection(manager):
    eligible = []
    for path in (manager.layout.state / "transactions").glob("*/state.json"):
        value = read_json(path)
        if value.get("kind") == "service-proxy" and value.get("phase") == "committed" and selection(value["candidateConfig"]) == selection(manager.config):
            require(re.fullmatch(r"[0-9a-f]{32}", path.parent.name) and
                    json.loads(private_file(path, limit=1024 * 1024)) == value,
                    "Previous proxy selection lacks its private journal", "integrity")
            # The journal contains the original exact instance selection; no
            # symlink or mutable "previous core" can point outside this history.
            original = json.loads(base64.b64decode(value["before"]["instance"]["data"], validate=True))
            require({key: item for key, item in original.items() if key != "serviceProxy"} ==
                    {key: item for key, item in value["candidateConfig"].items() if key != "serviceProxy"},
                    "Previous proxy journal changed unrelated configuration", "integrity")
            from .service_proxy import verify_selection
            verify_selection(manager.layout, original)
            eligible.append((path.stat().st_mtime_ns, str(path), selection(original)))
    require(eligible, "No previous proxy selection matches the current configuration", "not_installed")
    return sorted(eligible, key=lambda row: row[:2])[-1][2]


def change(manager, *, action, confirm_restart, input_file=None, version=None, port=18793, download_proxy=None):
    from .candidate_archive import require_idle
    from .config_layer import active_services
    from .proxy_core import prepare_core
    require(confirm_restart is True, "Confirm the proxy operation and brief restart of idle services", "confirmation_required")
    require(action in ("configure", "disable", "core-update", "rollback"), "Invalid proxy operation")
    require_capability(manager)
    manager.require_update_ready(persist=False)
    require_idle(manager)
    manager.verify(https_probe=set(active_services(manager)) == {"worker", "gateway"})
    current = selection(manager.config)
    if action == "configure":
        prerequisites()
        require(input_file is not None and version is not None, "Proxy configuration file and exact core version are required")
        ident = prepare_configuration(manager.layout, input_file, port)
        core = prepare_core(manager.layout, version, download_proxy=download_proxy)
        following = {"enabled": True, "port": port, "core": core["core"], "configuration": ident}
    elif action == "core-update":
        require(current is not None and version is not None, "Configure the proxy before updating its core")
        core = prepare_core(manager.layout, version, download_proxy=download_proxy)
        following = {**current, "core": core["core"]}
    elif action == "disable":
        following = {**current, "enabled": False} if current is not None else None
    else:
        following = previous_selection(manager)
    if following == current:
        return {**status(manager), "changed": False, "servicesRestored": True}
    if following is not None:
        check_core_config(manager.layout, following)
    if following is not None and following["enabled"]:
        prerequisites()
    require_idle(manager)  # Preparation can take time; idle evidence must be fresh.
    candidate = {key: value for key, value in manager.config.items() if key != "serviceProxy"}
    if following is not None:
        candidate["serviceProxy"] = following
    records = list((manager.layout.state / "transactions").glob("*/state.json"))
    require(sum(read_json(path).get("kind") == "service-proxy" for path in records) < 128, "Proxy recovery retention budget reached", "budget")
    journal = {"kind": "service-proxy", "phase": "prepared", "before": snapshot(manager), "candidateConfig": candidate,
               "mainActive": active_services(manager), "proxyActive": proxy_activity(manager, manager.config)}
    path = manager.layout.state / "transactions" / uuid.uuid4().hex / "state.json"
    mkdir(path.parent, 0o700)
    write_json(path, journal)
    old = manager.config
    stop(manager, (old, candidate))
    journal["phase"] = "stopped"
    write_json(path, journal)
    try:
        publish(manager, candidate, old)
        journal["phase"] = "selected"
        write_json(path, journal)
        restore(manager, journal, upstream=True)
    except Exception:
        recover(manager, path, journal)
        raise
    # Never run opposite-direction recovery after a terminal record was visible.
    journal["phase"] = "committed"
    write_json(path, journal)
    return {**status(manager), "changed": True, "transaction": path.parent.name, "servicesRestored": True}
