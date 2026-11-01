"""Ordinary receipt exhaustion must leave one durable emergency recovery slot."""
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

from deploy.common import DeployError, Layout, read_json, write_json
from deploy.manager import Manager


class ManagementCapacityTests(unittest.TestCase):
    def test_recovery_reservation_preserves_prior_receipts_and_replay(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            layout.config.mkdir(parents=True)
            write_json(layout.config / "instance.json", {})
            receipts = layout.state / "receipts"
            receipts.mkdir(parents=True)
            for index in range(3):
                write_json(receipts / (str(uuid.uuid4()) + ".json"), {"state": "unknown", "fixture": index})
            before = {path.name: path.read_bytes() for path in receipts.iterdir()}
            manager = Manager(layout, worker_gid=1)
            manager.require_update_ready = Mock()
            manager.restart = Mock(return_value={"restarted": True})
            recovery = {"method": "recover", "params": {"confirmStop": True}, "operationId": str(uuid.uuid4())}
            with patch("deploy.manager.MAX_MANAGEMENT_RECEIPTS", 3):
                with self.assertRaises(DeployError) as ordinary:
                    manager.dispatch({"method": "restart", "params": {}, "operationId": str(uuid.uuid4())})
                self.assertEqual(ordinary.exception.code, "budget")
                expected = {"ok": True, "result": {"restarted": True}}
                self.assertEqual(manager.dispatch(recovery), expected)
                self.assertEqual(manager.dispatch(recovery), expected)
                with self.assertRaises(DeployError) as extra:
                    manager.dispatch({**recovery, "operationId": str(uuid.uuid4())})
                self.assertEqual(extra.exception.code, "budget")
            manager.restart.assert_called_once()
            self.assertEqual({name: (receipts / name).read_bytes() for name in before}, before)
            self.assertEqual(read_json(receipts / (recovery["operationId"] + ".json"))["state"], "completed")

    def test_failed_recovery_is_retained_and_not_reexecuted(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            layout.config.mkdir(parents=True)
            write_json(layout.config / "instance.json", {})
            manager = Manager(layout, worker_gid=1)
            manager.require_update_ready = Mock()
            manager.restart = Mock(side_effect=DeployError("stop_unknown", "Stop not confirmed"))
            recovery = {"method": "recover", "params": {"confirmStop": True}, "operationId": str(uuid.uuid4())}
            with patch("deploy.manager.MAX_MANAGEMENT_RECEIPTS", 0):
                result = manager.dispatch(recovery)
                self.assertFalse(result["ok"])
                self.assertEqual(result["error"]["delivery"], "unknown")
                self.assertEqual(manager.dispatch(recovery), result)
                with self.assertRaises(DeployError):
                    manager.dispatch({**recovery, "operationId": str(uuid.uuid4())})
            manager.restart.assert_called_once()


if __name__ == "__main__":
    unittest.main()
