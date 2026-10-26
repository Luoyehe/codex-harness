from __future__ import annotations

import os
import secrets
import shutil
import stat
import uuid
from pathlib import Path

from .build import Builder, architecture
from .common import Layout, atomic_write, canonical, exclusive, mkdir, read_json, require, write_json
from .manager import Manager
from .provider import ProviderStore
from .safe_fs import snapshot
from .system import System, require_linux, run
from .units import render_units, sudo_rule, validate_origin
from .ownership import preflight_new


def trusted_ancestors(path: Path) -> None:
    for candidate in [path, *path.parents]:
        if candidate.exists() or candidate.is_symlink():
            status = candidate.lstat()
            require(stat.S_ISDIR(status.st_mode) and status.st_uid == 0 and not status.st_mode & 0o022,
                    "Managed path has an untrusted ancestor", "unsafe_path")


def ensure_account(name: str, home: Path) -> tuple[int, int]:
    import pwd
    import grp
    try:
        group = grp.getgrnam(name)
    except KeyError:
        run(["/usr/sbin/groupadd", "--system", name])
        group = grp.getgrnam(name)
    try:
        account = pwd.getpwnam(name)
        require(account.pw_uid != 0 and account.pw_gid == group.gr_gid and account.pw_dir == str(home) and
                account.pw_shell == "/usr/sbin/nologin", "Existing service account does not match expected identity", "identity_conflict")
    except KeyError:
        run(["/usr/sbin/useradd", "--system", "--no-create-home", "--gid", name, "--home-dir", str(home), "--shell", "/usr/sbin/nologin", name])
        account = pwd.getpwnam(name)
    require(not (set(group.gr_mem) - {name}) and not any(user.pw_gid == group.gr_gid and user.pw_uid != account.pw_uid for user in pwd.getpwall()),
            "Service primary group is shared with another identity", "identity_conflict")
    require(not any(name in item.gr_mem and item.gr_gid != group.gr_gid for item in grp.getgrall()),
            "Service account has unrelated supplementary groups", "identity_conflict")
    return account.pw_uid, group.gr_gid


def stage_control(layout: Layout, destination: Path) -> None:
    # This is the explicitly invoked trusted installer, never a candidate archive.
    source = Path(__file__).resolve().parent
    require(not destination.exists() and not destination.is_symlink(), "Management helper already exists", "collision")
    mkdir(destination, 0o755)
    mkdir(destination / "deploy", 0o755)
    # Never import cached bytecode from the checkout, or copy documentation and
    # unrelated files into the sudo-authorized Python package.
    for path in sorted(source.glob("*.py")):
        details = path.lstat()
        require(stat.S_ISREG(details.st_mode) and details.st_nlink == 1 and details.st_size <= 1024 * 1024,
                "Unsafe trusted deployment source", "unsafe_path")
        data = path.read_bytes()
        compile(data, str(path), "exec")
        atomic_write(destination / "deploy" / path.name, data, 0o644)
    write_control_launchers(layout, destination)
    write_json(destination / "capabilities.json", {"format": 1, "providerConfigLayer": "system-v1", "nativeWorkspace": 1,
                                                  "authenticationGuard": "account-v1"}, mode=0o644)


def write_control_launchers(layout: Layout, destination: Path) -> None:
    launcher = f'''#!/usr/bin/python3 -I
import sys
sys.dont_write_bytecode = True
import json
from pathlib import Path
for record in ([] if sys.argv[1:] == ["config-check"] else Path({str(layout.control.parent / ('.' + layout.instance + '-control-transactions'))!r}).glob("*/state.json")):
    try:
        if json.loads(record.read_text()).get("phase") not in ("committed", "recovered"):
            raise SystemExit(75)
    except (OSError, ValueError, AttributeError):
        raise SystemExit(75)
sys.path.insert(0, {str(layout.control)!r})
from deploy.cli import helper_main
helper_main({layout.instance!r})
'''
    atomic_write(destination / "manage", launcher.encode(), 0o755)
    native = f'''#!/usr/bin/python3 -I
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, {str(layout.control)!r})
from deploy.native_launcher import native_main
native_main({layout.instance!r})
'''
    atomic_write(destination / "native-launch", native.encode(), 0o755)


def install_control(layout: Layout) -> None:
    stage_control(layout, layout.control)


def initialize(layout: Layout, *, origin: str, port: int, account: dict | None = None) -> tuple[int, int]:
    require_linux()
    origin = validate_origin(origin)
    require(type(port) is int and 1024 <= port <= 65535, "Invalid listening port")
    # Check every name before creating identities, secrets or resumable records.
    preflight_new(layout, System())
    from .sandbox import require_host
    require_host()
    from .provider_layers import LAYER_MODE, preflight_host_policy, prepare_host_targets
    import grp
    try:
        proposed_gid = grp.getgrnam(layout.prefix + "-worker").gr_gid
    except KeyError:
        proposed_gid = -1
    preflight_host_policy({"kind": "chatgpt", "revision": "0" * 32}, layout, proposed_gid)
    for path in (layout.app, layout.config, layout.state, layout.control, layout.work):
        trusted_ancestors(path.parent)
    mkdir(layout.app, 0o755)
    mkdir(layout.config, 0o751)
    mkdir(layout.state, 0o711)
    mkdir(layout.config / "manifests", 0o700)
    mkdir(layout.state / "transactions", 0o700)
    mkdir(layout.state / "requests", 0o700)
    gateway_uid, gateway_gid = ensure_account(layout.prefix + "-gateway", layout.state / "gateway")
    worker_uid, worker_gid = ensure_account(layout.prefix + "-worker", layout.state / "worker")
    supervisor_uid, supervisor_gid = ensure_account(layout.prefix + "-control", layout.state / "supervisor")
    build_uid, build_gid = ensure_account(layout.prefix + "-build", Path("/nonexistent"))
    import pwd
    try:
        ipc = grp.getgrnam(layout.prefix + "-ipc")
        require(not ipc.gr_mem and not any(user.pw_gid == ipc.gr_gid for user in pwd.getpwall()),
                "Existing IPC group is shared with another identity", "identity_conflict")
    except KeyError:
        run(["/usr/sbin/groupadd", "--system", layout.prefix + "-ipc"])
    require(len({gateway_uid, worker_uid, supervisor_uid, build_uid}) == 4 and len({gateway_gid, worker_gid, supervisor_gid, build_gid, grp.getgrnam(layout.prefix + '-ipc').gr_gid}) == 5,
            "Gateway, supervisor, native, build and IPC identities must be distinct", "identity_conflict")
    mkdir(layout.state / "gateway", 0o700, gateway_uid, gateway_gid)
    mkdir(layout.state / "worker", 0o750, worker_uid, worker_gid)
    mkdir(layout.state / "worker/codex", 0o750, worker_uid, worker_gid)
    mkdir(layout.state / "supervisor", 0o750, supervisor_uid, worker_gid)
    mkdir(layout.state / "supervisor/attachments", 0o2750, supervisor_uid, worker_gid)
    # Native owns its user layer. System provider defaults/requirements are
    # mounted at /etc/codex; existing user data is never rewritten on migration.
    atomic_write(layout.state / "worker/codex/config.toml", b"", 0o600, worker_uid, worker_gid)
    token = secrets.token_urlsafe(48)
    atomic_write(layout.config / "gateway-token", (token + "\n").encode(), 0o640, 0, gateway_gid)
    settings = {"revision": secrets.token_hex(16), "kind": "chatgpt", "models": []}
    providers = ProviderStore(layout, worker_gid)
    prepare_host_targets(settings, layout, worker_gid)
    providers.select(providers.prepare(settings, layered=True))
    config = {"format": 1, "instance": layout.instance, "origin": origin, "port": port,
              "gatewayUid": gateway_uid, "gatewayGid": gateway_gid, "workerUid": worker_uid, "workerGid": worker_gid,
              "supervisorUid": supervisor_uid, "supervisorGid": supervisor_gid,
              "buildUid": build_uid, "buildGid": build_gid, "providerConfigLayer": LAYER_MODE}
    write_json(layout.config / "instance.json", config)
    if account is not None:
        from .accounts import write_bootstrap
        write_bootstrap(layout, config, account)
    write_json(layout.config / "installation.json", {"format": 1, "phase": "pending", "release": None})
    install_control(layout)
    sudo_path = layout.root / "etc/sudoers.d" / ("codex-harness-" + layout.instance)
    require(not sudo_path.exists(), "Existing sudoers entry", "collision")
    sudo_temp = layout.config / "sudoers.pending"
    atomic_write(sudo_temp, sudo_rule(layout).encode(), 0o440)
    run(["/usr/sbin/visudo", "-cf", str(sudo_temp)])
    atomic_write(sudo_path, sudo_temp.read_bytes(), 0o440)
    machine = "x86_64" if architecture() == "x64" else "aarch64"
    codex_relative = f"vendor/{machine}-unknown-linux-musl/bin/codex"
    # Official platform archives use the musl target on Linux; verified on import.
    config["codexRelative"] = codex_relative
    write_json(layout.config / "instance.json", config)
    write_json(layout.config / "native.json", {"uid": worker_uid, "gid": worker_gid, "cwd": str(layout.state / "worker"),
               "home": str(layout.state / "worker/codex"), "bin": str(layout.app / "current/codex" / codex_relative)}, mode=0o644)
    for name, content in render_units(layout, config, codex_relative).items():
        target = layout.units / name
        require(not target.exists(), "Service unit already exists", "collision")
        atomic_write(target, content.encode(), 0o644)
    System().reload()
    return build_uid, build_gid


def install(layout: Layout, archive: Path, *, origin: str, port: int, account: dict | None = None) -> dict:
    require(account is not None, "An initial administrator account is required")
    uid, gid = initialize(layout, origin=origin, port=port, account=account)
    # Failed installations deliberately keep identity, secrets and all recovery
    # records. Re-running install refuses replacement; update/repair resumes.
    with exclusive(layout.config / "management.lock"):
        release = Builder(layout, System(), uid, gid).prepare(archive)
        manager = Manager(layout)
        require((layout.app / "releases" / release / "codex" / manager.config["codexRelative"]).is_file(),
                "Pinned Codex platform binary is absent", "integrity")
        result = manager.activate(release)
        return {**result, "origin": origin, "authentication": "builtin",
                "login": "Open origin and sign in with the administrator username and password selected during installation."}


def uninstall(layout: Layout) -> dict:
    manager = Manager(layout)
    manager.require_recovered_transactions(None)
    manager.require_service_ownership(allow_absent=True)
    units = manager.service_units
    if (layout.units / layout.unit("config-check")).exists():
        units = [*units, layout.unit("config-check")]
    if (layout.config / "https.json").exists():
        units = [layout.unit("caddy"), layout.unit("authelia"), *units]
    manager.system.stop(units)
    run(["/usr/bin/systemctl", "disable", *units], check=False)
    for unit in units:
        (layout.units / unit).unlink(missing_ok=True)
    (layout.root / "etc/sudoers.d" / ("codex-harness-" + layout.instance)).unlink(missing_ok=True)
    manager.system.reload()
    # Deliberately retain all data and encrypted identity/key pairs. Purging is an
    # operator file operation, never exposed through gateway or implicit uninstall.
    write_json(layout.config / "uninstalled.json", {"servicesRemoved": True, "dataPreserved": True})
    return {"servicesRemoved": True, "dataPreserved": True, "dataPath": str(layout.state), "configPath": str(layout.config)}
