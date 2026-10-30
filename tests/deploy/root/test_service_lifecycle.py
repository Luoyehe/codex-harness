"""Real root-owned snapshots; every service and account operation is substituted."""
import contextlib
import base64
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout, atomic_write, digest, fsync_directory, mkdir, read_json, write_json
from deploy.manager import Manager
from deploy.ownership import ROLES
from deploy.safe_fs import inspect_tree
from deploy.service_lifecycle import restore_services, uninstall_services
from deploy.service_proxy import PROXY_ROLES
from deploy.units import render_edge_units, render_units, sudo_rule
from tests.deploy.test_control_update import previous_sudo_policy


class FixtureSystem:
    def __init__(self, layout):
        self.layout = layout
        self.active, self.enabled, self.events = set(), set(), []
        self.unknown = False

    def state(self, unit):
        active = unit in self.active
        routes = unit == self.layout.unit("proxy-routes")
        return {"LoadState": "loaded" if (self.layout.units / unit).exists() else "not-found", "ActiveState": "active" if active else "inactive",
                "SubState": ("exited" if routes else "running") if active else "dead",
                "MainPID": "100" if active and not routes else "0", "ControlPID": "0", "stopped": not active}

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
        self.manager.verify = lambda **kwargs: {"sudoPolicy": "current"}
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

    def configure_proxy(self):
        self.manager.config["serviceProxy"] = {"enabled": True, "port": 18793,
                                                "core": "a" * 64, "configuration": "b" * 64}
        write_json(self.layout.config / "instance.json", self.manager.config)
        for name, content in render_units(self.layout, self.manager.config, self.config["codexRelative"]).items():
            atomic_write(self.layout.units / name, content.encode(), 0o644)
        self.system.active.update(self.layout.unit(role) for role in PROXY_ROLES)
        self.system.enabled.add(self.layout.unit("proxy"))
        # Core/config byte ownership is exercised by proxy-specific root tests;
        # this fixture focuses on real retained service files and recovery.
        self.stack.enter_context(patch("deploy.proxy_core.verify_core", return_value={}))
        self.stack.enter_context(patch("deploy.service_proxy.verify_configuration"))

    def test_proxy_units_are_removed_and_restored_with_their_oneshot_activity(self):
        from deploy.service_lifecycle import service_paths
        self.configure_proxy()
        original_active, original_enabled = set(self.system.active), set(self.system.enabled)
        paths = service_paths(self.layout, self.manager.config)
        contents = {role: path.read_bytes() if path.exists() else None for role, path in paths.items()}
        config_bytes = (self.layout.config / "instance.json").read_bytes()
        uninstall_services(self.manager)
        record = read_json(self.journal())
        self.assertEqual(set(record["before"]), set(ROLES) | set(PROXY_ROLES) | {"sudo"})
        self.assertFalse(self.system.active)
        self.assertTrue(all(not path.exists() for path in paths.values()))
        restore_services(self.manager)
        self.assertEqual(self.system.active, original_active)
        self.assertEqual(self.system.enabled, original_enabled)
        self.assertEqual({role: path.read_bytes() if path.exists() else None for role, path in paths.items()}, contents)
        self.assertEqual((self.layout.config / "instance.json").read_bytes(), config_bytes)

    def test_restored_legacy_marker_allows_a_new_uninstall_after_proxy_is_configured(self):
        original = uninstall_services(self.manager)["transaction"]
        restore_services(self.manager)
        self.configure_proxy()
        selected = uninstall_services(self.manager)["transaction"]
        self.assertNotEqual(selected, original)
        self.assertIn("proxy-routes", read_json(self.journal())["before"])
        restore_services(self.manager)
        self.assertIn(self.layout.unit("proxy-routes"), self.system.active)

    def enable_real_verification(self):
        # Keep process/account/network calls isolated, but exercise the complete
        # Manager.verify file, release, provider and permission checks.
        self.config.update(workerUid=1002, supervisorUid=1003)
        self.manager.config = self.config
        write_json(self.layout.config / "instance.json", self.config)
        os.chown(self.layout.config / "gateway-token", 0, self.config["gatewayGid"])
        for role in ("gateway", "worker", "supervisor"):
            mkdir(self.layout.state / role, 0o700 if role == "gateway" else 0o750, self.config[role + "Uid"], 0)
        settings = {"kind": "responses", "revision": "a" * 32, "baseUrl": "https://provider.invalid/v1",
                    "model": "fixture-model", "apiKey": "fixture-secret", "models": []}
        self.manager.providers.select(self.manager.providers.prepare(settings))
        if Manager.selected(self.manager) is None:
            release = self.layout.app / "releases/stage"
            mkdir(release)
            atomic_write(release / "application.txt", b"verified fixture application", 0o644)
            manifest = inspect_tree(release, root_owned=True)
            identity = digest(manifest)
            release.rename(release.with_name(identity))
            mkdir(self.layout.config / "manifests")
            write_json(self.layout.config / "manifests" / (identity + ".json"), manifest)
            os.symlink("releases/" + identity, self.layout.app / "current")
        self.manager.selected = types.MethodType(Manager.selected, self.manager)
        self.manager.verify_release = types.MethodType(Manager.verify_release, self.manager)
        self.manager.verify = types.MethodType(Manager.verify, self.manager)
        self.https_verification = self.stack.enter_context(patch.object(self.manager, "verify_https", return_value={"configured": True}))

    def install_previous_sudo(self, *, workspace=True):
        data = previous_sudo_policy(self.layout, workspace=workspace)
        atomic_write(self.layout.root / "etc/sudoers.d/codex-harness-lifecycle", data, 0o440)
        return data

    def assert_recovery_pending(self):
        self.assertEqual(read_json(self.journal())["phase"], "restoring")
        self.assertFalse(self.system.active)
        for role in ROLES:
            self.assertTrue((self.layout.config / "service-lifecycle" / role).exists())

    def test_real_verification_restores_exact_legacy_policies_but_default_stays_strict(self):
        self.enable_real_verification()
        active, enabled = set(self.system.active), set(self.system.enabled)
        for workspace in (False, True):
            with self.subTest(workspace=workspace):
                old = self.install_previous_sudo(workspace=workspace)
                with self.assertRaisesRegex(DeployError, "Fixed sudo policy changed"):
                    self.manager.verify()
                uninstall_services(self.manager)
                result = restore_services(self.manager)
                self.assertEqual(result["sudoPolicy"], "retained-legacy")
                sudo = self.layout.root / "etc/sudoers.d/codex-harness-lifecycle"
                self.assertEqual(sudo.read_bytes(), old)
                self.assertEqual(sudo.stat().st_mode & 0o777, 0o440)
                self.assertEqual(self.system.active, active)
                self.assertEqual(self.system.enabled, enabled)
                self.assertEqual(read_json(self.journal())["phase"], "recovered")
                with self.assertRaisesRegex(DeployError, "Fixed sudo policy changed"):
                    self.manager.verify()
                with self.assertRaisesRegex(DeployError, "active restoration record"):
                    self.manager.verify(service_recovery=self.journal())
        self.assertEqual(self.https_verification.call_count, 2)

    def test_real_current_policy_verification_is_unchanged(self):
        self.enable_real_verification()
        self.assertEqual(self.manager.verify()["sudoPolicy"], "current")
        uninstall_services(self.manager)
        self.assertEqual(restore_services(self.manager)["sudoPolicy"], "current")
        self.assertEqual(self.manager.verify()["sudoPolicy"], "current")

    def test_legacy_context_requires_matching_active_journal(self):
        self.enable_real_verification()
        self.install_previous_sudo()
        with self.assertRaises(DeployError):
            self.manager.verify(service_recovery=self.layout.state / "transactions" / ("0" * 32) / "state.json")
        uninstall_services(self.manager)
        real_verify = self.manager.verify
        def wrong_context(**kwargs):
            return real_verify(https_probe=kwargs["https_probe"], service_recovery=self.journal().with_name("other.json"))
        with patch.object(self.manager, "verify", side_effect=wrong_context), self.assertRaises(DeployError):
            restore_services(self.manager)
        self.assert_recovery_pending()
        self.assertEqual(restore_services(self.manager)["sudoPolicy"], "retained-legacy")

    def test_legacy_restore_rejects_changed_policy_identity_and_metadata_then_retries(self):
        self.enable_real_verification()
        old = self.install_previous_sudo()
        uninstall_services(self.manager)
        sudo = self.layout.root / "etc/sudoers.d/codex-harness-lifecycle"
        linked = sudo.with_name("fixture-link")
        mutations = {"extra-command": lambda: sudo.write_bytes(old + b"root ALL=(ALL) NOPASSWD: ALL\n"),
                     "changed-command": lambda: sudo.write_bytes(old.replace(b"app-server", b"shell")),
                     "owner": lambda: os.chown(sudo, 65534, 65534),
                     "writable": lambda: sudo.chmod(0o660),
                     "safe-mode-drift": lambda: sudo.chmod(0o400),
                     "hardlink": lambda: os.link(sudo, linked)}
        for name, mutate in mutations.items():
            with self.subTest(mutation=name):
                with patch.object(self.manager, "healthy", side_effect=mutate), self.assertRaises(DeployError):
                    restore_services(self.manager)
                self.assert_recovery_pending()
                linked.unlink(missing_ok=True)
                atomic_write(sudo, old, 0o440)
        self.assertEqual(restore_services(self.manager)["sudoPolicy"], "retained-legacy")

    def test_matching_snapshot_cannot_authorize_unrecognized_policy(self):
        self.enable_real_verification()
        self.install_previous_sudo()
        uninstall_services(self.manager)
        record = read_json(self.journal())
        old = record["before"]["sudo"]
        old["data"] = base64.b64encode(base64.b64decode(old["data"]) + b"root ALL=(ALL) NOPASSWD: ALL\n").decode()
        write_json(self.journal(), record)
        marker = read_json(self.layout.config / "uninstalled.json")
        marker["snapshotDigest"] = digest({key: record[key] for key in ("before", "active", "enabled", "bindings")})
        write_json(self.layout.config / "uninstalled.json", marker)
        with self.assertRaises(DeployError):
            restore_services(self.manager)
        self.assert_recovery_pending()

    def test_legacy_compatibility_preserves_other_provider_and_https_checks(self):
        self.enable_real_verification()
        self.install_previous_sudo()
        uninstall_services(self.manager)
        provider = self.manager.providers.root / "current/config.toml"
        original = provider.read_bytes()
        with patch.object(self.manager, "healthy", side_effect=lambda: provider.write_bytes(b"changed provider")), self.assertRaises(DeployError):
            restore_services(self.manager)
        self.assert_recovery_pending()
        provider.write_bytes(original)
        with patch.object(self.manager, "verify_https", side_effect=DeployError("https_health", "fixture failed TLS")), self.assertRaises(DeployError):
            restore_services(self.manager)
        self.assert_recovery_pending()
        self.assertEqual(restore_services(self.manager)["sudoPolicy"], "retained-legacy")

    def test_real_verification_restores_stopped_legacy_workers_without_starting_them(self):
        self.enable_real_verification()
        self.system.active.clear()
        enabled = set(self.system.enabled)
        unit = self.layout.units / self.layout.unit("worker")
        for runtime, home in ((True, False), (False, True), (True, True)):
            with self.subTest(runtime=runtime, home=home):
                old = render_units(self.layout, self.config, self.config["codexRelative"],
                                   legacy_runtime_directory=runtime, legacy_native_home=home)[unit.name].encode()
                atomic_write(unit, old, 0o644)
                self.install_previous_sudo()
                with self.assertRaisesRegex(DeployError, "Service unit differs"):
                    self.manager.verify()
                uninstall_services(self.manager)
                with patch.object(self.manager, "healthy") as healthy:
                    result = restore_services(self.manager)
                    healthy.assert_not_called()
                self.assertEqual(result["unitPolicy"], "retained-legacy")
                self.assertEqual(result["sudoPolicy"], "retained-legacy")
                self.assertEqual(unit.read_bytes(), old)
                self.assertEqual(self.system.enabled, enabled)
                self.assertFalse(self.system.active)
                self.assertNotIn("start", self.system.events)
                self.https_verification.assert_called_with(probe=False)
                with self.assertRaisesRegex(DeployError, "Service unit differs"):
                    self.manager.verify()

    def test_legacy_worker_context_rejects_snapshot_mismatch_and_permission_drift(self):
        self.enable_real_verification()
        self.system.active.clear()
        unit = self.layout.units / self.layout.unit("worker")
        old = render_units(self.layout, self.config, self.config["codexRelative"], legacy_native_home=True)[unit.name].encode()
        other = render_units(self.layout, self.config, self.config["codexRelative"], legacy_runtime_directory=True)[unit.name].encode()
        atomic_write(unit, old, 0o644)
        uninstall_services(self.manager)
        real_verify = self.manager.verify
        for name, mutate in (("different-supported-variant", lambda: unit.write_bytes(other)),
                             ("safe-mode-drift", lambda: unit.chmod(0o600))):
            with self.subTest(mutation=name):
                def changed(**kwargs):
                    mutate()
                    return real_verify(**kwargs)
                with patch.object(self.manager, "verify", side_effect=changed), self.assertRaises(DeployError):
                    restore_services(self.manager)
                self.assert_recovery_pending()
                atomic_write(unit, old, 0o644)
        self.assertEqual(restore_services(self.manager)["unitPolicy"], "retained-legacy")
        self.assertNotIn("start", self.system.events)

    def test_matching_snapshot_cannot_authorize_extra_worker_commands(self):
        self.enable_real_verification()
        self.system.active.clear()
        unit = self.layout.units / self.layout.unit("worker")
        old = render_units(self.layout, self.config, self.config["codexRelative"], legacy_native_home=True)[unit.name].encode()
        atomic_write(unit, old, 0o644)
        uninstall_services(self.manager)
        record = read_json(self.journal())
        record["before"]["worker"]["data"] = base64.b64encode(old.replace(b"ExecStart=", b"ExecStartPre=/bin/false\nExecStart=")).decode()
        write_json(self.journal(), record)
        marker = read_json(self.layout.config / "uninstalled.json")
        marker["snapshotDigest"] = digest({key: record[key] for key in ("before", "active", "enabled", "bindings")})
        write_json(self.layout.config / "uninstalled.json", marker)
        with self.assertRaises(DeployError):
            restore_services(self.manager)
        self.assert_recovery_pending()
        self.assertNotIn("start", self.system.events)

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
                with patch.object(self.manager, "verify", return_value={"sudoPolicy": "current"}) as verify:
                    restore_services(self.manager)
                    verify.assert_called_once_with(https_probe=False, service_recovery=self.journal())
                self.assertEqual(self.system.active, {self.layout.unit(role) for role in roles})
                self.assertEqual(self.system.enabled, original_enabled)


if __name__ == "__main__": unittest.main()
