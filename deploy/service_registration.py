"""Crash-recoverable publication for one Codex Harness service registration.

The shell installer prepares complete candidates in the private transaction
directory created here.  This module snapshots every managed name before the
first publication, publishes each file with ``rename(2)``, and retains a
durable journal until systemd activation has also succeeded.  Rollback is
idempotent: an interrupted rollback can be retried without guessing whether a
particular name already contains its old or its candidate value.
"""

from __future__ import annotations

import base64
import contextlib
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import stat
import sys


sys.dont_write_bytecode = True

RECOVERY_ROOT = "/var/lib/codex-harness-registration"
SERVICE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
TRANSACTION_RE = re.compile(r"recovery\.([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.([0-9a-f]{32})")
STAGE_NAMES = {
    "unit", "admin-helper", "worker-launcher", "admin.conf", "sudoers", "command", "gateway.env",
}
MAX_JOURNAL_BYTES = 512 * 1024
MAX_UNIT_BYTES = 512 * 1024
MAX_SCRIPT_BYTES = 2 * 1024 * 1024
MAX_ENV_BYTES = 1024 * 1024
MAX_LEGACY_SCAN_ENTRIES = 8192
MAX_LEGACY_SCAN_BYTES = 32 * 1024 * 1024
MAX_XATTRS = 32
MAX_XATTR_BYTES = 64 * 1024
MAX_REMOVE_ENTRIES = 250_000

DIR_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
READ_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NONBLOCK", 0)
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_NOATIME", 0)
)


class Policy:
    """Filesystem trust policy.  Non-default values are for isolated tests."""

    def __init__(self, *, anchor="/", trust_uid=0, trust_gid=0, recovery_root=RECOVERY_ROOT,
                 enforce_system_layout=True):
        self.anchor = os.path.normpath(anchor)
        self.trust_uid = trust_uid
        self.trust_gid = trust_gid
        self.recovery_root = os.path.normpath(recovery_root)
        self.enforce_system_layout = enforce_system_layout


PRODUCTION_POLICY = Policy()


class MissingJournalError(ValueError):
    pass


def _file_identity(info):
    return [
        info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
        info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
    ]


def _directory_identity(info):
    return [info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid]


def _same_inode(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def _write_all(descriptor, payload):
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError("registration snapshot write made no progress")
        view = view[written:]


def _relative_parts(path, policy):
    path = os.path.normpath(path)
    if not os.path.isabs(path) or ".." in PurePosixPath(path).parts:
        raise ValueError("registration paths must be absolute without traversal")
    try:
        common = os.path.commonpath((policy.anchor, path))
    except ValueError:
        raise ValueError("registration path is outside its trust anchor") from None
    if common != policy.anchor:
        raise ValueError("registration path is outside its trust anchor")
    relative = os.path.relpath(path, policy.anchor)
    return [] if relative == "." else relative.split(os.sep)


def _validate_directory(info, policy, *, owner=None, group=None, mode=None):
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError("registration path contains a non-directory ancestor")
    if owner is None:
        if info.st_uid != policy.trust_uid or info.st_mode & 0o022:
            raise ValueError("registration ancestors must be trusted and not group/world writable")
        return
    if info.st_uid != owner or info.st_gid != group or stat.S_IMODE(info.st_mode) != mode:
        raise ValueError("registration directory has unexpected ownership or permissions")


def _open_directory(path, policy, *, owner=None, group=None, mode=None):
    parts = _relative_parts(path, policy)
    descriptor = os.open(policy.anchor, DIR_FLAGS)
    try:
        anchor_info = os.fstat(descriptor)
        _validate_directory(anchor_info, policy)
        for index, name in enumerate(parts):
            before = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            child = os.open(name, DIR_FLAGS, dir_fd=descriptor)
            try:
                opened = os.fstat(child)
                current = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                if not _same_inode(before, opened) or not _same_inode(opened, current):
                    raise RuntimeError("registration directory changed while it was opened")
                final = index == len(parts) - 1
                _validate_directory(
                    opened, policy,
                    owner=owner if final else None,
                    group=group if final else None,
                    mode=mode if final else None,
                )
            except BaseException:
                os.close(child)
                raise
            os.close(descriptor)
            descriptor = child
        if not parts and owner is not None:
            _validate_directory(os.fstat(descriptor), policy, owner=owner, group=group, mode=mode)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _fsync_directory(descriptor):
    os.fsync(descriptor)


def _ensure_private_root(policy):
    parent = os.path.dirname(policy.recovery_root)
    name = os.path.basename(policy.recovery_root)
    parent_fd = _open_directory(parent, policy)
    try:
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
            created = True
        except FileExistsError:
            created = False
        root_fd = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
        try:
            current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            opened = os.fstat(root_fd)
            if not _same_inode(current, opened):
                raise RuntimeError("registration recovery root changed while it was opened")
            if created:
                os.fchown(root_fd, policy.trust_uid, policy.trust_gid)
                os.fchmod(root_fd, 0o700)
                _fsync_directory(root_fd)
                _fsync_directory(parent_fd)
                opened = os.fstat(root_fd)
            _validate_directory(opened, policy, owner=policy.trust_uid, group=policy.trust_gid, mode=0o700)
        finally:
            os.close(root_fd)
    finally:
        os.close(parent_fd)


def prepare_lock(policy=PRODUCTION_POLICY):
    _ensure_private_root(policy)
    root_fd = _open_directory(
        policy.recovery_root, policy, owner=policy.trust_uid, group=policy.trust_gid, mode=0o700,
    )
    try:
        try:
            descriptor = os.open(
                "registration.lock", os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                0o600, dir_fd=root_fd,
            )
            created = True
        except FileExistsError:
            descriptor = os.open(
                "registration.lock", os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0),
                dir_fd=root_fd,
            )
            created = False
        try:
            info = os.fstat(descriptor)
            current = os.stat("registration.lock", dir_fd=root_fd, follow_symlinks=False)
            if (not _same_inode(info, current) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or info.st_uid != policy.trust_uid or info.st_gid != policy.trust_gid
                    or stat.S_IMODE(info.st_mode) != 0o600):
                raise ValueError("registration lock has unsafe metadata")
            if created:
                os.fchown(descriptor, policy.trust_uid, policy.trust_gid)
                os.fchmod(descriptor, 0o600)
                os.fsync(descriptor)
                _fsync_directory(root_fd)
        finally:
            os.close(descriptor)
    finally:
        os.close(root_fd)
    return os.path.join(policy.recovery_root, "registration.lock")


def begin(service, policy=PRODUCTION_POLICY):
    if not SERVICE_RE.fullmatch(service):
        raise ValueError("invalid service name")
    _ensure_private_root(policy)
    root_fd = _open_directory(
        policy.recovery_root, policy, owner=policy.trust_uid, group=policy.trust_gid, mode=0o700,
    )
    try:
        entries = 0
        with os.scandir(root_fd) as listing:
            for entry in listing:
                entries += 1
                if entries > 128:
                    raise ValueError("registration recovery directory exceeds its entry limit")
                if entry.name == "registration.lock":
                    continue
                if TRANSACTION_RE.fullmatch(entry.name):
                    raise RuntimeError(
                        f"unresolved registration recovery exists at {os.path.join(policy.recovery_root, entry.name)}"
                    )
                raise ValueError("registration recovery root contains an unexpected entry")
        name = f"recovery.{service}.{secrets.token_hex(16)}"
        os.mkdir(name, 0o700, dir_fd=root_fd)
        transaction_fd = os.open(name, DIR_FLAGS, dir_fd=root_fd)
        try:
            os.fchown(transaction_fd, policy.trust_uid, policy.trust_gid)
            os.fchmod(transaction_fd, 0o700)
            for child in ("stage", "backups"):
                os.mkdir(child, 0o700, dir_fd=transaction_fd)
                child_fd = os.open(child, DIR_FLAGS, dir_fd=transaction_fd)
                try:
                    os.fchown(child_fd, policy.trust_uid, policy.trust_gid)
                    os.fchmod(child_fd, 0o700)
                    _fsync_directory(child_fd)
                finally:
                    os.close(child_fd)
            _fsync_directory(transaction_fd)
        finally:
            os.close(transaction_fd)
        _fsync_directory(root_fd)
    finally:
        os.close(root_fd)
    return os.path.join(policy.recovery_root, name)


def _validate_transaction(transaction, policy):
    transaction = os.path.normpath(transaction)
    if os.path.dirname(transaction) != policy.recovery_root or not TRANSACTION_RE.fullmatch(os.path.basename(transaction)):
        raise ValueError("invalid registration recovery path")
    descriptor = _open_directory(
        transaction, policy, owner=policy.trust_uid, group=policy.trust_gid, mode=0o700,
    )
    os.close(descriptor)
    return transaction


def _xattrs(descriptor):
    if not hasattr(os, "listxattr"):
        return {}
    names = os.listxattr(descriptor)
    if len(names) > MAX_XATTRS:
        raise ValueError("registration target has too many extended attributes")
    result = {}
    total = 0
    for name in names:
        if not isinstance(name, str) or not name or len(name.encode("utf-8")) > 255:
            raise ValueError("registration target has an invalid extended attribute name")
        value = os.getxattr(descriptor, name)
        total += len(value)
        if total > MAX_XATTR_BYTES:
            raise ValueError("registration target extended attributes exceed their byte limit")
        result[name] = base64.b64encode(value).decode("ascii")
    return result


def _stable_read_at(parent_fd, name, limit, *, expected=None):
    try:
        before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit
            or expected is not None and (
                before.st_uid != expected[0] or before.st_gid != expected[1]
                or stat.S_IMODE(before.st_mode) != expected[2]
            )):
        raise ValueError("registration target is not a bounded singly-linked file with expected metadata")
    descriptor = os.open(name, READ_FLAGS, dir_fd=parent_fd)
    try:
        opened = os.fstat(descriptor)
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if _file_identity(before) != _file_identity(opened) or _file_identity(opened) != _file_identity(current):
            raise RuntimeError("registration file changed while it was opened")
        payload = bytearray()
        while len(payload) <= limit:
            chunk = os.read(descriptor, min(64 * 1024, limit + 1 - len(payload)))
            if not chunk:
                break
            payload.extend(chunk)
        after = os.fstat(descriptor)
        path_after = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (len(payload) > limit or len(payload) != before.st_size
                or _file_identity(before) != _file_identity(after)
                or _file_identity(after) != _file_identity(path_after)):
            raise RuntimeError("registration file changed while it was read")
        return bytes(payload), before, _xattrs(descriptor)
    finally:
        os.close(descriptor)


def _atomic_json(transaction, value, policy):
    payload = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if len(payload) > MAX_JOURNAL_BYTES:
        raise ValueError("registration journal exceeds its byte limit")
    directory_fd = _open_directory(
        transaction, policy, owner=policy.trust_uid, group=policy.trust_gid, mode=0o700,
    )
    temporary = f".journal.{secrets.token_hex(16)}.tmp"
    try:
        descriptor = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600, dir_fd=directory_fd,
        )
        try:
            _write_all(descriptor, payload)
            os.fchown(descriptor, policy.trust_uid, policy.trust_gid)
            os.fchmod(descriptor, 0o600)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, "journal.json", src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        _fsync_directory(directory_fd)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary, dir_fd=directory_fd)
        os.close(directory_fd)


def _load_journal(transaction, policy):
    directory_fd = _open_directory(
        transaction, policy, owner=policy.trust_uid, group=policy.trust_gid, mode=0o700,
    )
    try:
        result = _stable_read_at(
            directory_fd, "journal.json", MAX_JOURNAL_BYTES,
            expected=(policy.trust_uid, policy.trust_gid, 0o600),
        )
    finally:
        os.close(directory_fd)
    if result is None:
        raise MissingJournalError("registration recovery has no journal")
    value = json.loads(result[0].decode("utf-8"))
    if value.get("version") != 1 or not SERVICE_RE.fullmatch(value.get("service", "")):
        raise ValueError("invalid registration recovery journal")
    _validate_loaded_journal(value, policy)
    return value


def _expected_directory_paths(requirements, policy):
    result = set()
    for final_path in requirements:
        parts = _relative_parts(final_path, policy)
        current = policy.anchor
        for name in parts:
            current = os.path.join(current, name)
            result.add(current)
    return result


def _validate_loaded_journal(journal, policy):
    service = journal.get("service")
    bin_dir = journal.get("bin_dir")
    control_home = journal.get("control_home")
    install_dir = journal.get("install_dir")
    gateway_uid = journal.get("gateway_uid")
    gateway_gid = journal.get("gateway_gid")
    if (not all(isinstance(item, str) for item in (bin_dir, control_home, install_dir))
            or not isinstance(gateway_uid, int) or gateway_uid < 1
            or not isinstance(gateway_gid, int) or gateway_gid < 0
            or journal.get("state") not in ("directories-planned", "snapshotted", "publishing", "published", "restored")):
        raise ValueError("invalid registration recovery journal metadata")
    layout = _layout(service, bin_dir, control_home, gateway_uid, gateway_gid, policy)
    requirements = _layout_directories(layout, bin_dir, control_home, gateway_uid, gateway_gid, policy)
    directories = journal.get("directories")
    if not isinstance(directories, list) or len(directories) > 64:
        raise ValueError("invalid registration recovery directory records")
    expected_paths = _expected_directory_paths(requirements, policy)
    if {item.get("path") for item in directories if isinstance(item, dict)} != expected_paths:
        raise ValueError("registration recovery directory set does not match its layout")
    for item in directories:
        if (not isinstance(item.get("existed"), bool) or not isinstance(item.get("owner"), int)
                or not isinstance(item.get("group"), int) or not isinstance(item.get("mode"), int)
                or not isinstance(item.get("exact"), bool)):
            raise ValueError("invalid registration recovery directory record")
        if item["existed"] and (not isinstance(item.get("identity"), list) or len(item["identity"]) != 5):
            raise ValueError("invalid existing registration directory identity")
        if "created_identity" in item and (
                item["existed"] or not isinstance(item["created_identity"], list)
                or len(item["created_identity"]) != 5):
            raise ValueError("invalid created registration directory identity")
    entries = journal.get("entries")
    if not isinstance(entries, list) or len(entries) > len(layout):
        raise ValueError("invalid registration recovery entry records")
    if not entries:
        if journal["state"] != "directories-planned":
            raise ValueError("registration recovery is missing its file records")
        return
    if {item.get("label") for item in entries if isinstance(item, dict)} != set(layout):
        raise ValueError("registration recovery target set does not match its layout")
    for item in entries:
        target, source, action, uid, gid, mode, limit, optional = layout[item["label"]]
        if (item.get("target") != target or item.get("action") != action or item.get("uid") != uid
                or item.get("gid") != gid or item.get("mode") != mode or item.get("limit") != limit
                or item.get("unsafe") not in (True, False)
                or item.get("resolved") not in ("preserve", "replace", "delete", "runtime-optional")):
            raise ValueError("invalid registration recovery target record")
        expected_parent = list(_parent_expectation(target, control_home, gateway_uid, gateway_gid))
        if item.get("parent") != expected_parent or bool(item["unsafe"]) and not optional:
            raise ValueError("invalid registration recovery target trust metadata")
        original = item.get("original")
        if not isinstance(original, dict) or original.get("kind") not in ("missing", "file", "unsafe"):
            raise ValueError("invalid registration recovery original state")
        if original["kind"] == "file" and (
                not isinstance(original.get("identity"), list) or len(original["identity"]) != 9
                or not isinstance(original.get("atime_ns"), int)
                or not re.fullmatch(r"[0-9a-f]{64}", original.get("sha256", ""))
                or not re.fullmatch(r"[0-9]{2}\.bin", original.get("backup", ""))
                or not isinstance(original.get("xattrs"), dict)):
            raise ValueError("invalid registration recovery file snapshot")
        if source is not None:
            candidate = item.get("candidate")
            if (not isinstance(candidate, dict) or candidate.get("stage") != source
                    or not re.fullmatch(r"[0-9a-f]{64}", candidate.get("sha256", ""))
                    or not isinstance(candidate.get("size"), int) or not 0 <= candidate["size"] <= limit):
                raise ValueError("invalid registration recovery candidate snapshot")


def _directory_requirements(bin_dir, control_home, gateway_uid, gateway_gid, policy):
    requirements = {
        "/usr/local/libexec": (policy.trust_uid, policy.trust_gid, 0o755, False),
        "/etc/codex-harness": (policy.trust_uid, policy.trust_gid, 0o755, False),
        "/etc/sudoers.d": (policy.trust_uid, policy.trust_gid, 0o755, False),
        "/etc/systemd/system": (policy.trust_uid, policy.trust_gid, 0o755, False),
        bin_dir: (policy.trust_uid, policy.trust_gid, 0o755, False),
        os.path.dirname(control_home): (policy.trust_uid, policy.trust_gid, 0o755, False),
        control_home: (gateway_uid, gateway_gid, 0o700, True),
    }
    if not policy.enforce_system_layout:
        requirements = {
            bin_dir: (policy.trust_uid, policy.trust_gid, 0o755, False),
            os.path.dirname(control_home): (policy.trust_uid, policy.trust_gid, 0o755, False),
            control_home: (gateway_uid, gateway_gid, 0o700, True),
        }
    return requirements


def _inspect_directory_requirement(final_path, requirement, records, policy):
    parts = _relative_parts(final_path, policy)
    descriptor = os.open(policy.anchor, DIR_FLAGS)
    missing = False
    current_path = policy.anchor
    try:
        _validate_directory(os.fstat(descriptor), policy)
        for index, name in enumerate(parts):
            current_path = os.path.join(current_path, name)
            final = index == len(parts) - 1
            wanted = requirement if final else (policy.trust_uid, policy.trust_gid, 0o755, False)
            previous = records.get(current_path)
            if missing:
                candidate = {"path": current_path, "existed": False, "owner": wanted[0], "group": wanted[1],
                             "mode": wanted[2], "exact": wanted[3]}
                if previous is not None and previous != candidate:
                    raise ValueError("conflicting registration directory requirements")
                records[current_path] = candidate
                continue
            try:
                before = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            except FileNotFoundError:
                missing = True
                candidate = {"path": current_path, "existed": False, "owner": wanted[0], "group": wanted[1],
                             "mode": wanted[2], "exact": wanted[3]}
                if previous is not None and previous != candidate:
                    raise ValueError("conflicting registration directory requirements")
                records[current_path] = candidate
                continue
            child = os.open(name, DIR_FLAGS, dir_fd=descriptor)
            try:
                opened = os.fstat(child)
                current = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                if not _same_inode(before, opened) or not _same_inode(opened, current):
                    raise RuntimeError("registration directory changed during planning")
                if wanted[3]:
                    _validate_directory(opened, policy, owner=wanted[0], group=wanted[1], mode=wanted[2])
                else:
                    _validate_directory(opened, policy)
                candidate = {"path": current_path, "existed": True, "identity": _directory_identity(opened),
                             "owner": wanted[0], "group": wanted[1], "mode": wanted[2], "exact": wanted[3]}
                if previous is not None and previous != candidate:
                    raise ValueError("registration directory changed between planning passes")
                records[current_path] = candidate
            except BaseException:
                os.close(child)
                raise
            os.close(descriptor)
            descriptor = child
    finally:
        os.close(descriptor)


def _plan_directories(requirements, policy):
    records = {}
    for path, requirement in requirements.items():
        _inspect_directory_requirement(path, requirement, records, policy)
    return sorted(records.values(), key=lambda item: (len(PurePosixPath(item["path"]).parts), item["path"]))


def _create_directories(journal, transaction, policy, fault=None):
    for record in journal["directories"]:
        if record["existed"]:
            continue
        parent_fd = _open_directory(os.path.dirname(record["path"]), policy)
        name = os.path.basename(record["path"])
        try:
            if fault:
                fault("before-directory", record["path"])
            os.mkdir(name, record["mode"], dir_fd=parent_fd)
            child = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
            try:
                os.fchown(child, record["owner"], record["group"])
                os.fchmod(child, record["mode"])
                _fsync_directory(child)
                record["created_identity"] = _directory_identity(os.fstat(child))
            finally:
                os.close(child)
            _fsync_directory(parent_fd)
            _atomic_json(transaction, journal, policy)
            if fault:
                fault("after-directory", record["path"])
        finally:
            os.close(parent_fd)


def _layout(service, bin_dir, control_home, gateway_uid, gateway_gid, policy):
    command_name = "codex-harness" if service == "codex-harness" else f"codex-harness-{service}"
    root = (policy.trust_uid, policy.trust_gid)
    if policy.enforce_system_layout:
        values = {
            "unit": (f"/etc/systemd/system/{service}.service", "unit", "replace", root[0], root[1], 0o644, MAX_UNIT_BYTES, False),
            "admin-helper": (f"/usr/local/libexec/codex-harness-admin-{service}", "admin-helper", "replace", root[0], root[1], 0o755, MAX_SCRIPT_BYTES, False),
            "worker-launcher": (f"/usr/local/libexec/codex-harness-worker-{service}", "worker-launcher", "replace", root[0], root[1], 0o755, MAX_SCRIPT_BYTES, False),
            "admin.conf": (f"/etc/codex-harness/{service}.conf", "admin.conf", "replace", root[0], root[1], 0o600, MAX_ENV_BYTES, False),
            "sudoers": (f"/etc/sudoers.d/codex-harness-{service}", "sudoers", "replace", root[0], root[1], 0o440, MAX_ENV_BYTES, False),
            "command": (os.path.join(bin_dir, command_name), "command", "replace", root[0], root[1], 0o755, MAX_SCRIPT_BYTES, False),
            "gateway.env": (os.path.join(control_home, "gateway.env"), "gateway.env", "create-if-missing", gateway_uid, gateway_gid, 0o600, MAX_ENV_BYTES, False),
            "gateway-token": (os.path.join(control_home, "gateway-token"), None, "runtime-optional", gateway_uid, gateway_gid, 0o600, 4096, False),
        }
        if service != "codex-harness":
            values["legacy-command"] = (os.path.join(bin_dir, "codex-harness"), None, "legacy-command", root[0], root[1], 0o755, MAX_SCRIPT_BYTES, True)
        values.update({
            "legacy-admin-helper": ("/usr/local/libexec/codex-harness-admin", None, "legacy-admin", root[0], root[1], 0o755, MAX_SCRIPT_BYTES, True),
            "legacy-admin.conf": ("/etc/codex-harness/admin.conf", None, "legacy-admin", root[0], root[1], 0o600, MAX_ENV_BYTES, True),
            "legacy-sudoers": ("/etc/sudoers.d/codex-harness", None, "legacy-admin", root[0], root[1], 0o440, MAX_ENV_BYTES, True),
        })
        return values
    # Tests can supply a complete relocated layout through their bin/control roots.
    system = os.path.join(os.path.dirname(bin_dir), "system")
    return {
        "unit": (os.path.join(system, "units", f"{service}.service"), "unit", "replace", root[0], root[1], 0o644, MAX_UNIT_BYTES, False),
        "admin-helper": (os.path.join(system, "libexec", f"codex-harness-admin-{service}"), "admin-helper", "replace", root[0], root[1], 0o755, MAX_SCRIPT_BYTES, False),
        "worker-launcher": (os.path.join(system, "libexec", f"codex-harness-worker-{service}"), "worker-launcher", "replace", root[0], root[1], 0o755, MAX_SCRIPT_BYTES, False),
        "admin.conf": (os.path.join(system, "config", f"{service}.conf"), "admin.conf", "replace", root[0], root[1], 0o600, MAX_ENV_BYTES, False),
        "sudoers": (os.path.join(system, "sudoers", f"codex-harness-{service}"), "sudoers", "replace", root[0], root[1], 0o440, MAX_ENV_BYTES, False),
        "command": (os.path.join(bin_dir, command_name), "command", "replace", root[0], root[1], 0o755, MAX_SCRIPT_BYTES, False),
        "gateway.env": (os.path.join(control_home, "gateway.env"), "gateway.env", "create-if-missing", gateway_uid, gateway_gid, 0o600, MAX_ENV_BYTES, False),
        "gateway-token": (os.path.join(control_home, "gateway-token"), None, "runtime-optional", gateway_uid, gateway_gid, 0o600, 4096, False),
    }


def _layout_directories(layout, bin_dir, control_home, gateway_uid, gateway_gid, policy):
    requirements = _directory_requirements(bin_dir, control_home, gateway_uid, gateway_gid, policy)
    for target, _source, _action, _uid, _gid, _mode, _limit, _optional in layout.values():
        parent = os.path.dirname(target)
        if parent == control_home:
            continue
        requirements.setdefault(parent, (policy.trust_uid, policy.trust_gid, 0o755, False))
    return requirements


def _parent_expectation(target, control_home, gateway_uid, gateway_gid):
    if os.path.dirname(target) == control_home:
        return gateway_uid, gateway_gid, 0o700
    return None, None, None


def _backup_payload(transaction, index, payload, policy):
    backup_fd = _open_directory(
        os.path.join(transaction, "backups"), policy,
        owner=policy.trust_uid, group=policy.trust_gid, mode=0o700,
    )
    name = f"{index:02d}.bin"
    try:
        descriptor = os.open(
            name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600, dir_fd=backup_fd,
        )
        try:
            _write_all(descriptor, payload)
            os.fchown(descriptor, policy.trust_uid, policy.trust_gid)
            os.fchmod(descriptor, 0o600)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        _fsync_directory(backup_fd)
    finally:
        os.close(backup_fd)
    return name


def _read_stage(transaction, name, limit, policy):
    if name not in STAGE_NAMES:
        raise ValueError("invalid registration stage name")
    stage_fd = _open_directory(
        os.path.join(transaction, "stage"), policy,
        owner=policy.trust_uid, group=policy.trust_gid, mode=0o700,
    )
    try:
        value = _stable_read_at(
            stage_fd, name, limit, expected=(policy.trust_uid, policy.trust_gid, 0o600),
        )
    finally:
        os.close(stage_fd)
    if value is None:
        raise ValueError(f"registration stage is missing {name}")
    return value[0]


def _snapshot_entries(transaction, layout, control_home, gateway_uid, gateway_gid, install_dir, service, policy):
    entries = []
    for index, (label, definition) in enumerate(layout.items()):
        target, source, action, uid, gid, mode, limit, optional = definition
        parent_owner, parent_group, parent_mode = _parent_expectation(target, control_home, gateway_uid, gateway_gid)
        parent_fd = _open_directory(
            os.path.dirname(target), policy, owner=parent_owner, group=parent_group, mode=parent_mode,
        )
        unsafe = False
        try:
            try:
                original = _stable_read_at(parent_fd, os.path.basename(target), limit, expected=(uid, gid, mode))
            except (OSError, RuntimeError, ValueError):
                if not optional:
                    raise
                original = None
                unsafe = True
        finally:
            os.close(parent_fd)
        record = {
            "label": label, "target": target, "action": action, "resolved": "preserve",
            "uid": uid, "gid": gid, "mode": mode, "limit": limit,
            "parent": [parent_owner, parent_group, parent_mode], "unsafe": unsafe,
        }
        if unsafe:
            record["original"] = {"kind": "unsafe"}
        elif original is None:
            record["original"] = {"kind": "missing"}
        else:
            payload, info, attrs = original
            backup = _backup_payload(transaction, index, payload, policy)
            record["original"] = {
                "kind": "file", "identity": _file_identity(info), "sha256": hashlib.sha256(payload).hexdigest(),
                "backup": backup, "xattrs": attrs, "atime_ns": info.st_atime_ns,
            }
        if source is not None:
            candidate = _read_stage(transaction, source, limit, policy)
            record["candidate"] = {"stage": source, "sha256": hashlib.sha256(candidate).hexdigest(), "size": len(candidate)}
        if action == "replace":
            record["resolved"] = "replace"
        elif action == "create-if-missing" and record["original"]["kind"] == "missing":
            record["resolved"] = "replace"
        elif action == "runtime-optional":
            record["resolved"] = "runtime-optional"
        entries.append(record)

    unit_record = next(item for item in entries if item["label"] == "unit")
    if unit_record["original"]["kind"] == "file":
        payload = _read_backup(transaction, unit_record["original"]["backup"], policy)
        try:
            lines = payload.decode("utf-8").splitlines()
        except UnicodeDecodeError:
            raise ValueError("existing service unit is not valid UTF-8") from None
        if f"WorkingDirectory={install_dir}/apps/gateway" not in lines:
            raise ValueError(f"refusing to replace another checkout's unit: {unit_record['target']}")

    legacy_command = next((item for item in entries if item["action"] == "legacy-command"), None)
    if legacy_command and legacy_command["original"]["kind"] == "file" and not legacy_command["unsafe"]:
        payload = _read_backup(transaction, legacy_command["original"]["backup"], policy)
        try:
            lines = payload.decode("utf-8").splitlines()
        except UnicodeDecodeError:
            lines = []
        default_unit = _safe_system_unit("codex-harness", policy)
        if (f'exec bash "{install_dir}/deploy/manage.sh" "$@"' in lines
                and "# Managed instance: codex-harness" not in lines
                and default_unit is not None
                and f"WorkingDirectory={install_dir}/apps/gateway" not in default_unit.decode("utf-8", "replace").splitlines()):
            legacy_command["resolved"] = "delete"

    legacy_admin = [item for item in entries if item["action"] == "legacy-admin"]
    if legacy_admin and all(not item["unsafe"] for item in legacy_admin) and not _legacy_admin_referenced(service, policy):
        for item in legacy_admin:
            if item["original"]["kind"] == "file":
                item["resolved"] = "delete"
    return entries


def _safe_system_unit(service, policy):
    if not policy.enforce_system_layout:
        return b""
    try:
        value = _read_unit_path(f"/etc/systemd/system/{service}.service", policy, allow_link=True)
    except (OSError, RuntimeError, ValueError):
        return None
    return b"" if value is None else value


def _read_unit_path(path, policy, *, allow_link):
    """Boundedly resolve root-owned unit aliases, then pin the regular target."""
    seen = set()
    for _depth in range(20):
        _relative_parts(path, policy)
        parent = os.path.dirname(path)
        name = os.path.basename(path)
        directory_fd = _open_directory(parent, policy)
        try:
            try:
                before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            except FileNotFoundError:
                return None
            if not stat.S_ISLNK(before.st_mode):
                value = _stable_read_at(
                    directory_fd, name, MAX_UNIT_BYTES,
                    expected=(policy.trust_uid, policy.trust_gid, 0o644),
                )
                return None if value is None else value[0]
            if (not allow_link or before.st_uid != policy.trust_uid or before.st_nlink != 1
                    or before.st_size > 4096):
                raise ValueError("systemd unit alias is unsafe")
            target = os.readlink(name, dir_fd=directory_fd)
            current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if _file_identity(before) != _file_identity(current):
                raise RuntimeError("systemd unit alias changed while it was read")
        finally:
            os.close(directory_fd)
        path = os.path.normpath(target if os.path.isabs(target) else os.path.join(parent, target))
        if path in seen:
            raise ValueError("systemd unit alias cycle")
        seen.add(path)
    raise ValueError("systemd unit alias depth exceeds its limit")


def inspect_unit(service, policy=PRODUCTION_POLICY, unit_directory=None):
    """Return one bounded, descriptor-pinned snapshot of installer defaults."""
    if not SERVICE_RE.fullmatch(service):
        raise ValueError("invalid service name")
    unit_directory = unit_directory or "/etc/systemd/system"
    directory_fd = _open_directory(unit_directory, policy)
    try:
        value = _stable_read_at(
            directory_fd, f"{service}.service", MAX_UNIT_BYTES,
            expected=(policy.trust_uid, policy.trust_gid, 0o644),
        )
    finally:
        os.close(directory_fd)
    if value is None:
        return {"version": 1, "exists": False, "fields": {}}
    try:
        text = value[0].decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("existing service unit is not valid UTF-8") from None
    if "\0" in text or "\r" in text:
        raise ValueError("existing service unit contains unsupported control characters")
    prefixes = {
        "User=": "User",
        "WorkingDirectory=": "WorkingDirectory",
    }
    environment = {
        "RUN_USER": "RUN_USER", "GATEWAY_USER": "GATEWAY_USER",
        "GATEWAY_CONTROL_HOME": "GATEWAY_CONTROL_HOME", "CODEX_HOME": "CODEX_HOME",
        "CODEX_WORKSPACE": "CODEX_WORKSPACE", "PORT": "PORT", "ENV_FILE": "ENV_FILE",
        "NODE_BIN": "NODE_BIN", "NODE_BIN_DIR": "NODE_BIN_DIR", "TOOLS_BIN_DIR": "TOOLS_BIN_DIR",
    }
    fields = {}
    legacy = False
    for line in text.splitlines():
        for prefix, key in prefixes.items():
            if line.startswith(prefix):
                if key in fields:
                    raise ValueError(f"existing service unit repeats {key}")
                fields[key] = line[len(prefix):]
        if line == "Environment=CODEX_HARNESS_ADMIN_HELPER=/usr/local/libexec/codex-harness-admin":
            legacy = True
        if not line.startswith("Environment="):
            continue
        assignment = line[len("Environment="):]
        key, separator, contents = assignment.partition("=")
        if separator and key in environment:
            output_key = environment[key]
            if output_key in fields:
                raise ValueError(f"existing service unit repeats {output_key}")
            fields[output_key] = contents
    if any(not isinstance(value, str) or len(value) > 16 * 1024 for value in fields.values()):
        raise ValueError("existing service unit field exceeds its limit")
    return {"version": 1, "exists": True, "legacyAdmin": legacy, "fields": fields}


def _legacy_admin_referenced(current_service, policy):
    if not policy.enforce_system_layout:
        return False
    directory_fd = _open_directory("/etc/systemd/system", policy)
    total = 0
    count = 0
    try:
        with os.scandir(directory_fd) as listing:
            for entry in listing:
                count += 1
                if count > MAX_LEGACY_SCAN_ENTRIES:
                    return True
                if not entry.name.endswith(".service") or entry.name == f"{current_service}.service":
                    continue
                try:
                    payload = _read_unit_path(
                        os.path.join("/etc/systemd/system", entry.name), policy, allow_link=True,
                    )
                except (OSError, RuntimeError, ValueError):
                    return True
                if payload is None:
                    continue
                total += len(payload)
                if total > MAX_LEGACY_SCAN_BYTES:
                    return True
                try:
                    lines = payload.decode("utf-8").splitlines()
                except UnicodeDecodeError:
                    return True
                if "Environment=CODEX_HARNESS_ADMIN_HELPER=/usr/local/libexec/codex-harness-admin" in lines:
                    return True
    finally:
        os.close(directory_fd)
    return False


def _read_backup(transaction, name, policy):
    if not re.fullmatch(r"[0-9]{2}\.bin", name):
        raise ValueError("invalid registration backup name")
    directory_fd = _open_directory(
        os.path.join(transaction, "backups"), policy,
        owner=policy.trust_uid, group=policy.trust_gid, mode=0o700,
    )
    try:
        value = _stable_read_at(
            directory_fd, name, MAX_SCRIPT_BYTES,
            expected=(policy.trust_uid, policy.trust_gid, 0o600),
        )
    finally:
        os.close(directory_fd)
    if value is None:
        raise ValueError("registration backup is missing")
    return value[0]


def _current_entry(record, policy):
    parent_owner, parent_group, parent_mode = record["parent"]
    parent_fd = _open_directory(
        os.path.dirname(record["target"]), policy,
        owner=parent_owner, group=parent_group, mode=parent_mode,
    )
    try:
        return _stable_read_at(
            parent_fd, os.path.basename(record["target"]), record["limit"],
            expected=(record["uid"], record["gid"], record["mode"]),
        )
    finally:
        os.close(parent_fd)


def _matches_original(record, current):
    original = record["original"]
    if original["kind"] == "missing":
        return current is None
    if original["kind"] != "file" or current is None:
        return False
    return _file_identity(current[1]) == original["identity"]


def _matches_content(record, current, which):
    if current is None:
        return False
    expected = record[which]
    if hashlib.sha256(current[0]).hexdigest() != expected["sha256"]:
        return False
    info = current[1]
    return info.st_uid == record["uid"] and info.st_gid == record["gid"] and stat.S_IMODE(info.st_mode) == record["mode"]


def _matches_restored_snapshot(record, current):
    original = record["original"]
    if original["kind"] != "file" or not _matches_content(
            {**record, "backup-state": original}, current, "backup-state"):
        return False
    info = current[1]
    return (info.st_atime_ns == original["atime_ns"]
            and info.st_mtime_ns == original["identity"][7]
            and current[2] == original.get("xattrs", {}))


def _apply_xattrs(descriptor, attrs):
    if not hasattr(os, "listxattr"):
        if attrs:
            raise OSError("extended attribute restoration is unavailable")
        return
    for name in os.listxattr(descriptor):
        os.removexattr(descriptor, name)
    for name, encoded in attrs.items():
        os.setxattr(descriptor, name, base64.b64decode(encoded, validate=True))


def _rename_noreplace(source_fd, source_name, target_fd, target_name):
    """Linux renameat2(RENAME_NOREPLACE), used for names absent at snapshot."""
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise OSError(errno.ENOSYS, "renameat2 is required for no-clobber registration publication")
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(source_fd, os.fsencode(source_name), target_fd, os.fsencode(target_name), 1) != 0:
        value = ctypes.get_errno()
        raise OSError(value, os.strerror(value), target_name)


def _atomic_publish(record, payload, policy, *, restore_metadata=None):
    parent_owner, parent_group, parent_mode = record["parent"]
    parent_fd = _open_directory(
        os.path.dirname(record["target"]), policy,
        owner=parent_owner, group=parent_group, mode=parent_mode,
    )
    temporary = f".codex-harness-register.{secrets.token_hex(16)}.tmp"
    try:
        descriptor = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600, dir_fd=parent_fd,
        )
        try:
            _write_all(descriptor, payload)
            os.fchown(descriptor, record["uid"], record["gid"])
            os.fchmod(descriptor, record["mode"])
            if restore_metadata is not None:
                _apply_xattrs(descriptor, restore_metadata.get("xattrs", {}))
                identity = restore_metadata["identity"]
                os.utime(descriptor, ns=(restore_metadata["atime_ns"], identity[7]))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        target_name = os.path.basename(record["target"])
        if record["original"]["kind"] == "missing":
            _rename_noreplace(parent_fd, temporary, parent_fd, target_name)
        else:
            os.replace(temporary, target_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        _fsync_directory(parent_fd)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary, dir_fd=parent_fd)
        os.close(parent_fd)


def _unlink_entry(record, policy):
    parent_owner, parent_group, parent_mode = record["parent"]
    parent_fd = _open_directory(
        os.path.dirname(record["target"]), policy,
        owner=parent_owner, group=parent_group, mode=parent_mode,
    )
    try:
        os.unlink(os.path.basename(record["target"]), dir_fd=parent_fd)
        _fsync_directory(parent_fd)
    finally:
        os.close(parent_fd)


def apply(transaction, service, bin_dir, control_home, gateway_uid, gateway_gid, install_dir,
          policy=PRODUCTION_POLICY, fault=None):
    transaction = _validate_transaction(transaction, policy)
    if not SERVICE_RE.fullmatch(service):
        raise ValueError("invalid service name")
    for value in (bin_dir, control_home, install_dir):
        _relative_parts(value, policy)
    if not isinstance(gateway_uid, int) or not isinstance(gateway_gid, int) or gateway_uid < 1 or gateway_gid < 0:
        raise ValueError("invalid gateway identity")
    layout = _layout(service, bin_dir, control_home, gateway_uid, gateway_gid, policy)
    requirements = _layout_directories(layout, bin_dir, control_home, gateway_uid, gateway_gid, policy)
    journal = {
        "version": 1, "service": service, "state": "directories-planned",
        "directories": _plan_directories(requirements, policy), "entries": [],
        "control_home": control_home, "gateway_uid": gateway_uid, "gateway_gid": gateway_gid,
        "bin_dir": bin_dir, "install_dir": install_dir,
    }
    _atomic_json(transaction, journal, policy)
    _create_directories(journal, transaction, policy, fault)
    journal["entries"] = _snapshot_entries(
        transaction, layout, control_home, gateway_uid, gateway_gid, install_dir, service, policy,
    )
    journal["state"] = "snapshotted"
    _atomic_json(transaction, journal, policy)
    if fault:
        fault("after-snapshot", service)
    for index, record in enumerate(journal["entries"]):
        if record["resolved"] not in ("replace", "delete"):
            continue
        current = _current_entry(record, policy)
        if not _matches_original(record, current):
            raise RuntimeError(f"registration target changed before publication: {record['target']}")
        journal["state"] = "publishing"
        journal["publishing"] = index
        _atomic_json(transaction, journal, policy)
        if fault:
            fault("before-publish", record["label"])
        if record["resolved"] == "replace":
            payload = _read_stage(transaction, record["candidate"]["stage"], record["limit"], policy)
            if hashlib.sha256(payload).hexdigest() != record["candidate"]["sha256"]:
                raise RuntimeError("registration candidate changed before publication")
            _atomic_publish(record, payload, policy)
        elif current is not None:
            _unlink_entry(record, policy)
        record["applied"] = True
        _atomic_json(transaction, journal, policy)
        if fault:
            fault("after-publish", record["label"])
    journal.pop("publishing", None)
    journal["state"] = "published"
    _atomic_json(transaction, journal, policy)


def _valid_runtime_token(record, current):
    if current is None:
        return True
    return bool(re.fullmatch(rb"[0-9a-f]{64}\n?", current[0])) and _matches_content(
        {**record, "runtime": {"sha256": hashlib.sha256(current[0]).hexdigest()}}, current, "runtime"
    )


def _restore_entry(transaction, record, policy):
    if record["unsafe"] or record["resolved"] == "preserve":
        return
    current = _current_entry(record, policy)
    if _matches_original(record, current):
        return
    original = record["original"]
    if original["kind"] == "file" and current is not None and _matches_restored_snapshot(record, current):
        return
    if record["resolved"] == "runtime-optional":
        if original["kind"] == "missing" and _valid_runtime_token(record, current):
            if current is not None:
                _unlink_entry(record, policy)
            return
        raise RuntimeError(f"runtime control file changed unexpectedly: {record['target']}")
    changed_by_transaction = (
        record["resolved"] == "replace" and _matches_content(record, current, "candidate")
        or record["resolved"] == "delete" and current is None
    )
    if not changed_by_transaction:
        raise RuntimeError(f"registration target changed after publication: {record['target']}")
    if original["kind"] == "missing":
        if current is not None:
            _unlink_entry(record, policy)
        return
    payload = _read_backup(transaction, original["backup"], policy)
    if hashlib.sha256(payload).hexdigest() != original["sha256"]:
        raise RuntimeError("registration backup changed before rollback")
    _atomic_publish(record, payload, policy, restore_metadata=original)


def _remove_control_tree(path, record, gateway_uid, gateway_gid, policy):
    parent_fd = _open_directory(os.path.dirname(path), policy)
    name = os.path.basename(path)
    seen = [0]

    def descend(parent, entry_name, expected_identity=None):
        before = os.stat(entry_name, dir_fd=parent, follow_symlinks=False)
        child = os.open(entry_name, DIR_FLAGS, dir_fd=parent)
        try:
            opened = os.fstat(child)
            current = os.stat(entry_name, dir_fd=parent, follow_symlinks=False)
            if not _same_inode(before, opened) or not _same_inode(opened, current):
                raise RuntimeError("created control directory changed during rollback")
            if expected_identity is not None and _directory_identity(opened)[:2] != expected_identity[:2]:
                raise RuntimeError("created control directory was replaced before rollback")
            if opened.st_uid != gateway_uid or opened.st_gid != gateway_gid or opened.st_mode & 0o077:
                raise ValueError("created control directory contains an unsafe directory")
            with os.scandir(child) as listing:
                names = []
                for entry in listing:
                    seen[0] += 1
                    if seen[0] > MAX_REMOVE_ENTRIES:
                        raise ValueError("created control directory exceeds rollback entry limit")
                    names.append(entry.name)
            for child_name in names:
                info = os.stat(child_name, dir_fd=child, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    descend(child, child_name)
                elif (stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == gateway_uid
                      and info.st_gid == gateway_gid):
                    os.unlink(child_name, dir_fd=child)
                else:
                    raise ValueError("created control directory contains an unsafe entry")
            _fsync_directory(child)
        finally:
            os.close(child)
        os.rmdir(entry_name, dir_fd=parent)

    try:
        descend(parent_fd, name, record.get("created_identity"))
        _fsync_directory(parent_fd)
    finally:
        os.close(parent_fd)


def _restore_directories(journal, policy):
    control_home = journal["control_home"]
    gateway_record = next(item for item in journal["directories"] if item["path"] == control_home)
    gateway_uid, gateway_gid = journal["gateway_uid"], journal["gateway_gid"]
    for record in reversed(journal["directories"]):
        if record["existed"]:
            continue
        try:
            if record["path"] == control_home:
                _remove_control_tree(record["path"], gateway_record, gateway_uid, gateway_gid, policy)
                continue
            parent_fd = _open_directory(os.path.dirname(record["path"]), policy)
            try:
                current = os.stat(os.path.basename(record["path"]), dir_fd=parent_fd, follow_symlinks=False)
                created_identity = record.get("created_identity")
                if (not stat.S_ISDIR(current.st_mode)
                        or created_identity is not None and created_identity[:2] != _directory_identity(current)[:2]
                        or created_identity is None and (
                            current.st_uid != record["owner"] or current.st_gid != record["group"]
                            or stat.S_IMODE(current.st_mode) != record["mode"]
                        )):
                    raise RuntimeError("created registration directory was replaced before rollback")
                os.rmdir(os.path.basename(record["path"]), dir_fd=parent_fd)
                _fsync_directory(parent_fd)
            finally:
                os.close(parent_fd)
        except FileNotFoundError:
            continue


def restore(transaction, policy=PRODUCTION_POLICY):
    transaction = _validate_transaction(transaction, policy)
    try:
        journal = _load_journal(transaction, policy)
    except MissingJournalError:
        # Planning is read-only.  If no first journal exists, apply failed
        # before it created any managed directory or changed any target.
        return
    errors = []
    for record in reversed(journal.get("entries", [])):
        try:
            _restore_entry(transaction, record, policy)
        except BaseException as error:
            errors.append(f"{record.get('target', '?')}: {error}")
    if not errors:
        try:
            _restore_directories(journal, policy)
        except BaseException as error:
            errors.append(f"directories: {error}")
    if errors:
        raise RuntimeError("registration rollback incomplete: " + "; ".join(errors))
    journal["state"] = "restored"
    _atomic_json(transaction, journal, policy)


def _remove_recovery_tree(transaction, policy):
    transaction = _validate_transaction(transaction, policy)
    root_fd = _open_directory(
        policy.recovery_root, policy, owner=policy.trust_uid, group=policy.trust_gid, mode=0o700,
    )
    name = os.path.basename(transaction)
    seen = [0]

    def descend(parent, entry_name, level):
        before = os.stat(entry_name, dir_fd=parent, follow_symlinks=False)
        directory = os.open(entry_name, DIR_FLAGS, dir_fd=parent)
        try:
            info = os.fstat(directory)
            current = os.stat(entry_name, dir_fd=parent, follow_symlinks=False)
            if (not _same_inode(before, info) or not _same_inode(info, current)
                    or info.st_uid != policy.trust_uid or info.st_gid != policy.trust_gid
                    or stat.S_IMODE(info.st_mode) != 0o700):
                raise ValueError("registration recovery directory has unsafe metadata")
            with os.scandir(directory) as listing:
                names = []
                for entry in listing:
                    seen[0] += 1
                    if seen[0] > 128:
                        raise ValueError("registration recovery contains too many entries")
                    names.append(entry.name)
            for child_name in names:
                child_info = os.stat(child_name, dir_fd=directory, follow_symlinks=False)
                if stat.S_ISDIR(child_info.st_mode):
                    if level != 0 or child_name not in ("stage", "backups"):
                        raise ValueError("registration recovery contains an unexpected directory")
                    descend(directory, child_name, level + 1)
                    continue
                allowed = (
                    level == 0 and child_name == "journal.json"
                    or level == 1 and entry_name == "stage" and child_name in STAGE_NAMES
                    or level == 1 and entry_name == "backups" and re.fullmatch(r"[0-9]{2}\.bin", child_name)
                )
                if (not allowed or not stat.S_ISREG(child_info.st_mode) or child_info.st_nlink != 1
                        or child_info.st_uid != policy.trust_uid or child_info.st_gid != policy.trust_gid
                        or stat.S_IMODE(child_info.st_mode) != 0o600):
                    raise ValueError("registration recovery contains an unsafe entry")
                os.unlink(child_name, dir_fd=directory)
            _fsync_directory(directory)
        finally:
            os.close(directory)
        os.rmdir(entry_name, dir_fd=parent)

    try:
        descend(root_fd, name, 0)
        _fsync_directory(root_fd)
    finally:
        os.close(root_fd)


def discard(transaction, policy=PRODUCTION_POLICY):
    _remove_recovery_tree(transaction, policy)


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("prepare-lock")
    inspect = commands.add_parser("inspect-unit")
    inspect.add_argument("service")
    begin_parser = commands.add_parser("begin")
    begin_parser.add_argument("service")
    apply_parser = commands.add_parser("apply")
    apply_parser.add_argument("transaction")
    apply_parser.add_argument("service")
    apply_parser.add_argument("bin_dir")
    apply_parser.add_argument("control_home")
    apply_parser.add_argument("gateway_uid", type=int)
    apply_parser.add_argument("gateway_gid", type=int)
    apply_parser.add_argument("install_dir")
    for name in ("restore", "discard"):
        command = commands.add_parser(name)
        command.add_argument("transaction")
    args = parser.parse_args(argv)
    if os.name != "posix" or not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise ValueError("service registration transactions require Linux no-follow descriptors")
    if args.command == "inspect-unit":
        print(json.dumps(inspect_unit(args.service), ensure_ascii=False, separators=(",", ":")))
        return
    if os.geteuid() != 0:
        raise ValueError("service registration transactions require root")
    if args.command == "prepare-lock":
        print(prepare_lock())
    elif args.command == "begin":
        print(begin(args.service))
    elif args.command == "apply":
        apply(args.transaction, args.service, args.bin_dir, args.control_home,
              args.gateway_uid, args.gateway_gid, args.install_dir)
    elif args.command == "restore":
        restore(args.transaction)
    else:
        discard(args.transaction)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(str(error)) from None
