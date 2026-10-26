"""Explicit gateway schema contracts understood by the stop-confirmed recovery helper.

The helper is separately installed trusted code. Never execute DDL read from the
application checkout or accept unknown tables merely because receipts exist.
The integration test constructs the real JavaScript Ledger to detect drift.
"""
from __future__ import annotations

import re
import sqlite3

from .common import require


BASE = """
CREATE TABLE receipts (
 id TEXT PRIMARY KEY, method TEXT NOT NULL, scope TEXT NOT NULL, digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','dispatching','accepted','not_sent','unknown')),
 result TEXT, error TEXT, bytes INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE projects(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL) STRICT;
CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
"""
RETIREMENTS = "CREATE TABLE retired_operations(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL) STRICT;"
FEATURES = """
CREATE TABLE automations(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,state TEXT NOT NULL,spec TEXT NOT NULL,next_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE automation_runs(id TEXT PRIMARY KEY,automation_id TEXT NOT NULL,revision INTEGER NOT NULL,scheduled_at INTEGER NOT NULL,manual INTEGER NOT NULL,operation_id TEXT NOT NULL UNIQUE,client_id TEXT NOT NULL,state TEXT NOT NULL,thread_id TEXT,turn_id TEXT,started_at INTEGER,finished_at INTEGER,stop_requested INTEGER NOT NULL DEFAULT 0,stop_sent INTEGER NOT NULL DEFAULT 0,code TEXT,spec TEXT NOT NULL) STRICT;
CREATE UNIQUE INDEX automation_occurrence ON automation_runs(automation_id,revision,scheduled_at) WHERE manual=0;
CREATE INDEX automation_run_order ON automation_runs(automation_id,scheduled_at DESC);
CREATE TABLE worktree_projects(
 id TEXT PRIMARY KEY, origin_id TEXT NOT NULL, active_path TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL, phase TEXT NOT NULL, head TEXT NOT NULL, revision TEXT NOT NULL,
 generation INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
"""


def schema_objects(db: sqlite3.Connection) -> dict:
    # LIKE 'sqlite_%' treats '_' as a wildcard and would hide sqlitex... tables.
    values = db.execute("SELECT type,name,sql FROM sqlite_schema WHERE substr(name,1,7) != 'sqlite_'").fetchall()
    # Ignore formatting outside quoted literals; removing whitespace inside
    # CHECK literals would accidentally accept a changed state vocabulary.
    return {(kind, name): re.sub(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|\s+",
                                lambda match: "" if match.group().isspace() else match.group(), sql or "")
            for kind, name, sql in values}


def schema_layout(db: sqlite3.Connection, objects: dict) -> dict:
    layout = {}
    for kind, name in objects:
        if kind != "table": continue
        quoted = '"' + name.replace('"', '""') + '"'
        indexes = db.execute("PRAGMA index_list(" + quoted + ")").fetchall()
        layout[name] = {"columns": db.execute("PRAGMA table_xinfo(" + quoted + ")").fetchall(),
                        "indexes": sorted(indexes), "keys": {}}
        for index in indexes:
            index_name = '"' + index[1].replace('"', '""') + '"'
            layout[name]["keys"][index[1]] = db.execute("PRAGMA index_xinfo(" + index_name + ")").fetchall()
    return layout


def validate_schema(db: sqlite3.Connection) -> bool:
    require(db.execute("PRAGMA user_version").fetchone()[0] == 0,
            "Unknown journal schema version", "corrupt_state")
    actual = schema_objects(db)
    for ddl in (BASE, BASE + RETIREMENTS, BASE + RETIREMENTS + FEATURES):
        reference = sqlite3.connect(":memory:")
        try:
            reference.executescript(ddl)
            if actual == schema_objects(reference) and schema_layout(db, actual) == schema_layout(reference, actual):
                return ("table", "retired_operations") in actual
        finally:
            reference.close()
    require(False, "Unexpected journal schema objects or definitions", "corrupt_state")
    return False
