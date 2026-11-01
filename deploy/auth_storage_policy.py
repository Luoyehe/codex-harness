"""Managed instances use file auth; never silently discard another store's login."""
from __future__ import annotations

import os
import re
import stat
import tomllib
from pathlib import Path

from .common import DeployError, require
from .provider_layers import LAYER_LIMIT

MESSAGE = ("实例共享 ChatGPT 登录只支持 file 认证存储。检测到其他存储设置；请先在原执行模式确认并保留现有登录，"
           "再明确改为 file 并重新登录。不会自动读取或迁移 keyring，也不会覆盖原存储。")
LIMIT = 1024 * 1024


def validate_document(document):
    require(isinstance(document, dict), "Invalid authentication storage configuration", "configuration_conflict")
    require(document.get("cli_auth_credentials_store", "file") == "file", MESSAGE, "auth_store_unsupported")
    profiles = document.get("profiles", {})
    require(isinstance(profiles, dict), "Invalid authentication storage profiles", "configuration_conflict")
    for profile in profiles.values():
        require(isinstance(profile, dict), "Invalid authentication storage profile", "configuration_conflict")
        require(profile.get("cli_auth_credentials_store", "file") == "file", MESSAGE, "auth_store_unsupported")


def check_file(path, uid, limit=LIMIT):
    try:
        parent = path.parent.lstat()
        require(stat.S_ISDIR(parent.st_mode) and not stat.S_ISLNK(parent.st_mode),
                "Authentication configuration parent is not a real directory", "configuration_conflict")
        info = path.lstat()
    except FileNotFoundError:
        return
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= limit and
            (os.name != "posix" or info.st_uid in (0, uid) and not info.st_mode & 0o022),
            "Unsafe authentication storage configuration", "configuration_conflict")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        before = os.fstat(fd)
        require((info.st_dev, info.st_ino) == (before.st_dev, before.st_ino),
                "Authentication configuration changed during inspection", "configuration_conflict")
        with os.fdopen(fd, "rb", closefd=False) as source:
            data = source.read(limit + 1)
        after = os.fstat(fd)
    finally:
        os.close(fd)
    require(len(data) <= limit and (before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
            (after.st_size, after.st_mtime_ns, after.st_ctime_ns),
            "Authentication configuration changed or exceeded budget", "configuration_conflict")
    try:
        document = tomllib.loads(data.decode("utf-8"))
    except (ValueError, UnicodeError) as error:
        raise DeployError("configuration_conflict", "Authentication storage TOML is invalid; file contents were not changed") from error
    validate_document(document)


def require_file_store(layout, home: Path, uid: int):
    # Both launcher namespace views and retained immutable instance views are
    # checked. -c file alone must not silently hide an existing keyring setting.
    files = [(home / "config.toml", LIMIT)]
    # In the worker mount namespace these two host paths are the generated
    # provider layers, whose existing supported budget is larger than host TOML.
    files += [(layout.root / "etc/codex" / name, LAYER_LIMIT) for name in ("config.toml", "requirements.toml")]
    files.append((layout.root / "etc/codex/managed_config.toml", LIMIT))
    current = layout.config / "providers/current"
    if current.is_symlink():
        selected = os.readlink(current)
        require(re.fullmatch(r"[0-9a-f]{32}", selected) is not None, "Invalid authentication provider generation", "configuration_conflict")
        current = current.parent / selected
    files += [(current / name, LAYER_LIMIT) for name in ("system-config.toml", "requirements.toml")]
    # Project settings in the fixed launcher cwd/ancestors can affect bootstrap.
    require(home.is_relative_to(layout.root), "Authentication home escaped instance root", "integrity")
    parent = home.parent
    for _ in range(32):
        files.append((parent / ".codex/config.toml", LIMIT))
        if parent == layout.root:
            break
        require(parent != parent.parent, "Authentication ancestry escaped instance root", "integrity")
        parent = parent.parent
    else:
        raise DeployError("budget", "Authentication configuration ancestry exceeds budget")
    for path, limit in files:
        check_file(path, uid, limit)


def require_mode_stores(layout, config):
    for mode in ("native", "root"):
        home = layout.state / ("worker-root" if mode == "root" else "worker") / "codex"
        require_file_store(layout, home, 0 if mode == "root" else config["workerUid"])
