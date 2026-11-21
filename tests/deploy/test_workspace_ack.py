"""Supervisor acknowledgements reclaim only confirmed, payload-free receipts."""
import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError
from deploy.workspace import Workspace, WRITES, validate
from deploy.workspace_paths import Root


class AcknowledgementValidationTests(unittest.TestCase):
    def test_fixed_internal_shape_rejects_digest_overrides_and_mutation_identity(self):
        request = {"version": 1, "root": "/project", "action": "operation/ack", "params": {"operationId": str(uuid.uuid4()), "requestDigest": "a" * 64}}
        validate(request)
        for change in ({"params": {**request["params"], "requestDigest": "bad"}},
                       {"params": {**request["params"], "result": {}}},
                       {"operationId": str(uuid.uuid4())}, {"binding": {}}):
            with self.assertRaises(DeployError): validate({**request, **change})


@unittest.skipUnless(sys.platform == "linux", "Requires Linux descriptor paths and renameat2")
class AcknowledgementFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="workspace-ack-")
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
        if action in WRITES: request["operationId"] = operation or str(uuid.uuid4())
        return self.workspace.dispatch(validate(request))["result"]

    def ack(self, identity):
        saved = self.call("operation/read", {"operationId": identity})
        return self.call("operation/ack", {"operationId": identity, "requestDigest": saved["requestDigest"]})

    def test_immediate_retained_and_legacy_workspace_failure_share_chinese_code_and_delivery(self):
        from deploy.workspace import failure
        (self.path / "already-there").mkdir()
        op = str(uuid.uuid4())
        with self.assertRaises(DeployError) as caught:
            self.call("mkdir", {"path": "already-there"}, op)
        instant = failure(caught.exception, dispatched=True)["error"]
        self.assertEqual(instant["code"], "already_exists")
        self.assertEqual(instant["delivery"], "not_sent")
        self.assertIn("目标已存在", instant["message"])
        retained = self.call("operation/read", {"operationId": op})
        self.assertEqual(retained["response"]["error"], instant)
        self.assertEqual(retained["diagnostic"]["type"], "FileExistsError")
        file = self.records / op / "state.json"
        older = json.loads(file.read_text())
        older["response"]["error"]["message"] = "Workspace operation failed; inspect recovery record"
        raw = json.dumps(older).encode()
        file.write_bytes(raw)
        self.assertEqual(self.call("operation/read", {"operationId": op})["response"]["error"], instant)
        self.assertEqual(self.workspace.dispatch(validate({"version": 1, "action": "mkdir", "root": str(self.path),
            "params": {"path": "already-there"}, "operationId": op}))["error"], instant)
        self.assertEqual(file.read_bytes(), raw)
        self.assertTrue((self.path / "already-there").is_dir())

    def test_many_accepted_payload_free_operations_do_not_exhaust_lifetime_budget(self):
        with patch("deploy.workspace_store.MAX_RECORDS", 2):
            for index in range(8):
                identity = str(uuid.uuid4())
                self.call("mkdir", {"path": str(index)}, identity)
                saved = self.call("operation/read", {"operationId": identity})
                self.assertTrue(self.ack(identity)["removed"])
                self.assertEqual(self.call("operation/ack", {"operationId": identity, "requestDigest": saved["requestDigest"]}),
                                 {"acknowledged": True, "operationId": identity, "removed": True})
                self.assertEqual(self.call("operation/read", {"operationId": identity})["state"], "not_received")

    def test_ack_after_interrupted_publication_archives_raw_evidence_and_releases_capacity(self):
        from hashlib import sha256
        with patch("deploy.workspace_store.MAX_RECORDS", 1):
            identity = str(uuid.uuid4())
            self.call("mkdir", {"path": "a"}, identity)
            pending = self.records / identity / ".state-next"
            pending.write_bytes(b"{")
            pending.chmod(0o600)
            self.assertEqual(self.call("recovery/read", {"operationId": identity})["resolution"], "retained")
            self.assertTrue(self.ack(identity)["removed"])
            self.assertEqual((self.records / "unpublished" / (identity + "-" + sha256(b"{").hexdigest())).read_bytes(), b"{")
            self.assertFalse((self.records / identity).exists())
            self.call("mkdir", {"path": "b"})

    def test_completed_receipt_can_publish_interrupted_ack_without_changing_result(self):
        identity = str(uuid.uuid4())
        self.call("mkdir", {"path": "a"}, identity)
        holder = self.records / identity
        old = json.loads((holder / "state.json").read_text())
        candidate = {**old, "acknowledged": True}
        pending = holder / ".state-next"
        pending.write_text(json.dumps(candidate))
        pending.chmod(0o600)
        self.assertEqual(self.call("recovery/read", {"operationId": identity})["resolution"], "published")
        self.assertEqual(json.loads((holder / "state.json").read_text()), candidate)
        self.assertTrue(self.ack(identity)["removed"])

    def test_mismatched_and_unknown_receipts_cannot_be_acknowledged(self):
        identity = str(uuid.uuid4())
        self.call("mkdir", {"path": "directory"}, identity)
        with self.assertRaises(DeployError):
            self.call("operation/ack", {"operationId": identity, "requestDigest": "0" * 64})
        path = self.records / identity / "state.json"
        saved = json.loads(path.read_text())
        path.write_text(json.dumps({**saved, "state": "failed"}))
        with self.assertRaises(DeployError): self.ack(identity)
        self.assertTrue(path.is_file())

    def test_retained_payload_survives_ack_and_full_budget_allows_one_discard(self):
        with patch("deploy.workspace_store.MAX_RECORDS", 2):
            first = self.call("write", {"path": "a", "text": "old", "expectedRevision": None})
            edited = self.call("write", {"path": "a", "text": "new", "expectedRevision": first["revision"]})
            identity = edited["recoveryOperationId"]
            self.assertFalse(self.ack(identity)["removed"])
            with self.assertRaises(DeployError): self.call("mkdir", {"path": "blocked"})
            inspected = self.call("recovery/read", {"operationId": identity})
            discarded = str(uuid.uuid4())
            self.call("recovery/discard", {"recoveryOperationId": identity, "expectedManifest": inspected["manifest"], "confirm": True}, discarded)
            self.assertTrue(self.ack(discarded)["removed"])
            self.call("mkdir", {"path": "capacity-restored"})
            self.assertFalse((self.records / identity).exists())

    def test_failed_discard_consumes_the_single_reserved_slot(self):
        with patch("deploy.workspace_store.MAX_RECORDS", 2):
            first = self.call("write", {"path": "a", "text": "old", "expectedRevision": None})
            edited = self.call("write", {"path": "a", "text": "new", "expectedRevision": first["revision"]})
            params = {"recoveryOperationId": edited["recoveryOperationId"], "expectedManifest": "0" * 64, "confirm": True}
            with self.assertRaises(DeployError): self.call("recovery/discard", params)
            inspected = self.call("recovery/read", {"operationId": edited["recoveryOperationId"]})
            with self.assertRaises(DeployError) as caught:
                self.call("recovery/discard", {**params, "expectedManifest": inspected["manifest"]})
            self.assertEqual(caught.exception.code, "budget")
            self.assertEqual((self.records / edited["recoveryOperationId"] / "before").read_text(), "old")

    def test_external_index_recovery_preserves_receipt_until_explicit_discard(self):
        identity = str(uuid.uuid4())
        self.call("mkdir", {"path": "directory"}, identity)
        index = self.native / "git-index-state"
        index.mkdir(mode=0o700)
        project = index / self.workspace.store.project
        project.mkdir(mode=0o700)
        backup = project / identity
        backup.mkdir(mode=0o700)
        (backup / "state.json").write_text("{}")
        self.assertFalse(self.ack(identity)["removed"])
        self.assertEqual(self.call("operation/read", {"operationId": identity})["state"], "completed")
        (backup / "state.json").unlink(); backup.rmdir()
        self.assertTrue(self.ack(identity)["removed"])

    def test_ack_retries_empty_directory_left_after_metadata_unlink(self):
        identity = str(uuid.uuid4())
        self.call("mkdir", {"path": "directory"}, identity)
        saved = self.call("operation/read", {"operationId": identity})
        (self.records / identity / "state.json").unlink()
        self.assertTrue(self.call("operation/ack", {"operationId": identity, "requestDigest": saved["requestDigest"]})["removed"])
        self.assertFalse((self.records / identity).exists())
