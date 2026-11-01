"""Real local files/locks; synthetic history only, no native or provider network."""
import hashlib
import gzip
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from deploy import thread_history as history

THREAD = "00000000-0000-4000-8000-000000000001"


def line(kind, payload):
    return (json.dumps({"timestamp": "2026-11-01T00:00:00Z", "type": kind, "payload": payload}, ensure_ascii=False) + "\n").encode()


class ThreadHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.uid = os.geteuid() if os.name == "posix" else 0
        (self.home / "sessions").mkdir(mode=0o700)
        self.path = self.home / "sessions" / ("rollout-" + THREAD + ".jsonl")
        self.header = line("session_meta", {"id": THREAD, "history_mode": "paginated"})
        self.user = line("response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "synthetic 用户 text"}]})
        self.plain = {"type": "reasoning", "summary": [], "content": [{"type": "reasoning_text", "text": "synthetic thought"}], "encrypted_content": None}
        self.encrypted = {"type": "reasoning", "summary": [], "encrypted_content": "synthetic-opaque"}

    def save(self, *records):
        self.path.write_bytes(self.header + b"".join(records)); self.path.chmod(0o600)
        return self.path.read_bytes()

    def request(self, action="inspect", mode="foreign", **extra):
        return {"action": action, "threadId": THREAD, "path": str(self.path), "mode": mode, **extra}

    def inspect(self, mode="foreign"):
        return history.operate(self.home, self.uid, self.request(mode=mode))

    def repair(self, proof, mode="foreign"):
        return history.operate(self.home, self.uid, self.request("repair", mode, expected=proof["expected"]))

    def test_foreign_keeps_every_offset_ordinal_and_nonreasoning_record_with_exact_private_backup(self):
        compacted = line("compacted", {"message": "synthetic compacted", "replacement_history": [self.plain, {"type": "function_call_output", "call_id": "fixture", "output": "synthetic tool result"}, self.encrypted],
                                      "replacement_history_metadata": [{"fixture": 0}, {"fixture": 1}, {"fixture": 2}]})
        raw = self.save(self.user, line("response_item", self.plain), line("response_item", self.encrypted), compacted,
                        line("event_msg", {"type": "agent_reasoning", "text": "synthetic display-only thought"}))
        proof = self.inspect(); self.assertEqual(proof["changedItems"], 4)
        self.assertFalse((self.home / "thread-writer-locks").exists())
        result = self.repair(proof); repaired = self.path.read_bytes()
        self.assertTrue(result["repaired"]); self.assertFalse(result["needsRepair"])
        before, after = raw.splitlines(keepends=True), repaired.splitlines(keepends=True)
        self.assertEqual([len(x) for x in before], [len(x) for x in after])
        self.assertEqual([before[i] for i in [0, 1, 5]], [after[i] for i in [0, 1, 5]])
        self.assertEqual(json.loads(after[2])["payload"], {"type": "other"})
        replacements = json.loads(after[4])["payload"]["replacement_history"]
        self.assertEqual(len(replacements), 1)
        self.assertEqual(replacements[0]["output"], "synthetic tool result")
        self.assertEqual(json.loads(after[4])["payload"]["replacement_history_metadata"], [{"fixture": 1}])
        backups = list((self.home / "harness-history-backups").glob("*.jsonl.gz"))
        self.assertEqual(len(backups), 1); self.assertEqual(gzip.decompress(backups[0].read_bytes()), raw)
        if os.name == "posix": self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
        self.assertFalse(self.inspect()["needsRepair"])

    def test_plaintext_preserves_opaque_reasoning_and_only_removes_nonempty_content(self):
        raw = self.save(line("response_item", self.plain), line("response_item", self.encrypted),
                        line("response_item", {**self.encrypted, "content": []}))
        self.assertEqual(self.inspect("plaintext")["changedItems"], 1)
        self.repair(self.inspect("plaintext"), "plaintext")
        self.assertEqual(self.path.read_bytes().splitlines(keepends=True)[2:], raw.splitlines(keepends=True)[2:])

    def test_inherited_prefix_is_explicit_and_never_mistaken_for_a_clean_complete_history(self):
        self.header = line("session_meta", {"id": THREAD, "history_mode": "paginated",
                                            "history_base": {"thread_id": "00000000-0000-4000-8000-000000000002", "end_byte_offset": 600, "end_ordinal_exclusive": 5}})
        original = self.save(self.user)
        proof = self.inspect()
        self.assertTrue(proof["hasHistoryBase"]); self.assertFalse(proof["needsRepair"])
        with self.assertRaises(history.HistoryError) as error: self.repair(proof)
        self.assertEqual(error.exception.code, "thread_history_inherited")
        self.assertEqual(self.path.read_bytes(), original)
        self.assertFalse((self.home / "harness-history-backups").exists())

    def test_opaque_compaction_is_reported_and_foreign_repair_refused_without_changes(self):
        for record in [line("response_item", {"type": "compaction", "encrypted_content": "synthetic-opaque"}),
                       line("compacted", {"replacement_history": [{"type": "context_compaction", "encrypted_content": "synthetic-opaque"}]})]:
            original = self.save(record)
            proof = self.inspect(); self.assertTrue(proof["hasOpaqueCompaction"])
            with self.assertRaises(history.HistoryError) as error: self.repair(proof)
            self.assertEqual(error.exception.code, "thread_history_opaque")
            self.assertEqual(self.path.read_bytes(), original)
            self.assertFalse((self.home / "harness-history-backups").exists())

    def test_compacted_mismatched_parallel_metadata_refuses_before_changes(self):
        original = self.save(line("compacted", {"replacement_history": [self.plain], "replacement_history_metadata": []}))
        with self.assertRaisesRegex(history.HistoryError, "metadata"): self.inspect()
        self.assertEqual(self.path.read_bytes(), original)

    def test_plain_fork_checks_only_frozen_prefix_and_does_not_change_parent(self):
        parent_id = "00000000-0000-4000-8000-000000000002"
        parent = self.path.with_name("rollout-" + parent_id + ".jsonl")
        prefix = line("session_meta", {"id": parent_id, "history_mode": "paginated"}) + self.user
        tail = line("response_item", self.plain)
        parent.write_bytes(prefix + tail); parent.chmod(0o600)
        for cutoff, found in [(len(prefix), False), (len(prefix + tail), True)]:
            self.header = line("session_meta", {"id": THREAD, "history_mode": "paginated", "history_base": {
                "thread_id": parent_id, "end_byte_offset": cutoff, "end_ordinal_exclusive": 3}})
            original = self.save(self.user)
            result = self.inspect("plaintext")
            self.assertEqual(result["hasInheritedPlaintext"], found); self.assertFalse(result["inspectionUnsupported"])
            self.assertEqual(self.path.read_bytes(), original); self.assertEqual(parent.read_bytes(), prefix + tail)
        parent.rename(parent.with_suffix(".jsonl.zst"))
        result = self.inspect("plaintext")
        self.assertTrue(result["inspectionUnsupported"]); self.assertFalse(result["hasInheritedPlaintext"])

    def test_compressed_primary_reports_unknown_inspection_and_never_repairs_it(self):
        compressed = self.path.with_suffix(".jsonl.zst")
        compressed.write_bytes(b"synthetic compressed opaque fixture"); compressed.chmod(0o600)
        for requested in [self.path, compressed]:
            result = history.operate(self.home, self.uid, {**self.request(mode="plaintext"), "path": str(requested)})
            self.assertTrue(result["inspectionUnsupported"])
            with self.assertRaises(history.HistoryError):
                history.operate(self.home, self.uid, {**self.request("repair", "plaintext"), "path": str(requested), "expected": result["expected"]})
        self.assertFalse((self.home / "harness-history-backups").exists())

    def test_stale_hash_and_same_bytes_replaced_inode_are_rejected_without_backup(self):
        raw = self.save(line("response_item", self.plain)); proof = self.inspect()
        self.path.write_bytes(raw + self.user)
        with self.assertRaisesRegex(history.HistoryError, "changed"): self.repair(proof)
        self.path.write_bytes(raw); proof = self.inspect()
        new = self.path.with_suffix(".tmp"); new.write_bytes(raw); new.chmod(0o600); os.replace(new, self.path)
        with self.assertRaisesRegex(history.HistoryError, "changed"): self.repair(proof)
        self.assertFalse((self.home / "harness-history-backups").exists())

    def test_competing_writer_and_coordinator_locks_refuse_before_any_history_write(self):
        raw = self.save(line("response_item", self.plain)); proof = self.inspect()
        directory = self.home / "thread-writer-locks"; directory.mkdir(mode=0o700)
        for name in [THREAD + ".lock", ".coordination.lock"]:
            with self.subTest(name=name):
                lock_path = directory / name
                code = "import os,sys;from deploy.thread_history import _lock;f=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600);\nwith _lock(f):\n print('locked',flush=True)\n sys.stdin.readline()\nos.close(f)"
                process = subprocess.Popen([sys.executable, "-B", "-c", code, str(lock_path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    self.assertEqual(process.stdout.readline().rstrip(b"\r\n"), b"locked")
                    with self.assertRaises(history.HistoryError) as error: self.repair(proof)
                    self.assertEqual(error.exception.code, "thread_history_busy")
                    self.assertEqual(self.path.read_bytes(), raw)
                    self.assertFalse((self.home / "harness-history-backups").exists())
                finally:
                    process.communicate(b"done\n", timeout=5)
                lock_path.unlink()

    def test_backup_deduplication_and_budget_never_discard_originals(self):
        raw = self.save(line("response_item", self.plain)); self.repair(self.inspect())
        self.path.write_bytes(raw); self.repair(self.inspect())
        self.assertEqual(len(list((self.home / "harness-history-backups").iterdir())), 1)
        altered = raw + self.user; self.path.write_bytes(altered)
        with patch.object(history, "BACKUP_LIMIT", 1):
            with self.assertRaises(history.HistoryError) as error: self.repair(self.inspect())
        self.assertEqual(error.exception.code, "thread_history_backup_limit")
        self.assertEqual(self.path.read_bytes(), altered)

    def test_unknown_after_replace_preserves_backup_and_new_file_without_partial_temp(self):
        raw = self.save(line("response_item", self.plain)); proof = self.inspect()
        original = history.fsync_directory
        def fail_after_replace(path, **kwargs):
            if path == self.path.parent: raise OSError("synthetic fsync failure")
            return original(path, **kwargs)
        with patch.object(history, "fsync_directory", side_effect=fail_after_replace):
            with self.assertRaises(history.HistoryError) as error: self.repair(proof)
        self.assertEqual(error.exception.delivery, "unknown")
        self.assertNotEqual(self.path.read_bytes(), raw)
        self.assertEqual(gzip.decompress(next((self.home / "harness-history-backups").glob("*.jsonl.gz")).read_bytes()), raw)
        self.assertFalse(list(self.path.parent.glob(".harness-history-*")))

    def test_wrong_identity_malformed_records_and_oversize_leave_original_untouched(self):
        raw = self.save(line("response_item", self.plain))
        for contents in [raw[:-1], raw.replace(THREAD.encode(), b"00000000-0000-4000-8000-000000000002", 1),
                         self.header + b'{"type":"response_item","payload":{"type":"reasoning","type":"message"}}\n']:
            self.path.write_bytes(contents)
            with self.assertRaises(history.HistoryError): self.inspect()
            self.assertEqual(self.path.read_bytes(), contents)
        self.path.write_bytes(raw)
        with patch.object(history, "ROLLOUT_LIMIT", len(raw) - 1):
            with self.assertRaises(history.HistoryError) as error: self.inspect()
        self.assertEqual(error.exception.code, "thread_history_limit")
        self.assertFalse((self.home / "harness-history-backups").exists())

    def test_outside_path_and_hardlinks_are_rejected(self):
        self.save(self.user)
        outside = self.home / "outside.jsonl"; outside.write_bytes(self.path.read_bytes())
        with self.assertRaises(history.HistoryError): history.operate(self.home, self.uid, self.request(path=str(outside)))
        linked = self.path.with_name("hardlink.jsonl"); os.link(self.path, linked)
        try:
            with self.assertRaises(history.HistoryError): self.inspect()
        finally: linked.unlink()

    def test_symlink_history_is_rejected(self):
        self.save(self.user)
        linked = self.path.with_name("symlink.jsonl")
        try: linked.symlink_to(self.path)
        except OSError as error: self.skipTest("Symlink creation unavailable: " + type(error).__name__)
        with self.assertRaises(history.HistoryError): history.operate(self.home, self.uid, self.request(path=str(linked)))

    def test_module_entrypoint_uses_same_implementation_and_returns_metadata_only(self):
        raw = self.save(line("response_item", self.plain))
        result = subprocess.run([sys.executable, "-B", "-m", "deploy.thread_history", "--home", str(self.home)],
                                input=json.dumps(self.request()).encode(), capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        body = json.loads(result.stdout)
        self.assertEqual(body["expected"]["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertNotIn(b"synthetic thought", result.stdout)

    @unittest.skipUnless(os.name == "nt", "Windows native rollout path prefix")
    def test_extended_drive_path_is_same_file_but_device_namespaces_are_rejected(self):
        self.save(line("response_item", self.plain))
        prefixed = "\\\\?\\" + str(self.path)
        proof = history.operate(self.home, self.uid, self.request(path=prefixed))
        self.assertEqual(proof["expected"], self.inspect()["expected"])
        repaired = history.operate(self.home, self.uid, self.request("repair", path=prefixed, expected=proof["expected"]))
        self.assertTrue(repaired["repaired"])
        for invalid in ["\\\\.\\C:\\sessions\\rollout.jsonl", "\\\\?\\UNC\\server\\share\\sessions\\rollout.jsonl"]:
            with self.assertRaises(history.HistoryError): history.operate(self.home, self.uid, self.request(path=invalid))


if __name__ == "__main__":
    unittest.main()
