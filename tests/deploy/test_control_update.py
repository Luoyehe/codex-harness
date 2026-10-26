"""Unprivileged control maintenance interface checks."""
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.cli import parser
from deploy.common import Layout, read_json
from deploy.control_update import ControlSystem
from deploy.install import stage_control


class ControlBoundaryTests(unittest.TestCase):
    def test_operator_control_commands_have_no_candidate_archive_argument(self):
        self.assertEqual(parser().parse_args(["control-update"]).command, "control-update")
        self.assertEqual(parser().parse_args(["control-recover"]).command, "control-recover")
        self.assertEqual(parser().parse_args(["control-recover", "--target", "candidate"]).target, "candidate")
        self.assertEqual(parser().parse_args(["repair", "--target", "candidate"]).target, "candidate")
        self.assertEqual(parser().parse_args(["control-rollback", "--transaction", "a" * 32]).transaction, "a" * 32)
        with patch("sys.stderr"), self.assertRaises(SystemExit):
            parser().parse_args(["control-update", "--source", "/tmp/untrusted.tgz"])

    def test_instance_prefix_does_not_stop_another_instance_with_longer_name(self):
        text = "\n".join([
            "codex-harness-main-worker.service loaded active running worker",
            "codex-harness-main-other-worker.service loaded active running other",
            "codex-harness-main-manage-" + "a" * 32 + ".service loaded active running helper",
            "codex-harness-main-other-manage-" + "b" * 32 + ".service loaded active running other helper",
            "codex-harness-main-sandbox-" + "c" * 32 + ".service loaded active running sandbox probe",
            "codex-harness-main-other-sandbox-" + "d" * 32 + ".service loaded active running other sandbox probe",
        ])
        with patch("deploy.control_update.run", return_value=subprocess.CompletedProcess([], 0, text, "")):
            units = ControlSystem().instance_units(Layout("main"))
        self.assertEqual(len(units), 3)
        self.assertFalse(any("main-other" in unit for unit in units))

    def test_stage_has_fixed_real_paths_and_excludes_checkout_bytecode(self):
        with tempfile.TemporaryDirectory(prefix="stage-control-") as folder:
            layout = Layout("fixture", Path(folder))
            destination = Path(folder) / "staged"
            stage_control(layout, destination)
            self.assertEqual(read_json(destination / "capabilities.json")["authenticationGuard"], "account-v1")
            self.assertTrue((destination / "deploy/control_update.py").is_file())
            self.assertEqual(list(destination.rglob("*.pyc")), [])
            self.assertFalse((destination / "deploy/README.md").exists())
            for name in ("manage", "native-launch"):
                content = (destination / name).read_text()
                self.assertIn("sys.dont_write_bytecode = True", content)
                self.assertIn(repr(str(layout.control)), content)
                self.assertFalse((destination / name).is_symlink())


if __name__ == "__main__":
    unittest.main()
