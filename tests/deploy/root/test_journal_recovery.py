"""Real Ledger + dropped-UID recovery through all stopped service paths."""
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from deploy.common import DeployError, Layout, mkdir, write_json
from deploy.control_update import ControlUpdater, ROLES
from deploy.manager import Manager
from tests.deploy import test_journal_schema as journal_fixture


class Services:
    def __init__(self, layout, journal):
        self.layout, self.journal = layout, journal
        self.active, self.events = {"gateway", "worker"}, []

    def state(self, unit):
        active = any(self.layout.unit(role) == unit for role in self.active)
        return {"stopped": not active, "ActiveState": "active" if active else "inactive",
                "SubState": "running" if active else "dead", "MainPID": "123" if active else "0", "ControlPID": "0"}

    def stop(self, units):
        self.events.append("stop")
        self.active.difference_update(role for role in tuple(self.active) if self.layout.unit(role) in units)

    def start(self, units):
        # Actual recovery must finish before any service can run again.
        db = sqlite3.connect(self.journal)
        try:
            assert dict(db.execute("SELECT id,state FROM receipts")) == {"pending": "not_sent", "sent": "unknown"}
            assert db.execute("SELECT value FROM metadata WHERE key='activityUncertain'").fetchone()[0] == "false"
        finally: db.close()
        self.events.append("start")
        self.active.update(role for role in ROLES if self.layout.unit(role) in units)

    def enabled_state(self, unit): return "enabled"
    def control_healthy(self, layout, config): self.events.append("health")


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root and native owner fixture")
class JournalManagementRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="journal-management-")
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout("fixture", Path(self.temp.name))
        os.chmod(self.layout.root, 0o755)
        for path in (self.layout.config, self.layout.app, self.layout.state / "transactions", self.layout.state / "gateway"):
            mkdir(path)
        self.journal = self.layout.state / "gateway/journal.sqlite"
        self.ledger = journal_fixture.CurrentJournalCompatibilityTests()
        db = self.ledger.create_current_journal(self.journal)
        db.close()
        os.chown(self.journal.parent, 65534, 65534)
        os.chmod(self.journal.parent, 0o700)
        os.chown(self.journal, 65534, 65534)
        self.config = {"gatewayUid": 65534, "gatewayGid": 65534, "workerUid": 65533, "workerGid": 65533}
        write_json(self.layout.config / "instance.json", self.config)
        self.system = Services(self.layout, self.journal)
        self.manager = Manager(self.layout, self.system, worker_gid=65533)
        self.manager.require_service_ownership = Mock()
        self.manager.refresh_worker_unit = Mock()
        self.manager.verify_release = Mock()
        self.manager.healthy = Mock()
        self.old, self.candidate = "a" * 64, "b" * 64
        self.manager.select(self.old)

    def verify_reopened(self):
        self.assertEqual(self.ledger.open_real_ledger(self.journal)["state"], "not_sent")
        self.assertEqual(self.journal.stat().st_uid, 65534)
        db = sqlite3.connect(self.journal)
        try:
            self.assertEqual(db.execute("SELECT name FROM projects").fetchall(), [("Retained project",)])
            self.assertEqual(db.execute("SELECT state FROM automations").fetchall(), [("paused",)])
            self.assertEqual(db.execute("SELECT name FROM worktree_projects").fetchall(), [("Retained worktree",)])
            self.assertEqual(db.execute("SELECT * FROM retired_operations").fetchall(), [("fenced", 1)])
        finally: db.close()

    def test_restart_drops_gateway_uid_recovers_real_schema_then_reopens(self):
        self.assertTrue(self.manager.restart()["restarted"])
        self.assertEqual(self.system.events, ["stop", "start"])
        self.verify_reopened()

    def test_activation_recovers_before_candidate_start_and_preserves_previous(self):
        self.assertTrue(self.manager.activate(self.candidate)["changed"])
        self.assertEqual(self.manager.selected(), self.candidate)
        self.assertEqual(self.manager.selected("previous"), self.old)
        self.assertEqual(self.system.events, ["stop", "start"])
        self.verify_reopened()

    def test_control_update_restore_recovers_before_original_services_resume(self):
        updater = ControlUpdater(self.layout, self.system)
        mkdir(updater.barriers)
        self.system.stop([self.layout.unit(role) for role in ROLES])
        updater.restore_services({"services": {role: {"active": role in ("worker", "gateway"), "enabled": "enabled"} for role in ROLES}})
        self.assertEqual(self.system.events, ["stop", "start", "health"])
        self.verify_reopened()

    def test_rejected_schema_leaves_services_stopped_and_receipts_unmodified(self):
        db = sqlite3.connect(self.journal)
        db.execute("CREATE VIEW untrusted AS SELECT * FROM receipts")
        db.commit(); db.close()
        with self.assertRaises(DeployError): self.manager.restart()
        self.assertEqual(self.system.events, ["stop"])
        self.assertFalse(self.system.active)
        db = sqlite3.connect(self.journal)
        try: self.assertEqual(dict(db.execute("SELECT id,state FROM receipts")), {"pending": "pending", "sent": "dispatching"})
        finally: db.close()
