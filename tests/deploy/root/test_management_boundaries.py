"""Cross-transaction and service ownership regressions with real local files."""
import tempfile
import os
import sys
import subprocess
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from deploy import install
from deploy.common import DeployError, Layout, atomic_write, digest, mkdir, read_json, write_json
from deploy.control_update import ControlUpdater
from deploy.https import setup_https
from deploy.manager import Manager
from deploy.ownership import require_owned
from deploy.units import render_edge_units, render_units, sudo_rule


class FixtureSystem:
    def __init__(self, layout):
        self.layout, self.events, self.active = layout, [], set()
        self.reload_failure = False

    def state(self, unit):
        exists = (self.layout.units / unit).exists()
        active = unit in self.active
        return {"LoadState": "loaded" if exists else "not-found", "ActiveState": "active" if active else "inactive",
                "SubState": "running" if active else "dead", "MainPID": "123" if active else "0",
                "ControlPID": "0", "stopped": not active}

    def stop(self, units):
        self.events.append("stop")
        self.active.difference_update(units)

    def start(self, units):
        self.events.append("start")
        self.active.update(units)

    def reload(self):
        self.events.append("reload")
        if self.reload_failure:
            self.reload_failure = False
            raise DeployError("reload", "Injected reload interruption")

    def enable(self, units):
        self.events.append("enable")


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root ownership fixture")
class ManagementBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout("fixture", Path(self.temp.name))
        for path in (self.layout.config, self.layout.units, self.layout.state / "transactions", self.layout.root / "etc/sudoers.d"):
            mkdir(path)
        self.config = {"port": 3300, "origin": "http://127.0.0.1:3300", "workerGid": 102, "gatewayUid": 101,
                       "gatewayGid": 101, "codexRelative": "vendor/fixture/codex"}
        write_json(self.layout.config / "instance.json", self.config)
        write_json(self.layout.config / "installation.json", {"format": 1, "phase": "complete", "release": "a" * 64})
        for name, content in render_units(self.layout, self.config, self.config["codexRelative"]).items():
            atomic_write(self.layout.units / name, content.encode(), 0o644)
        self.sudo = self.layout.root / "etc/sudoers.d/codex-harness-fixture"
        atomic_write(self.sudo, sudo_rule(self.layout).encode(), 0o644)
        self.system = FixtureSystem(self.layout)
        self.manager = Manager(self.layout, self.system, worker_gid=102)
        self.manager.selected = lambda name="current": "a" * 64 if name == "current" else None
        self.manager.verify_release = lambda release: {"release": release}
        self.manager.recover_control = lambda: None
        self.manager.healthy = lambda: None

    def pending(self, kind):
        path = self.layout.state / "transactions" / "interrupted"
        mkdir(path)
        write_json(path / "state.json", {"kind": kind, "phase": "selected", "old": "a" * 64})
        return path / "state.json"

    def test_pending_transactions_block_all_new_write_entrypoints_without_new_receipts(self):
        for kind in ("release", "provider", "https"):
            with self.subTest(kind=kind):
                journal = self.pending(kind)
                before = journal.read_bytes()
                params = {"expectedRevision": "a" * 32, "kind": "chatgpt"}
                requests = [("provider/write", params), ("models/refresh", {"expectedRevision": "a" * 32}),
                            ("models/refresh", {"expectedRevision": "a" * 32, "confirmCapabilities": True, "models": []}), ("restart", {})]
                for method, fields in requests:
                    with self.assertRaises(DeployError) as caught:
                        self.manager.dispatch({"method": method, "params": fields, "operationId": str(uuid.uuid4())})
                    self.assertEqual(caught.exception.code, "recovery_required")
                with self.assertRaises(DeployError):
                    self.manager.provider_change(params)
                with self.assertRaises(DeployError):
                    setup_https(self.manager, host="work.example.test", auth_host="auth.example.test", domain="example.test",
                                username="admin", email="admin@example.test", auth_port=9091)
                with self.assertRaises(DeployError):
                    ControlUpdater(self.layout, self.system).update()
                with patch("deploy.install.Manager", return_value=self.manager), self.assertRaises(DeployError):
                    install.uninstall(self.layout)
                self.assertEqual(journal.read_bytes(), before)
                self.assertFalse((self.layout.state / "receipts").exists())
                self.assertEqual(self.system.events, [])
                journal.unlink()

    def test_completed_receipt_remains_queryable_during_pending_recovery(self):
        self.pending("release")
        operation = str(uuid.uuid4())
        receipts = self.layout.state / "receipts"
        mkdir(receipts)
        write_json(receipts / (operation + ".json"), {"state": "completed", "operationId": operation,
                   "requestDigest": digest({"method": "restart", "params": {}}), "result": {"restarted": True}})
        result = self.manager.dispatch({"method": "operation/read", "params": {"operationId": operation}})
        self.assertEqual(result["result"]["state"], "completed")
        replay = self.manager.dispatch({"method": "restart", "params": {}, "operationId": operation})
        self.assertEqual(replay, {"ok": True, "result": {"restarted": True}})
        self.assertEqual(self.system.events, [])

    def test_pending_nonrelease_transaction_does_not_create_legacy_installation_marker(self):
        self.pending("provider")
        marker = self.layout.config / "installation.json"
        marker.unlink()
        self.manager.selected = lambda name="current": None
        with self.assertRaises(DeployError):
            self.manager.require_update_ready()
        self.assertFalse(marker.exists())

    def test_first_https_password_hash_input_is_a_complete_stdin_line(self):
        password = "isolated-" + "password-fixture"
        observed = []
        def command(argv, **kwargs):
            self.assertIn("hash-password", argv)
            observed.append(kwargs["input"])
            # Caddy's real non-TTY reader returns EOF if the line is not ended.
            if not kwargs["input"].endswith("\n"):
                raise DeployError("command_failed", "Incomplete hasher input")
            return subprocess.CompletedProcess(argv, 0, "$argon2id$fixture\n", "")
        with patch("deploy.https.edge_binary", side_effect=lambda layout, kind: self.layout.control / "edge" / kind / kind), \
             patch("deploy.https.sys.stdin.isatty", return_value=True), \
             patch("deploy.https.getpass.getpass", return_value=password), \
             patch("deploy.https.run", side_effect=command), \
             patch("deploy.https.ensure_account", side_effect=DeployError("fixture_stop", "Stop after real caller hasher protocol")):
            with self.assertRaises(DeployError) as caught:
                setup_https(self.manager, host="work.example.test", auth_host="auth.example.test", domain="example.test",
                            username="admin", email="admin@example.test", auth_port=9091)
        self.assertEqual(caught.exception.code, "fixture_stop")
        self.assertEqual(observed, [password + "\n"])
        self.assertEqual(self.system.events, [])

    def test_uninstall_and_resume_reject_unowned_service_before_stop_or_delete(self):
        path = self.layout.units / self.layout.unit("gateway")
        path.write_bytes(b"unrelated existing service")
        for action in (self.manager.restart, self.manager.repair, lambda: self.manager.activate("b" * 64)):
            with self.assertRaises(DeployError) as caught:
                action()
            self.assertEqual(caught.exception.code, "ownership_conflict")
        with patch("deploy.install.Manager", return_value=self.manager), patch("deploy.install.run") as command:
            with self.assertRaises(DeployError):
                install.uninstall(self.layout)
            command.assert_not_called()
        self.assertEqual(path.read_bytes(), b"unrelated existing service")
        self.assertEqual(self.system.events, [])

    def test_known_control_dropins_are_preserved_but_unknown_overrides_are_rejected(self):
        directory = self.layout.units / (self.layout.unit("worker") + ".d")
        mkdir(directory)
        known = directory / "90-codex-harness-control-maintenance.conf"
        content = f"[Unit]\nConditionPathExists=!{self.layout.config / 'control-maintenance/worker'}\n".encode()
        atomic_write(known, content, 0o644)
        require_owned(self.layout, self.config)
        atomic_write(directory / "99-unrelated.conf", b"[Service]\nExecStart=/unrelated\n", 0o644)
        with self.assertRaises(DeployError):
            self.manager.restart()
        self.assertEqual(known.read_bytes(), content)
        self.assertEqual(self.system.events, [])

    def test_recognized_runtime_group_unit_migrates_only_after_stop_and_reloads_on_retry(self):
        path = self.layout.units / self.layout.unit("worker")
        old = render_units(self.layout, self.config, self.config["codexRelative"], legacy_runtime_directory=True)[path.name]
        atomic_write(path, old.encode(), 0o644)
        self.system.reload_failure = True
        with self.assertRaises(DeployError):
            self.manager.restart()
        self.assertEqual(self.system.events, ["stop", "reload"])
        self.assertIn("\nGroup=ch-fixture-ipc\n", path.read_text())
        self.assertNotIn("ExecStartPre=", path.read_text())
        self.manager.restart()
        self.assertEqual(self.system.events, ["stop", "reload", "stop", "reload", "start"])


if __name__ == "__main__":
    unittest.main()
