"""Bounded root request spool, independent of durable operation receipts.

The RPC waiter holds admission through launch/wait. Executors only take the
short file gate, so a disconnected waiter does not cancel the transaction.
Collection never stops an active executor. A stopped/cgroup-confirmed request
is revoked by removing its files under the same gate used by late executors.
"""
from __future__ import annotations

import os
import re
import stat
import uuid
from contextlib import contextmanager
from pathlib import Path

from .common import DeployError, Layout, atomic_write, canonical, exclusive, fsync_directory, require
from .system import System

MAX_REQUEST = 1024 * 1024
MAX_RESULT = 1024 * 1024
MAX_REQUESTS = 32
MAX_SPOOL_BYTES = 16 * 1024 * 1024
ID = re.compile(r"[0-9a-f]{32}\Z")
LEGACY = re.compile(r"([0-9a-f]{32})(?:\.result)?\.json\Z")


def bounded_json(value: object, limit: int) -> bytes:
    data = canonical(value) + b"\n"
    require(len(data) <= limit, "Management request/result exceeds its byte budget", "budget")
    return data


class RequestSpool:
    def __init__(self, layout: Layout, system: System | None = None):
        self.layout, self.system = layout, system or System()
        self.root = layout.state / "requests"

    def gate(self):
        return exclusive(self.layout.config / "request-files.lock")

    def ordinary(self, path: Path, *, directory: bool = False) -> os.stat_result:
        info = path.lstat()
        require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1) and
                (os.name != "posix" or info.st_uid == 0 and not info.st_mode & 0o077),
                "Unsafe management request storage; inspect retained files", "recovery_required")
        return info

    def inventory(self) -> tuple[dict[str, list[Path]], int]:
        self.ordinary(self.root, directory=True)
        records: dict[str, list[Path]] = {}
        total = 0
        # Root-only writers use at most an input and a result plus one unfinished
        # atomic replacement. Bound enumeration too, including legacy flat files.
        for index, entry in enumerate(self.root.iterdir()):
            require(index < MAX_REQUESTS * 3, "Management request retention count reached; inspect retained files", "budget")
            if ID.fullmatch(entry.name):
                self.ordinary(entry, directory=True)
                ident = entry.name
                require(ident not in records, "Mixed legacy/current request storage", "recovery_required")
                files = []
                for offset, item in enumerate(entry.iterdir()):
                    require(offset < 3 and (item.name in ("request.json", "result.json") or item.name.startswith(".new-")),
                            "Unexpected management request material; inspect before cleanup", "recovery_required")
                    files.append(item)
                records[ident] = files
            else:
                match = LEGACY.fullmatch(entry.name)
                require(match is not None, "Unrecognized legacy request material; inspect before cleanup", "recovery_required")
                ident = match[1]
                require(not (self.root / ident).exists(), "Mixed legacy/current request storage", "recovery_required")
                records.setdefault(ident, []).append(entry)
                files = [entry]
            require(len(records) <= MAX_REQUESTS, "Management request retention count reached; inspect retained files", "budget")
            for item in files:
                info = self.ordinary(item)
                require(info.st_size <= max(MAX_REQUEST, MAX_RESULT), "Retained management file exceeds budget", "budget")
                total += info.st_size
                require(total <= MAX_SPOOL_BYTES, "Management request retention byte budget reached; inspect retained files", "budget")
        return records, total

    def stopped(self, ident: str) -> None:
        unit = f"codex-harness-{self.layout.instance}-manage-{ident}.service"
        try:
            state = self.system.state(unit)
            require(state["stopped"], "A retained management request is still running; query its operation before retrying", "busy")
            # Only observed-stopped units reach stop(): confirm the cgroup too.
            # Failed/empty observations cannot authorize deletion or more input.
            self.system.stop([unit])
        except DeployError as exc:
            if exc.code == "busy":
                raise
            raise DeployError("recovery_required", "Management request stop is unconfirmed; files retained and new requests blocked") from exc
        except Exception as exc:
            raise DeployError("recovery_required", "Management request stop is unconfirmed; files retained and new requests blocked") from exc

    def remove(self, ident: str, files: list[Path]) -> None:
        for item in files:
            item.unlink()
        directory = self.root / ident
        if directory.exists():
            directory.rmdir()
        fsync_directory(self.root)

    @contextmanager
    def stage(self, request: dict):
        data = bounded_json(request, MAX_REQUEST)
        with exclusive(self.layout.config / "request-admission.lock"):
            with self.gate():
                records, _ = self.inventory()
                # Check all units before removing any material. An active or
                # ambiguous predecessor keeps the complete spool and blocks growth.
                for ident in records:
                    self.stopped(ident)
                for ident, files in records.items():
                    self.remove(ident, files)
                require(MAX_REQUESTS > 0 and len(data) + MAX_RESULT <= MAX_SPOOL_BYTES,
                        "No management request/result reservation available", "budget")
                ident = uuid.uuid4().hex
                directory = self.root / ident
                directory.mkdir(mode=0o700)
                os.chmod(directory, 0o700)
                fsync_directory(self.root)
                atomic_write(directory / "request.json", data)
            # The files gate is never held while the executor needs to read or
            # publish. Admission stays leased to this caller through launch/wait.
            yield ident

    def load(self, ident: str) -> dict:
        import json
        require(ID.fullmatch(ident) is not None, "Invalid management request identity")
        with self.gate():
            directory = self.root / ident
            self.ordinary(directory, directory=True)
            path = directory / "request.json"
            info = self.ordinary(path)
            require(info.st_size <= MAX_REQUEST, "Management request exceeds budget", "budget")
            value = json.loads(path.read_bytes())
            require(isinstance(value, dict), "Management request must be an object")
            return value

    def publish(self, ident: str, result: dict) -> None:
        data = bounded_json(result, MAX_RESULT)
        with self.gate():
            records, total = self.inventory()
            directory = self.root / ident
            require(ident in records and directory.is_dir() and directory / "request.json" in records[ident],
                    "Management request was revoked; result cannot recreate it", "recovery_required")
            require(not (directory / "result.json").exists(), "Management result was already published", "recovery_required")
            require(total + len(data) <= MAX_SPOOL_BYTES, "Management result reservation exceeded", "budget")
            atomic_write(directory / "result.json", data)

    def finish(self, ident: str) -> dict | None:
        import json
        with self.gate():
            records, _ = self.inventory()
            require(ident in records, "Management request material is missing", "recovery_required")
            self.stopped(ident)
            response = self.root / ident / "result.json"
            result = json.loads(response.read_bytes()) if response in records[ident] else None
            require(result is None or isinstance(result, dict), "Invalid management result", "corrupt_state")
            # Receipt records are deliberately untouched. In particular missing
            # output or collected staging does not resolve an unknown operation.
            self.remove(ident, records[ident])
            return result
