"""Request admission/lifetime faults using isolated files and a controlled unit model.

Root UID enforcement is exercised separately in root/test_request_spool.py.
Windows substitutes flock with nonblocking locks; Linux uses the actual flock.
"""
import contextlib
import io
import json
import os
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

from deploy import cli, requests
from deploy.common import DeployError, Layout, canonical, digest, mkdir, read_json, write_json
from deploy.manager import Manager
from deploy.requests import RequestSpool


class FixtureSystem:
    def __init__(self):
        self.active, self.stops = set(), []
        self.state_failure = self.stop_failure = False

    def state(self, unit):
        if self.state_failure:
            raise DeployError("stop_unknown", "fixture query failure")
        return {"stopped": unit not in self.active}

    def stop(self, units):
        self.stops.extend(units)
        if self.stop_failure:
            raise DeployError("stop_unknown", "fixture populated cgroup")
        if any(unit in self.active for unit in units):
            raise AssertionError("collector attempted to stop an active executor")


class FixtureSpool(RequestSpool):
    def ordinary(self, path, *, directory=False):
        info = path.lstat()
        # Only replace UID in the unprivileged fixture. File type, link count,
        # size and private permission checks still use real filesystem values.
        if os.name == "posix":
            values = list(info)
            values[4] = 0
            with patch.object(Path, "lstat", return_value=os.stat_result(values)):
                return super().ordinary(path, directory=directory)
        return super().ordinary(path, directory=directory)


class RequestSpoolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="request-spool-")
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout("fixture", Path(self.temp.name))
        for path in (self.layout.config, self.layout.state / "requests", self.layout.state / "receipts",
                     self.layout.state / "transactions"):
            mkdir(path, 0o700)
        self.system = FixtureSystem()
        self.spool = FixtureSpool(self.layout, self.system)
        self.request = {"method": "restart", "params": {}, "operationId": str(uuid.uuid4())}
        self.current = {"revision": "a" * 32, "kind": "responses", "baseUrl": "https://provider.invalid/v1",
                        "model": "fixture-model", "apiKey": "fixture-key", "effort": "native-only", "models": []}
        write_json(self.layout.config / "instance.json", {})
        self.manager = Manager(self.layout, self.system, worker_gid=1)
        self.manager.require_update_ready = Mock(return_value=None)
        self.manager.require_recovered_transactions = Mock()
        self.manager.require_service_ownership = Mock()
        self.manager.providers.read = Mock(return_value=self.current)
        self.manager.restart = Mock(return_value={"restarted": True})
        if os.name != "posix":
            locks = {}
            @contextlib.contextmanager
            def exclusive(path):
                lock = locks.setdefault(str(path), threading.Lock())
                if not lock.acquire(blocking=False):
                    raise DeployError("busy", "fixture lock held")
                try:
                    yield
                finally:
                    lock.release()
            for target in ("deploy.cli.exclusive", "deploy.requests.exclusive"):
                item = patch(target, exclusive)
                item.start()
                self.addCleanup(item.stop)

    def unit(self, ident):
        return f"codex-harness-fixture-manage-{ident}.service"

    def snapshot(self):
        return {path.relative_to(self.spool.root).as_posix(): path.read_bytes()
                for path in self.spool.root.rglob("*") if path.is_file()}

    def rpc(self, request=None, runner=None):
        output = io.StringIO()
        with patch.object(cli, "require_linux"), patch.object(cli, "Layout", return_value=self.layout), \
             patch.object(cli, "Manager", return_value=self.manager), patch.object(cli, "RequestSpool", return_value=self.spool), \
             patch.object(cli, "run", side_effect=runner) as run, patch("sys.argv", ["manage", "rpc"]), \
             patch("sys.stdin", io.StringIO(json.dumps(self.request if request is None else request))), \
             patch("sys.stdout", output):
            try:
                cli.helper_main("fixture")
            except SystemExit as exc:
                self.assertEqual(exc.code, 1)
        return json.loads(output.getvalue()), run

    def test_invalid_envelope_and_mutation_are_rejected_without_staging_or_launch(self):
        invalid = [
            {"method": "restart", "params": {}},
            {**self.request, "unexpected": "x" * 65536},
            {**self.request, "params": {"unexpected": True}},
            {**self.request, "method": "provider/write", "params": {"unexpected": True}},
            {**self.request, "method": "models/refresh", "params": {"expectedRevision": "b" * 32}},
            {**self.request, "method": "models/refresh", "params": {"expectedRevision": "a" * 32, "confirmCapabilities": True}},
        ]
        for value in invalid:
            with self.subTest(method=value["method"]):
                result, run = self.rpc(value)
                self.assertFalse(result["ok"])
                self.assertEqual(result["error"]["delivery"], "not_sent")
                run.assert_not_called()
                self.assertEqual(self.snapshot(), {})
                self.assertEqual(list((self.layout.state / "receipts").iterdir()), [])

    def test_receipt_budget_and_recovery_reject_before_any_spool_write(self):
        with patch.object(Path, "glob", return_value=[None] * 10000):
            result, run = self.rpc()
        self.assertEqual(result["error"]["code"], "budget")
        run.assert_not_called()
        self.manager.require_update_ready.side_effect = DeployError("recovery_required", "fixture recovery")
        result, run = self.rpc()
        self.assertEqual(result["error"]["code"], "recovery_required")
        run.assert_not_called()
        self.assertEqual(self.snapshot(), {})

    def test_receipt_replay_never_stages_even_with_blocked_spool(self):
        write_json(self.spool.root / "unexpected", {"retained": True})
        for state in ("running", "completed", "failed"):
            saved = {"operationId": self.request["operationId"], "state": state,
                     "requestDigest": digest({"method": "restart", "params": {}})}
            if state == "completed":
                saved["result"] = {"restarted": True}
            if state == "failed":
                saved["error"] = {"code": "health", "message": "fixture", "delivery": "unknown"}
            write_json(self.layout.state / "receipts" / (self.request["operationId"] + ".json"), saved)
            before = self.snapshot()
            result, run = self.rpc()
            run.assert_not_called()
            self.assertEqual(self.snapshot(), before)
            self.assertEqual(result["ok"], state == "completed")
            if state != "completed":
                self.assertEqual(result["error"]["delivery"], "unknown")
        self.manager.restart.assert_not_called()

    def test_active_executor_preserves_input_and_output_and_blocks_new_admission(self):
        with self.spool.stage(self.request) as ident:
            self.system.active.add(self.unit(ident))
            self.assertEqual(self.spool.load(ident), self.request)
            self.spool.publish(ident, {"ok": True, "result": {}})
        before = self.snapshot()
        for action in (lambda: self.spool.finish(ident), lambda: self.spool.stage(self.request).__enter__()):
            with self.assertRaises(DeployError) as caught:
                action()
            self.assertEqual(caught.exception.code, "busy")
            self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.system.stops, [])
        self.system.active.clear()
        self.assertTrue(self.spool.finish(ident)["ok"])
        self.assertEqual(self.snapshot(), {})

    def test_uncertain_state_or_stop_retains_all_material_and_blocks_growth(self):
        with self.spool.stage(self.request) as ident:
            pass
        before = self.snapshot()
        for field in ("state_failure", "stop_failure"):
            setattr(self.system, field, True)
            for action in (lambda: self.spool.finish(ident), lambda: self.spool.stage(self.request).__enter__()):
                with self.assertRaises(DeployError) as caught:
                    action()
                self.assertEqual(caught.exception.code, "recovery_required")
                self.assertIn("new requests blocked", str(caught.exception))
                self.assertEqual(self.snapshot(), before)
            setattr(self.system, field, False)

    def test_waiter_disconnect_allows_publish_then_confirmed_collection_without_receipt_change(self):
        with self.spool.stage(self.request) as old:
            self.system.active.add(self.unit(old))
        self.spool.publish(old, {"ok": False, "error": {"delivery": "unknown"}})
        receipt = self.layout.state / "receipts" / (self.request["operationId"] + ".json")
        write_json(receipt, {"state": "running"})
        receipt_before = receipt.read_bytes()
        self.system.active.clear()
        with self.spool.stage(self.request) as fresh:
            self.assertNotEqual(old, fresh)
            self.assertFalse((self.spool.root / old).exists())
            with self.assertRaises(FileNotFoundError):
                self.spool.load(old)
            with self.assertRaises(DeployError):
                self.spool.publish(old, {"ok": True})
            self.assertFalse((self.spool.root / old).exists())
            self.assertEqual(receipt.read_bytes(), receipt_before)
            self.spool.finish(fresh)

    def test_admission_lease_blocks_second_waiter_but_executor_file_gate_remains_available(self):
        with self.spool.stage(self.request) as ident:
            with self.assertRaises(DeployError) as caught:
                with self.spool.stage(self.request):
                    self.fail("concurrent admission")
            self.assertEqual(caught.exception.code, "busy")
            self.assertEqual(self.spool.load(ident), self.request)
            self.spool.publish(ident, {"ok": True})
            self.assertTrue(self.spool.finish(ident)["ok"])

    def test_failed_launch_with_confirmed_stop_is_bounded_and_still_unknown(self):
        for _ in range(3):
            result, run = self.rpc(runner=DeployError("command_failed", "fixture launch failure"))
            run.assert_called_once()
            self.assertEqual(result["error"]["delivery"], "unknown")
            self.assertEqual(self.snapshot(), {})
            self.assertEqual(list(self.spool.root.iterdir()), [])

    def test_failed_wait_with_live_unit_retains_request_and_reports_unknown(self):
        def interrupted(command, **kwargs):
            self.system.active.add(self.unit(command[-1]))
            raise TimeoutError("fixture waiter interruption")
        result, run = self.rpc(runner=interrupted)
        self.assertEqual(result["error"]["code"], "busy")
        self.assertEqual(result["error"]["delivery"], "unknown")
        self.assertEqual(len(self.snapshot()), 1)
        self.assertEqual(self.system.stops, [])
        before = self.snapshot()
        blocked, run = self.rpc()
        self.assertEqual(blocked["error"]["code"], "busy")
        run.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_result_after_failed_wait_can_be_returned_only_after_confirmed_stop(self):
        expected = {"ok": True, "result": {"restarted": True}}
        def interrupted(command, **kwargs):
            self.spool.publish(command[-1], expected)
            raise TimeoutError("fixture waiter lost final status")
        result, _ = self.rpc(runner=interrupted)
        self.assertEqual(result, expected)
        self.assertEqual(self.snapshot(), {})

    def test_executor_rechecks_admission_after_staging_and_keeps_input_until_collection(self):
        with self.spool.stage(self.request) as ident:
            self.manager.require_update_ready.side_effect = DeployError("recovery_required", "changed after stage")
            with patch.object(cli, "require_linux"), patch.object(cli, "Layout", return_value=self.layout), \
                 patch.object(cli, "Manager", return_value=self.manager), patch.object(cli, "RequestSpool", return_value=self.spool), \
                 patch("sys.argv", ["manage", "execute", ident]):
                cli.helper_main("fixture")
            self.assertEqual(len(self.snapshot()), 2)
            self.assertEqual(self.spool.load(ident), self.request)
            result = self.spool.finish(ident)
            self.assertEqual(result["error"]["delivery"], "not_sent")
            self.assertEqual(result["error"]["code"], "recovery_required")
            self.manager.restart.assert_not_called()

    def test_result_overflow_preserves_receipt_and_never_publishes_partial_output(self):
        def execute(command, **kwargs):
            ident = command[-1]
            result = self.manager.dispatch(self.spool.load(ident))
            with patch.object(requests, "MAX_RESULT", 8):
                try:
                    self.spool.publish(ident, result)
                except DeployError:
                    self.assertEqual(set(self.snapshot()), {ident + "/request.json"})
                    raise
        result, _ = self.rpc(runner=execute)
        self.assertEqual(result["error"]["delivery"], "unknown")
        saved = read_json(self.layout.state / "receipts" / (self.request["operationId"] + ".json"))
        self.assertEqual(saved["state"], "completed")
        replay, run = self.rpc()
        run.assert_not_called()
        self.assertTrue(replay["ok"])

    def test_input_and_reserved_result_bytes_checked_before_directory_creation(self):
        for limits in ({"MAX_REQUEST": 10}, {"MAX_SPOOL_BYTES": len(canonical(self.request)) + requests.MAX_RESULT}):
            with patch.multiple(requests, **limits), self.assertRaises(DeployError) as caught:
                with self.spool.stage(self.request):
                    self.fail("over-budget admission")
            self.assertEqual(caught.exception.code, "budget")
            self.assertEqual(list(self.spool.root.iterdir()), [])

    def test_retained_count_and_aggregate_bytes_fail_closed_before_unit_commands(self):
        for ident in ("a" * 32, "b" * 32):
            write_json(self.spool.root / (ident + ".json"), {"fixture": "x" * 64})
        before = self.snapshot()
        for limits in ({"MAX_REQUESTS": 1}, {"MAX_SPOOL_BYTES": 100}):
            with patch.multiple(requests, **limits), self.assertRaises(DeployError) as caught:
                with self.spool.stage(self.request):
                    self.fail("over-budget retention")
            self.assertEqual(caught.exception.code, "budget")
            self.assertEqual(self.snapshot(), before)
            self.assertEqual(self.system.stops, [])

    def test_legacy_files_collect_only_after_every_unit_confirms_stopped(self):
        first, second = "a" * 32, "b" * 32
        for ident in (first, second):
            write_json(self.spool.root / (ident + ".json"), self.request)
            write_json(self.spool.root / (ident + ".result.json"), {"ok": True})
        self.system.active.add(self.unit(second))
        before = self.snapshot()
        with self.assertRaises(DeployError):
            with self.spool.stage(self.request):
                self.fail("active legacy request")
        self.assertEqual(self.snapshot(), before)
        self.system.active.clear()
        with self.spool.stage(self.request) as ident:
            self.assertEqual(set(self.snapshot()), {ident + "/request.json"})
            self.spool.finish(ident)

    def test_unknown_storage_and_duplicate_results_are_retained(self):
        write_json(self.spool.root / ".new-unknown", {"fixture": True})
        before = self.snapshot()
        with self.assertRaises(DeployError) as caught:
            with self.spool.stage(self.request):
                self.fail("unrecognized legacy material")
        self.assertEqual(caught.exception.code, "recovery_required")
        self.assertEqual(self.snapshot(), before)
        (self.spool.root / ".new-unknown").unlink()
        with self.spool.stage(self.request) as ident:
            self.spool.publish(ident, {"ok": True})
            before = self.snapshot()
            with self.assertRaises(DeployError):
                self.spool.publish(ident, {"ok": False})
            self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
