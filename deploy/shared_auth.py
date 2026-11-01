"""One instance login, transferred only while both execution services are stopped.

Codex 0.164 writes CODEX_HOME/auth.json in place and unlinks it on logout. A
symlink or file bind cannot share that lifecycle. Keep exactly one active file;
the execution transaction moves it, never a stale credential snapshot. Journals
contain inode identities, not credentials. Legacy logins are quarantined once.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import stat

from .common import require, write_json
from .execution_identity import state as execution_state
from .workspace_paths import rename_absent

MODES = ("native", "root")
DIRECTORY = "shared-chatgpt-auth"
LIMIT = 1024 * 1024


def present(layout):
    path = layout.state / DIRECTORY
    return path.exists() or path.is_symlink()


def require_control(layout, capabilities):
    if present(layout):
        require(type(capabilities.get("sharedChatgptAuth")) is int and capabilities["sharedChatgptAuth"] == 1,
                "Control target cannot preserve the instance ChatGPT login; select shared-auth capable control tools",
                "shared_auth_unsupported")


def validate_record(value):
    require(isinstance(value, dict) and set(value) == {"format", "mode", "backups", "migration", "pending"} and
            type(value["format"]) is int and value["format"] == 1 and value["mode"] in MODES and
            isinstance(value["backups"], list) and len(value["backups"]) <= 1 and
            all(mode in MODES for mode in value["backups"]), "Invalid shared authentication state", "corrupt_state")
    migration = value["migration"]
    if migration is not None:
        require(isinstance(migration, dict) and set(migration) == {"mode", "identity"} and
                migration["mode"] in MODES and migration["mode"] != value["mode"] and not value["backups"] and
                value["pending"] is None, "Invalid shared authentication migration", "corrupt_state")
        validate_identity(migration["identity"])
    pending = value["pending"]
    if pending is not None:
        require(isinstance(pending, dict) and set(pending) == {"from", "to", "identity", "transaction"} and
                pending["from"] == value["mode"] and pending["to"] in MODES and pending["to"] != pending["from"] and
                isinstance(pending["transaction"], str) and re.fullmatch(r"[0-9a-f]{32}", pending["transaction"]),
                "Invalid shared authentication transfer", "corrupt_state")
        validate_identity(pending["identity"])
    return value


def validate_identity(value):
    require(value is None or isinstance(value, list) and len(value) == 2 and
            all(type(number) is int and number >= 0 for number in value) and value[1] > 0,
            "Invalid shared authentication inode", "corrupt_state")


class Store:
    def __init__(self, layout, config, *, create=False):
        self.layout, self.config = layout, config
        self.path = layout.state / DIRECTORY
        self.stack = contextlib.ExitStack()
        self.homes = {}
        self.fd = None
        self.create = create

    def directory(self, name, *, parent=None, uid=0, gid=None, private=False):
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        self.stack.callback(os.close, fd)
        info = os.fstat(fd)
        require(info.st_uid == uid and (gid is None or info.st_gid == gid) and not info.st_mode & 0o022 and
                (not private or stat.S_IMODE(info.st_mode) == 0o700),
                "Shared authentication directory ownership changed", "integrity")
        return fd

    def __enter__(self):
        try:
            require(os.name == "posix" and os.geteuid() == 0, "Shared authentication requires trusted Linux control", "integrity")
            parent = self.directory(str(self.layout.state))
            if self.create:
                try:
                    os.mkdir(DIRECTORY, 0o700, dir_fd=parent)
                except FileExistsError:
                    pass
                os.fsync(parent)
            self.fd = self.directory(DIRECTORY, parent=parent, gid=0, private=True)
            for mode in MODES:
                uid, gid = self.owner(mode)
                name = "worker-root" if mode == "root" else "worker"
                try:
                    worker = self.directory(name, parent=parent, uid=uid, gid=gid, private=mode == "root")
                    self.homes[mode] = self.directory("codex", parent=worker, uid=uid, gid=gid, private=mode == "root")
                except FileNotFoundError:
                    self.homes[mode] = None
            return self
        except BaseException:
            self.stack.close()
            raise

    def __exit__(self, *args):
        self.stack.close()

    def owner(self, mode):
        return (0, 0) if mode == "root" else (self.config["workerUid"], self.config["workerGid"])

    def info(self, fd, name, owners):
        if fd is None:
            return None
        try:
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            return None
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= LIMIT and
                stat.S_IMODE(info.st_mode) == 0o600 and (info.st_uid, info.st_gid) in owners,
                "Unsafe shared authentication file; original files were preserved", "integrity")
        return [info.st_dev, info.st_ino]

    def auth(self, mode):
        return self.info(self.homes[mode], "auth.json", {self.owner(mode)})

    def load(self):
        identity = self.info(self.fd, "state.json", {(0, 0)})
        if identity is None:
            return None
        fd = os.open("state.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.fd)
        with os.fdopen(fd, "rb") as stream:
            require([os.fstat(stream.fileno()).st_dev, os.fstat(stream.fileno()).st_ino] == identity,
                    "Shared authentication state changed during inspection", "integrity")
            raw = stream.read(8193)
        require(len(raw) <= 8192, "Shared authentication state exceeds budget", "corrupt_state")
        return validate_record(json.loads(raw))

    def save(self, value):
        write_json(self.path / "state.json", validate_record(value))

    def normalize_owner(self, fd, name, identity, owner):
        opened = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            info = os.fstat(opened)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and [info.st_dev, info.st_ino] == identity,
                    "Shared authentication file changed during transfer", "integrity")
            os.fchown(opened, *owner)
            os.fchmod(opened, 0o600)
            os.fsync(opened)
        finally:
            os.close(opened)

    def move(self, source, name, target, destination, identity):
        require(self.info(target, destination, {(0, 0), self.owner("native")}) is None,
                "Shared authentication destination already exists", "integrity")
        opened = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source)
        try:
            info = os.fstat(opened)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and [info.st_dev, info.st_ino] == identity,
                    "Shared authentication source changed during transfer", "integrity")
            os.fsync(opened)
        finally:
            os.close(opened)
        rename_absent(source, name, target, destination)

    def migrate(self, value):
        migration = value["migration"]
        if migration is None:
            return
        mode, identity = migration["mode"], migration["identity"]
        backup = "legacy-" + mode + ".auth.json"
        current = self.auth(mode)
        retained = self.info(self.fd, backup, {(0, 0), self.owner(mode)})
        if identity is not None:
            require((current is None) != (retained is None) and (current or retained) == identity,
                    "Legacy authentication migration is ambiguous", "integrity")
            if current is not None:
                self.move(self.homes[mode], "auth.json", self.fd, backup, identity)
            self.normalize_owner(self.fd, backup, identity, (0, 0))
            value["backups"] = [mode]
        else:
            require(current is None and retained is None, "Legacy authentication appeared during migration", "integrity")
        value["migration"] = None
        self.save(value)

    def finish(self, value, transaction, destination):
        pending = value["pending"]
        if pending is None:
            return
        require(pending["transaction"] == transaction, "Another authentication transfer needs recovery", "recovery_required")
        source, target, identity = pending["from"], pending["to"], pending["identity"]
        require(destination in (source, target) and self.homes[destination] is not None, "Authentication home is missing", "integrity")
        original, selected = self.auth(source), self.auth(target)
        held = self.info(self.fd, "transfer.auth.json", {(0, 0), self.owner(source), self.owner(target)})
        if identity is None:
            require(original is None and held is None and selected is None,
                    "Logged-out authentication transfer acquired unexpected credentials", "integrity")
        else:
            found = [item for item in (original, held, selected) if item is not None]
            require(found == [identity], "Authentication transfer is ambiguous or was replaced", "integrity")
            located = source if original is not None else target if selected is not None else None
            # Old-direction recovery returns directly to the old home. It must
            # not first complete publication into a broken candidate home.
            if located != destination:
                if located is not None:
                    self.move(self.homes[located], "auth.json", self.fd, "transfer.auth.json", identity)
                self.normalize_owner(self.fd, "transfer.auth.json", identity, self.owner(destination))
                self.move(self.fd, "transfer.auth.json", self.homes[destination], "auth.json", identity)
        value["mode"], value["pending"] = destination, None
        self.save(value)

    def check(self, value, mode):
        require(value["mode"] == mode and value["pending"] is None and value["migration"] is None,
                "Shared authentication needs execution transaction recovery", "recovery_required")
        require(self.homes[mode] is not None, "Active authentication home is missing", "integrity")
        self.auth(mode)
        other = "root" if mode == "native" else "native"
        require(self.auth(other) is None and self.info(self.fd, "transfer.auth.json", {(0, 0), self.owner("native")}) is None,
                "Inactive authentication must not override the instance login", "integrity")
        expected = {"state.json"} | {"legacy-" + entry + ".auth.json" for entry in value["backups"]}
        require(set(os.listdir(self.fd)) == expected, "Unexpected shared authentication recovery files", "integrity")
        for entry in value["backups"]:
            require(self.info(self.fd, "legacy-" + entry + ".auth.json", {(0, 0)}) is not None,
                    "Retained legacy authentication is missing", "integrity")


def summary(value):
    return {"shared": True, "activeMode": value["mode"], "archivedLegacyModes": value["backups"],
            "automaticRestore": False,
            "message": "首次共享时沿用当前执行模式的认证状态（包括未登录）；另一模式的旧登录已保留为受限备份，不会自动恢复。" if value["backups"] else
                       "ChatGPT 登录、刷新和退出由实例共享；两个执行模式的工作目录保持独立。"}


def handoff(layout, config, mode, transaction):
    """Caller owns management.lock and has proved all execution services stopped."""
    require(mode in MODES and isinstance(transaction, str) and re.fullmatch(r"[0-9a-f]{32}", transaction),
            "Invalid authentication transfer target")
    with Store(layout, config, create=True) as store:
        value = store.load()
        if value is None:
            require(not os.listdir(store.fd), "Authentication recovery state is missing", "integrity")
            current = execution_state(config)["mode"]
            store.auth(current)
            other = "root" if current == "native" else "native"
            value = {"format": 1, "mode": current, "backups": [], "pending": None,
                     "migration": {"mode": other, "identity": store.auth(other)}}
            store.save(value)
        store.migrate(value)
        store.finish(value, transaction, mode)
        store.check(value, value["mode"])
        if value["mode"] != mode:
            require(store.homes[mode] is not None, "Destination authentication home is missing", "integrity")
            value["pending"] = {"from": value["mode"], "to": mode, "identity": store.auth(value["mode"]), "transaction": transaction}
            store.save(value)
            store.finish(value, transaction, mode)
        store.check(value, mode)
        return summary(value)


def verify(layout, config):
    if not present(layout):
        return {"shared": False}
    with Store(layout, config) as store:
        value = store.load()
        require(value is not None, "Shared authentication initialization needs recovery", "recovery_required")
        store.check(value, execution_state(config)["mode"])
        return summary(value)


def status(layout, config):
    """Nonsecret state remains readable while a transfer awaits recovery."""
    if not present(layout):
        return {"shared": False}
    with Store(layout, config) as store:
        value = store.load()
        if value is None or value["pending"] is not None or value["migration"] is not None or value["mode"] != execution_state(config)["mode"]:
            return {"shared": True, "ready": False, "automaticRestore": False,
                    "message": "ChatGPT 登录转交尚未完成，请先恢复执行权限事务；不会自动恢复旧账号。"}
        store.check(value, value["mode"])
        return {**summary(value), "ready": True}
