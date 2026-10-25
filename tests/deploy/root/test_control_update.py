"""Control maintenance fault injection; all system/process operations substituted."""
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from deploy.cli import parser
from deploy.common import DeployError, Layout, atomic_write, mkdir, read_json, write_json
from deploy.control_update import BLOCKER, ControlSystem, ControlUpdater, ROLES, require_no_pending_control, tree_manifest
from deploy.install import stage_control, write_control_launchers
from deploy.safe_fs import inspect_tree
from deploy.units import render_units, render_edge_units, sudo_rule


class PowerLoss(BaseException):
    pass


class FixtureSystem:
    def __init__(self, layout):
        self.layout = layout
        self.active = {"worker", "caddy"}
        self.enabled = {role: ("enabled" if role in ("gateway", "authelia") else "disabled") for role in ROLES}
        self.events = []
        self.failure = None
        self.failed = False
        self.unknown = False
        self.processes_remain = False
        self.transient = "codex-harness-fixture-manage-" + "a" * 32 + ".service"

    def fault(self, event):
        if self.failure == event and not self.failed:
            self.failed = True
            raise DeployError("injected", "One-time " + event + " failure")

    def state(self, unit):
        role = next((role for role in ROLES if self.layout.unit(role) == unit), None)
        active = role in self.active
        return {"LoadState": "loaded", "ActiveState": "active" if active else "inactive",
                "SubState": "running" if active else "dead", "MainPID": "123" if active else "0",
                "ControlPID": "0", "stopped": not active}

    def enabled_state(self, unit):
        return self.enabled[next(role for role in ROLES if self.layout.unit(role) == unit)]

    def instance_units(self, layout):
        self.events.append("enumerate")
        return [self.transient]

    def stop(self, units):
        self.events.append(("stop", units))
        if self.unknown:
            raise DeployError("stop_unknown", "Injected uncertain cgroup stop")
        self.active.difference_update(role for role in ROLES if self.layout.unit(role) in units)

    def no_instance_processes(self, layout, config):
        self.events.append("process-confirmation")
        if self.processes_remain:
            raise DeployError("stop_unknown", "Injected process outside cgroups")

    def start(self, units):
        self.events.append(("start", units))
        for role in ROLES:
            if self.layout.unit(role) in units:
                if not (self.layout.config / "control-maintenance" / role).exists():
                    self.active.add(role)
        # Model Wants=worker when restoring a previously isolated gateway.
        if "gateway" in self.active and not (self.layout.config / "control-maintenance/worker").exists():
            self.active.add("worker")
        self.fault("start")

    def reload(self):
        self.events.append("reload")
        self.fault("reload")

    def control_healthy(self, layout, config):
        self.events.append("health")
        self.fault("health")


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root ownership fixture")
class ControlUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="control-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout("fixture", Path(self.temp.name))
        for path in (self.layout.config, self.layout.units, self.layout.state / "gateway", self.layout.control / "deploy"):
            mkdir(path)
        config = {"gatewayUid": 101, "gatewayGid": 101, "workerGid": 102, "port": 3300,
                  "origin": "http://127.0.0.1:3300", "codexRelative": "vendor/fixture/codex"}
        write_json(self.layout.config / "instance.json", config)
        for name, content in {**render_units(self.layout, config, config["codexRelative"]), **render_edge_units(self.layout)}.items():
            atomic_write(self.layout.units / name, content.encode(), 0o644)
        mkdir(self.layout.root / "etc/sudoers.d")
        atomic_write(self.layout.root / "etc/sudoers.d" / ("codex-harness-" + self.layout.instance), sudo_rule(self.layout).encode(), 0o644)
        for name in ("manage", "native-launch", "deploy/cli.py", "deploy/native_launcher.py"):
            atomic_write(self.layout.control / name, ("old " + name).encode(), 0o755 if "/" not in name else 0o644)
        write_json(self.layout.control / "capabilities.json", {"format": 1, "providerConfigLayer": "system-v1", "nativeWorkspace": 1}, mode=0o644)
        for path in (self.layout.config / "gateway-token", self.layout.config / "identity-key", self.layout.state / "identity-db"):
            atomic_write(path, b"opaque paired secret fixture")
        self.secret_paths = [self.layout.config / "gateway-token", self.layout.config / "identity-key", self.layout.state / "identity-db"]
        self.system = FixtureSystem(self.layout)
        self.updater = ControlUpdater(self.layout, self.system)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        # Pure relocated filesystem fixture. Production ancestry checks require
        # Linux root and intentionally reject world-writable OS temporary parents.
        self.stack.enter_context(patch("deploy.control_update.trusted_ancestors", side_effect=self.check_real_directories))
        self.stack.enter_context(patch("deploy.control_update.stage_control", side_effect=self.make_candidate))
        self.probe = self.stack.enter_context(patch("deploy.control_update.run", return_value=subprocess.CompletedProcess([], 0, "", "")))
        self.stack.enter_context(patch("deploy.control_update.snapshot", side_effect=self.copy_fixture))

    def check_real_directories(self, path):
        for item in [path, *path.parents]:
            if item.exists() or item.is_symlink():
                if item.is_symlink() or not item.is_dir():
                    raise DeployError("unsafe_path", "Fixture path is not a real directory")

    def copy_fixture(self, source, target, **kwargs):
        shutil.copytree(source, target)
        return inspect_tree(target)

    def make_candidate(self, layout, destination):
        mkdir(destination / "deploy")
        for name in ("manage", "native-launch", "deploy/cli.py", "deploy/native_launcher.py"):
            atomic_write(destination / name, ("new " + name).encode(), 0o755 if "/" not in name else 0o644)
        write_json(destination / "capabilities.json", {"format": 1, "providerConfigLayer": "system-v1", "nativeWorkspace": 1}, mode=0o644)

    def current(self):
        return (self.layout.control / "manage").read_bytes()

    def transaction(self):
        return next(path for path in self.updater.records.iterdir() if (path / "state.json").exists())

    def assert_secrets_preserved(self):
        for path in self.secret_paths:
            self.assertEqual(path.read_bytes(), b"opaque paired secret fixture")

    def test_update_preserves_independent_active_and_enabled_sets_and_old_tree(self):
        enabled = dict(self.system.enabled)
        result = self.updater.update()
        tx = self.updater.records / result["transaction"]
        self.assertEqual(self.current(), b"new manage")
        self.assertEqual((tx / "old/manage").read_bytes(), b"old manage")
        self.assertEqual(self.system.active, {"worker", "caddy"})
        self.assertEqual(self.system.enabled, enabled)
        self.assertEqual(read_json(tx / "state.json")["phase"], "committed")
        self.assertFalse(self.layout.control.is_symlink())
        self.assertGreaterEqual(self.system.events.count("enumerate"), 2)
        self.assertTrue(all(self.system.transient in event[1] for event in self.system.events if isinstance(event, tuple) and event[0] == "stop"))
        self.assertEqual(list(self.updater.barriers.iterdir()), [])
        self.assert_secrets_preserved()

    def test_gateway_only_restoration_does_not_start_previously_stopped_worker(self):
        self.system.active = {"gateway"}
        self.updater.update()
        self.assertEqual(self.system.active, {"gateway"})
        self.assertNotIn("health", self.system.events)

    def test_initialized_instance_without_application_release_stays_stopped(self):
        self.system.active.clear()
        self.updater.update()
        self.assertEqual(self.system.active, set())
        self.assertFalse(any(isinstance(event, tuple) and event[0] == "start" for event in self.system.events))

    def test_probe_failure_never_stops_services_or_replaces_control(self):
        self.probe.side_effect = DeployError("probe", "Injected trusted import failure")
        with self.assertRaises(DeployError):
            self.updater.update()
        self.assertEqual(self.current(), b"old manage")
        self.assertEqual(self.system.active, {"worker", "caddy"})
        self.assertFalse(any(isinstance(event, tuple) for event in self.system.events))

    def test_unknown_stop_retains_trees_and_persistent_start_barriers(self):
        self.system.unknown = True
        with self.assertRaises(DeployError) as caught:
            self.updater.update()
        self.assertEqual(caught.exception.code, "stop_unknown")
        tx = self.transaction()
        self.assertEqual(self.current(), BLOCKER)
        self.assertEqual((self.layout.control / "deploy/cli.py").read_bytes(), b"old deploy/cli.py")
        self.assertTrue((tx / "candidate").exists())
        self.assertFalse((tx / "old").exists())
        self.assertEqual({p.name for p in self.updater.barriers.iterdir()}, set(ROLES))
        with self.assertRaises(DeployError):
            require_no_pending_control(self.layout)
        with self.assertRaises(DeployError):
            self.updater.update()
        self.system.unknown = False
        self.updater.recover()
        self.assertEqual(self.system.active, {"worker", "caddy"})

    def test_escaped_account_process_prevents_any_control_directory_rename(self):
        self.system.processes_remain = True
        with self.assertRaises(DeployError) as caught:
            self.updater.update()
        self.assertEqual(caught.exception.code, "stop_unknown")
        self.assertEqual(self.current(), BLOCKER)
        self.assertFalse((self.transaction() / "old").exists())

    def test_start_failure_restores_old_code_and_exact_activity(self):
        self.system.failure = "start"
        with self.assertRaises(DeployError):
            self.updater.update()
        self.assertEqual(self.current(), b"old manage")
        self.assertEqual(self.system.active, {"worker", "caddy"})
        tx = self.transaction()
        self.assertEqual((tx / "failed/manage").read_bytes(), b"new manage")
        self.assertEqual(read_json(tx / "state.json")["phase"], "recovered")
        self.assert_secrets_preserved()

    def test_health_failure_restores_old_code(self):
        self.system.active = {"worker", "gateway"}
        self.system.failure = "health"
        with self.assertRaises(DeployError):
            self.updater.update()
        self.assertEqual(self.current(), b"old manage")
        self.assertEqual(self.system.active, {"worker", "gateway"})

    def test_reload_failure_restores_old_activity_without_changing_code(self):
        self.system.failure = "reload"
        with self.assertRaises(DeployError):
            self.updater.update()
        self.assertEqual(self.current(), b"old manage")
        self.assertEqual(self.system.active, {"worker", "caddy"})

    def test_crashes_before_and_between_directory_renames_recover(self):
        for crash_point in ("prepared", "stopped", "old_moved", "installed"):
            with self.subTest(crash_point=crash_point):
                original = self.updater.save
                def save(path, state, phase):
                    original(path, state, phase)
                    if phase == crash_point:
                        raise PowerLoss()
                with patch.object(self.updater, "save", side_effect=save), self.assertRaises(PowerLoss):
                    self.updater.update()
                self.updater.recover()
                self.assertEqual(self.current(), b"old manage")
                self.assertEqual(self.system.active, {"worker", "caddy"})
                self.assert_secrets_preserved()

    def test_crash_after_rename_before_phase_write_is_recovered_from_files(self):
        original = self.updater.rename
        def rename(source, target):
            original(source, target)
            if target.name == "old":
                raise PowerLoss()
        with patch.object(self.updater, "rename", side_effect=rename), self.assertRaises(PowerLoss):
            self.updater.update()
        self.assertFalse(self.layout.control.exists())
        self.updater.recover()
        self.assertEqual(self.current(), b"old manage")

    def test_old_helper_cache_written_during_stop_is_sealed_without_changing_source(self):
        original = self.system.stop
        def stop(units):
            original(units)
            mkdir(self.layout.control / "deploy/__pycache__")
            atomic_write(self.layout.control / "deploy/__pycache__/cli.cpython-311.pyc", b"legacy root-owned cache")
        with patch.object(self.system, "stop", side_effect=stop):
            result = self.updater.update()
        tx = self.updater.records / result["transaction"]
        self.assertEqual((tx / "old/deploy/__pycache__/cli.cpython-311.pyc").read_bytes(), b"legacy root-owned cache")
        self.assertIn("deploy/__pycache__/cli.cpython-311.pyc", read_json(tx / "state.json")["old"])

    def test_launchers_are_durably_blocked_before_any_control_directory_rename(self):
        original = self.updater.rename
        checked = []
        def rename(source, target):
            if source == self.layout.control:
                for name in ("manage", "native-launch"):
                    self.assertEqual((source / name).read_bytes(), BLOCKER)
                self.assertTrue((target.parent / "state.json").is_file())
                self.assertEqual((source / "deploy/cli.py").read_bytes(), b"old deploy/cli.py")
                checked.append(True)
            original(source, target)
        with patch.object(self.updater, "rename", side_effect=rename):
            self.updater.update()
        self.assertEqual(checked, [True])

    def test_new_fixed_bootstrap_rejects_pending_transaction_before_importing_legacy_modules(self):
        self.system.unknown = True
        with self.assertRaises(DeployError):
            self.updater.update()
        # Use the same bootstrap that rollback installs around old modules. The
        # deliberately invalid fixture cli.py would fail if imported at all.
        write_control_launchers(self.layout, self.layout.control)
        result = subprocess.run([sys.executable, "-I", str(self.layout.control / "manage"), "rpc"],
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 75)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(list(self.layout.control.rglob("*.pyc")), [])

    def test_dropin_collision_does_not_install_entrypoint_or_service_barriers(self):
        directory = self.layout.units / (self.layout.unit("caddy") + ".d")
        mkdir(directory)
        atomic_write(directory / "90-codex-harness-control-maintenance.conf", b"unrelated root drop-in")
        with self.assertRaises(DeployError):
            self.updater.update()
        self.assertEqual(self.current(), b"old manage")
        self.assertFalse(self.updater.barriers.exists())
        self.assertEqual(self.system.active, {"worker", "caddy"})
        self.assertEqual(self.updater.pending(), [])
        require_no_pending_control(self.layout)

    def test_tampered_old_generation_blocks_recovery_and_leaves_every_service_stopped(self):
        original = self.updater.save
        def save(path, state, phase):
            original(path, state, phase)
            if phase == "installed":
                raise PowerLoss()
        with patch.object(self.updater, "save", side_effect=save), self.assertRaises(PowerLoss):
            self.updater.update()
        (self.transaction() / "old/manage").write_bytes(b"tampered")
        with self.assertRaises(DeployError) as caught:
            self.updater.recover()
        self.assertEqual(caught.exception.code, "integrity")
        self.assertEqual(self.current(), BLOCKER)
        self.assertEqual((self.layout.control / "deploy/cli.py").read_bytes(), b"new deploy/cli.py")
        self.assertEqual(self.system.active, set())
        self.assertEqual({p.name for p in self.updater.barriers.iterdir()}, set(ROLES))

    def add_edge(self, kind, data):
        mkdir(self.layout.control / "edge" / kind)
        atomic_write(self.layout.control / "edge" / kind / kind, data, 0o755)
        write_json(self.layout.config / (kind + "-binary.json"), {"version": "fixture", "sha256": hashlib.sha256(data).hexdigest()})

    def test_update_preserves_edge_binary_and_config_binding(self):
        self.add_edge("caddy", b"verified edge fixture")
        metadata = (self.layout.config / "caddy-binary.json").read_bytes()
        self.updater.update()
        self.assertEqual((self.layout.control / "edge/caddy/caddy").read_bytes(), b"verified edge fixture")
        self.assertEqual((self.layout.config / "caddy-binary.json").read_bytes(), metadata)

    def test_rollback_restores_code_but_preserves_edge_installed_after_original_update(self):
        result = self.updater.update()
        self.add_edge("authelia", b"later verified edge")
        rollback = self.updater.update(result["transaction"])
        self.assertIn(b"sys.dont_write_bytecode = True", self.current())
        self.assertEqual((self.layout.control / "deploy/cli.py").read_bytes(), b"old deploy/cli.py")
        self.assertEqual((self.layout.control / "edge/authelia/authelia").read_bytes(), b"later verified edge")
        self.assertEqual(rollback["rollbackOf"], result["transaction"])
        self.assertEqual(self.system.active, {"worker", "caddy"})

    def test_old_control_rollback_requires_legacy_namespace_and_sudo_first(self):
        (self.layout.control / "capabilities.json").unlink()
        result = self.updater.update()
        self.system.events.clear()
        with self.assertRaises(DeployError) as caught:
            self.updater.update(result["transaction"])
        self.assertEqual(caught.exception.code, "configuration_conflict")
        self.assertFalse(any(isinstance(event, tuple) for event in self.system.events))
        atomic_write(self.layout.root / "etc/sudoers.d" / ("codex-harness-" + self.layout.instance),
                     sudo_rule(self.layout, workspace=False).encode(), 0o440)
        self.updater.update(result["transaction"])
        self.assertEqual((self.layout.control / "deploy/cli.py").read_bytes(), b"old deploy/cli.py")

    def test_old_control_without_layer_support_is_rejected_before_any_stop(self):
        write_json(self.layout.control / "capabilities.json", {"format": 1, "nativeWorkspace": 1}, mode=0o644)
        result = self.updater.update()
        self.updater.config["providerConfigLayer"] = "system-v1"
        write_json(self.layout.config / "instance.json", self.updater.config)
        for name, content in render_units(self.layout, self.updater.config, self.updater.config["codexRelative"]).items():
            atomic_write(self.layout.units / name, content.encode(), 0o644)
        self.system.events.clear()
        with self.assertRaises(DeployError) as caught:
            self.updater.update(result["transaction"])
        self.assertEqual(caught.exception.code, "configuration_conflict")
        self.assertFalse(any(isinstance(event, tuple) for event in self.system.events))

    def test_mismatched_edge_hash_aborts_before_services_stop(self):
        self.add_edge("caddy", b"verified edge fixture")
        (self.layout.control / "edge/caddy/caddy").write_bytes(b"changed")
        with self.assertRaises(DeployError):
            self.updater.update()
        self.assertEqual(self.system.active, {"worker", "caddy"})
        self.assertEqual(self.current(), b"old manage")
        self.assertEqual((self.layout.control / "deploy/cli.py").read_bytes(), b"old deploy/cli.py")

    def test_enablement_change_cannot_be_silently_committed(self):
        original = self.updater.rename
        def rename(source, target):
            original(source, target)
            if target == self.layout.control:
                self.system.enabled["worker"] = "enabled"
        with patch.object(self.updater, "rename", side_effect=rename), self.assertRaises(DeployError):
            self.updater.update()
        self.assertEqual(self.current(), BLOCKER)
        self.assertEqual((self.layout.control / "deploy/cli.py").read_bytes(), b"old deploy/cli.py")
        self.assertEqual(self.system.active, set())
        self.assertTrue(self.updater.pending())


if __name__ == "__main__":
    unittest.main()
