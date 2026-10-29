"""Control maintenance fault injection; all system/process operations substituted."""
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest.mock import patch

from deploy.cli import parser
from deploy.common import DeployError, Layout, atomic_write, digest, mkdir, read_json, write_json
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
        write_json(destination / "capabilities.json", {"format": 1, "providerConfigLayer": "system-v1", "nativeWorkspace": 1,
                                                      "authenticationGuard": "account-v1", "dnsChallenge": "caddy-dns-v1"}, mode=0o644)

    def current(self):
        return (self.layout.control / "manage").read_bytes()

    def test_initial_staging_accepts_user_owned_exact_recipe_and_rejects_tampering(self):
        from deploy.dns_caddy_build import source_material
        material = source_material()
        source = self.layout.root / "reviewed/deploy/caddy_dns_source"
        mkdir(source)
        for name, data in material.items():
            atomic_write(source / name, data, 0o644, 65534, 65534)
        os.chown(source, 65534, 65534)
        with patch("deploy.dns_caddy_build.__file__", str(source.parent / "dns_caddy_build.py")):
            destination = self.layout.root / "new-control"
            stage_control(self.layout, destination)
            for name, data in material.items():
                self.assertEqual((destination / "deploy/caddy_dns_source" / name).read_bytes(), data)
            atomic_write(source / "main.go", material["main.go"] + b"// changed\n", 0o644, 65534, 65534)
            rejected = self.layout.root / "rejected-control"
            with self.assertRaisesRegex(DeployError, "differs from reviewed recipe"):
                stage_control(self.layout, rejected)
            self.assertFalse((rejected / "manage").exists())
            self.assertFalse((rejected / "capabilities.json").exists())

    def transaction(self):
        return next(path for path in self.updater.records.iterdir() if (path / "state.json").exists())

    def assert_secrets_preserved(self):
        for path in self.secret_paths:
            self.assertEqual(path.read_bytes(), b"opaque paired secret fixture")

    @contextmanager
    def terminal_failure(self, phase, *, published):
        from deploy.common import fsync_directory
        replace = os.replace
        observed = {}

        def fail():
            observed.update(active=set(self.system.active), enabled=dict(self.system.enabled),
                            events=list(self.system.events), launcher=self.current())
            raise OSError("Injected terminal publication failure")

        def replacing(source, target):
            target = Path(target)
            if not published and target.name == "state.json" and target.parent.parent == self.updater.records and read_json(Path(source)).get("phase") == phase:
                fail()
            return replace(source, target)

        def syncing(directory, **kwargs):
            directory = Path(directory)
            journal = directory / "state.json"
            if published and directory.parent == self.updater.records and journal.exists() and read_json(journal).get("phase") == phase:
                # atomic_write has performed the real os.replace, but has not
                # completed its directory fsync. This is an ambiguous write.
                fail()
            return fsync_directory(directory, **kwargs)

        with patch("deploy.common.os.replace", side_effect=replacing), patch("deploy.common.fsync_directory", side_effect=syncing):
            yield observed

    def assert_terminal_failure_preserved_services(self, observed, *, phase, published):
        self.assertTrue(observed, "The requested publication checkpoint was not reached")
        self.assertEqual(self.system.active, observed["active"])
        self.assertEqual(self.system.enabled, observed["enabled"])
        self.assertEqual(self.system.events, observed["events"])
        self.assertEqual(self.current(), observed["launcher"])
        self.assertEqual(list(self.updater.barriers.iterdir()), [])
        journal = read_json(self.transaction() / "state.json")
        self.assertEqual(journal["phase"] == phase, published)
        self.assertEqual(bool(self.updater.pending()), not published)
        self.assert_secrets_preserved()

    def check_update_terminal_failure(self, *, published):
        with self.terminal_failure("committed", published=published) as observed, self.assertRaises(OSError):
            self.updater.update()
        self.assert_terminal_failure_preserved_services(observed, phase="committed", published=published)
        if not published:
            self.updater.recover(target="candidate")
        require_no_pending_control(self.layout)
        self.assertEqual(self.current(), b"new manage")
        self.assertEqual(self.system.active, {"worker", "caddy"})

    def test_update_terminal_replace_failure_keeps_retryable_candidate(self):
        self.check_update_terminal_failure(published=False)

    def test_update_terminal_directory_fsync_failure_does_not_restore_old_code(self):
        self.check_update_terminal_failure(published=True)

    def check_recovery_terminal_failure(self, *, candidate, published):
        self.interrupted_control_upgrade()
        phase, target = ("committed", "candidate") if candidate else ("recovered", "old")
        with self.terminal_failure(phase, published=published) as observed, self.assertRaises(OSError):
            self.updater.recover(target=target)
        self.assert_terminal_failure_preserved_services(observed, phase=phase, published=published)
        if not published:
            self.updater.recover(target=target)
        require_no_pending_control(self.layout)
        self.assertEqual(self.current(), b"new manage" if candidate else b"old manage")
        self.assertEqual(self.system.active, {"worker", "caddy"})

    def test_candidate_terminal_replace_failure_keeps_recovery_retryable(self):
        self.check_recovery_terminal_failure(candidate=True, published=False)

    def test_candidate_terminal_directory_fsync_failure_does_not_reblock_services(self):
        self.check_recovery_terminal_failure(candidate=True, published=True)

    def test_old_terminal_replace_failure_keeps_recovery_retryable(self):
        self.check_recovery_terminal_failure(candidate=False, published=False)

    def test_old_terminal_directory_fsync_failure_does_not_reblock_services(self):
        self.check_recovery_terminal_failure(candidate=False, published=True)

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

    def add_dns_variant(self, version, data):
        # Retained root-owned recipes can predate the currently reviewed build.
        from deploy.dns_caddy_build import recipe
        source_recipe = {**recipe("amd64"), "caddyVersion": version}
        relative = Path("edge/caddy/dns") / digest(source_recipe)
        directory = self.layout.control / relative
        mkdir(directory)
        atomic_write(directory / "caddy", data, 0o755)
        write_json(directory / "manifest.json", {"format": 1, "recipe": source_recipe, "sha256": hashlib.sha256(data).hexdigest()})
        return relative

    def test_update_and_rollback_preserve_all_verified_dns_variants(self):
        self.add_edge("caddy", b"standard verified edge")
        first = self.add_dns_variant("2.11.6", b"earlier DNS binary")
        result = self.updater.update()
        second = self.add_dns_variant("2.11.7", b"later DNS binary")
        self.updater.update(result["transaction"])
        self.assertEqual((self.layout.control / "edge/caddy/caddy").read_bytes(), b"standard verified edge")
        self.assertEqual((self.layout.control / first / "caddy").read_bytes(), b"earlier DNS binary")
        self.assertEqual((self.layout.control / second / "caddy").read_bytes(), b"later DNS binary")

    def test_tampered_unselected_dns_variant_prevents_control_update(self):
        self.add_edge("caddy", b"standard verified edge")
        variant = self.add_dns_variant("2.11.6", b"verified DNS binary")
        (self.layout.control / variant / "caddy").write_bytes(b"tampered DNS binary")
        self.system.events.clear()
        with self.assertRaisesRegex(DeployError, "DNS Caddy binary changed"):
            self.updater.update()
        self.assertEqual(self.system.events, [])
        self.assertEqual(self.current(), b"old manage")
        self.assertEqual(self.system.active, {"worker", "caddy"})
        self.assertEqual(self.updater.pending(), [])

    def add_application(self, *, accounts=True):
        staging = self.layout.app / "releases/staged-fixture"
        mkdir(staging / "app")
        package = {"name": "opaque-current-source-fixture"}
        if accounts:
            package["harnessAuthentication"] = "account-v1"
        write_json(staging / "app/package.json", package, mode=0o644)
        manifest = inspect_tree(staging, root_owned=True)
        identity = digest(manifest)
        target = staging.parent / identity
        staging.rename(target)
        mkdir(self.layout.config / "manifests")
        write_json(self.layout.config / "manifests" / (identity + ".json"), manifest)
        (self.layout.app / "current").symlink_to("releases/" + identity)
        return target

    def assert_account_rollback_rejected(self, transaction, code="authentication_downgrade"):
        before = inspect_tree(self.layout.control, root_owned=True)
        records = inspect_tree(self.updater.records, root_owned=True)
        pointer = self.layout.app / "current"
        selected = os.readlink(pointer) if pointer.is_symlink() else None
        active, enabled = set(self.system.active), dict(self.system.enabled)
        self.system.events.clear()
        with self.assertRaises(DeployError) as caught:
            self.updater.update(transaction)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.system.events, [])
        self.assertEqual(inspect_tree(self.layout.control, root_owned=True), before)
        self.assertEqual(inspect_tree(self.updater.records, root_owned=True), records)
        self.assertEqual(os.readlink(pointer) if pointer.is_symlink() else None, selected)
        self.assertEqual(self.system.active, active)
        self.assertEqual(self.system.enabled, enabled)

    def test_root_account_bootstrap_blocks_control_guard_downgrade_before_any_mutation(self):
        result = self.updater.update()
        atomic_write(self.layout.config / "auth-bootstrap.json", b"opaque account bootstrap fixture")
        self.assert_account_rollback_rejected(result["transaction"])

    def test_builtin_https_blocks_control_guard_downgrade_before_any_mutation(self):
        result = self.updater.update()
        write_json(self.layout.config / "https.json", {"authentication": "builtin"})
        self.assert_account_rollback_rejected(result["transaction"])

    def test_dns_https_blocks_control_downgrade_before_any_mutation(self):
        capabilities = self.layout.control / "capabilities.json"
        write_json(capabilities, {**read_json(capabilities), "authenticationGuard": "account-v1"}, mode=0o644)
        result = self.updater.update()
        write_json(self.layout.config / "https.json", {"authentication": "builtin", "tls": "acme", "dnsProvider": "alidns",
                   "dnsBinaryRevision": "a" * 64, "dnsCredentialsRevision": "b" * 32})
        self.assert_account_rollback_rejected(result["transaction"], "dns_downgrade")

    def test_new_provider_blocks_original_alidns_only_control_before_any_mutation(self):
        path = self.layout.control / "capabilities.json"
        write_json(path, {**read_json(path), "authenticationGuard": "account-v1", "dnsChallenge": "caddy-dns-v1"}, mode=0o644)
        result = self.updater.update()
        write_json(self.layout.config / "https.json", {"authentication": "builtin", "tls": "acme", "dnsProvider": "cloudflare",
                   "dnsBinaryRevision": "a" * 64, "dnsBinarySha256": "b" * 64,
                   "dnsCredentialsRevision": "c" * 32, "dnsCredentialsSha256": "d" * 64})
        self.assert_account_rollback_rejected(result["transaction"], "dns_downgrade")

    def test_browser_initialized_application_blocks_control_guard_downgrade_without_database_reads(self):
        result = self.updater.update()
        self.add_application()
        self.assertFalse((self.layout.config / "auth-bootstrap.json").exists())
        self.assertFalse((self.layout.state / "gateway/auth.sqlite").exists())
        self.assert_account_rollback_rejected(result["transaction"])

    def test_changed_application_declaration_cannot_hide_account_guard_requirement(self):
        result = self.updater.update()
        target = self.add_application()
        write_json(target / "app/package.json", {"name": "tampered-fixture"}, mode=0o644)
        self.assert_account_rollback_rejected(result["transaction"], "integrity")

    def test_account_compatible_control_rollback_succeeds_with_account_and_edge_markers(self):
        path = self.layout.control / "capabilities.json"
        write_json(path, {**read_json(path), "authenticationGuard": "account-v1"}, mode=0o644)
        result = self.updater.update()
        atomic_write(self.layout.config / "auth-bootstrap.json", b"opaque account bootstrap fixture")
        write_json(self.layout.config / "https.json", {"authentication": "builtin"})
        self.add_application()
        rollback = self.updater.update(result["transaction"])
        self.assertEqual(rollback["rollbackOf"], result["transaction"])
        self.assertEqual(read_json(self.layout.control / "capabilities.json")["authenticationGuard"], "account-v1")
        self.assertEqual((self.layout.control / "deploy/cli.py").read_bytes(), b"old deploy/cli.py")
        self.assertEqual((self.layout.config / "auth-bootstrap.json").read_bytes(), b"opaque account bootstrap fixture")
        self.assertEqual(self.system.active, {"worker", "caddy"})

    def test_legacy_application_without_account_dependencies_allows_legacy_control_rollback(self):
        result = self.updater.update()
        self.add_application(accounts=False)
        rollback = self.updater.update(result["transaction"])
        self.assertEqual(rollback["rollbackOf"], result["transaction"])
        self.assertNotIn("authenticationGuard", read_json(self.layout.control / "capabilities.json"))
        self.assertEqual((self.layout.control / "deploy/cli.py").read_bytes(), b"old deploy/cli.py")

    def interrupted_control_upgrade(self):
        original = self.updater.save
        def save(path, state, phase):
            original(path, state, phase)
            if phase == "installed":
                raise PowerLoss()
        with patch.object(self.updater, "save", side_effect=save), self.assertRaises(PowerLoss):
            self.updater.update()
        return self.transaction()

    def test_control_recover_cannot_restore_legacy_guard_for_account_dependent_instance(self):
        self.add_application()
        transaction = self.interrupted_control_upgrade()
        before = inspect_tree(self.layout.control, root_owned=True)
        records = inspect_tree(self.updater.records, root_owned=True)
        self.system.events.clear()
        with self.assertRaises(DeployError) as caught:
            self.updater.recover()
        self.assertEqual(caught.exception.code, "authentication_downgrade")
        self.assertEqual(self.system.events, [])
        self.assertEqual(inspect_tree(self.layout.control, root_owned=True), before)
        self.assertEqual(inspect_tree(self.updater.records, root_owned=True), records)
        self.assertEqual(read_json(transaction / "state.json")["phase"], "installed")
        self.assertEqual(self.system.active, set())

    def test_control_recover_cannot_restore_dns_incompatible_old_code(self):
        self.assert_dns_recovery_rejected("alidns", {})

    def test_control_recover_cannot_restore_alidns_only_code_for_new_provider(self):
        self.assert_dns_recovery_rejected("tencentcloud", {"dnsChallenge": "caddy-dns-v1"})

    def assert_dns_recovery_rejected(self, provider, dns_capabilities):
        capabilities = self.layout.control / "capabilities.json"
        write_json(capabilities, {**read_json(capabilities), "authenticationGuard": "account-v1", **dns_capabilities}, mode=0o644)
        transaction = self.interrupted_control_upgrade()
        write_json(self.layout.config / "https.json", {"authentication": "builtin", "tls": "acme", "dnsProvider": provider,
                   "dnsBinaryRevision": "a" * 64, "dnsBinarySha256": "b" * 64,
                   "dnsCredentialsRevision": "c" * 32, "dnsCredentialsSha256": "d" * 64})
        before = inspect_tree(self.layout.control, root_owned=True)
        records = inspect_tree(self.updater.records, root_owned=True)
        self.system.events.clear()
        with self.assertRaises(DeployError) as caught:
            self.updater.recover()
        self.assertEqual(caught.exception.code, "dns_downgrade")
        self.assertIn("--target candidate", str(caught.exception))
        self.assertEqual(self.system.events, [])
        self.assertEqual(inspect_tree(self.layout.control, root_owned=True), before)
        self.assertEqual(inspect_tree(self.updater.records, root_owned=True), records)
        self.assertEqual(read_json(transaction / "state.json")["phase"], "installed")
        self.assertEqual(self.system.active, set())

    def test_automatic_control_recovery_does_not_restore_account_incompatible_guard(self):
        self.add_application()
        self.system.failure = "start"
        with self.assertRaises(DeployError) as caught:
            self.updater.update()
        self.assertEqual(caught.exception.code, "authentication_downgrade")
        self.assertEqual((self.layout.control / "deploy/cli.py").read_bytes(), b"new deploy/cli.py")
        self.assertEqual(read_json(self.transaction() / "state.json")["phase"], "installed")

    def test_compatible_control_recovery_restores_prior_generation_with_accounts(self):
        path = self.layout.control / "capabilities.json"
        write_json(path, {**read_json(path), "authenticationGuard": "account-v1"}, mode=0o644)
        self.add_application()
        self.interrupted_control_upgrade()
        result = self.updater.recover()
        self.assertTrue(result["controlRecovered"])
        self.assertEqual((self.layout.control / "deploy/cli.py").read_bytes(), b"old deploy/cli.py")
        self.assertEqual(self.system.active, {"worker", "caddy"})

    def test_initial_legacy_control_upgrade_failure_still_recovers(self):
        self.add_application(accounts=False)
        self.system.failure = "start"
        with self.assertRaises(DeployError) as caught:
            self.updater.update()
        self.assertEqual(caught.exception.code, "injected")
        self.assertEqual((self.layout.control / "deploy/cli.py").read_bytes(), b"old deploy/cli.py")
        self.assertEqual(read_json(self.transaction() / "state.json")["phase"], "recovered")
        self.assertEqual(self.system.active, {"worker", "caddy"})

    def test_explicit_candidate_recovery_finishes_each_original_interruption_phase(self):
        self.add_application()
        for point in ("prepared", "stopped", "old_moved", "installed"):
            with self.subTest(point=point):
                original = self.updater.save
                def save(path, state, phase):
                    original(path, state, phase)
                    if phase == point:
                        raise PowerLoss()
                with patch.object(self.updater, "save", side_effect=save), self.assertRaises(PowerLoss):
                    self.updater.update()
                path, state = self.updater.pending()[0]
                result = self.updater.recover(target="candidate")
                self.assertEqual(result["target"], "candidate")
                self.assertEqual(read_json(path / "state.json")["phase"], "committed")
                self.assertEqual(self.updater.pending(), [])
                self.assertEqual(self.system.active, {"worker", "caddy"})
                self.updater.verify_generation(self.layout.control, state["candidate"])
                self.updater.verify_generation(path / "old", state["old"])

    def test_candidate_recovery_interrupted_between_renames_can_repeat(self):
        self.add_application()
        original_save = self.updater.save
        def save(path, state, phase):
            original_save(path, state, phase)
            if phase == "prepared":
                raise PowerLoss()
        with patch.object(self.updater, "save", side_effect=save), self.assertRaises(PowerLoss):
            self.updater.update()
        original_rename = self.updater.rename
        def rename(source, target):
            original_rename(source, target)
            if target.name == "old":
                raise PowerLoss()
        with patch.object(self.updater, "rename", side_effect=rename), self.assertRaises(PowerLoss):
            self.updater.recover(target="candidate")
        self.assertFalse(self.layout.control.exists())
        result = self.updater.recover(target="candidate")
        self.assertEqual(result["target"], "candidate")
        self.assertEqual(self.updater.pending(), [])
        self.assertEqual(self.system.active, {"worker", "caddy"})

    def test_candidate_health_failure_keeps_guard_and_can_repeat_after_prerequisite_repair(self):
        self.system.active = {"worker", "gateway"}
        self.add_application()
        path = self.interrupted_control_upgrade()
        self.system.failure = "health"
        with self.assertRaises(DeployError):
            self.updater.recover(target="candidate")
        self.assertEqual(read_json(path / "state.json")["phase"], "installed")
        self.assertEqual(self.system.active, set())
        self.assertEqual({entry.name for entry in self.updater.barriers.iterdir()}, set(ROLES))
        result = self.updater.recover(target="candidate")
        self.assertEqual(result["target"], "candidate")
        self.assertEqual(self.system.active, {"worker", "gateway"})

    def test_incomplete_candidate_is_rejected_before_mutating_recovery_state(self):
        self.add_application()
        path = self.interrupted_control_upgrade()
        (self.layout.control / "deploy/cli.py").unlink()
        before = (path / "state.json").read_bytes()
        self.system.events.clear()
        with self.assertRaises(DeployError):
            self.updater.recover(target="candidate")
        self.assertEqual((path / "state.json").read_bytes(), before)
        self.assertEqual(self.system.events, [])

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
