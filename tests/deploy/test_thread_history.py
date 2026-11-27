"""Real local files/locks; synthetic history only, no native or provider network."""
import hashlib
import base64
from contextlib import closing
import gzip
import json
import os
import random
import struct
import zlib
from pathlib import Path
import sqlite3
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

    def test_bounded_ancestor_index_reports_capacity_without_claiming_complete_inspection(self):
        self.header = line("session_meta", {"id": THREAD, "history_mode": "paginated", "history_base": {
            "thread_id": "00000000-0000-4000-8000-000000000002", "end_byte_offset": 1, "end_ordinal_exclusive": 1}})
        self.save(self.user)
        for name in ("first-marker", "second-marker"): (self.home / "sessions" / name).touch()
        with patch.object(history, "LOOKUP_ENTRY_LIMIT", 2):
            result = self.inspect("plaintext")
            self.assertTrue(result["inspectionUnsupported"])
            self.assertEqual(result["inspectionIssue"]["code"], "thread_history_limit")
            self.assertIn("traversal budget", result["inspectionIssue"]["message"])
            with self.assertRaises(history.HistoryError) as caught: history._rollout_index(self.home, self.uid)
            self.assertEqual(caught.exception.code, "thread_history_limit")

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


    def test_attachment_scan_inherits_only_frozen_prefix_and_compacted_references(self):
        attachment_root = self.home / "managed-attachments"
        first = str(attachment_root / "11111111-1111-4111-8111-111111111111")
        later = str(attachment_root / "22222222-2222-4222-8222-222222222222.wav")
        prefix = self.header + line("response_item", {"type": "message", "role": "user", "content": [{"type": "localImage", "path": first}]})
        self.path.write_bytes(prefix + line("response_item", {"type": "message", "role": "user", "content": [{"type": "localAudio", "path": later}]})); self.path.chmod(0o600)
        target_id = "00000000-0000-4000-8000-000000000002"
        target = self.home / "sessions" / ("rollout-" + target_id + ".jsonl")
        target.write_bytes(line("session_meta", {"id": target_id, "history_mode": "paginated", "history_base": {"thread_id": THREAD, "end_byte_offset": len(prefix), "end_ordinal_exclusive": 2}}))
        target.chmod(0o600)
        request = {"action": "attachment-inspect", "threadId": target_id, "path": str(target), "mode": "plaintext", "attachmentRoot": str(attachment_root)}
        self.assertEqual(history.operate(self.home, self.uid, request)["paths"], [first])
        target.write_bytes(target.read_bytes() + line("compacted", {"replacement_history": [{"type": "message", "role": "user", "content": [{"type": "localAudio", "path": later}]}]}))
        self.assertEqual(history.operate(self.home, self.uid, request)["paths"], sorted([first, later]))

    def test_guided_vision_reference_and_older_bare_reference_both_retain_their_original_files(self):
        root = self.home / "attachments"
        old = str(root / "11111111-1111-4111-8111-111111111111")
        current = str(root / "22222222-2222-4222-8222-222222222222.png")
        from_code = Path("src/core/attachment-media.ts").read_text()
        tip = "Decide whether an available and authorized vision tool can read this file. If the image was not read successfully, say so. Answer any independent text request normally."
        self.assertIn(tip, from_code)
        self.save(line("response_item", {"type": "message", "content": [
            {"type": "input_text", "text": 'Attached file "legacy.png" is available at ' + json.dumps(old) + '.'},
            {"type": "input_text", "text": 'Attached file "new.png" is available at ' + json.dumps(current) + '.\n' + tip},
        ]}))
        result = history.operate(self.home, self.uid, {"action": "attachment-index", "attachmentRoot": str(root)})
        self.assertEqual(result["references"], [{"threadId": THREAD, "paths": sorted([old, current])}])

    def test_historical_media_suffixes_are_retained_only_under_the_attachment_root(self):
        root = self.home / "attachments"
        base = "11111111-1111-4111-8111-111111111111"
        valid = [str(root / (base + "." + suffix)) for suffix in ("jpeg", "m4v", "avi", "wmv")]
        others = [str(root / (base + ".exe")), str(self.home / (base + ".jpeg"))]
        self.save(line("response_item", {"type": "message", "content": [
            {"type": "input_text", "text": 'Attached file "media" is available at ' + json.dumps(name) + '.'}
            for name in valid + others]}))
        # Previously completed scans omitted these paths. Upgrading must rescan the prefix.
        before = self.path.stat()
        witness = ["inline-refs-v4", None, str(self.path), THREAD, str(root), *history._identity(before),
                   before.st_ctime_ns, before.st_size]
        key = hashlib.sha256(json.dumps(witness).encode()).hexdigest()
        with history._scan_checkpoints(self.home, self.uid) as db:
            db.execute("INSERT INTO checkpoints VALUES(?,?,?,?,?)", (key, before.st_size, 2, '{"paths":[]}', 0))
            db.commit()
        with patch.object(history, "ATTACHMENT_CHECKPOINT_BYTES", 1):
            result = history.operate(self.home, self.uid, {"action": "attachment-index", "attachmentRoot": str(root)})
        self.assertEqual(result["references"], [{"threadId": THREAD, "paths": sorted(valid)}])

    def test_attachment_inventory_keeps_uninspectable_history_distinct_from_confirmed_absence(self):
        attachment_root = self.home / "attachments"
        attachment = str(attachment_root / "11111111-1111-4111-8111-111111111111")
        self.save(line("response_item", {"type": "message", "content": [{"type": "input_text", "text": 'Attached file "a.txt" is available at ' + json.dumps(attachment) + '.'}]}))
        compressed_id = "00000000-0000-4000-8000-000000000003"
        compressed = self.home / "sessions" / ("rollout-" + compressed_id + ".jsonl.zst")
        compressed.write_bytes(b"opaque"); compressed.chmod(0o600)
        result = history.operate(self.home, self.uid, {"action": "attachment-index", "attachmentRoot": str(attachment_root)})
        self.assertEqual(result["references"], [{"threadId": THREAD, "paths": [attachment]}])
        self.assertEqual(result["unresolvedThreadIds"], [compressed_id])
        self.assertEqual(result["threadIds"], sorted([THREAD, compressed_id]))

    def test_known_ancestor_lookup_beyond_ten_thousand_directory_entries(self):
        for i in range(10050):
            (self.home / "sessions" / ("unrelated-" + str(i))).touch()
        self.save(self.user)
        self.assertEqual(history._rollout_index(self.home, self.uid, target=THREAD), {THREAD: [self.path]})

    def test_attachment_scans_resume_after_interruption_and_invalidate_changed_files(self):
        root = self.home / "attachments"
        one = str(root / "11111111-1111-4111-8111-111111111111.png")
        two = str(root / "22222222-2222-4222-8222-222222222222.png")
        rows = [line("event_msg", {"type": "fixture", "value": one}) for _ in range(6)]
        raw = self.save(*rows)
        request = {"action": "attachment-index", "attachmentRoot": str(root)}
        decode = history._decode
        scanned = []
        def observed(data):
            value = decode(data)
            if isinstance(value, dict) and value.get("type") == "event_msg": scanned.append(True)
            return value
        def interrupt(data):
            value = observed(data)
            if len(scanned) == 4: raise KeyboardInterrupt()
            return value
        with patch.object(history, "ATTACHMENT_CHECKPOINT_BYTES", 1):
            with patch.object(history, "_decode", interrupt), self.assertRaises(KeyboardInterrupt):
                history._attachment_index(self.home, self.uid, str(root))
            scanned.clear()
            with patch.object(history, "_decode", observed):
                self.assertEqual(history.operate(self.home, self.uid, request)["references"][0]["paths"], [one])
            self.assertEqual(len(scanned), 3)
            changed = self.save(*(line("event_msg", {"type": "fixture", "value": two}) for _ in rows))
            self.assertNotEqual(raw, changed)
            self.assertEqual(len(raw), len(changed))
            # Force the same cache hit as a filesystem that timestamps both writes in one tick.
            current = self.path.stat()
            witness = ["inline-refs-v5", None, str(self.path), THREAD, str(root),
                       *history._identity(current), current.st_ctime_ns, current.st_size]
            collision = hashlib.sha256(json.dumps(witness).encode()).hexdigest()
            with history._scan_checkpoints(self.home, self.uid) as db:
                self.assertEqual(db.execute("UPDATE checkpoints SET key=?", (collision,)).rowcount, 1)
                db.commit()
            self.assertEqual(history.operate(self.home, self.uid, request)["references"][0]["paths"], [two])

    def test_independent_rollouts_remain_collectable_when_aggregate_exceeds_per_history_limit(self):
        root = self.home / "attachments"
        ref = str(root / "11111111-1111-4111-8111-111111111111.png")
        row = line("event_msg", {"path": ref, "message": "x" * 2048})
        self.save(row)
        other = "00000000-0000-4000-8000-000000000009"
        target = self.path.with_name("rollout-" + other + ".jsonl")
        target.write_bytes(line("session_meta", {"id": other}) + row); target.chmod(0o600)
        with patch.object(history, "ROLLOUT_LIMIT", self.path.stat().st_size + 1):
            result = history.operate(self.home, self.uid, {"action": "attachment-index", "attachmentRoot": str(root)})
        self.assertEqual(result["unresolvedThreadIds"], [])
        self.assertEqual(result["references"], [{"threadId": key, "paths": [ref]} for key in [THREAD, other]])

    def test_inline_queue_and_rollout_evidence_is_scoped_to_thread_and_content(self):
        png = Path("tests/fixtures/visual-media/sample.png").read_bytes()
        jpeg = Path("tests/fixtures/visual-media/sample.jpg").read_bytes()
        uri = lambda mime, data: "data:" + mime + ";base64," + base64.b64encode(data).decode()
        evidence = lambda mime, data: {"mimeType": mime, "sha256": hashlib.sha256(data).hexdigest()}
        p, j = uri("image/png", png), uri("image/jpeg", jpeg)
        other = "00000000-0000-4000-8000-000000000099"
        queue = self.home / "queue_1.sqlite"
        with closing(sqlite3.connect(queue)) as db, db:
            db.execute("CREATE TABLE queued_items(id TEXT PRIMARY KEY,thread_id TEXT,payload_json TEXT)")
            db.execute("INSERT INTO queued_items VALUES(?,?,?)", ("a", THREAD, json.dumps({"UserInput": {"content": [{"type": "image", "image_url": p}], "client_id": "native-client"}})))
            db.execute("INSERT INTO queued_items VALUES(?,?,?)", ("b", other, json.dumps({"input": [{"type": "image", "url": j}]})))
        queue.chmod(0o600)
        self.save(line("event_msg", {"type": "user_message", "images": [p]}),
                  line("response_item", {"type": "message", "role": "user", "content": [
                      {"type": "input_image", "image_url": p}, {"type": "input_text", "text": j}]}))
        request = {"action": "attachment-index", "attachmentRoot": str(self.home / "attachments")}
        with patch.object(history, "ATTACHMENT_CHECKPOINT_BYTES", 1):
            for _ in range(2):
                result = history.operate(self.home, self.uid, request)
                self.assertEqual(result["references"], [
                    {"threadId": THREAD, "paths": [], "images": [evidence("image/png", png)]},
                    {"threadId": other, "paths": [], "images": [evidence("image/jpeg", jpeg)]}])
                self.assertNotIn("base64", json.dumps(result))
        with closing(sqlite3.connect(queue)) as db, db:
            db.execute("DELETE FROM queued_items WHERE thread_id=?", (other,))
            db.execute("INSERT INTO queued_items VALUES(?,?,?)", ("c", other, json.dumps({"input": [{"type": "image", "url": "data:image/png;base64,!"}]})))
        result = history.operate(self.home, self.uid, request)
        self.assertEqual(result["unresolvedThreadIds"], [other])
        self.assertEqual(result["references"], [{"threadId": THREAD, "paths": [], "images": [evidence("image/png", png)]}])
        inspected = history.operate(self.home, self.uid, dict(request, action="attachment-inspect", threadId=THREAD, path=str(self.path), mode="plaintext"))
        self.assertEqual(inspected, {"paths": [], "images": [evidence("image/png", png)]})

    def test_filtered_image_digests_survive_different_owners_duplicates_and_checkpoint_changes(self):
        png = Path("tests/fixtures/visual-media/sample.png").read_bytes()
        other = "00000000-0000-4000-8000-000000000088"
        url = "data:;base64," + base64.b64encode(png).decode()
        digest = hashlib.sha256(png).digest()
        rows = [line("response_item", {"type": "message", "role": "user", "content":
                [{"type": "input_image", "image_url": url}, {"type": "input_image", "image_url": url}]})]
        self.save(*rows)
        path = self.path.with_name("rollout-" + other + ".jsonl")
        path.write_bytes(line("session_meta", {"id": other}) + rows[0]); path.chmod(0o600)
        req = {"action": "attachment-index", "attachmentRoot": str(self.home / "attachments")}
        with patch.object(history, "ATTACHMENT_CHECKPOINT_BYTES", 1):
            empty = history.operate(self.home, self.uid, dict(req, activeImageDigests=""))
            self.assertEqual(empty["references"], [])
            filtered = history.operate(self.home, self.uid, dict(req, activeImageDigests=base64.b64encode(digest).decode()))
            self.assertEqual(filtered["references"], [{"threadId": tid, "paths": [], "images": [
                {"mimeType": "image/png", "sha256": digest.hex()}]} for tid in [THREAD, other]])
            filtered = history.operate(self.home, self.uid, dict(req, activeImageDigests=base64.b64encode(b"x" * 32).decode()))
            for row in filtered["references"]:
                self.assertNotIn("images", row)
                self.assertEqual(row["unmatchedHistoryImages"], [{"mimeType": "image/png", "sha256": digest.hex()}])
        self.save(line("event_msg", {"type": "user_message", "images": ["data:image/png;base64,Y29ycnVwdA=="]}))
        self.assertEqual(history.operate(self.home, self.uid, req)["unresolvedThreadIds"], [THREAD])
        with self.assertRaises(history.HistoryError): history.operate(self.home, self.uid, dict(req, activeImageDigests="YQ=="))

    def test_large_native_queue_keeps_ids_order_models_and_only_returns_small_owned_image_proofs(self):
        def chunk(kind, data): return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        w, h = 1024, 800
        pixels = random.Random(37).randbytes(3 * w * h)
        png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) +
               chunk(b"IDAT", zlib.compress(b"".join(b"\0" + pixels[i:i + 3*w] for i in range(0, len(pixels), 3*w)))) + chunk(b"IEND", b""))
        uri = "data:image/png;base64," + base64.b64encode(png).decode()
        large = [{"type": "text", "text": "Screenshot question", "text_elements": []}] + [
            {"type": "image", "image_url": uri, "detail": "high"} for _ in range(4)]
        root = self.home / "attachments"; root.mkdir()
        text = 'Attached file "a.png" is available at ' + json.dumps(str(root / "11111111-1111-4111-8111-111111111111.png")) + '.'
        small = [{"type": "text", "text": text, "text_elements": []},
                 {"type": "text", "text": "原始上下文", "text_elements": [{"byte_range": {"start": 0, "end": 15}, "placeholder": "附件来源"}]}]
        def payload(parts, cid): return json.dumps({"UserInput": {"content": parts, "client_id": cid}})
        queue = self.home / "queue_1.sqlite"
        with closing(sqlite3.connect(queue)) as db, db:
            db.execute("CREATE TABLE queued_items(id TEXT PRIMARY KEY,thread_id TEXT,payload_json TEXT,queue_order INTEGER)")
            db.executemany("INSERT INTO queued_items VALUES(?,?,?,?)", [
                ("large", THREAD, payload(large, "first"), 1), ("small", THREAD, payload(small, "second"), 2),
                ("different", "00000000-0000-4000-8000-000000000088", payload(small, "different"), 0)])
        queue.chmod(0o600)
        req = {"action": "queue-capacity", "threadId": THREAD, "attachmentRoot": str(root)}
        listing = history.operate(self.home, self.uid, req)
        self.assertTrue(listing["large"]); self.assertTrue(listing["complete"])
        first, second = listing["data"]
        self.assertEqual((first["id"], first["clientUserMessageId"], first["preview"], first["media"]), ("large", "first", "Screenshot question", [{"type": "image"}]))
        self.assertGreater(first["bytes"], 12*1024*1024)
        self.assertTrue(first["oversized"]); self.assertFalse(second["oversized"]); self.assertEqual(second["media"], [{"type": "text", "text": text}])
        detail = history.operate(self.home, self.uid, dict(req, action="queue-item", queuedSubmissionId="large"))["queuedSubmission"]
        self.assertEqual(detail["input"][0], large[0])
        self.assertEqual(detail["input"][1:], [{"type": "harnessInlineImageDigest", "mimeType": "image/png",
            "sha256": hashlib.sha256(png).hexdigest(), "bytes": len(png), "detail": "high",
            "urlSha256": hashlib.sha256(uri.encode("utf-8")).hexdigest()}] * 4)
        self.assertNotIn("base64", json.dumps(detail)); self.assertEqual(len(listing["data"]), 2)
        self.assertEqual(history.operate(self.home, self.uid, dict(req, action="queue-item", queuedSubmissionId="small"))["queuedSubmission"]["input"],
                         [small[0], {"type": "text", "text": "原始上下文", "text_elements": [{"byteRange": {"start": 0, "end": 15}, "placeholder": "附件来源"}]}])
        image_request = dict(req, action="queue-image", queuedSubmissionId="large", ordinal=1,
                             expectedSha256=hashlib.sha256(png).hexdigest(), expectedBytes=len(png))
        image = history.operate(self.home, self.uid, image_request)
        self.assertEqual(image["mimeType"], "image/png"); self.assertEqual(base64.b64decode(image["base64"]), png)
        for wrong in [{"ordinal": 0}, {"expectedSha256": "f" * 64}, {"expectedBytes": 1}, {"queuedSubmissionId": "different"}]:
            with self.assertRaises(history.HistoryError): history.operate(self.home, self.uid, {**image_request, **wrong})
        alternate = base64.b64encode(hashlib.sha256(b"old upload pre-encoding").digest()).decode()
        old = history.operate(self.home, self.uid, {"action": "attachment-index", "attachmentRoot": str(root), "activeImageDigests": alternate})
        self.assertTrue(next(row for row in old["references"] if row["threadId"] == THREAD)["unmatchedQueuedImage"])
        known = history.operate(self.home, self.uid, {"action": "attachment-index", "attachmentRoot": str(root), "activeImageDigests": base64.b64encode(hashlib.sha256(png).digest()).decode()})
        own = next(row for row in known["references"] if row["threadId"] == THREAD)
        self.assertEqual(own["queuedImages"], [{"mimeType": "image/png", "sha256": hashlib.sha256(png).hexdigest()}])
        self.assertNotIn("unmatchedQueuedImage", own)
        self.assertIsNone(history.operate(self.home, self.uid, dict(req, action="queue-item", queuedSubmissionId="different"))["queuedSubmission"])
        with closing(sqlite3.connect(queue)) as db, db:
            db.execute("DELETE FROM queued_items WHERE id='large'")
        self.assertEqual(history.operate(self.home, self.uid, req), {"large": False, "data": [], "complete": True})

    def test_queue_only_reference_survives_reopen_and_clear_removes_evidence(self):
        attachment_root = self.home / "attachments"; attachment_root.mkdir()
        item = attachment_root / "11111111-1111-4111-8111-111111111111"
        item.write_bytes(b"actual queued bytes")
        queue = self.home / "queue_1.sqlite"
        request = {"action": "attachment-index", "attachmentRoot": str(attachment_root)}
        with closing(sqlite3.connect(queue)) as db, db:
            db.execute("CREATE TABLE queued_items(id TEXT PRIMARY KEY,thread_id TEXT,payload_json TEXT)")
            db.execute("INSERT INTO queued_items VALUES(?,?,?)", ("a", THREAD, json.dumps({"input": [{"type": "text", "text": 'Attached file "a.txt" is available at ' + json.dumps(str(item)) + "."}]})))
        queue.chmod(0o600)
        self.assertEqual(history.operate(self.home, self.uid, request)["references"], [{"threadId": THREAD, "paths": [str(item)]}])
        self.assertEqual(item.read_bytes(), b"actual queued bytes")
        with closing(sqlite3.connect(queue)) as db, db:
            db.execute("DELETE FROM queued_items")
        self.assertEqual(history.operate(self.home, self.uid, request)["references"], [])



class RecoveryCopyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.uid = os.geteuid() if os.name == "posix" else 0
        (self.home / "sessions").mkdir(mode=0o700)
        self.target_id = "00000000-0000-4000-8000-000000000002"
        self.source = self.home / "sessions" / (THREAD + ".jsonl")
        self.target = self.home / "sessions" / (self.target_id + ".jsonl")
        self.cwd = str(self.home / "project")
        self.settings = {"cwd": self.cwd, "model_provider": "fixture_a", "history_mode": "paginated",
                         "base_instructions": {"text": "synthetic original base"}, "dynamic_tools": [], "selected_capability_roots": []}
        self.source_raw = self.record(0, "session_meta", {**self.settings, "id": THREAD}) + self.record(1, "response_item", {
            "type": "message", "role": "user", "content": [{"type": "input_text", "text": "synthetic public 用户"}]}) + self.record(2, "event_msg", {
            "type": "thread_settings_applied", "thread_id": THREAD, "thread_settings": {
                "cwd": self.cwd, "model_provider_id": "fixture_a", "reasoning_summary": "detailed", "service_tier": "priority"}})
        self.target_raw = self.record(0, "session_meta", {**self.settings, "id": self.target_id})
        self.write(self.source, self.source_raw); self.write(self.target, self.target_raw)

    def record(self, ordinal, kind, payload):
        return (json.dumps({"ordinal": ordinal, "timestamp": "2026-11-01T00:00:00Z", "type": kind, "payload": payload}, ensure_ascii=False) + "\n").encode()

    def write(self, path, data):
        path.write_bytes(data); path.chmod(0o600)

    def inspect(self, path=None, identity=None):
        return history.operate(self.home, self.uid, {"action": "copy-inspect", "mode": "foreign",
            "threadId": identity or THREAD, "path": str(path or self.source)})

    def request(self):
        return {"action": "recovery-copy", "mode": "foreign", "threadId": THREAD, "path": str(self.source),
                "expected": self.inspect()["expected"], "sourceProvider": "fixture_a", "cwd": self.cwd,
                "target": {"threadId": self.target_id, "path": str(self.target),
                           "expected": self.inspect(self.target, self.target_id)["expected"]}}

    def test_copy_keeps_official_header_and_all_other_bytes_source_unchanged_and_target_witness(self):
        request = self.request(); metadata = self.inspect()["sourceMetadata"]
        self.assertEqual(metadata, {"baseInstructions": "synthetic original base", "dynamicTools": [], "selectedCapabilityRoots": [], "summary": "detailed", "serviceTier": "priority"})
        result = history.operate(self.home, self.uid, request)
        self.assertTrue(result["copied"]); self.assertTrue(result["sourcePreserved"])
        self.assertEqual(result["expected"], request["expected"])
        self.assertEqual(self.source.read_bytes(), self.source_raw)
        self.assertEqual(self.target.read_bytes(), self.target_raw + self.source_raw.split(b"\n", 1)[1])
        self.assertFalse((self.home / "harness-history-backups").exists())
        self.assertEqual(result["target"]["expected"]["sha256"], hashlib.sha256(self.target.read_bytes()).hexdigest())
        if os.name == "posix": self.assertEqual(self.target.stat().st_mode & 0o777, 0o600)
        # Copying never modifies the source's identity, bytes or timestamps.
        proof = history.operate(self.home, self.uid, {"action": "inspect", "mode": "foreign", "threadId": THREAD, "path": str(self.source)})
        self.assertEqual(proof["expected"], result["expected"])

    def test_nonempty_and_replayed_target_never_overwrite_a_published_copy(self):
        request = self.request(); history.operate(self.home, self.uid, request)
        published = self.target.read_bytes()
        with self.assertRaises(history.HistoryError): history.operate(self.home, self.uid, request)
        request["target"]["expected"] = self.inspect(self.target, self.target_id)["expected"]
        with self.assertRaises(history.HistoryError) as caught: history.operate(self.home, self.uid, request)
        self.assertEqual(caught.exception.code, "thread_history_target_not_empty")
        self.assertEqual(self.target.read_bytes(), published); self.assertEqual(self.source.read_bytes(), self.source_raw)

    def test_conversion_uses_native_target_provider_header_without_changing_source_provider_or_history(self):
        target_raw = self.record(0, "session_meta", {**self.settings, "id": self.target_id, "model_provider": "fixture_b"})
        self.write(self.target, target_raw); request = self.request(); request["targetProvider"] = "fixture_b"
        result = history.operate(self.home, self.uid, request)
        self.assertTrue(result["sourcePreserved"]); self.assertEqual(self.source.read_bytes(), self.source_raw)
        self.assertEqual(self.target.read_bytes(), target_raw + self.source_raw.split(b"\n", 1)[1])

    def test_source_or_target_changed_inode_or_bytes_refuses_before_backup(self):
        for path, data in ((self.source, self.source_raw), (self.target, self.target_raw)):
            for change in ("inode", "bytes"):
                with self.subTest(path=path.name, change=change):
                    request = self.request()
                    if change == "inode":
                        temporary = path.with_suffix(".replacement"); self.write(temporary, data); os.replace(temporary, path)
                    else: self.write(path, data + self.record(3, "event_msg", {"type": "fixture"}))
                    with self.assertRaises(history.HistoryError) as caught: history.operate(self.home, self.uid, request)
                    self.assertEqual(caught.exception.code, "thread_history_changed")
                    self.assertFalse((self.home / "harness-history-backups").exists())
                    self.write(path, data)

    def test_latest_official_settings_not_stale_source_header_determine_provider_and_cwd(self):
        # Existing source header can predate a legitimate provider/settings change.
        self.write(self.source, self.source_raw.replace(b'"model_provider": "fixture_a"', b'"model_provider": "fixture_old"', 1))
        request = self.request(); history.operate(self.home, self.uid, request)
        self.write(self.target, self.target_raw)
        request = self.request(); request["sourceProvider"] = "fixture_wrong"
        with self.assertRaises(history.HistoryError): history.operate(self.home, self.uid, request)
        self.assertEqual(self.target.read_bytes(), self.target_raw)

    def test_without_settings_source_header_must_correspond_to_current_source_provider_and_project(self):
        original = b"".join(self.source_raw.splitlines(keepends=True)[:2])
        for key, different in (("model_provider", "fixture_old"), ("cwd", str(self.home / "old-project"))):
            rows = original.splitlines(keepends=True)
            header = json.loads(rows[0]); header["payload"][key] = different
            self.write(self.source, (json.dumps(header) + "\n").encode() + rows[1])
            with self.assertRaises(history.HistoryError) as caught: history.operate(self.home, self.uid, self.request())
            self.assertEqual(caught.exception.code, "thread_history_changed")
            self.assertEqual(self.target.read_bytes(), self.target_raw)
        self.write(self.source, original)
        self.assertIsNone(self.inspect()["sourceMetadata"]["serviceTier"])
        self.assertTrue(history.operate(self.home, self.uid, self.request())["copied"])

    def test_wrong_target_identity_project_provider_or_header_semantics_are_rejected(self):
        for key, value in (("cwd", str(self.home / "other")), ("model_provider", "fixture_b"),
                           ("base_instructions", {"text": "different base"}), ("dynamic_tools", [{"name": "different"}]),
                           ("selected_capability_roots", ["different"]), ("history_base", {"thread_id": THREAD})):
            with self.subTest(key=key):
                self.write(self.target, self.record(0, "session_meta", {**self.settings, key: value, "id": self.target_id}))
                with self.assertRaises(history.HistoryError): history.operate(self.home, self.uid, self.request())
                self.assertEqual(self.source.read_bytes(), self.source_raw)
        self.assertFalse((self.home / "harness-history-backups").exists())

    def test_no_aliases_wrong_home_symlinks_or_hardlinks(self):
        request = self.request(); request["target"] = {"threadId": THREAD, "path": str(self.source), "expected": request["expected"]}
        with self.assertRaises(history.HistoryError): history.operate(self.home, self.uid, request)
        self.target.unlink(); os.link(self.source, self.target)
        with self.assertRaises(history.HistoryError): self.request()
        self.target.unlink(); self.write(self.target, self.target_raw)
        request = self.request(); request["target"]["path"] = str(self.home / "outside.jsonl")
        with self.assertRaises(history.HistoryError): history.operate(self.home, self.uid, request)
        if os.name == "posix":
            self.target.unlink(); self.target.symlink_to(self.source)
            with self.assertRaises(history.HistoryError): self.request()

    def test_late_source_or_target_change_is_rejected_before_publication(self):
        scan = history._copy_scan
        for path in (self.source, self.target):
            request = self.request()
            def mutate(*args, **kwargs):
                result = scan(*args, **kwargs)
                if kwargs.get("output") is not None:
                    path.write_bytes(path.read_bytes() + self.record(4, "event_msg", {"type": "fixture"}))
                return result
            with patch.object(history, "_copy_scan", side_effect=mutate):
                with self.assertRaises(history.HistoryError): history.operate(self.home, self.uid, request)
            if path == self.source: self.assertEqual(self.target.read_bytes(), self.target_raw)
            else: self.assertEqual(self.source.read_bytes(), self.source_raw)
            self.assertFalse(list(self.home.rglob(".harness-history-copy-*")))
            self.write(self.source, self.source_raw); self.write(self.target, self.target_raw)

    def test_post_publish_failure_is_unknown_and_keeps_named_copy_and_unchanged_original(self):
        request = self.request(); original = history.fsync_directory
        def fail(path, **kwargs):
            if path == self.target.parent: raise OSError("synthetic confirmation failure")
            return original(path, **kwargs)
        with patch.object(history, "fsync_directory", side_effect=fail):
            with self.assertRaises(history.HistoryError) as caught: history.operate(self.home, self.uid, request)
        self.assertEqual(caught.exception.delivery, "unknown")
        self.assertEqual(self.source.read_bytes(), self.source_raw)
        self.assertEqual(self.target.read_bytes(), self.target_raw + self.source_raw.split(b"\n", 1)[1])
        self.assertFalse((self.home / "harness-history-backups").exists())

    def test_metadata_and_rollout_budgets_fail_without_partial_target(self):
        request = self.request()
        for limit, value in (("COPY_METADATA_LIMIT", 1), ("ROLLOUT_LIMIT", len(self.source_raw) - 1)):
            with self.subTest(limit=limit), patch.object(history, limit, value):
                with self.assertRaises(history.HistoryError): history.operate(self.home, self.uid, request)
            self.assertEqual(self.source.read_bytes(), self.source_raw); self.assertEqual(self.target.read_bytes(), self.target_raw)
            self.assertFalse(list(self.home.rglob(".harness-history-copy-*")))

    def test_source_and_target_native_writer_locks_each_block_copy(self):
        request = self.request(); directory = self.home / "thread-writer-locks"; directory.mkdir(mode=0o700)
        for identity in (THREAD, self.target_id):
            lock_path = directory / (identity + ".lock")
            code = "import os,sys;from deploy.thread_history import _lock;f=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600);\nwith _lock(f):\n print('locked',flush=True)\n sys.stdin.readline()\nos.close(f)"
            process = subprocess.Popen([sys.executable, "-B", "-c", code, str(lock_path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                self.assertEqual(process.stdout.readline().rstrip(b"\r\n"), b"locked")
                with self.assertRaises(history.HistoryError) as caught: history.operate(self.home, self.uid, request)
                self.assertEqual(caught.exception.code, "thread_history_busy")
                self.assertEqual(self.target.read_bytes(), self.target_raw); self.assertEqual(self.source.read_bytes(), self.source_raw)
            finally: process.communicate(b"done\n", timeout=5)
            lock_path.unlink()
        self.assertFalse((self.home / "harness-history-backups").exists())

    def test_copy_metadata_entrypoint_uses_utf8_and_never_emits_other_record_text(self):
        text = "原始基础说明🙂" * 100
        self.write(self.source, self.source_raw.replace(b'synthetic original base', text.encode("utf-8")))
        request = {"action": "copy-inspect", "mode": "foreign", "threadId": THREAD, "path": str(self.source)}
        result = subprocess.run([sys.executable, "-B", "-m", "deploy.thread_history", "--home", str(self.home)],
                                input=json.dumps(request).encode(), capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout)["sourceMetadata"]["baseInstructions"], text)
        self.assertIn(text.encode("utf-8"), result.stdout)
        self.assertNotIn("synthetic public 用户".encode("utf-8"), result.stdout)

    def test_copy_does_not_consume_backup_budget_but_only_target_repair_preserves_its_raw_backup(self):
        plaintext = {"type": "reasoning", "content": [{"type": "reasoning_text", "text": "synthetic 思考"}], "summary": []}
        raw = self.source_raw + self.record(3, "response_item", plaintext)
        self.write(self.source, raw)
        self.assertNotIn("plannedRepairSha256", self.inspect())
        with patch.object(history, "BACKUP_LIMIT", 1):
            copied = history.operate(self.home, self.uid, self.request())
        before = self.target.read_bytes()
        request = {"action": "repair", "mode": "foreign", "threadId": self.target_id,
                   "path": str(self.target), "expected": copied["target"]["expected"]}
        with patch.object(history, "BACKUP_LIMIT", 1):
            with self.assertRaises(history.HistoryError) as caught: history.operate(self.home, self.uid, request)
        self.assertEqual(caught.exception.code, "thread_history_backup_limit")
        self.assertEqual(self.target.read_bytes(), before); self.assertEqual(self.source.read_bytes(), raw)
        result = history.operate(self.home, self.uid, request)
        self.assertTrue(result["repaired"]); self.assertTrue(result["backupPreserved"])
        self.assertEqual(self.source.read_bytes(), raw)
        backup = next((self.home / "harness-history-backups").glob("*.jsonl.gz"))
        self.assertTrue(backup.name.startswith(self.target_id + "-"))
        self.assertEqual(gzip.decompress(backup.read_bytes()), before)
        self.assertNotEqual(self.target.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
