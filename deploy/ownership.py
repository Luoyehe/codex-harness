"""Recognize service definitions before stopping, replacing or removing them.

An instance.json file alone is not evidence that initialization claimed a unit.
Exact managed contents also recognize installations made before this check was
introduced, without trusting a new ownership record written after a collision.
"""
import os
import stat

from .common import Layout, require
from .units import render_config_check, render_edge_units, render_units, sudo_rule

ROLES = ("worker", "gateway", "authelia", "caddy", "config-check")
SYSTEMD_PATHS = ("etc/systemd/system", "run/systemd/system", "usr/local/lib/systemd/system",
                 "usr/lib/systemd/system", "lib/systemd/system", "etc/systemd/system.control",
                 "run/systemd/system.control", "run/systemd/transient", "run/systemd/generator",
                 "run/systemd/generator.early", "run/systemd/generator.late")


def present(path):
    return path.exists() or path.is_symlink()


def regular(path, expected: set[bytes]) -> None:
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 1024 * 1024 and
            (info.st_uid == 0 and not info.st_mode & 0o022 if os.name == 'posix' else True) and
            path.read_bytes() in expected, "Service definition is not owned by this instance", "ownership_conflict")


def require_owned(layout: Layout, config: dict, *, allow_absent: bool = False,
                  prior_units: dict[str, bytes | None] | None = None, candidate_dns: dict | None = None) -> None:
    expected = {**render_units(layout, config, config["codexRelative"]), **render_edge_units(layout), layout.unit("config-check"): render_config_check(layout)}
    worker_variants = {render_units(layout, config, config["codexRelative"], legacy_runtime_directory=runtime, legacy_native_home=home)[layout.unit("worker")].encode()
                       for runtime in (False, True) for home in (False, True)}
    for role in ROLES:
        unit = layout.unit(role)
        path = layout.units / unit
        allowed = {expected[unit].encode()}
        if role == "caddy":
            allowed.add(render_edge_units(layout, builtin=True)[unit].encode())
            if candidate_dns is not None:
                allowed.add(render_edge_units(layout, builtin=True, dns_metadata=candidate_dns)[unit].encode())
            if present(layout.config / "https.json"):
                from .https import read_https_metadata
                metadata = read_https_metadata(layout)
                if metadata.get("dnsProvider") is not None:
                    allowed.add(render_edge_units(layout, builtin=True, dns_metadata=metadata)[unit].encode())
        if role == "worker":
            allowed.update(worker_variants)
        if prior_units and prior_units.get(role) is not None:
            allowed.add(prior_units[role])
        if present(path):
            regular(path, allowed)
        else:
            require(allow_absent or role in ("authelia", "caddy") or role == "config-check" and
                    (config.get("providerConfigLayer") is None or prior_units is not None and "config-check" in prior_units and prior_units["config-check"] is None),
                    "Managed service definition is missing", "ownership_conflict")
        for root in SYSTEMD_PATHS:
            directory = layout.root / root
            if directory != layout.units:
                require(not present(directory / unit) and not present(directory / (unit + ".d")),
                        "Another systemd definition conflicts with this instance", "ownership_conflict")
        dropins = layout.units / (unit + ".d")
        if present(dropins):
            info = dropins.lstat()
            require(stat.S_ISDIR(info.st_mode) and (os.name != 'posix' or info.st_uid == 0 and not info.st_mode & 0o022),
                    "Unsafe service drop-in directory", "ownership_conflict")
            allowed_dropins = {
                "90-codex-harness-control-maintenance.conf": f"[Unit]\nConditionPathExists=!{layout.config / 'control-maintenance' / role}\n".encode(),
                "91-codex-harness-https-recovery.conf": f"[Unit]\nConditionPathExists=!{layout.config / 'https-recovery' / role}\n".encode(),
                "92-codex-harness-config-layer.conf": f"[Unit]\nConditionPathExists=!{layout.config / 'config-layer-maintenance' / role}\n".encode(),
                "93-codex-harness-service-lifecycle.conf": f"[Unit]\nConditionPathExists=!{layout.config / 'service-lifecycle' / role}\n".encode(),
            }
            for item in dropins.iterdir():
                require(item.name in allowed_dropins, "Unrecognized service drop-in", "ownership_conflict")
                regular(item, {allowed_dropins[item.name]})
    sudo = layout.root / "etc/sudoers.d" / ("codex-harness-" + layout.instance)
    if present(sudo):
        regular(sudo, {sudo_rule(layout, workspace=workspace, legacy_catalog_server=legacy).encode()
                       for workspace in (False, True) for legacy in (False, True)})
    else:
        require(allow_absent, "Managed sudo policy is missing", "ownership_conflict")


def preflight_new(layout: Layout, system) -> None:
    for path in (layout.app, layout.config, layout.state, layout.control, layout.work, layout.run,
                 layout.control.parent / ("." + layout.instance + "-control-transactions"),
                 layout.root / "etc/sudoers.d" / ("codex-harness-" + layout.instance)):
        require(not present(path), "Instance path already exists; inspect before installation", "collision")
    for role in ROLES:
        unit = layout.unit(role)
        for root in SYSTEMD_PATHS:
            directory = layout.root / root
            require(not present(directory / unit) and not present(directory / (unit + ".d")),
                    "Service definition already exists", "collision")
        state = system.state(unit)
        require(state["LoadState"] == "not-found" and state["stopped"],
                "A systemd service already uses this instance name", "collision")
