"""Stop-confirmed migration/rollback of provider configuration namespaces."""
from __future__ import annotations

import base64
import json
import os
import re
import stat
import uuid
from pathlib import Path

from .common import DeployError, atomic_write, canonical, fsync_directory, mkdir, read_json, require, write_json
from .ownership import present, regular, require_owned
from .provider import native_config, require_provider_layer
from .provider_layers import LAYER_MODE, prepare_host_targets, verify_system_layers
from .system import run
from .units import render_units, sudo_rule

ROLES = ("worker", "gateway")


def paths(layout) -> dict[str, Path]:
    return {"instance": layout.config / "instance.json", "worker": layout.units / layout.unit("worker"),
            "check": layout.units / layout.unit("config-check"),
            "sudo": layout.root / "etc/sudoers.d" / ("codex-harness-" + layout.instance)}


def snapshot(layout) -> dict:
    result = {}
    for name, path in paths(layout).items():
        if not present(path):
            require(name == "check", "Missing managed configuration path", "ownership_conflict")
            result[name] = None
            continue
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 128 * 1024 and
                (os.name != "posix" or info.st_uid == 0 and not info.st_mode & 0o022), "Unsafe configuration snapshot", "ownership_conflict")
        result[name] = {"data": base64.b64encode(path.read_bytes()).decode(), "mode": stat.S_IMODE(info.st_mode)}
    return result


def decoded_snapshot(before: dict) -> dict[str, bytes | None]:
    require(isinstance(before, dict) and set(before) == {"instance", "worker", "check", "sudo"}, "Invalid configuration layer journal", "corrupt_state")
    result = {}
    for name, item in before.items():
        if item is None:
            require(name == "check", "Invalid absent configuration snapshot", "corrupt_state")
            result[name] = None
        else:
            require(isinstance(item, dict) and set(item) == {"data", "mode"} and type(item["mode"]) is int and
                    0 <= item["mode"] <= 0o777 and not item["mode"] & 0o022, "Invalid snapshot mode", "corrupt_state")
            data = base64.b64decode(item["data"], validate=True)
            require(len(data) <= 128 * 1024, "Configuration snapshot exceeds budget", "corrupt_state")
            result[name] = data
    return result


def user_layer(manager) -> None:
    # The native account may still be running during initial preflight. Pin
    # directories and open nonblocking so a replacement symlink/FIFO cannot
    # redirect or hang the root reader. Never write or normalize user bytes.
    descriptors = []
    limit = 1024 * 1024
    import tomllib
    try:
        fd = os.open(manager.layout.state, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(fd)
        from .execution_identity import native_settings
        settings = native_settings(manager.layout, manager.config)
        for name in (("worker-root" if settings["uid"] == 0 else "worker"), "codex"):
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            descriptors.append(fd)
            info = os.fstat(fd)
            require(info.st_uid == settings["uid"] and info.st_gid == settings["gid"] and not info.st_mode & 0o022,
                    "Native configuration directory ownership changed", "configuration_conflict")
        fd = os.open("config.toml", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        descriptors.append(fd)
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit and
                before.st_uid == settings["uid"] and before.st_gid == settings["gid"] and
                stat.S_IMODE(before.st_mode) == 0o600, "Native user configuration ownership or size changed", "configuration_conflict")
        data = bytearray()
        while len(data) <= limit:
            block = os.read(fd, min(65536, limit + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        after = os.fstat(fd)
        require(len(data) <= limit and (before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_size, after.st_mtime_ns, after.st_ctime_ns), "Native user configuration changed during inspection", "configuration_conflict")
        tomllib.loads(bytes(data).decode("utf-8"))
    except OSError as exc:
        raise DeployError("configuration_conflict", "Native user configuration cannot be read safely; bytes were preserved") from exc
    except (ValueError, UnicodeError) as exc:
        raise DeployError("configuration_conflict", "Native user configuration is not valid TOML; bytes were preserved") from exc
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def active_services(manager) -> list[str]:
    active = []
    for role in ROLES:
        state = manager.system.state(manager.layout.unit(role))
        running = state["ActiveState"] == "active" and state["SubState"] == "running" and state["MainPID"] != "0" and state["ControlPID"] == "0"
        require(running or state["stopped"], "Configuration migration requires stable service state", "stop_unknown")
        if running:
            active.append(role)
    return active


def barriers(manager, active: list[str] | None = None) -> Path:
    layout = manager.layout
    folder = layout.config / "config-layer-maintenance"
    candidates = []
    for role in ROLES:
        directory = layout.units / (layout.unit(role) + ".d")
        require(not directory.is_symlink() and (not directory.exists() or directory.is_dir()), "Unsafe configuration-layer drop-in directory", "ownership_conflict")
        path = directory / "92-codex-harness-config-layer.conf"
        data = f"[Unit]\nConditionPathExists=!{folder / role}\n".encode()
        if present(path):
            regular(path, {data})
        candidates.append((directory, path, data))
    mkdir(folder, 0o700)
    for role in ROLES:
        if active is not None and role in active:
            (folder / role).unlink(missing_ok=True)
        else:
            atomic_write(folder / role, b"configuration layer maintenance\n")
    fsync_directory(folder)
    for directory, path, data in candidates:
        mkdir(directory, 0o755)
        if not present(path):
            atomic_write(path, data, 0o644)
    manager.system.reload()
    return folder


def stop(manager) -> None:
    units = manager.service_units
    if paths(manager.layout)["check"].exists():
        units = [*units, manager.layout.unit("config-check")]
    manager.system.stop(units)
    manager.recover_control()


def restore_activity(manager, active: list[str]) -> None:
    folder = barriers(manager, active)
    try:
        if active:
            manager.system.start([manager.layout.unit(role) for role in ROLES if role in active])
        require(set(active_services(manager)) == set(active), "Configuration-layer service restoration failed", "health")
        if set(active) == set(ROLES):
            manager.healthy()
    except Exception:
        barriers(manager)
        stop(manager)
        raise
    for role in ROLES:
        (folder / role).unlink(missing_ok=True)
    fsync_directory(folder)


def validate_journal(manager, journal: dict) -> tuple[dict, dict, dict[str, bytes | None]]:
    require(journal.get("kind") == "config-layer" and journal.get("targetMode") in ("legacy", LAYER_MODE) and
            isinstance(journal.get("active"), list) and len(journal["active"]) == len(set(journal["active"])) and set(journal["active"]) <= set(ROLES),
            "Invalid configuration-layer transaction", "corrupt_state")
    old = decoded_snapshot(journal["before"])
    old_config = json.loads(old["instance"])
    candidate = journal.get("candidateConfig")
    require(isinstance(candidate, dict) and {key: value for key, value in candidate.items() if key != "providerConfigLayer"} ==
            {key: value for key, value in old_config.items() if key != "providerConfigLayer"} and
            candidate.get("providerConfigLayer") == (LAYER_MODE if journal["targetMode"] == LAYER_MODE else None),
            "Invalid configuration-layer candidate", "corrupt_state")
    for key in ("oldProvider", "candidateProvider"):
        require(isinstance(journal.get(key), str) and re.fullmatch("[0-9a-f]{32}", journal[key]) is not None, "Invalid provider identity in recovery", "corrupt_state")
    require_owned(manager.layout, candidate, prior_units={"worker": old["worker"], "config-check": old["check"]})
    return old_config, candidate, old


def require_candidate_layer(manager, journal: dict) -> None:
    if journal["targetMode"] != "legacy":
        return
    generation = journal["candidateProvider"]
    require(isinstance(generation, str) and re.fullmatch("[0-9a-f]{32}", generation) is not None,
            "Invalid provider identity in recovery", "corrupt_state")
    settings = read_json(manager.layout.config / "providers" / generation / "settings.json", 4 * 1024 * 1024)
    require(isinstance(settings, dict) and settings.get("revision") == generation,
            "Candidate provider identity changed", "corrupt_state")
    require_provider_layer(settings, layered=False)


def apply_candidate(manager, journal: dict) -> None:
    # Recheck the exact generation immediately before publication; the current
    # pointer can differ during recovery of an older interrupted transaction.
    require_candidate_layer(manager, journal)
    layout = manager.layout
    config = journal["candidateConfig"]
    generated = render_units(layout, config, config["codexRelative"])
    manager.providers.select(journal["candidateProvider"])
    write_json(paths(layout)["instance"], config)
    atomic_write(paths(layout)["worker"], generated[layout.unit("worker")].encode(), 0o644)
    check = generated.get(layout.unit("config-check"))
    if check is None:
        paths(layout)["check"].unlink(missing_ok=True)
    else:
        atomic_write(paths(layout)["check"], check.encode(), 0o644)
    atomic_write(paths(layout)["sudo"], sudo_rule(layout, config=config, workspace=journal["targetMode"] == LAYER_MODE).encode(), 0o440)
    fsync_directory(layout.units)
    manager.config = config
    manager.system.reload()


def recover_config_layer(manager, journal_path: Path, journal: dict, *, candidate: bool = False) -> dict:
    old_config, next_config, old = validate_journal(manager, journal)
    if candidate:
        # Reject old unsafe candidates before altering barriers, services or
        # journal phase. Restoring the original snapshot remains available.
        require_candidate_layer(manager, journal)
    barriers(manager)
    stop(manager)  # No path, pointer or unit changes after an unconfirmed stop.
    journal["phase"] = "recovering-candidate" if candidate else "recovering"
    write_json(journal_path, journal)
    if candidate:
        apply_candidate(manager, journal)
    else:
        manager.providers.select(journal["oldProvider"])
        for name, path in paths(manager.layout).items():
            if old[name] is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, old[name], journal["before"][name]["mode"])
        fsync_directory(manager.layout.units)
        manager.config = old_config
        manager.system.reload()
    restore_activity(manager, journal["active"])
    # No compensation may follow terminal publication: atomic_write can replace
    # state.json and then fail its parent-directory fsync. Earlier failures keep
    # the recovering phase available for another explicit recovery.
    journal["phase"] = "committed" if candidate else "recovered"
    write_json(journal_path, journal)
    return {"providerConfigLayer": manager.config.get("providerConfigLayer", "legacy"), "recovered": True,
            "transaction": journal_path.parent.name, "direction": "candidate" if candidate else "old"}


def change_config_layer(manager, *, layered: bool = True) -> dict:
    require(layered or manager.config.get("executionMode", "native") != "root", "Switch to native execution before restoring the legacy provider layer", "configuration_conflict")
    manager.require_recovered_transactions(None)
    manager.require_service_ownership()
    layout = manager.layout
    current = manager.providers.read()
    require_provider_layer(current, layered=layered)
    user_layer(manager)
    mode = LAYER_MODE if layered else "legacy"
    if not layered and manager.config.get("providerConfigLayer") is None and not paths(layout)["check"].exists() and paths(layout)["sudo"].read_bytes() == sudo_rule(layout, config=manager.config, workspace=False).encode():
        return {"providerConfigLayer": "legacy", "changed": False, "nativeWorkspace": False}
    require(sum(1 for path in (layout.state / "transactions").glob("*/state.json") if read_json(path).get("kind") == "config-layer") < 128,
            "Configuration-layer retention budget reached; inspect completed records", "budget")
    if layered:
        capability = read_json(layout.control / "capabilities.json", 4096)
        require(capability.get("providerConfigLayer") == LAYER_MODE, "Run trusted control-update before configuration migration", "configuration_conflict")
        if manager.config.get("providerConfigLayer") == LAYER_MODE:
            try:
                verify_system_layers(layout)
            except DeployError as exc:
                if exc.code != "configuration_conflict":
                    raise
            else:
                # A recognized old policy can still lack catalog-server after
                # control code changed. Publish its replacement through this
                # transaction so failures can restore the exact prior policy.
                if "connections" in current and paths(layout)["sudo"].read_bytes() == sudo_rule(layout, config=manager.config).encode():
                    return {"providerConfigLayer": LAYER_MODE, "changed": False}
    candidate_config = {key: value for key, value in manager.config.items() if key != "providerConfigLayer"}
    if layered:
        candidate_config["providerConfigLayer"] = LAYER_MODE
        next_settings = {**current, "revision": uuid.uuid4().hex}
        if "connections" not in current:
            from .provider_registry import combine, entries
            rows = entries(current)
            if current["kind"] == "zhipu-coding" and not current.get("models"):
                from .provider_catalogs import initialize
                rows[0]["settings"] = initialize(rows[0]["settings"])
            next_settings = combine(current, rows, "default")
        prepare_host_targets(next_settings, layout, manager.config["workerGid"])
        generation = manager.providers.prepare(next_settings, layered=True)
    else:
        generation = current["revision"]
        require((layout.config / "providers" / generation / "config.toml").read_bytes() == native_config(current, layout),
                "Legacy provider configuration is unavailable", "integrity")
    pending_sudo = layout.config / "sudo.layer.pending"
    atomic_write(pending_sudo, sudo_rule(layout, config=candidate_config, workspace=layered).encode(), 0o440)
    run(["/usr/sbin/visudo", "-cf", str(pending_sudo)])
    active, before = active_services(manager), snapshot(layout)
    transaction = layout.state / "transactions" / uuid.uuid4().hex
    mkdir(transaction, 0o700)
    journal = {"kind": "config-layer", "phase": "prepared", "targetMode": mode, "before": before,
               "oldProvider": current["revision"], "candidateProvider": generation, "candidateConfig": candidate_config, "active": active}
    write_json(transaction / "state.json", journal)
    barriers(manager)
    stop(manager)
    journal["phase"] = "stopped"
    write_json(transaction / "state.json", journal)
    try:
        user_layer(manager)
        apply_candidate(manager, journal)
        journal["phase"] = "selected"
        write_json(transaction / "state.json", journal)
        restore_activity(manager, active)
    except Exception:
        recover_config_layer(manager, transaction / "state.json", journal)
        raise
    # Keep the terminal write outside the compensation block for the same
    # publish-before-fsync failure boundary as explicit recovery above.
    journal["phase"] = "committed"
    write_json(transaction / "state.json", journal)
    return {"providerConfigLayer": mode, "changed": True, "providerRevision": generation, "transaction": transaction.name,
            "userConfigPreserved": True, "nativeWorkspace": layered}
