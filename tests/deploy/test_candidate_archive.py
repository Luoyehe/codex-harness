"""Archival fault boundaries using real rename/inventory files and substituted services."""
import json
import os
import tempfile
import types
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest.mock import Mock, patch

from deploy import candidate_archive as archive
from deploy.cli import parser
from deploy.common import DeployError, Layout, read_json, write_json


class CandidateArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.layout = Layout("fixture", Path(self.temporary.name))
        self.candidate = "a" * 32
        self.release = "b" * 64
        self.source = self.layout.work / ("candidate-" + self.candidate)
        self.source.mkdir(parents=True)
        (self.source / "retained.txt").write_text("recovery material")
        self.prepared = self.layout.state / "transactions" / self.candidate / "prepared.json"
        self.prepared.parent.mkdir(parents=True)
        self.proof = {"release": self.release, "manifestDigest": self.release,
                      **{key: True for key in archive.PROBES}}
        write_json(self.prepared, self.proof)
        self.lifecycle_id = "c" * 32
        self.lifecycle = {"phase": "recovered"}
        self.events = []
        self.system = Mock()
        self.system.state.return_value = {"stopped": True}
        self.system.instance_units.return_value = []
        self.system.stop.side_effect = lambda _: self.events.append("stop")
        self.system.no_instance_processes.side_effect = lambda *_: self.events.append("no-processes")
        self.manager = types.SimpleNamespace(layout=self.layout, system=self.system, config={},
                                             verify_release=Mock(), require_service_ownership=Mock())
        self.root = archive.archive_root(self.layout)
        self.target = self.root / self.source.name
        self.inventory = self.root / (self.candidate + ".json")
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(archive, "trusted_ancestors"))
        self.stack.enter_context(patch.object(archive, "unmounted"))
        self.stack.enter_context(patch.object(archive, "stopped_units"))
        self.stack.enter_context(patch.object(archive, "require_recovered", side_effect=self.recovered))
        self.stack.enter_context(patch.object(archive, "require_idle", side_effect=lambda _: self.events.append("idle")))
        self.stack.enter_context(patch.object(archive, "uninstall_services", side_effect=self.remove_services))
        self.stack.enter_context(patch.object(archive, "read_record", side_effect=lambda _: (self.prepared.parent.parent / self.lifecycle_id / "state.json", self.lifecycle)))
        self.stack.enter_context(patch.object(archive, "require_only_transaction"))
        self.stack.enter_context(patch.object(archive, "verify_retained"))
        self.stack.enter_context(patch.object(archive, "service_paths", return_value={}))
        self.stack.enter_context(patch.object(archive, "restore_services", side_effect=self.restore))

    def recovered(self, _):
        if self.lifecycle["phase"] != "recovered":
            raise DeployError("recovery_required", "pending lifecycle")

    def remove_services(self, _):
        self.events.append("remove")
        self.lifecycle["phase"] = "removed"
        return {"servicesRemoved": True, "transaction": self.lifecycle_id}

    def restore(self, _):
        self.events.append("restore")
        self.lifecycle["phase"] = "recovered"
        return {"servicesRestored": True}

    def perform(self):
        return archive.archive_locked(self.manager, self.candidate)

    def test_success_moves_only_candidate_and_restores_services(self):
        untouched = self.layout.work / ("candidate-" + "d" * 32)
        untouched.mkdir()
        result = self.perform()
        self.assertTrue(result["servicesRestored"])
        self.assertEqual(self.events, ["idle", "remove", "stop", "stop", "no-processes", "restore"])
        self.assertFalse(self.source.exists())
        self.assertEqual((self.target / "retained.txt").read_text(), "recovery material")
        self.assertTrue(untouched.exists())
        self.assertEqual(read_json(self.prepared), self.proof)
        self.assertEqual(read_json(self.inventory)["phase"], "complete")
        self.manager.verify_release.assert_called_with(self.release)
        if os.name == "posix":
            self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
            self.assertEqual(self.inventory.stat().st_mode & 0o777, 0o600)
        self.events.clear()
        self.assertTrue(self.perform()["alreadyArchived"])
        self.assertEqual(self.events, [])

    def test_missing_or_incomplete_probe_never_stops_services(self):
        for key in archive.PROBES:
            write_json(self.prepared, {name: value for name, value in self.proof.items() if name != key})
            with self.subTest(key=key), self.assertRaisesRegex(DeployError, "incomplete"):
                self.perform()
        self.assertEqual(self.events, [])
        self.assertTrue(self.source.exists())

    def test_failed_release_integrity_or_pending_transaction_never_stops(self):
        self.manager.verify_release.side_effect = DeployError("integrity", "release changed")
        with self.assertRaisesRegex(DeployError, "release changed"):
            self.perform()
        self.manager.verify_release.side_effect = None
        self.lifecycle["phase"] = "selected"
        with self.assertRaisesRegex(DeployError, "pending"):
            self.perform()
        self.assertEqual(self.events, [])

    def test_existing_destination_never_overwritten(self):
        self.root.mkdir(mode=0o700, parents=True)
        self.root.parent.chmod(0o700)
        self.target.mkdir()
        (self.target / "keep").write_text("original")
        with self.assertRaisesRegex(DeployError, "already exists"):
            self.perform()
        self.assertTrue(self.source.exists())
        self.assertEqual((self.target / "keep").read_text(), "original")
        self.assertEqual(self.events, [])

    def test_archive_identity_cannot_escape_fixed_directories(self):
        for value in ("../foreign", "A" * 32, "a" * 31, "a" * 33):
            with self.subTest(value=value), self.assertRaises(DeployError):
                archive.archive_locked(self.manager, value)
        self.assertEqual(self.events, [])

    def test_stop_uncertainty_preserves_source_and_bound_inventory(self):
        self.system.stop.side_effect = DeployError("stop_unknown", "still alive")
        with self.assertRaisesRegex(DeployError, "alive"):
            self.perform()
        self.assertTrue(self.source.exists())
        self.assertFalse(self.target.exists())
        self.assertEqual(read_json(self.inventory)["phase"], "stopped")
        self.assertNotIn("restore", self.events)

    def test_no_instance_process_confirmation_is_required_before_move(self):
        self.system.no_instance_processes.side_effect = DeployError("stop_unknown", "escaped process")
        with self.assertRaisesRegex(DeployError, "escaped"):
            self.perform()
        self.assertTrue(self.source.exists())
        self.assertFalse(self.target.exists())

    def test_rename_failure_can_retry_same_stopped_inventory(self):
        original = os.rename
        with patch.object(archive.os, "rename", side_effect=OSError("rename fixture")), self.assertRaises(OSError):
            self.perform()
        self.assertEqual(read_json(self.inventory)["phase"], "moving")
        self.assertTrue(self.source.exists())
        self.perform()
        self.assertEqual(self.events.count("remove"), 1)
        self.assertFalse(self.source.exists())

    def test_rename_published_before_error_is_resumed_without_second_move(self):
        original = os.rename
        def moved_then_error(source, target):
            original(source, target)
            raise OSError("after rename")
        with patch.object(archive.os, "rename", side_effect=moved_then_error), self.assertRaises(OSError):
            self.perform()
        self.assertTrue(self.target.exists())
        self.assertEqual(read_json(self.inventory)["phase"], "moving")
        rows = archive.list_candidates(self.manager)["candidates"]
        self.assertEqual([(row["id"], row.get("resume")) for row in rows], [(self.candidate, True)])
        with patch.object(archive.os, "rename") as rename:
            self.perform()
        rename.assert_not_called()
        self.assertEqual(self.events.count("remove"), 1)

    def test_restore_failure_retries_restoration_and_keeps_archive(self):
        with patch.object(archive, "restore_services", side_effect=DeployError("health", "restore failed")), self.assertRaises(DeployError):
            self.perform()
        self.assertEqual(read_json(self.inventory)["phase"], "archived")
        self.assertTrue(self.target.exists())
        with patch.object(archive.os, "rename") as rename:
            self.perform()
        rename.assert_not_called()
        self.assertEqual(self.events.count("remove"), 1)

    def test_operator_restore_before_move_requires_new_stopped_window(self):
        with patch.object(archive.os, "rename", side_effect=OSError("blocked")), self.assertRaises(OSError):
            self.perform()
        self.restore(self.manager)
        self.perform()
        self.assertEqual(self.events.count("idle"), 2)
        self.assertEqual(self.events.count("remove"), 2)

    def test_crash_between_removal_and_binding_preserves_recovery_gate(self):
        original = archive.write_json
        def fail_binding(path, value, **kwargs):
            if path == self.inventory and value["phase"] == "stopped":
                raise OSError("save interrupted")
            return original(path, value, **kwargs)
        with patch.object(archive, "write_json", side_effect=fail_binding), self.assertRaises(OSError):
            self.perform()
        with self.assertRaisesRegex(DeployError, "pending"):
            self.perform()
        self.assertTrue(self.source.exists())
        self.restore(self.manager)
        self.perform()

    def test_changed_source_binding_and_changed_lifecycle_rejected(self):
        with patch.object(archive.os, "rename", side_effect=OSError("blocked")), self.assertRaises(OSError):
            self.perform()
        saved = read_json(self.inventory)
        saved["inode"][1] += 1
        write_json(self.inventory, saved)
        with self.assertRaisesRegex(DeployError, "binding changed"):
            self.perform()
        saved["inode"][1] -= 1
        write_json(self.inventory, saved)
        self.lifecycle_id = "e" * 32
        with self.assertRaisesRegex(DeployError, "transaction changed"):
            self.perform()

    def test_list_retains_incomplete_candidates_and_does_not_change_services(self):
        candidate = "d" * 32
        (self.layout.work / ("candidate-" + candidate)).mkdir()
        result = archive.list_candidates(self.manager)
        self.assertEqual(result["count"], 2)
        self.assertEqual([row["eligible"] for row in result["candidates"]], [True, False])
        self.assertEqual(self.events, [])


class CandidateArchiveBoundaryTests(unittest.TestCase):
    def test_cli_requires_explicit_stop_confirmation_before_locking(self):
        args = parser().parse_args(["candidate-archive", "--candidate", "a" * 32])
        self.assertFalse(args.confirm_stop)
        with patch.object(archive, "initialization_lock") as lock, self.assertRaisesRegex(DeployError, "confirm-stop"):
            archive.archive_candidate(Layout("fixture"), "a" * 32, confirm_stop=False)
        lock.assert_not_called()

    def test_acquires_both_locks_in_order_around_entire_operation(self):
        events = []
        @contextmanager
        def lock(name):
            events.append("enter " + name)
            yield
            events.append("exit " + name)
        with patch.object(archive, "require_initialization_complete"), \
             patch.object(archive, "initialization_lock", side_effect=lambda _: lock("initialization")), \
             patch.object(archive, "root_lock", side_effect=lambda _: lock("management")), \
             patch.object(archive, "Manager"), patch.object(archive, "archive_locked", side_effect=lambda *_: events.append("archive")):
            archive.archive_candidate(Layout("fixture"), "a" * 32, confirm_stop=True)
        self.assertEqual(events, ["enter initialization", "enter management", "archive", "exit management", "exit initialization"])

    def test_mounted_descendant_and_remaining_images_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "candidate with space"
            path.mkdir()
            mounted = str(path / "fetch").replace(" ", "\\040")
            with patch.object(Path, "read_text", return_value=f"1 2 3:4 / {mounted} rw - ext4 fixture rw\n"), self.assertRaisesRegex(DeployError, "mounted"):
                archive.unmounted(path)
            (path / "fetch.ext4").write_bytes(b"retained")
            with patch.object(Path, "read_text", return_value=""), self.assertRaisesRegex(DeployError, "image"):
                archive.unmounted(path)

    def test_unknown_and_active_worker_are_not_treated_as_idle(self):
        manager = types.SimpleNamespace(layout=Layout("fixture"), system=Mock())
        manager.system.state.return_value = {"stopped": False, "ActiveState": "active", "SubState": "running"}
        activity = {"activeThreads": [], "pendingStarts": 0, "terminals": 0, "subscriptions": 0, "processes": 0, "unknown": False}
        for changed in ({"unknown": True}, {"terminals": 1}, {"activeThreads": ["running"]}, {"pendingStarts": False}):
            connection = Mock()
            response = connection.getresponse.return_value
            response.status = 200
            response.read.return_value = json.dumps({"result": {"connected": True, "activity": {**activity, **changed}}}).encode()
            with self.subTest(changed=changed), patch.object(archive.http.client, "HTTPConnection", return_value=connection), \
                 patch.object(archive.socket, "socket"), self.assertRaises(DeployError):
                archive.require_idle(manager)


if __name__ == "__main__":
    unittest.main()
