"""Root-owned provider profiles and bounded, reference-aware generation retention."""
from __future__ import annotations

import os
import re
import secrets
import stat
from pathlib import Path

from .common import fsync_directory, mkdir, read_json, require, write_json

MAX_PROFILES = 16
MAX_GENERATIONS = 128
KEEP_HISTORY = 3
GENERATION = re.compile(r"[0-9a-f]{32}")
GENERATION_FILES = {"settings.json", "models.json", "runtime.json", "config.toml", "host-layers.json", "system-config.toml",
                    "requirements.toml", "provider.env", "native-env.json"}


def private_file(path: Path) -> None:
    details = path.lstat()
    require(stat.S_ISREG(details.st_mode) and details.st_nlink == 1 and details.st_size <= 4 * 1024 * 1024,
            "Unsafe provider profile", "corrupt_state")
    if os.name == "posix":
        require(details.st_uid == os.geteuid() and not details.st_mode & 0o077,
                "Provider profile ownership or permissions changed", "corrupt_state")


class Profiles:
    def __init__(self, layout):
        self.root = layout.config / "provider-profiles"

    def records(self) -> list[dict]:
        if not self.root.exists():
            require(not self.root.is_symlink(), "Unsafe provider profile directory", "corrupt_state")
            return []
        require(not self.root.is_symlink() and self.root.is_dir(), "Unsafe provider profile directory", "corrupt_state")
        if os.name == "posix":
            info = self.root.stat()
            require(info.st_uid == os.geteuid() and not info.st_mode & 0o077, "Provider profile directory ownership or permissions changed", "corrupt_state")
        records = []
        for path in self.root.iterdir():
            require(len(records) < MAX_PROFILES and re.fullmatch(r"[0-9a-f]{32}\.json", path.name),
                    "Provider profile inventory exceeds its bound or contains unknown material", "corrupt_state")
            private_file(path)
            value = read_json(path, 4 * 1024 * 1024)
            require(isinstance(value, dict) and set(value) == {"id", "name", "settings"} and
                    value["id"] == path.stem and isinstance(value["name"], str) and isinstance(value["settings"], dict),
                    "Invalid provider profile", "corrupt_state")
            from .provider import small_text
            small_text(value["name"], "profile name", 256)
            require(len(value["name"]) <= 64 and value["name"] == value["name"].strip(), "Invalid provider profile name", "corrupt_state")
            require(not any(row["name"] == value["name"] for row in records), "Duplicate provider profile name", "corrupt_state")
            records.append(value)
        return sorted(records, key=lambda row: (row["name"].casefold(), row["id"]))

    def read(self, identity: object) -> dict:
        require(isinstance(identity, str) and GENERATION.fullmatch(identity), "Invalid provider profile identity")
        rows = self.records()
        selected = next((row for row in rows if row["id"] == identity), None)
        require(selected is not None, "Saved provider profile no longer exists", "profile_missing")
        return selected

    def public(self) -> list[dict]:
        return [{"id": row["id"], "name": row["name"], **{key: value for key, value in row["settings"].items()
                 if key in ("kind", "baseUrl", "region", "model", "revision")},
                 "hasApiKey": bool(row["settings"].get("apiKey"))} for row in self.records()]

    def validate_save(self, name: object) -> str:
        from .provider import small_text
        name = small_text(name, "profile name", 256).strip()
        require(bool(name) and len(name) <= 64, "Provider profile name must contain 1 to 64 characters")
        rows = self.records()
        require(len(rows) < MAX_PROFILES, "At most 16 provider profiles can be saved; remove an unused profile first", "budget")
        require(not any(row["name"] == name for row in rows),
                "A profile with this name already exists; explicitly remove it before saving a replacement", "profile_exists")
        return name

    def save(self, name: object, settings: dict) -> None:
        name = self.validate_save(name)
        mkdir(self.root, 0o700)
        identity = secrets.token_hex(16)
        write_json(self.root / (identity + ".json"), {"id": identity, "name": name, "settings": settings}, mode=0o600)

    def remove(self, identity: object) -> None:
        record = self.read(identity)
        (self.root / (record["id"] + ".json")).unlink()
        fsync_directory(self.root)


def protected_generations(layout, root: Path) -> set[str]:
    protected = set()
    current = root / "current"
    if current.is_symlink():
        target = os.readlink(current)
        require(GENERATION.fullmatch(target), "Invalid provider pointer", "corrupt_state")
        require((root / target).is_dir() and not (root / target).is_symlink(), "Current provider generation is absent or unsafe", "corrupt_state")
        protected.add(target)
    else:
        require(not current.exists(), "Provider pointer is not a symlink", "corrupt_state")
    transactions = layout.state / "transactions"
    if transactions.exists():
        require(not transactions.is_symlink(), "Unsafe transaction directory", "corrupt_state")
        count = 0
        for directory in transactions.iterdir():
            count += 1
            require(count <= 10000 and not directory.is_symlink() and directory.is_dir(),
                    "Unsafe or excessive transaction inventory", "corrupt_state")
            path = directory / "state.json"
            if not path.exists():
                continue  # Dependency preparation has no provider references.
            require(not path.is_symlink(), "Unsafe provider transaction record", "corrupt_state")
            record = read_json(path)
            require(isinstance(record, dict) and isinstance(record.get("phase"), str), "Invalid transaction record", "corrupt_state")
            if record["phase"] in ("committed", "recovered", "failed_first_start"):
                continue
            def collect(value, depth=0):
                require(depth <= 24, "Transaction reference depth exceeded", "corrupt_state")
                if isinstance(value, str) and GENERATION.fullmatch(value):
                    protected.add(value)
                elif isinstance(value, dict):
                    for child in value.values():
                        collect(child, depth + 1)
                elif isinstance(value, list):
                    for child in value:
                        collect(child, depth + 1)
            collect(record)
    return protected


def generations(root: Path) -> list[Path]:
    if not root.exists():
        return []
    require(not root.is_symlink() and root.is_dir(), "Unsafe provider generation directory", "corrupt_state")
    result = []
    for path in root.iterdir():
        if GENERATION.fullmatch(path.name):
            require(not path.is_symlink() and path.is_dir(), "Unsafe provider generation", "corrupt_state")
            result.append(path)
            require(len(result) <= MAX_GENERATIONS, "Provider generation inventory exceeds its bound", "budget")
    return result


def collect_generations(layout, root: Path) -> dict:
    """Called under management.lock; native users cannot rename these directories."""
    rows = generations(root)
    protected = protected_generations(layout, root)
    unused = sorted((path for path in rows if path.name not in protected), key=lambda path: (path.stat().st_mtime_ns, path.name), reverse=True)
    remove = unused[KEEP_HISTORY:]
    retired = []
    for path in root.iterdir() if root.exists() else []:
        if path.name.startswith(".retired-"):
            identity = path.name.removeprefix(".retired-")
            require(GENERATION.fullmatch(identity) and identity not in protected and not path.is_symlink() and path.is_dir(),
                    "Unsafe retired provider generation", "recovery_required")
            retired.append(path)
            require(len(retired) <= MAX_GENERATIONS, "Retired provider generation budget exceeded", "budget")
    # Validate the entire removal set before changing any generation.
    for path in [*remove, *retired]:
        entries = list(path.iterdir())
        require(len(entries) <= len(GENERATION_FILES) + MAX_PROFILES and all(entry.name in GENERATION_FILES or
                re.fullmatch(r"catalog-(?:default|[0-9a-f]{32})\.json", entry.name) for entry in entries),
                "Unexpected provider generation material; retained for inspection", "recovery_required")
        for entry in entries:
            details = entry.lstat()
            require(stat.S_ISREG(details.st_mode) and details.st_nlink == 1,
                    "Unsafe provider generation material; retained for inspection", "recovery_required")
    for path in remove:
        target = root / (".retired-" + path.name)
        require(not target.exists() and not target.is_symlink(), "Retired provider destination exists", "recovery_required")
        os.rename(path, target)
        fsync_directory(root)
        retired.append(target)
    for path in retired:
        for entry in path.iterdir():
            entry.unlink()
        path.rmdir()
        fsync_directory(root)
    return {"generations": len(rows) - len(remove), "removed": len(remove), "limit": MAX_GENERATIONS,
            "retainedHistory": KEEP_HISTORY, "protected": len(protected)}
