from __future__ import annotations

import os
import stat
from pathlib import Path

from .build import Builder
from .common import Layout, atomic_write, canonical, exclusive, mkdir, require
from .manager import Manager
from .system import System, require_linux, run
from .units import validate_origin
from .ownership import preflight_new


def trusted_ancestors(path: Path) -> None:
    for candidate in [path, *path.parents]:
        if candidate.exists() or candidate.is_symlink():
            status = candidate.lstat()
            require(stat.S_ISDIR(status.st_mode) and status.st_uid == 0 and not status.st_mode & 0o022,
                    "Managed path has an untrusted ancestor", "unsafe_path")


def ensure_account(name: str, home: Path) -> tuple[int, int]:
    from .install_recovery import reserved_identities, root_lock
    # This helper provisions the HTTPS edge on the real host. Initialization
    # uses the same host-wide lock and journals numeric reservations first.
    allocation = Layout("allocation")
    with root_lock(allocation.config.parent / ".initialize-identities.lock", shared_root=allocation.root):
        return ensure_reserved_account(name, home, reserved_identities(allocation))


def ensure_reserved_account(name: str, home: Path, reserved: tuple[set[int], set[int]]) -> tuple[int, int]:
    import pwd
    import grp
    reserved_uids, reserved_gids = reserved
    try:
        group = grp.getgrnam(name)
    except KeyError:
        used = {item.gr_gid for item in grp.getgrall()} | reserved_gids
        available = [value for value in range(999, 99, -1) if value not in used]
        require(bool(available), "No free system group outside initialization reservations", "prerequisite")
        run(["/usr/sbin/groupadd", "--system", "--gid", str(available[0]), name])
        group = grp.getgrnam(name)
    try:
        account = pwd.getpwnam(name)
        require(account.pw_uid != 0 and account.pw_gid == group.gr_gid and account.pw_dir == str(home) and
                account.pw_shell == "/usr/sbin/nologin", "Existing service account does not match expected identity", "identity_conflict")
    except KeyError:
        used = {item.pw_uid for item in pwd.getpwall()} | reserved_uids
        available = [value for value in range(999, 99, -1) if value not in used]
        require(bool(available), "No free system account outside initialization reservations", "prerequisite")
        run(["/usr/sbin/useradd", "--system", "--no-create-home", "--uid", str(available[0]), "--gid", name,
             "--home-dir", str(home), "--shell", "/usr/sbin/nologin", name])
        account = pwd.getpwnam(name)
    require(not (set(group.gr_mem) - {name}) and not any(user.pw_gid == group.gr_gid and user.pw_uid != account.pw_uid for user in pwd.getpwall()),
            "Service primary group is shared with another identity", "identity_conflict")
    require(not any(name in item.gr_mem and item.gr_gid != group.gr_gid for item in grp.getgrall()),
            "Service account has unrelated supplementary groups", "identity_conflict")
    require(not any(item.pw_uid == account.pw_uid and item.pw_name != name for item in pwd.getpwall()) and
            not any(item.gr_gid == group.gr_gid and item.gr_name != name for item in grp.getgrall()),
            "Service identity has a numeric alias", "identity_conflict")
    return account.pw_uid, group.gr_gid


def stage_control(layout: Layout, destination: Path) -> None:
    require(not destination.exists() and not destination.is_symlink(), "Management helper already exists", "collision")
    mkdir(destination, 0o755)
    mkdir(destination / "deploy", 0o755)
    mkdir(destination / "deploy/caddy_dns_source", 0o755)
    for name, (data, mode) in control_material(layout).items():
        atomic_write(destination / name, data, mode)


def control_material(layout: Layout) -> dict[str, tuple[bytes, int]]:
    """Bytes from the invoked trusted checkout, also bound by initialization recovery."""
    source = Path(__file__).resolve().parent
    result = {}
    # Never import cached bytecode from the checkout, or copy documentation and
    # unrelated files into the sudo-authorized Python package.
    for path in sorted(source.glob("*.py")):
        details = path.lstat()
        require(stat.S_ISREG(details.st_mode) and details.st_nlink == 1 and details.st_size <= 1024 * 1024,
                "Unsafe trusted deployment source", "unsafe_path")
        data = path.read_bytes()
        compile(data, str(path), "exec")
        result["deploy/" + path.name] = (data, 0o644)
    from .dns_caddy_build import source_material
    for name, data in source_material().items():
        result["deploy/caddy_dns_source/" + name] = (data, 0o644)
    result.update(control_launchers(layout))
    from .dns_providers import PROVIDERS
    result["capabilities.json"] = (canonical({"format": 1, "providerConfigLayer": "system-v1", "nativeWorkspace": 1,
                                             "authenticationGuard": "account-v1", "dnsChallenge": "caddy-dns-v1",
                                             "dnsProviders": list(PROVIDERS)}) + b"\n", 0o644)
    return result


def write_control_launchers(layout: Layout, destination: Path) -> None:
    for name, (data, mode) in control_launchers(layout).items():
        atomic_write(destination / name, data, mode)


def control_launchers(layout: Layout) -> dict[str, tuple[bytes, int]]:
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
    native = f'''#!/usr/bin/python3 -I
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, {str(layout.control)!r})
from deploy.native_launcher import native_main
native_main({layout.instance!r})
'''
    return {"manage": (launcher.encode(), 0o755), "native-launch": (native.encode(), 0o755)}


def install_control(layout: Layout) -> None:
    stage_control(layout, layout.control)


def initialize(layout: Layout, *, origin: str, port: int, account: dict | None = None) -> tuple[int, int]:
    require_linux()
    origin = validate_origin(origin)
    require(type(port) is int and 1024 <= port <= 65535, "Invalid listening port")
    # Check every name before creating identities, secrets or resumable records.
    preflight_new(layout, System())
    from .ports import require_ports_available
    require_ports_available(tcp_ports=(port,))
    from .sandbox import require_host
    require_host()
    from .provider_layers import preflight_host_policy
    import grp
    try:
        proposed_gid = grp.getgrnam(layout.prefix + "-worker").gr_gid
    except KeyError:
        proposed_gid = -1
    preflight_host_policy({"kind": "chatgpt", "revision": "0" * 32}, layout, proposed_gid)
    for path in (layout.app, layout.config, layout.state, layout.control, layout.work):
        trusted_ancestors(path.parent)
    from .install_recovery import initialize_recorded
    return initialize_recorded(layout, origin=origin, port=port, account=account)


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
    from .service_lifecycle import uninstall_services
    return uninstall_services(manager)


def restore_services(layout: Layout) -> dict:
    from .service_lifecycle import restore_services as restore
    return restore(Manager(layout))
