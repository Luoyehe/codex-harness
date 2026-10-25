"""Recovery validates explicit source/destination versions and never replays unknown writes."""
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError
from deploy.workspace import Workspace, WRITES, validate
from deploy.workspace_paths import Root, rename_absent


class RecoveryValidationTests(unittest.TestCase):
    def request(self, action, params):
        return {"version": 1, "root": "/registered/project", "action": action, "params": params,
                **({"operationId": str(uuid.uuid4())} if action in WRITES else {})}

    def test_restore_requires_explicit_target_source_slot_and_both_revisions(self):
        valid = {"recoveryOperationId": str(uuid.uuid4()), "slot": "before", "path": "file", "sourceRevision": "a" * 64, "expectedRevision": None}
        validate(self.request("recovery/restore", valid))
        for changed in ({"slot": "state.json"}, {"path": "../escape"}, {"sourceRevision": "bad"}, {"recoveryOperationId": "bad"}, {"expectedRevision": False}):
            with self.subTest(changed=changed), self.assertRaises(DeployError):
                validate(self.request("recovery/restore", {**valid, **changed}))
        del valid["expectedRevision"]
        with self.assertRaises(DeployError):
            validate(self.request("recovery/restore", valid))

    def test_discard_requires_current_manifest_confirmation_and_no_path(self):
        valid = {"recoveryOperationId": str(uuid.uuid4()), "expectedManifest": "a" * 64, "confirm": True}
        validate(self.request("recovery/discard", valid))
        for changed in ({"confirm": False}, {"expectedManifest": "bad"}, {"path": "outside"}):
            with self.subTest(changed=changed), self.assertRaises(DeployError):
                validate(self.request("recovery/discard", {**valid, **changed}))
        with self.assertRaises(DeployError):
            validate(self.request("recovery/read", {"operationId": "bad"}))


@unittest.skipUnless(os.name == "posix", "Requires real Linux descriptor paths and renameat2")
class RecoveryFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="workspace-recovery-")
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name).resolve()
        self.path, self.native = base / "project", base / "native"
        self.path.mkdir(); self.native.mkdir()
        self.root = Root(str(self.path), [])
        self.addCleanup(self.root.close)
        self.workspace = Workspace(self.root, [], self.native / "workspace-state")
        self.records = self.workspace.store.storage / self.workspace.store.project

    def call(self, action, params, operation=None):
        request = {"version": 1, "root": str(self.path), "action": action, "params": params}
        if action in WRITES:
            request["operationId"] = operation or str(uuid.uuid4())
        return self.workspace.dispatch(validate(request))["result"]

    def edited(self):
        first = self.call("write", {"path": "a", "text": "old", "expectedRevision": None})
        changed = self.call("write", {"path": "a", "text": "new", "expectedRevision": first["revision"]})
        return changed, self.call("recovery/read", {"operationId": changed["recoveryOperationId"]})

    def test_restore_preserves_source_backup_captures_current_target_and_replays_once(self):
        current, source = self.edited()
        operation = str(uuid.uuid4())
        params = {"recoveryOperationId": source["operationId"], "slot": "before", "path": "a",
                  "sourceRevision": source["entries"][0]["revision"], "expectedRevision": current["revision"]}
        restored = self.call("recovery/restore", params, operation)
        self.assertEqual(restored["restoredFromOperationId"], source["operationId"])
        self.assertEqual((self.path / "a").read_text(), "old")
        self.assertEqual((self.records / source["operationId"] / "before").read_text(), "old")
        self.assertEqual((self.records / operation / "before").read_text(), "new")
        self.assertEqual(self.call("recovery/restore", params, operation), restored)
        self.assertEqual(self.call("read", {"path": "a"})["revision"], restored["revision"])

    def test_removed_file_and_empty_directory_restore_to_explicit_absent_destinations(self):
        (self.path / "binary").write_bytes(b"\0\xff")
        for name in ("binary", "folder"):
            if name == "folder":
                self.call("mkdir", {"path": name})
            target = self.call("metadata", {"path": name})
            removed = self.call("remove", {"path": name, "expectedRevision": target["revision"], "confirm": True, "recursive": False})
            source = self.call("recovery/read", {"operationId": removed["recoveryOperationId"]})
            self.call("recovery/restore", {"recoveryOperationId": source["operationId"], "slot": "before", "path": name,
                                          "sourceRevision": source["entries"][0]["revision"], "expectedRevision": None})
            self.assertTrue((self.path / name).exists())
        self.assertEqual((self.path / "binary").read_bytes(), b"\0\xff")
        self.assertEqual(list((self.path / "folder").iterdir()), [])

    def test_stale_source_destination_and_injected_record_path_never_redirect_restore(self):
        current, source = self.edited()
        state_path = self.records / source["operationId"] / "state.json"
        state = json.loads(state_path.read_bytes()); state["path"] = "../../outside"
        state_path.write_text(json.dumps(state))
        params = {"recoveryOperationId": source["operationId"], "slot": "before", "path": "a",
                  "sourceRevision": source["entries"][0]["revision"], "expectedRevision": current["revision"]}
        for changed in ({"sourceRevision": "0" * 64}, {"expectedRevision": "0" * 64}, {"expectedRevision": None}):
            with self.subTest(changed=changed), self.assertRaises(DeployError):
                self.call("recovery/restore", {**params, **changed})
            self.assertEqual((self.path / "a").read_text(), "new")
        self.call("recovery/restore", {**params, "path": "restored", "expectedRevision": None})
        self.assertEqual((self.path / "restored").read_text(), "old")
        self.assertFalse((self.path.parent / "outside").exists())

    def test_publish_collision_retains_target_backup_source_and_new_content(self):
        current, source = self.edited()
        operation = str(uuid.uuid4())
        def race(source_fd, source_name, target_fd, target):
            if source_name == "next":
                (self.path / "a").write_text("concurrent")
            rename_absent(source_fd, source_name, target_fd, target)
        with patch("deploy.workspace_recovery.rename_absent", side_effect=race), self.assertRaises(DeployError):
            self.call("recovery/restore", {"recoveryOperationId": source["operationId"], "slot": "before", "path": "a",
                                          "sourceRevision": source["entries"][0]["revision"], "expectedRevision": current["revision"]}, operation)
        self.assertEqual((self.path / "a").read_text(), "concurrent")
        self.assertEqual((self.records / operation / "before").read_text(), "new")
        self.assertEqual((self.records / operation / "next").read_text(), "old")
        self.assertEqual((self.records / source["operationId"] / "before").read_text(), "old")

    def test_discard_releases_payload_and_retains_receipt_replay_even_under_byte_pressure(self):
        current, source = self.edited()
        original = self.call("operation/read", {"operationId": source["operationId"]})
        params = {"recoveryOperationId": source["operationId"], "expectedManifest": source["manifest"], "confirm": True}
        operation = str(uuid.uuid4())
        with patch("deploy.workspace_store.MAX_BYTES", 32768):
            result = self.call("recovery/discard", params, operation)
        self.assertTrue(result["receiptRetained"])
        self.assertFalse((self.records / source["operationId"] / "before").exists())
        retained = self.call("operation/read", {"operationId": source["operationId"]})
        self.assertEqual(retained["response"], original["response"])
        self.assertTrue(retained["recoveryDiscarded"])
        self.assertEqual(self.call("recovery/discard", params, operation), result)
        self.assertEqual((self.path / "a").read_text(), "new")

    def test_discard_refuses_stale_manifest_and_unknown_or_failed_receipts(self):
        _, source = self.edited()
        params = {"recoveryOperationId": source["operationId"], "expectedManifest": "0" * 64, "confirm": True}
        with self.assertRaises(DeployError):
            self.call("recovery/discard", params)
        state_path = self.records / source["operationId"] / "state.json"
        saved = json.loads(state_path.read_bytes())
        for state in ("running", "failed"):
            state_path.write_text(json.dumps({**saved, "state": state}))
            inspected = self.call("recovery/read", {"operationId": source["operationId"]})
            with self.assertRaises(DeployError) as caught:
                self.call("recovery/discard", {**params, "expectedManifest": inspected["manifest"]})
            self.assertEqual(caught.exception.code, "recovery_required")
            self.assertEqual((self.records / source["operationId"] / "before").read_text(), "old")

    def test_discard_capture_race_keeps_every_payload_and_reports_unknown(self):
        _, source = self.edited()
        source_dir = self.records / source["operationId"]
        (source_dir / "next").write_text("another retained version")
        source = self.call("recovery/read", {"operationId": source["operationId"]})
        operation = str(uuid.uuid4())
        def race(source_fd, source_name, target_fd, target):
            if source_name == "before":
                (source_dir / "before").write_text("concurrent backup edit")
            rename_absent(source_fd, source_name, target_fd, target)
        with patch("deploy.workspace_recovery.rename_absent", side_effect=race), self.assertRaises(DeployError):
            self.call("recovery/discard", {"recoveryOperationId": source["operationId"], "expectedManifest": source["manifest"], "confirm": True}, operation)
        self.assertEqual((self.records / operation / "before").read_text(), "concurrent backup edit")
        self.assertEqual((source_dir / "next").read_text(), "another retained version")
        self.assertEqual(self.call("operation/read", {"operationId": operation})["state"], "failed")

    def test_recovery_inventory_is_bounded_and_cross_project_sources_are_absent(self):
        self.assertEqual(self.call("recovery/list", {})["records"], [])
        _, source = self.edited()
        self.assertEqual(len(self.call("recovery/list", {})["records"]), 2)
        another = self.path.parent / "another"; another.mkdir()
        root = Root(str(another), [])
        try:
            other = Workspace(root, [], self.native / "workspace-state")
            with self.assertRaises(FileNotFoundError):
                other.read("recovery/read", {"operationId": source["operationId"]})
        finally:
            root.close()


if __name__ == "__main__":
    unittest.main()
