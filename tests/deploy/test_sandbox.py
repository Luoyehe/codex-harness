import subprocess
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from deploy.common import DeployError, Layout
from deploy.sandbox import command, preflight

BINARY = Path.cwd() / "fixture-candidate" / "codex"

class NativeSandboxTests(unittest.TestCase):
    def test_actual_uid_sterile_home_and_no_privilege_or_network_relaxation(self):
        unit, argv = command(Layout("fixture"), "a" * 32, BINARY, 101, 102)
        self.assertIn("--property=User=101", argv)
        self.assertIn("--property=Group=102", argv)
        self.assertIn("--property=NoNewPrivileges=yes", argv)
        self.assertIn("--property=CapabilityBoundingSet=", argv)
        self.assertIn("--property=PrivateNetwork=yes", argv)
        self.assertIn("--property=RuntimeDirectoryPreserve=no", argv)
        self.assertIn("/usr/bin/env", argv)
        self.assertEqual(argv[-5:], ["sandbox", "-c", 'sandbox_mode="read-only"', "--", "/usr/bin/true"])
        self.assertTrue(unit.endswith(".service"))
        for uid, gid in ((0, 10), (10, 0), (True, 10)):
            with self.assertRaises(DeployError): command(Layout("fixture"), "a" * 32, BINARY, uid, gid)

    def test_probe_failure_and_timeout_stop_before_reporting_prerequisite(self):
        for error in (DeployError("command_failed", "failed"), subprocess.TimeoutExpired("probe", 60)):
            system = Mock()
            with patch("deploy.sandbox.Path.is_file", return_value=True), patch("deploy.sandbox.read_json", return_value={"workerUid": 101, "workerGid": 102}), patch("deploy.sandbox.run", side_effect=error), self.assertRaises(DeployError) as caught:
                preflight(Layout("fixture"), system, "a" * 32, BINARY)
            self.assertEqual(caught.exception.code, "sandbox_prerequisite")
            system.stop.assert_called_once()

    def test_unknown_stop_is_not_reclassified_as_prerequisite_and_missing_bwrap_does_not_launch(self):
        system = Mock()
        system.stop.side_effect = DeployError("stop_unknown", "still running")
        with patch("deploy.sandbox.Path.is_file", return_value=True), patch("deploy.sandbox.read_json", return_value={"workerUid": 101, "workerGid": 102}), patch("deploy.sandbox.run"), self.assertRaises(DeployError) as caught:
            preflight(Layout("fixture"), system, "a" * 32, BINARY)
        self.assertEqual(caught.exception.code, "stop_unknown")
        with patch("deploy.sandbox.Path.is_file", return_value=False), patch("deploy.sandbox.run") as runner, self.assertRaises(DeployError) as caught:
            preflight(Layout("fixture"), system, "a" * 32, BINARY)
        self.assertEqual(caught.exception.code, "prerequisite")
        runner.assert_not_called()
