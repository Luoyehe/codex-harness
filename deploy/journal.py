"""Reset only the old worker activity barrier after both service cgroups stopped."""
from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

from .common import DeployError, require
from .journal_schema import validate_schema


def recover_journal(path: Path, *, services_stopped: bool) -> dict:
    require(services_stopped, "Both services must be confirmed stopped", "stop_unknown")
    if not path.exists():
        return {"notSent": 0, "unknown": 0}
    require(not path.is_symlink() and path.is_file() and path.stat().st_size <= 1024**3, "Unsafe control journal", "corrupt_state")
    for suffix in ("-wal", "-shm", "-journal"):
        require(not Path(str(path) + suffix).is_symlink(), "Unsafe SQLite sidecar", "corrupt_state")
    db = sqlite3.connect(path, timeout=5)
    try:
        db.enable_load_extension(False)
        db.execute("PRAGMA trusted_schema=OFF")
        db.execute("PRAGMA synchronous=FULL")
        has_retirements = validate_schema(db)
        require(db.execute("SELECT count(*) FROM receipts").fetchone()[0] <= 100_000, "Journal receipt budget exceeded", "budget")
        if has_retirements:
            require(db.execute("SELECT count(*) FROM retired_operations").fetchone()[0] <= 100_000,
                    "Journal retirement budget exceeded", "budget")
        db.execute("BEGIN IMMEDIATE")
        now = int(time.time() * 1000)
        not_sent = db.execute("UPDATE receipts SET state='not_sent',updated_at=?,error=? WHERE state='pending'", (now, json.dumps({
            "code": "interrupted_before_dispatch", "message": "Service stopped before dispatch", "delivery": "not_sent"}))).rowcount
        unknown = db.execute("UPDATE receipts SET state='unknown',updated_at=?,error=? WHERE state='dispatching'", (now, json.dumps({
            "code": "interrupted_after_dispatch", "message": "Service stopped after dispatch; inspect history", "delivery": "unknown"}))).rowcount
        db.execute("INSERT INTO metadata(key,value) VALUES('activityUncertain','false') ON CONFLICT(key) DO UPDATE SET value='false'")
        db.commit()
        return {"notSent": not_sent, "unknown": unknown}
    finally:
        db.close()


def recover_as_owner(path: Path, uid: int, gid: int) -> None:
    """SQLite and all its sidecars are opened with the gateway's existing DAC rights."""
    if not path.exists():
        return
    pid = os.fork()
    if pid == 0:
        try:
            os.setgroups([])
            os.setgid(gid)
            os.setuid(uid)
            recover_journal(path, services_stopped=True)
            os._exit(0)
        except BaseException:
            os._exit(1)
    _, result = os.waitpid(pid, 0)
    require(os.waitstatus_to_exitcode(result) == 0, "Control journal recovery failed; services remain stopped", "recovery_required")
