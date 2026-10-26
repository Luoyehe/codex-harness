"""Reset only the old worker activity barrier after both service cgroups stopped."""
from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

from .common import DeployError, require
from .journal_schema import validate_schema

MAX_RECEIPT_BYTES = 64 * 1024 * 1024
PAYLOAD_BYTES = "length(CAST(coalesce(result,'') AS BLOB)) + length(CAST(coalesce(error,'') AS BLOB))"


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
        # The offline writer shares the gateway's payload budget. Correct old
        # accounting without removing evidence, even for an overfull legacy DB.
        db.execute(f"UPDATE receipts SET bytes={PAYLOAD_BYTES} WHERE bytes<>({PAYLOAD_BYTES})")
        total = db.execute("SELECT coalesce(sum(bytes),0) FROM receipts").fetchone()[0]
        not_sent = unknown = 0
        pending = db.execute("SELECT id,state,bytes,length(CAST(coalesce(error,'') AS BLOB)) FROM receipts WHERE state IN ('pending','dispatching') ORDER BY id").fetchall()
        for operation_id, prior_state, prior_bytes, prior_error_bytes in pending:
            dispatched = prior_state == 'dispatching'
            state = 'unknown' if dispatched else 'not_sent'
            error = json.dumps({
                "code": "interrupted_after_dispatch" if dispatched else "interrupted_before_dispatch",
                "message": "Service stopped after dispatch; inspect history" if dispatched else "Service stopped before dispatch",
                "delivery": state,
            })
            size = prior_bytes - prior_error_bytes + len(error.encode('utf-8'))
            if total - prior_bytes + size <= MAX_RECEIPT_BYTES or size <= prior_bytes:
                db.execute("UPDATE receipts SET state=?,updated_at=?,error=?,bytes=? WHERE id=?", (state, now, error, size, operation_id))
                total += size - prior_bytes
            else:
                # A new error cannot justify growing a full legacy payload.
                # Keep its old bytes as evidence and persist only the outcome.
                db.execute("UPDATE receipts SET state=?,updated_at=? WHERE id=?", (state, now, operation_id))
            if dispatched: unknown += 1
            else: not_sent += 1
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
