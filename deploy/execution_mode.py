"""Journaled native/root selection; root authorization is operator-only."""
from __future__ import annotations

import base64
import json
import os
import re
import stat
import uuid

from .common import atomic_write, canonical, fsync_directory, mkdir, read_json, require, write_json
from .execution_identity import FIELDS, managed, native_settings, require_application, require_control, state
from .ownership import regular, require_owned
from .units import render_units, sudo_rule
from .system import run


def paths(layout):
    return {"instance": layout.config / "instance.json", "native": layout.config / "native.json",
            "worker": layout.units / layout.unit("worker"),
            "sudo": layout.root / "etc/sudoers.d" / ("codex-harness-" + layout.instance)}


def snapshot(layout):
    result = {}
    for name, path in paths(layout).items():
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 128 * 1024 and
                (os.name != "posix" or info.st_uid == 0 and not info.st_mode & 0o022), "Unsafe execution snapshot", "integrity")
        result[name] = {"data": base64.b64encode(path.read_bytes()).decode(), "mode": stat.S_IMODE(info.st_mode)}
    return result


def decoded(before):
    require(isinstance(before, dict) and set(before) == set(("instance", "native", "worker", "sudo")), "Invalid execution snapshot", "corrupt_state")
    result = {}
    for name, item in before.items():
        require(isinstance(item, dict) and set(item) == {"data", "mode"} and type(item["mode"]) is int and
                0 <= item["mode"] <= 0o777 and not item["mode"] & 0o022, "Invalid execution snapshot mode", "corrupt_state")
        data = base64.b64decode(item["data"], validate=True)
        require(len(data) <= 128 * 1024, "Execution snapshot exceeds budget", "corrupt_state")
        result[name] = data
    return result


def validate_write(config, params):
    require(isinstance(params, dict) and set(params) == {"mode", "expectedRevision", "confirmRestart", "confirmRoot"}, "Invalid execution mode fields")
    require(params["mode"] in ("native", "root") and params["confirmRestart"] is True and
            params["confirmRoot"] is (params["mode"] == "root"), "Confirm the execution privilege change and service restart", "confirmation_required")
    current = state(config)
    require(params["expectedRevision"] == current["revision"], "Execution policy changed; read it again", "revision_conflict")
    require(params["mode"] != "root" or current["rootAllowed"], "服务器尚未授权 root 模式，请先通过部署运维脚本授权。", "root_not_authorized")
    return current


def prepare_home(layout, config):
    if state(config)["mode"] != "root":
        return
    home = layout.state / "worker-root"
    for directory in (home, home / "codex"):
        if directory.exists() or directory.is_symlink():
            info = directory.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
                    "Root execution home ownership changed; files were preserved", "integrity")
        else:
            mkdir(directory, 0o700)
            fsync_directory(directory.parent)
    user_config = home / "codex/config.toml"
    if not user_config.exists() and not user_config.is_symlink():
        atomic_write(user_config, b"", 0o600)


def validate_journal(manager, journal):
    from .config_layer import ROLES
    require(journal.get("kind") == "execution-mode" and journal.get("phase") in
            ("prepared", "stopped", "selected", "recovering", "recovering-candidate", "committed", "recovered") and
            isinstance(journal.get("active"), list) and len(journal["active"]) == len(set(journal["active"])) and set(journal["active"]) <= set(ROLES),
            "Invalid execution transaction", "corrupt_state")
    old = decoded(journal["before"])
    before, candidate = json.loads(old["instance"]), journal.get("candidateConfig")
    require(isinstance(candidate, dict) and {k: v for k, v in before.items() if k not in FIELDS} ==
            {k: v for k, v in candidate.items() if k not in FIELDS}, "Execution transaction changed another configuration field", "corrupt_state")
    state(before); state(candidate)
    require(managed(candidate), "Missing execution candidate generation", "corrupt_state")
    require(json.loads(old["native"]) == native_settings(manager.layout, before), "Retained native identity changed", "corrupt_state")
    generated = {render_units(manager.layout, before, before["codexRelative"], legacy_runtime_directory=r, legacy_native_home=h)[manager.layout.unit("worker")].encode()
                 for r in (False, True) for h in (False, True)}
    require(old["worker"] in generated and old["sudo"] in {sudo_rule(manager.layout, config=before, workspace=w, legacy_catalog_server=c).encode()
            for w in (False, True) for c in (False, True)}, "Retained execution definitions are not generated policies", "corrupt_state")
    require(manager.config in (before, candidate), "Execution transaction no longer binds this instance", "integrity")
    other = candidate if manager.config == before else before
    alternate_unit = render_units(manager.layout, other, other["codexRelative"])[manager.layout.unit("worker")].encode() if other is candidate else old["worker"]
    alternate_sudo = sudo_rule(manager.layout, config=other).encode() if other is candidate else old["sudo"]
    require_owned(manager.layout, manager.config, prior_units={"worker": alternate_unit}, prior_sudo=alternate_sudo)
    actual_native = manager.layout.config / "native.json"
    regular(actual_native, {old["native"], canonical(native_settings(manager.layout, candidate)) + b"\n"})
    regular(manager.layout.config / "instance.json", {old["instance"], canonical(candidate) + b"\n"})
    return before, candidate, old


def apply_candidate(manager, config):
    layout = manager.layout
    require_application(layout, manager.selected(), config, enabling=True)
    require_control(read_json(layout.control / "capabilities.json"), config, enabling=True)
    prepare_home(layout, config)
    generated = render_units(layout, config, config["codexRelative"])
    write_json(paths(layout)["instance"], config)
    write_json(paths(layout)["native"], native_settings(layout, config), mode=0o644)
    atomic_write(paths(layout)["worker"], generated[layout.unit("worker")].encode(), 0o644)
    atomic_write(paths(layout)["sudo"], sudo_rule(layout, config=config).encode(), 0o440)
    fsync_directory(layout.units)
    manager.config = config
    manager.system.reload()


def recover(manager, journal_path, journal, *, candidate=False):
    from .config_layer import barriers, stop, restore_activity
    before, next_config, old = validate_journal(manager, journal)
    if state(before)["rootAllowed"] != state(next_config)["rootAllowed"]:
        from .operator_origin import require_external_operator
        require_external_operator(manager.config)
    require(journal_path.parent.parent == manager.layout.state / "transactions" and journal_path.name == "state.json" and
            re.fullmatch(r"[0-9a-f]{32}", journal_path.parent.name) is not None, "Invalid execution recovery path", "integrity")
    pending = [p for p in (manager.layout.state / "transactions").glob("*/state.json")
               if read_json(p).get("phase") not in ("committed", "recovered", "failed_first_start")]
    require(pending == [journal_path], "Execution recovery requires its sole unfinished transaction", "recovery_required")
    if candidate:
        require_application(manager.layout, manager.selected(), next_config, enabling=True)
        require_control(read_json(manager.layout.control / "capabilities.json"), next_config, enabling=True)
    barriers(manager)
    stop(manager)
    journal["phase"] = "recovering-candidate" if candidate else "recovering"
    write_json(journal_path, journal)
    if candidate:
        apply_candidate(manager, next_config)
    else:
        for name, path in paths(manager.layout).items():
            atomic_write(path, old[name], journal["before"][name]["mode"])
        fsync_directory(manager.layout.units)
        manager.config = before
        manager.system.reload()
    try:
        restore_activity(manager, journal["active"])
        manager.verify(https_probe={"gateway", "worker"} <= set(journal["active"]))
    except Exception:
        barriers(manager)
        stop(manager)
        raise
    # Publication is terminal. A failed directory fsync must not trigger an
    # opposite-direction compensation after the committed state became visible.
    journal["phase"] = "committed" if candidate else "recovered"
    write_json(journal_path, journal)
    return {**state(manager.config), "recovered": True, "transaction": journal_path.parent.name,
            "servicesRestored": True, "direction": "candidate" if candidate else "old"}


def change(manager, params=None, *, root_allowed=None, confirm_restart=False):
    from .candidate_archive import require_idle
    from .config_layer import ROLES, active_services, barriers, stop, restore_activity
    current = state(manager.config)
    if root_allowed is None:
        validate_write(manager.config, params)
        mode, allowed = params["mode"], current["rootAllowed"]
    else:
        from .operator_origin import require_external_operator
        require_external_operator(manager.config)
        require(type(root_allowed) is bool and confirm_restart is True, "Confirm service restart for root authorization", "confirmation_required")
        mode, allowed = (current["mode"] if root_allowed else "native"), root_allowed
    manager.require_update_ready(persist=False)
    if mode == current["mode"] and allowed == current["rootAllowed"]:
        return {**current, "changed": False, "servicesRestored": True}
    require(manager.config.get("providerConfigLayer") == "system-v1", "Migrate the managed provider layer before execution identity changes", "execution_unsupported")
    require_application(manager.layout, manager.selected(), manager.config, enabling=True)
    require_control(read_json(manager.layout.control / "capabilities.json"), manager.config, enabling=True)
    require_idle(manager)
    manager.verify(https_probe={"gateway", "worker"} <= set(active_services(manager)))
    require(sum(read_json(p).get("kind") == "execution-mode" for p in (manager.layout.state / "transactions").glob("*/state.json")) < 128,
            "Execution transaction retention budget reached", "budget")
    config = {**manager.config, "executionMode": mode, "rootAllowed": allowed, "executionGeneration": uuid.uuid4().hex}
    pending = manager.layout.config / "sudo.execution.pending"
    atomic_write(pending, sudo_rule(manager.layout, config=config).encode(), 0o440)
    run(["/usr/sbin/visudo", "-cf", str(pending)])
    active, before = active_services(manager), snapshot(manager.layout)
    transaction = manager.layout.state / "transactions" / uuid.uuid4().hex
    mkdir(transaction, 0o700)
    journal = {"kind": "execution-mode", "phase": "prepared", "before": before, "candidateConfig": config, "active": active}
    write_json(transaction / "state.json", journal)
    barriers(manager)
    stop(manager)
    journal["phase"] = "stopped"
    write_json(transaction / "state.json", journal)
    try:
        apply_candidate(manager, config)
        journal["phase"] = "selected"
        write_json(transaction / "state.json", journal)
        restore_activity(manager, active)
        manager.verify(https_probe=set(active) == set(ROLES))
    except Exception:
        recover(manager, transaction / "state.json", journal)
        raise
    journal["phase"] = "committed"
    write_json(transaction / "state.json", journal)
    return {**state(config), "changed": True, "transaction": transaction.name, "servicesRestored": True}
