"""Cross-transaction and service ownership regressions with real local files."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy import install
from deploy.common import DeployError, Layout


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


class InstallationPreflightTests(unittest.TestCase):
    def test_every_service_policy_and_instance_collision_precedes_initialization(self):
        cases = ["gateway", "worker", "authelia", "caddy", "dropin", "vendor-unit", "sudo", "work", "run", "control-records"]
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as folder:
                layout = Layout("fixture", Path(folder))
                paths = {
                    **{role: layout.units / layout.unit(role) for role in ("gateway", "worker", "authelia", "caddy")},
                    "dropin": layout.units / (layout.unit("gateway") + ".d") / "unrelated.conf",
                    "vendor-unit": layout.root / "usr/lib/systemd/system" / layout.unit("gateway"),
                    "sudo": layout.root / "etc/sudoers.d/codex-harness-fixture", "work": layout.work / "unrelated",
                    "run": layout.run / "unrelated", "control-records": layout.control.parent / ".fixture-control-transactions/old/state.json",
                }
                target = paths[case]
                target.parent.mkdir(parents=True)
                target.write_bytes(b"unrelated existing content")
                system = FixtureSystem(layout)
                with patch("deploy.install.require_linux"), patch("deploy.install.System", return_value=system), \
                     patch("deploy.install.ensure_account") as accounts:
                    with self.assertRaises(DeployError) as caught:
                        install.initialize(layout, origin="http://127.0.0.1:3300", port=3300)
                self.assertEqual(caught.exception.code, "collision")
                accounts.assert_not_called()
                self.assertFalse(layout.config.exists())
                self.assertFalse(layout.app.exists())
                self.assertEqual(target.read_bytes(), b"unrelated existing content")
                self.assertEqual(system.events, [])


if __name__ == "__main__":
    unittest.main()
