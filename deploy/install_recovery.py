"""Resume only initialization material claimed by a durable, private creation plan."""
from __future__ import annotations

import contextlib
import hashlib
import os
import re
import secrets
import stat
import uuid
from pathlib import Path

from .common import Layout, canonical, digest, durable_directory, fsync_directory, read_json, require, write_json
from .ownership import ROLES, SYSTEMD_PATHS, present
from .system import System, run


def record_path(layout: Layout) -> Path:
    return layout.config.parent / ("." + layout.instance + "-initialize.json")


def private_record(path: Path) -> dict:
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 4 * 1024**2 and
            (os.name != "posix" or info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600),
            "Initialization record is not a private root-owned file", "integrity")
    value = read_json(path, 4 * 1024**2)
    require(isinstance(value, dict), "Invalid initialization record", "corrupt_state")
    return value


@contextlib.contextmanager
def _owned_lock(path: Path, *, modes: tuple[int, ...], message: str, shared_root: Path | None = None):
    from .install import trusted_ancestors
    import fcntl
    trusted_ancestors(path.parent)
    durable_directory(path.parent, create=True, shared_root=shared_root)
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and info.st_size == 0 and
                stat.S_IMODE(info.st_mode) in modes, message, "integrity")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            require(False, "Another operation holds this lock", "busy")
        current = path.lstat()
        require((current.st_dev, current.st_ino) == (info.st_dev, info.st_ino),
                "Lock path changed while acquiring ownership", "integrity")
        yield
    finally:
        os.close(fd)


def root_lock(path: Path, *, shared_root: Path | None = None):
    return _owned_lock(path, modes=(0o600,), message="Unsafe initialization lock", shared_root=shared_root)


def management_lock(layout: Layout):
    # common.exclusive creates this shared, empty lock with the operator's
    # umask. Group/other read permission cannot modify its contents or inode.
    # Keep its inode and mode, so existing operators contend on the same lock.
    return _owned_lock(layout.config / "management.lock", modes=(0o600, 0o640, 0o644), message="Unsafe management lock")


def initialization_lock(layout: Layout):
    return root_lock(layout.config.parent / ("." + layout.instance + "-initialize.lock"), shared_root=layout.root)


def reserved_identities(layout: Layout) -> tuple[set[int], set[int]]:
    uids, gids = set(), set()
    for index, path in enumerate(layout.config.parent.glob(".*-initialize.json")):
        require(index < 1024, "Initialization reservation budget exceeded", "budget")
        other = path.name[1:-len("-initialize.json")]
        state = private_record(path)
        require(state.get("format") == 1 and state.get("instance") == other and state.get("phase") in ("initializing", "initialized"),
                "Invalid retained identity reservation", "corrupt_state")
        validate_state(Layout(other, layout.root), state)
        for item in state["identities"].values():
            gids.add(item["gid"])
            if "uid" in item: uids.add(item["uid"])
    return uids, gids


def identity_plan(layout: Layout, reserved: tuple[set[int], set[int]] | None = None) -> dict:
    """Reserve exact numeric identities before groupadd/useradd can have effects."""
    import grp
    import pwd
    users, groups = pwd.getpwall(), grp.getgrall()
    roles = ("gateway", "worker", "control", "build", "ipc")
    names = {layout.prefix + "-" + role for role in roles}
    require(not names.intersection(user.pw_name for user in users) and
            not names.intersection(group.gr_name for group in groups),
            "Service identities already exist without this initialization record", "identity_conflict")
    reserved_uids, reserved_gids = reserved or (set(), set())
    uids = [value for value in range(999, 99, -1) if value not in {user.pw_uid for user in users} | reserved_uids]
    gids = [value for value in range(999, 99, -1) if value not in {group.gr_gid for group in groups} | reserved_gids]
    require(len(uids) >= 4 and len(gids) >= 5, "Insufficient free system identities", "prerequisite")
    return {role: {"name": layout.prefix + "-" + role, "gid": gids[index],
                   **({"uid": uids[index], "home": str(Path("/nonexistent") if role == "build" else
                       layout.state / ("supervisor" if role == "control" else role))} if role != "ipc" else {})}
            for index, role in enumerate(roles)}


def ensure_identities(plan: dict) -> None:
    import grp
    import pwd
    for role, entry in plan.items():
        name, gid = entry["name"], entry["gid"]
        groups, users = grp.getgrall(), pwd.getpwall()
        matching = [item for item in groups if item.gr_name == name or item.gr_gid == gid]
        require(not matching or len(matching) == 1 and matching[0].gr_name == name and matching[0].gr_gid == gid and
                not (set(matching[0].gr_mem) - ({name} if role != "ipc" else set())),
                "Reserved service group differs from initialization plan", "identity_conflict")
        if not matching:
            run(["/usr/sbin/groupadd", "--system", "--gid", str(gid), name])
        if role == "ipc":
            require(not any(user.pw_gid == gid for user in users), "IPC group is in use", "identity_conflict")
            continue
        matching_users = [item for item in users if item.pw_name == name or item.pw_uid == entry["uid"]]
        require(not matching_users or len(matching_users) == 1 and matching_users[0].pw_name == name and
                matching_users[0].pw_uid == entry["uid"] and matching_users[0].pw_gid == gid and
                matching_users[0].pw_dir == entry["home"] and matching_users[0].pw_shell == "/usr/sbin/nologin",
                "Reserved service account differs from initialization plan", "identity_conflict")
        require(not any(user.pw_gid == gid and user.pw_name != name for user in users) and
                not any(name in group.gr_mem and group.gr_gid != gid for group in groups),
                "Reserved service identity is shared", "identity_conflict")
        if not matching_users:
            run(["/usr/sbin/useradd", "--system", "--no-create-home", "--uid", str(entry["uid"]), "--gid", str(gid),
                 "--home-dir", entry["home"], "--shell", "/usr/sbin/nologin", name])
    users, groups = pwd.getpwall(), grp.getgrall()
    for role, entry in plan.items():
        group = [item for item in groups if item.gr_name == entry["name"] or item.gr_gid == entry["gid"]]
        require(len(group) == 1 and group[0].gr_name == entry["name"] and group[0].gr_gid == entry["gid"] and
                not (set(group[0].gr_mem) - ({entry["name"]} if role != "ipc" else set())),
                "Created service group did not match its reserved identity", "identity_conflict")
        if role == "ipc":
            require(not any(item.pw_gid == entry["gid"] for item in users), "IPC group is shared", "identity_conflict")
        else:
            user = [item for item in users if item.pw_name == entry["name"] or item.pw_uid == entry["uid"]]
            require(len(user) == 1 and user[0].pw_name == entry["name"] and user[0].pw_uid == entry["uid"] and
                    user[0].pw_gid == entry["gid"] and user[0].pw_dir == entry["home"] and user[0].pw_shell == "/usr/sbin/nologin" and
                    not any(item.pw_gid == entry["gid"] and item.pw_name != entry["name"] for item in users) and
                    not any(entry["name"] in item.gr_mem and item.gr_gid != entry["gid"] for item in groups),
                    "Created service account did not match its reserved identity", "identity_conflict")


def validate_state(layout: Layout, state: dict):
    from .units import validate_origin
    roles = {"gateway", "worker", "control", "build", "ipc"}
    require(set(state.get("identities", {})) == roles and isinstance(state.get("config"), dict), "Invalid initialization identities", "corrupt_state")
    for role, entry in state["identities"].items():
        require(isinstance(entry, dict) and entry.get("name") == layout.prefix + "-" + role and
                type(entry.get("gid")) is int and 100 <= entry["gid"] <= 999, "Invalid reserved group", "corrupt_state")
        if role != "ipc":
            home = str(Path("/nonexistent") if role == "build" else layout.state / ("supervisor" if role == "control" else role))
            require(type(entry.get("uid")) is int and 100 <= entry["uid"] <= 999 and entry.get("home") == home,
                    "Invalid reserved account", "corrupt_state")
    require(len({item["gid"] for item in state["identities"].values()}) == 5 and
            len({item["uid"] for item in state["identities"].values() if "uid" in item}) == 4,
            "Initialization identities overlap", "corrupt_state")
    config = state["config"]
    for role, source in (("gateway", "gateway"), ("worker", "worker"), ("supervisor", "control"), ("build", "build")):
        require(config.get(role + "Uid") == state["identities"][source]["uid"] and config.get(role + "Gid") == state["identities"][source]["gid"],
                "Initialization configuration identity mismatch", "corrupt_state")
    require(config.get("instance") == layout.instance and config.get("format") == 1 and config.get("providerConfigLayer") == "system-v1" and
            type(config.get("port")) is int and 1024 <= config["port"] <= 65535 and
            config.get("codexRelative") in ("vendor/x86_64-unknown-linux-musl/bin/codex", "vendor/aarch64-unknown-linux-musl/bin/codex"),
            "Invalid initialization configuration", "corrupt_state")
    validate_origin(config.get("origin"))
    require(all(isinstance(state.get(key), str) and re.fullmatch(pattern, state[key]) is not None for key, pattern in
                (("id", r"[0-9a-f]{32}"), ("providerRevision", r"[0-9a-f]{32}"), ("token", r"[A-Za-z0-9_-]{64}"))),
            "Invalid initialization identity material", "corrupt_state")


class CreationPlan:
    def __init__(self, layout: Layout, state: dict):
        self.layout, self.state = layout, state
        self.entries: dict[Path, dict] = {}
        self.content: dict[Path, bytes] = {}

    def directory(self, path: Path, mode: int, uid: int = 0, gid: int = 0):
        self.entries[path] = {"kind": "directory", "mode": mode, "uid": uid, "gid": gid}

    def file(self, path: Path, data: bytes, mode: int = 0o600, uid: int = 0, gid: int = 0):
        self.entries[path] = {"kind": "file", "mode": mode, "uid": uid, "gid": gid, "sha256": hashlib.sha256(data).hexdigest()}
        self.content[path] = data

    def json(self, path: Path, value, mode: int = 0o600, uid: int = 0, gid: int = 0):
        self.file(path, canonical(value) + b"\n", mode, uid, gid)

    def link(self, path: Path, target: str):
        self.entries[path] = {"kind": "link", "target": target, "uid": 0, "gid": 0}

    def temporary(self, path: Path) -> Path:
        suffix = hashlib.sha256(str(path).encode()).hexdigest()[:20]
        return path.parent / (".initialize-" + self.state["id"] + "-" + suffix)

    def bind(self):
        expected = {str(path.relative_to(self.layout.root)): entry for path, entry in self.entries.items()}
        if self.state.get("plan") is not None:
            require(self.state["plan"] == expected, "Initialization inputs or host policy changed; use the original reviewed checkout and policy", "integrity")
        else:
            self.state["plan"] = expected
            write_json(record_path(self.layout), self.state)

    def verify(self, path: Path):
        expected = self.entries[path]
        info = path.lstat()
        require(os.name != "posix" or info.st_uid == expected["uid"] and info.st_gid == expected["gid"],
                "Initialization material ownership changed", "integrity")
        kind = expected["kind"]
        if kind == "link":
            require(stat.S_ISLNK(info.st_mode) and os.readlink(path) == expected["target"], "Initialization pointer changed", "integrity")
        else:
            require(stat.S_IMODE(info.st_mode) == expected["mode"] if os.name == "posix" else True,
                    "Initialization material permissions changed", "integrity")
            require(stat.S_ISDIR(info.st_mode) if kind == "directory" else stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                    "Initialization material type changed", "integrity")
            if kind == "file":
                require(info.st_size == len(self.content[path]) and path.read_bytes() == self.content[path],
                        "Initialization material differs from the recorded plan", "integrity")

    def inspect_existing(self):
        for path in self.content:
            temporary = self.temporary(path)
            if present(path) and present(temporary):
                info, staging = path.lstat(), temporary.lstat()
                require(stat.S_ISREG(info.st_mode) and stat.S_ISREG(staging.st_mode) and
                        info.st_ino == staging.st_ino and info.st_dev == staging.st_dev and info.st_nlink == 2 and
                        path.read_bytes() == self.content[path], "Unexpected initialization publication links", "integrity")
                temporary.unlink()
                fsync_directory(path.parent)
        for path in self.entries:
            if present(path):
                self.verify(path)
        # The recorded plan, not merely an existing directory, claims each entry.
        for root in (self.layout.app, self.layout.config, self.layout.state, self.layout.control):
            if not present(root):
                continue
            pending = [root]
            count = 0
            while pending:
                for path in pending.pop().iterdir():
                    count += 1
                    require(count <= 4096, "Initialization inventory exceeds budget", "budget")
                    if path in self.entries:
                        if self.entries[path]["kind"] == "directory":
                            pending.append(path)
                    else:
                        targets = [item for item in self.entries if self.temporary(item) == path]
                        require(len(targets) == 1, "Unclaimed material in interrupted initialization", "ownership_conflict")
                        target = targets[0]
                        info = path.lstat()
                        entry = self.entries[target]
                        allowed = ((0, 0, 0o700) if entry["kind"] == "directory" else (0, 0, 0o600),
                                   (0, 0, entry.get("mode", 0)),
                                   (entry["uid"], entry["gid"], entry.get("mode", 0)))
                        require((stat.S_ISDIR(info.st_mode) and not any(path.iterdir()) if entry["kind"] == "directory" else
                                 stat.S_ISREG(info.st_mode) and info.st_nlink == 1) and
                                (os.name != "posix" or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) in allowed),
                                "Unsafe interrupted initialization staging file", "integrity")

    def publish(self, path: Path):
        if present(path):
            self.verify(path)
            durable_directory(path if self.entries[path]["kind"] == "directory" else path.parent)
            return
        entry = self.entries[path]
        if entry["kind"] == "directory":
            temporary = self.temporary(path)
            if present(temporary):
                require(temporary.is_dir() and not temporary.is_symlink() and not any(temporary.iterdir()),
                        "Initialization staging directory is not empty", "integrity")
                temporary.rmdir()
            temporary.mkdir(mode=0o700)
            os.chmod(temporary, entry["mode"])
            if os.name == "posix": os.chown(temporary, entry["uid"], entry["gid"])
            fsync_directory(temporary)
            if os.name == "posix":
                from .workspace_paths import rename_absent
                fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try: rename_absent(fd, temporary.name, fd, path.name)
                finally: os.close(fd)
            else:
                os.rename(temporary, path)
        elif entry["kind"] == "link":
            os.symlink(entry["target"], path)
        else:
            temporary = self.temporary(path)
            # Its deterministic name was claimed in the plan before first write.
            if present(temporary):
                info = temporary.lstat()
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                        (os.name != "posix" or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) in
                         ((0, 0, 0o600), (0, 0, entry["mode"]), (entry["uid"], entry["gid"], entry["mode"]))),
                        "Unsafe initialization staging file", "integrity")
                temporary.unlink()
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(self.content[path]); stream.flush(); os.fsync(stream.fileno())
            # A hardlink provides no-replace publication. A crash before unlink
            # leaves the known staging link, which is finalized on a retry.
            os.chmod(temporary, entry["mode"])
            if os.name == "posix": os.chown(temporary, entry["uid"], entry["gid"])
            with temporary.open("rb" if os.name == "posix" else "r+b") as stream: os.fsync(stream.fileno())
            os.link(temporary, path)
            temporary.unlink()
        durable_directory(path if entry["kind"] == "directory" else path.parent)


def build_plan(layout: Layout, state: dict, material: dict) -> CreationPlan:
    from .provider import native_config
    from .provider_layers import generation_layers, prepare_host_targets
    from .units import render_units, sudo_rule
    identities, config = state["identities"], state["config"]
    gateway, worker, control = (identities[key] for key in ("gateway", "worker", "control"))
    plan = CreationPlan(layout, state)
    for path, mode in ((layout.app, 0o755), (layout.config, 0o751), (layout.state, 0o711),
                       (layout.config / "manifests", 0o700), (layout.state / "transactions", 0o700),
                       (layout.state / "requests", 0o700), (layout.control, 0o755), (layout.control / "deploy", 0o755)):
        plan.directory(path, mode)
    for path, mode, uid, gid in ((layout.state / "gateway", 0o700, gateway["uid"], gateway["gid"]),
                                (layout.state / "worker", 0o750, worker["uid"], worker["gid"]),
                                (layout.state / "worker/codex", 0o750, worker["uid"], worker["gid"]),
                                (layout.state / "supervisor", 0o750, control["uid"], worker["gid"]),
                                (layout.state / "supervisor/attachments", 0o2750, control["uid"], worker["gid"])):
        plan.directory(path, mode, uid, gid)
    plan.file(layout.state / "worker/codex/config.toml", b"", 0o600, worker["uid"], worker["gid"])
    plan.file(layout.config / "gateway-token", (state["token"] + "\n").encode(), 0o640, 0, gateway["gid"])
    settings = {"revision": state["providerRevision"], "kind": "chatgpt", "models": []}
    prepare_host_targets(settings, layout, worker["gid"])
    layers, host_manifest = generation_layers(settings, layout, worker["gid"])
    providers = layout.config / "providers"
    generation = providers / settings["revision"]
    plan.directory(providers, 0o750, 0, worker["gid"])
    plan.directory(generation, 0o750, 0, worker["gid"])
    plan.json(generation / "settings.json", settings)
    plan.file(generation / "config.toml", native_config(settings, layout), 0o640, 0, worker["gid"])
    for name, content in layers.items(): plan.file(generation / name, content, 0o640, 0, worker["gid"])
    plan.json(generation / "host-layers.json", host_manifest)
    plan.file(generation / "provider.env", b'HARNESS_PROVIDER_API_KEY=""\n')
    plan.json(generation / "native-env.json", {"HARNESS_PROVIDER_API_KEY": ""}, 0o640, 0, worker["gid"])
    plan.link(providers / "current", settings["revision"])
    plan.json(layout.config / "instance.json", config)
    if state["account"] is not None: plan.json(layout.config / "auth-bootstrap.json", state["account"], 0o640, 0, gateway["gid"])
    plan.json(layout.config / "installation.json", {"format": 1, "phase": "pending", "release": None})
    plan.json(layout.config / "native.json", {"uid": worker["uid"], "gid": worker["gid"], "cwd": str(layout.state / "worker"),
              "home": str(layout.state / "worker/codex"), "bin": str(layout.app / "current/codex" / config["codexRelative"])}, 0o644)
    if any(name.startswith("deploy/caddy_dns_source/") for name in material):
        plan.directory(layout.control / "deploy/caddy_dns_source", 0o755)
    for name, (data, mode) in material.items(): plan.file(layout.control / name, data, mode)
    plan.file(layout.config / "sudoers.pending", sudo_rule(layout).encode(), 0o440)
    plan.file(layout.root / "etc/sudoers.d" / ("codex-harness-" + layout.instance), sudo_rule(layout).encode(), 0o440)
    for name, content in render_units(layout, config, config["codexRelative"]).items():
        plan.file(layout.units / name, content.encode(), 0o644)
    return plan


def initialize_recorded(layout: Layout, *, origin: str | None = None, port: int | None = None,
                        account: dict | None = None, resume: bool = False) -> tuple[int, int]:
    from .build import architecture
    from .install import control_material, trusted_ancestors
    from .ports import require_ports_available
    from .provider_layers import LAYER_MODE
    from .ownership import preflight_new
    from .sandbox import require_host
    with initialization_lock(layout):
        path = record_path(layout)
        material = control_material(layout)
        source_digest = digest({name: [hashlib.sha256(data).hexdigest(), mode] for name, (data, mode) in material.items()})
        if resume:
            require(present(path), "No recorded initialization; unknown retained paths cannot be resumed", "recovery_required")
            state = private_record(path)
            require(state.get("format") == 1 and state.get("instance") == layout.instance and
                    state.get("phase") in ("initializing", "initialized"), "Invalid initialization record", "corrupt_state")
            require(state.get("controlDigest") == source_digest,
                    "Initialization requires the original reviewed control checkout; its source digest changed", "integrity")
            validate_state(layout, state)
            if state["phase"] == "initialized":
                return state["config"]["buildUid"], state["config"]["buildGid"]
        else:
            require(not present(path), "Recorded initialization exists; use install-resume", "collision")
            preflight_new(layout, System())
            # Reserve across instances as well as current /etc/passwd entries.
            # A crash before groupadd must not make another instance reuse IDs.
            with root_lock(layout.config.parent / ".initialize-identities.lock", shared_root=layout.root):
                identities = identity_plan(layout, reserved_identities(layout))
                config = {"format": 1, "instance": layout.instance, "origin": origin, "port": port, "providerConfigLayer": LAYER_MODE,
                          "codexRelative": "vendor/" + ("x86_64" if architecture() == "x64" else "aarch64") + "-unknown-linux-musl/bin/codex"}
                for role, source in (("gateway", "gateway"), ("worker", "worker"), ("supervisor", "control"), ("build", "build")):
                    config[role + "Uid"], config[role + "Gid"] = identities[source]["uid"], identities[source]["gid"]
                state = {"format": 1, "id": uuid.uuid4().hex, "instance": layout.instance, "phase": "initializing", "config": config,
                         "identities": identities, "token": secrets.token_urlsafe(48), "account": account,
                         "providerRevision": secrets.token_hex(16), "controlDigest": source_digest, "plan": None}
                write_json(path, state)
        validate_state(layout, state)
        require_host()
        require_ports_available(tcp_ports=(state["config"]["port"],))
        # Never stop or adopt a service during initialization recovery.
        for role in ROLES:
            require(System().state(layout.unit(role))["stopped"], "Initialization service is active or unknown", "stop_unknown")
            for base in SYSTEMD_PATHS:
                directory = layout.root / base
                require(not present(directory / (layout.unit(role) + ".d")) and
                        (directory == layout.units or not present(directory / layout.unit(role))),
                        "Unclaimed service override during initialization", "ownership_conflict")
        shared = (layout.app.parent, layout.state.parent, layout.control.parent)
        for parent in (*shared, layout.units, layout.root / "etc/sudoers.d"):
            trusted_ancestors(parent)
            durable_directory(parent, create=True, shared_root=layout.root if parent in shared else None)
        plan = build_plan(layout, state, material)
        plan.bind()
        plan.inspect_existing()
        ensure_identities(state["identities"])
        for target in sorted(plan.entries, key=lambda value: (len(value.parts), str(value))):
            if target == layout.root / "etc/sudoers.d" / ("codex-harness-" + layout.instance): continue
            plan.publish(target)
        run(["/usr/sbin/visudo", "-cf", str(layout.config / "sudoers.pending")])
        plan.publish(layout.root / "etc/sudoers.d" / ("codex-harness-" + layout.instance))
        System().reload()
        state["phase"] = "initialized"
        write_json(path, state)
        return state["config"]["buildUid"], state["config"]["buildGid"]


def install_resume(layout: Layout, archive: Path) -> dict:
    from .build import Builder
    from .common import exclusive
    from .manager import Manager
    from .system import require_linux
    require_linux()
    uid, gid = initialize_recorded(layout, resume=True)
    with exclusive(layout.config / "management.lock"):
        manager = Manager(layout)
        installation = manager.initial_installation(persist=False)
        require(installation is not None and installation["phase"] != "complete",
                "Installation is already complete; use update for application changes", "already_installed")
        manager.require_update_ready(persist=False)
        release = Builder(layout, manager.system, uid, gid).prepare(archive)
        return {**manager.activate(release), "origin": manager.config["origin"], "authentication": "builtin", "resumed": True}
