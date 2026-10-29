"""Real root-owned snapshots; every service and account operation is substituted."""
import contextlib
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout, atomic_write, fsync_directory, mkdir, read_json, write_json
from deploy.manager import Manager
from deploy.ownership import ROLES
from deploy.service_lifecycle import restore_services, uninstall_services
from deploy.units import render_edge_units, render_units, sudo_rule


class FixtureSystem:
    def __init__(self, layout):
        self.layout = layout
        self.active, self.enabled, self.events = set(), set(), []
        self.unknown = False

    def state(self, unit):
        active = unit in self.active
        return {"LoadState": "loaded" if (self.layout.units / unit).exists() else "not-found", "ActiveState": "active" if active else "inactive",
                "SubState": "running" if active else "dead", "MainPID": "100" if active else "0", "ControlPID": "0", "stopped": not active}

    def stop(self, units):
        self.events.append("stop")
        if self.unknown: raise DeployError("stop_unknown", "Fixture unknown stop")
        self.active.difference_update(units)

    def start(self, units):
        self.events.append("start")
        self.active.update(units)

    def reload(self): self.events.append("reload")
    def enable(self, units): self.enabled.update(units)


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root ownership fixture")
class ServiceLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout("lifecycle", Path(self.temp.name))
        for path in (self.layout.config, self.layout.units, self.layout.control, self.layout.state / "transactions", self.layout.root / "etc/sudoers.d"):
            mkdir(path)
        self.config = {"port": 3300, "origin": "https://fixture.example.test", "workerGid": 1002, "gatewayUid": 1001,
                       "gatewayGid": 1001, "codexRelative": "vendor/fixture/codex"}
        write_json(self.layout.config / "instance.json", self.config)
        write_json(self.layout.config / "https.json", {"host": "fixture.example.test", "authentication": "builtin", "tls": "internal"})
        atomic_write(self.layout.config / "Caddyfile", b"retained caddy config", 0o644)
        atomic_write(self.layout.config / "gateway-token", b"private retained token", 0o640)
        atomic_write(self.layout.control / "manage", b"retained trusted helper", 0o755)
        for name, content in {**render_units(self.layout, self.config, self.config["codexRelative"]), **render_edge_units(self.layout, builtin=True)}.items():
            atomic_write(self.layout.units / name, content.encode(), 0o644)
        atomic_write(self.layout.root / "etc/sudoers.d/codex-harness-lifecycle", sudo_rule(self.layout).encode(), 0o440)
        self.system = FixtureSystem(self.layout)
        self.system.active = {self.layout.unit(role) for role in ("gateway", "worker", "caddy")}
        self.system.enabled = {self.layout.unit(role) for role in ("gateway", "caddy")}
        self.manager = Manager(self.layout, self.system, worker_gid=1002)
        self.manager.selected = lambda name="current": "a" * 64 if name == "current" else None
        self.manager.verify_release = lambda release: {"release": release}
        self.manager.recover_control = lambda: None
        self.manager.healthy = lambda: None
        self.manager.verify = lambda **kwargs: None
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch("deploy.service_lifecycle.identity_state", return_value={"fixture": "exact numeric identities"}))
        self.stack.enter_context(patch("deploy.control_update.require_no_pending_control"))
        self.command = self.stack.enter_context(patch("deploy.service_lifecycle.run", side_effect=self.run_command))

    def run_command(self, argv, **kwargs):
        if "is-enabled" in argv:
            unit = argv[-1]
            enabled = unit in self.system.enabled
            return types.SimpleNamespace(stdout="enabled\n" if enabled else "disabled\n", returncode=0 if enabled else 1)
        if "disable" in argv: self.system.enabled.difference_update(argv[2:])
        return types.SimpleNamespace(stdout="", returncode=0)

    def journal(self):
        marker = read_json(self.layout.config / "uninstalled.json")
        return self.layout.state / "transactions" / marker["transaction"] / "state.json"

    def test_transaction_parent_failure_prevents_uninstall_marker_stop_and_deletion(self):
        from deploy.service_lifecycle import service_paths
        before = {name: path.read_bytes() if path.exists() else None for name, path in service_paths(self.layout).items()}
        def fail(path, **kwargs):
            if path == self.layout.state / "transactions":
                raise OSError("Injected uninstall journal publication failure")
            return fsync_directory(path, **kwargs)
        with patch("deploy.common.fsync_directory", side_effect=fail), self.assertRaises(OSError):
            uninstall_services(self.manager)
        self.assertEqual(self.system.events, [])
        self.assertFalse((self.layout.config / "uninstalled.json").exists())
        self.assertEqual({name: path.read_bytes() if path.exists() else None for name, path in service_paths(self.layout).items()}, before)

    def test_roundtrip_restores_exact_activity_enablement_and_tls_material(self):
        active, enabled = set(self.system.active), set(self.system.enabled)
        token = (self.layout.config / "gateway-token").read_bytes()
        uninstall_services(self.manager)
        self.assertEqual(self.system.active, set())
        self.assertEqual(read_json(self.journal())["phase"], "removed")
        self.assertFalse((self.layout.units / self.layout.unit("caddy")).exists())
        self.assertTrue((self.layout.config / "service-lifecycle/caddy").exists())
        result = restore_services(self.manager)
        self.assertTrue(result["servicesRestored"])
        self.assertEqual(self.system.active, active)
        self.assertEqual(self.system.enabled, enabled)
        self.assertEqual((self.layout.config / "gateway-token").read_bytes(), token)
        self.assertEqual(read_json(self.journal())["phase"], "recovered")
        self.assertFalse((self.layout.config / "service-lifecycle/caddy").exists())

    def test_unknown_stop_preserves_definitions_and_blocks_restart_until_retry(self):
        self.system.unknown = True
        with self.assertRaises(DeployError): uninstall_services(self.manager)
        self.assertTrue((self.layout.units / self.layout.unit("gateway")).exists())
        self.assertTrue((self.layout.config / "service-lifecycle/gateway").exists())
        self.assertEqual(read_json(self.journal())["phase"], "prepared")
        self.system.unknown = False
        restore_services(self.manager)
        self.assertEqual(read_json(self.journal())["phase"], "recovered")

    def test_partial_uninstall_and_missing_convenience_marker_are_recoverable(self):
        original = Path.unlink
        target = self.layout.units / self.layout.unit("gateway")
        def interrupt(path, *args, **kwargs):
            original(path, *args, **kwargs)
            if path == target: raise KeyboardInterrupt("loss after first unit removal")
        with patch.object(Path, "unlink", interrupt), self.assertRaises(KeyboardInterrupt): uninstall_services(self.manager)
        self.assertFalse(target.exists())
        (self.layout.config / "uninstalled.json").unlink()
        restore_services(self.manager)
        self.assertTrue(target.exists())

    def test_tampered_configuration_and_foreign_units_are_not_overwritten(self):
        uninstall_services(self.manager)
        token = self.layout.config / "gateway-token"
        original = token.read_bytes()
        token.write_bytes(b"different token")
        with self.assertRaises(DeployError): restore_services(self.manager)
        self.assertEqual(token.read_bytes(), b"different token")
        token.write_bytes(original)
        unit = self.layout.units / self.layout.unit("gateway")
        unit.write_bytes(b"foreign service")
        with self.assertRaises(DeployError): restore_services(self.manager)
        self.assertEqual(unit.read_bytes(), b"foreign service")

    def test_failed_restore_health_retains_barriers_and_retry_succeeds(self):
        uninstall_services(self.manager)
        with patch.object(self.manager, "healthy", side_effect=DeployError("health", "failure")), self.assertRaises(DeployError): restore_services(self.manager)
        self.assertEqual(self.system.active, set())
        self.assertTrue((self.layout.config / "service-lifecycle/gateway").exists())
        self.assertEqual(read_json(self.journal())["phase"], "restoring")
        restore_services(self.manager)
        self.assertEqual(read_json(self.journal())["phase"], "recovered")

    def test_legacy_marker_and_unrelated_transaction_refuse_restoration(self):
        write_json(self.layout.config / "uninstalled.json", {"servicesRemoved": True, "dataPreserved": True})
        with self.assertRaises(DeployError): restore_services(self.manager)
        (self.layout.config / "uninstalled.json").unlink()
        uninstall_services(self.manager)
        path = self.layout.state / "transactions/other"
        mkdir(path)
        write_json(path / "state.json", {"kind": "provider", "phase": "selected"})
        with self.assertRaises(DeployError): restore_services(self.manager)

    def test_last_marker_failure_keeps_journal_pending_and_retry_restores(self):
        uninstall_services(self.manager)
        original = write_json
        def fail_marker(path, value, **kwargs):
            if path == self.layout.config / "uninstalled.json" and value.get("servicesRestored"):
                raise OSError("completion marker failed")
            return original(path, value, **kwargs)
        with patch("deploy.service_lifecycle.write_json", side_effect=fail_marker), self.assertRaises(DeployError): restore_services(self.manager)
        self.assertEqual(read_json(self.journal())["phase"], "restoring")
        self.assertFalse(self.system.active)
        restore_services(self.manager)
        self.assertEqual(read_json(self.journal())["phase"], "recovered")

    def test_terminal_journal_published_then_error_does_not_stop_verified_services(self):
        uninstall_services(self.manager)
        original = write_json
        def publish_then_fail(path, value, **kwargs):
            original(path, value, **kwargs)
            if path.name == "state.json" and value.get("phase") == "recovered": raise OSError("directory fsync failed")
        with patch("deploy.service_lifecycle.write_json", side_effect=publish_then_fail), self.assertRaises(OSError): restore_services(self.manager)
        self.assertEqual(read_json(self.journal())["phase"], "recovered")
        self.assertTrue(self.system.active)
        self.assertFalse((self.layout.config / "service-lifecycle/gateway").exists())
        self.assertTrue(restore_services(self.manager)["alreadyRestored"])

    def test_second_uninstall_journal_precedes_new_marker_and_can_recover(self):
        uninstall_services(self.manager)
        restore_services(self.manager)
        old = read_json(self.layout.config / "uninstalled.json")["transaction"]
        original = write_json
        def fail_new_marker(path, value, **kwargs):
            if path == self.layout.config / "uninstalled.json" and value.get("transaction") != old:
                raise KeyboardInterrupt("new journal persisted before marker")
            return original(path, value, **kwargs)
        with patch("deploy.service_lifecycle.write_json", side_effect=fail_new_marker), self.assertRaises(KeyboardInterrupt): uninstall_services(self.manager)
        self.assertEqual(read_json(self.layout.config / "uninstalled.json")["transaction"], old)
        restore_services(self.manager)
        self.assertNotEqual(read_json(self.layout.config / "uninstalled.json")["transaction"], old)
        self.assertEqual(read_json(self.journal())["phase"], "recovered")

    def test_independent_activity_sets_preserve_stopped_dependencies_and_skip_live_probe(self):
        for roles in (set(), {"caddy"}, {"gateway"}):
            with self.subTest(roles=roles):
                self.system.active = {self.layout.unit(role) for role in roles}
                original_enabled = set(self.system.enabled)
                uninstall_services(self.manager)
                with patch.object(self.manager, "verify") as verify:
                    restore_services(self.manager)
                    verify.assert_called_once_with(https_probe=False)
                self.assertEqual(self.system.active, {self.layout.unit(role) for role in roles})
                self.assertEqual(self.system.enabled, original_enabled)


if __name__ == "__main__": unittest.main()
