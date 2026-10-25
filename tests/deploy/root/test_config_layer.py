"""Relocated Linux root fixtures: real ownership/files, substituted service manager."""
import os
import stat
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout, atomic_write, mkdir, read_json, write_json
from deploy.config_layer import apply_candidate, barriers, change_config_layer, paths, recover_config_layer, snapshot, user_layer
from deploy.manager import Manager
from deploy.provider import validate_provider
from deploy.provider_layers import verify_system_layers
from deploy.units import render_units, sudo_rule


class PowerLoss(BaseException):
    pass


class FixtureSystem:
    def __init__(self, layout):
        self.layout, self.active, self.events = layout, {"worker", "gateway"}, []
        self.unknown, self.fail_start = False, False

    def state(self, unit):
        active = any(unit == self.layout.unit(role) for role in self.active)
        return {"ActiveState": "active" if active else "inactive", "SubState": "running" if active else "dead",
                "MainPID": "123" if active else "0", "ControlPID": "0", "stopped": not active}

    def stop(self, units):
        self.events.append(("stop", list(units)))
        if self.unknown:
            raise DeployError("stop_unknown", "Fixture cgroup cannot be confirmed stopped")
        self.active.difference_update(role for role in tuple(self.active) if self.layout.unit(role) in units)

    def reload(self):
        self.events.append("reload")

    def start(self, units):
        self.events.append(("start", list(units)))
        barrier = self.layout.config / "config-layer-maintenance"
        for role in ("worker", "gateway"):
            if self.layout.unit(role) in units and not (barrier / role).exists():
                self.active.add(role)
        if "gateway" in self.active and not (barrier / "worker").exists():
            self.active.add("worker")
        if "worker" in self.active and read_json(self.layout.config / "instance.json").get("providerConfigLayer"):
            verify_system_layers(self.layout)
        if self.fail_start:
            self.fail_start = False
            raise DeployError("health", "One-time start failure")


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root configuration-layer fixture")
class ConfigurationLayerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="config-layer-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout("fixture", Path(self.temp.name))
        for directory in (self.layout.config, self.layout.units, self.layout.control, self.layout.state / "transactions",
                          self.layout.root / "etc/sudoers.d"):
            mkdir(directory)
        for directory in (self.layout.state / "worker", self.layout.state / "worker/codex"):
            mkdir(directory, 0o750, 65534, 65534)
        self.user = self.layout.state / "worker/codex/config.toml"
        self.user_bytes = b'# Existing native settings must survive byte-for-byte.\n[features]\nmulti_agent = true\n'
        atomic_write(self.user, self.user_bytes, 0o600, 65534, 65534)
        self.config = {"workerUid": 65534, "workerGid": 65534, "gatewayUid": 101, "gatewayGid": 101,
                       "origin": "http://127.0.0.1:3300", "port": 3300, "codexRelative": "vendor/codex"}
        write_json(self.layout.config / "instance.json", self.config)
        write_json(self.layout.control / "capabilities.json", {"format": 1, "providerConfigLayer": "system-v1", "nativeWorkspace": 1}, mode=0o644)
        for name, data in render_units(self.layout, self.config, self.config["codexRelative"]).items():
            atomic_write(self.layout.units / name, data.encode(), 0o644)
        atomic_write(paths(self.layout)["sudo"], sudo_rule(self.layout, workspace=False).encode(), 0o440)
        self.system = FixtureSystem(self.layout)
        self.manager = Manager(self.layout, self.system, worker_gid=65534)
        self.manager.recover_control = lambda: self.system.events.append("recover-receipts")
        self.manager.healthy = lambda: self.system.events.append("health")
        self.settings = {"kind": "responses", "revision": "a" * 32, "baseUrl": "https://provider.invalid/v1",
                         "model": "fixture-model", "apiKey": "fixture-secret", "models": []}
        self.manager.providers.select(self.manager.providers.prepare(self.settings))
        self.visudo = patch("deploy.config_layer.run", return_value=subprocess.CompletedProcess([], 0, "", ""))
        self.visudo.start()
        self.addCleanup(self.visudo.stop)

    def transaction(self):
        return next((self.layout.state / "transactions").glob("*/state.json"))

    def advanced_provider(self, kind):
        change_config_layer(self.manager)
        current = self.manager.providers.read()
        params = {"kind": kind, "expectedRevision": current["revision"]}
        if kind == "chatgpt-gateway":
            params.update(baseUrl="https://gateway.invalid/v1", confirmGatewayCredentials=True,
                          gatewayOAuth={"authorizationUrl": "https://login.invalid/authorize", "tokenUrl": "https://login.invalid/token",
                                        "clientId": "public-fixture", "cookieName": "fixture-auth"})
        else:
            params.update(region="us-east-1", apiKey="fixture-managed-bearer")
        settings = validate_provider(params, current)
        self.manager.providers.select(self.manager.providers.prepare(settings, layered=True))
        return settings

    def materials(self):
        result = {}
        for path in self.layout.root.rglob("*"):
            info = path.lstat()
            data = os.readlink(path) if path.is_symlink() else path.read_bytes() if stat.S_ISREG(info.st_mode) else None
            result[path.relative_to(self.layout.root).as_posix()] = (info.st_mode, info.st_uid, info.st_gid, data)
        return result

    def historical_legacy_journal(self, settings, phase="prepared"):
        before = snapshot(self.layout)
        candidate = {key: value for key, value in self.manager.config.items() if key != "providerConfigLayer"}
        journal = {"kind": "config-layer", "phase": phase, "targetMode": "legacy", "before": before,
                   "oldProvider": settings["revision"], "candidateProvider": settings["revision"],
                   "candidateConfig": candidate, "active": ["worker", "gateway"]}
        folder = self.layout.state / "transactions" / uuid.uuid4().hex
        mkdir(folder, 0o700)
        path = folder / "state.json"
        write_json(path, journal)
        if phase != "prepared":
            barriers(self.manager)
            self.system.stop(self.manager.service_units)
        if phase == "selected":
            # Reconstruct bytes published by the old bug, without disabling the
            # new guard or using new rollback code to manufacture the fixture.
            write_json(paths(self.layout)["instance"], candidate)
            generated = render_units(self.layout, candidate, candidate["codexRelative"])
            atomic_write(paths(self.layout)["worker"], generated[self.layout.unit("worker")].encode(), 0o644)
            paths(self.layout)["check"].unlink()
            atomic_write(paths(self.layout)["sudo"], sudo_rule(self.layout, workspace=False).encode(), 0o440)
            self.manager.config = candidate
        return path, journal, before

    def test_advanced_rollback_rejects_before_any_material_or_service_change(self):
        for kind in ("chatgpt-gateway", "bedrock-runtime", "bedrock-mantle"):
            with self.subTest(kind=kind):
                self.advanced_provider(kind)
                before = self.materials()
                self.system.events.clear()
                with self.assertRaises(DeployError) as caught:
                    change_config_layer(self.manager, layered=False)
                self.assertEqual(caught.exception.code, "configuration_conflict")
                self.assertEqual(self.materials(), before)
                self.assertEqual(self.system.events, [])
                self.assertEqual(self.system.active, {"worker", "gateway"})

    def test_old_unsafe_candidates_reject_without_changes_and_old_recovery_still_works(self):
        for kind in ("chatgpt-gateway", "bedrock-runtime", "bedrock-mantle"):
            for phase in ("prepared", "stopped", "selected"):
                with self.subTest(kind=kind, phase=phase):
                    settings = self.advanced_provider(kind)
                    path, journal, original = self.historical_legacy_journal(settings, phase)
                    before, active = self.materials(), set(self.system.active)
                    self.system.events.clear()
                    with self.assertRaises(DeployError) as caught:
                        recover_config_layer(self.manager, path, journal, candidate=True)
                    self.assertEqual(caught.exception.code, "configuration_conflict")
                    self.assertEqual(self.materials(), before)
                    self.assertEqual(self.system.events, [])
                    self.assertEqual(self.system.active, active)
                    result = recover_config_layer(self.manager, path, journal)
                    self.assertEqual(result["direction"], "old")
                    self.assertEqual(snapshot(self.layout), original)
                    self.assertEqual(self.manager.providers.read()["revision"], settings["revision"])
                    self.assertEqual(read_json(path)["phase"], "recovered")
                    self.assertEqual(self.user.read_bytes(), self.user_bytes)
                    self.assertEqual(self.system.active, {"worker", "gateway"})
                    self.assertTrue(verify_system_layers(self.layout)["hostPolicyVerified"])

    def test_candidate_checks_its_generation_instead_of_the_current_pointer(self):
        settings = self.advanced_provider("bedrock-runtime")
        path, journal, _ = self.historical_legacy_journal(settings)
        # The selected pointer is a compatible provider, but the recorded
        # candidate still requires requirements.toml and cannot be published.
        self.manager.providers.select(self.settings["revision"])
        before = self.materials()
        self.system.events.clear()
        with self.assertRaises(DeployError) as caught:
            recover_config_layer(self.manager, path, journal, candidate=True)
        self.assertEqual(caught.exception.code, "configuration_conflict")
        self.assertEqual(self.materials(), before)
        self.assertEqual(self.system.events, [])
        recover_config_layer(self.manager, path, journal)
        self.assertEqual(self.manager.providers.read()["revision"], settings["revision"])

    def test_old_completed_unsafe_downgrade_is_not_accepted_as_a_legacy_noop(self):
        for kind in ("chatgpt-gateway", "bedrock-runtime", "bedrock-mantle"):
            with self.subTest(kind=kind):
                settings = self.advanced_provider(kind)
                path, journal, _ = self.historical_legacy_journal(settings, "selected")
                journal["phase"] = "committed"
                write_json(path, journal)
                before = self.materials()
                self.system.events.clear()
                with self.assertRaises(DeployError) as caught:
                    change_config_layer(self.manager, layered=False)
                self.assertEqual(caught.exception.code, "configuration_conflict")
                self.assertEqual(self.materials(), before)
                self.assertEqual(self.system.events, [])
                # An explicit forward migration remains available to repair
                # the older completed downgrade while retaining user bytes.
                change_config_layer(self.manager)
                self.assertTrue(verify_system_layers(self.layout)["hostPolicyVerified"])

    def test_candidate_publication_rechecks_policy_and_generation_identity(self):
        settings = self.advanced_provider("chatgpt-gateway")
        _, journal, _ = self.historical_legacy_journal(settings)
        before = self.materials()
        self.system.events.clear()
        with self.assertRaises(DeployError) as caught:
            apply_candidate(self.manager, journal)
        self.assertEqual(caught.exception.code, "configuration_conflict")
        self.assertEqual(self.materials(), before)
        target = self.layout.config / "providers" / settings["revision"] / "settings.json"
        write_json(target, {**settings, "revision": "0" * 32, "kind": "responses"})
        before = self.materials()
        with self.assertRaises(DeployError) as caught:
            apply_candidate(self.manager, journal)
        self.assertEqual(caught.exception.code, "corrupt_state")
        self.assertEqual(self.materials(), before)
        self.assertEqual(self.system.events, [])

    def test_migrate_and_rollback_preserve_user_and_host_bytes_and_old_generation(self):
        host = self.layout.root / "etc/codex"
        mkdir(host)
        atomic_write(host / "config.toml", b'model_instructions_file = "./instructions.md"\n', 0o644)
        atomic_write(host / "managed_config.toml", b'developer_instructions = "host-policy"\n', 0o644)
        before = {name: (host / name).read_bytes() for name in ("config.toml", "managed_config.toml")}
        result = change_config_layer(self.manager)
        self.assertTrue(result["changed"])
        self.assertEqual(self.system.active, {"worker", "gateway"})
        self.assertEqual(self.user.read_bytes(), self.user_bytes)
        self.assertEqual({name: (host / name).read_bytes() for name in before}, before)
        self.assertEqual((host / "requirements.toml").read_bytes(), b"")
        self.assertFalse((self.layout.config / "providers" / self.settings["revision"] / "system-config.toml").exists())
        self.assertTrue(verify_system_layers(self.layout)["hostPolicyVerified"])
        legacy = change_config_layer(self.manager, layered=False)
        self.assertEqual(legacy["providerConfigLayer"], "legacy")
        self.assertFalse(paths(self.layout)["check"].exists())
        self.assertEqual(paths(self.layout)["sudo"].read_bytes(), sudo_rule(self.layout, workspace=False).encode())
        self.assertEqual(self.user.read_bytes(), self.user_bytes)
        self.assertEqual(self.system.active, {"worker", "gateway"})

    def test_gateway_only_and_stopped_activity_are_preserved(self):
        for active in ({"gateway"}, set(), {"worker"}):
            self.system.active = set(active)
            change_config_layer(self.manager)
            self.assertEqual(self.system.active, active)
            change_config_layer(self.manager, layered=False)
            self.assertEqual(self.system.active, active)

    def test_prior_unit_without_native_home_is_recognized_and_migrated_after_stop(self):
        legacy = render_units(self.layout, self.config, self.config["codexRelative"], legacy_native_home=True)[self.layout.unit("worker")]
        atomic_write(paths(self.layout)["worker"], legacy.encode(), 0o644)
        self.manager.require_service_ownership()
        change_config_layer(self.manager)
        self.assertIn("Environment=HARNESS_NATIVE_HOME=", paths(self.layout)["worker"].read_text())
        self.assertTrue(any(isinstance(item, tuple) and item[0] == "stop" for item in self.system.events))

    def test_unknown_stop_never_publishes_pointer_config_units_or_sudo(self):
        before = snapshot(self.layout)
        self.system.unknown = True
        with self.assertRaises(DeployError) as caught:
            change_config_layer(self.manager)
        self.assertEqual(caught.exception.code, "stop_unknown")
        self.assertEqual(snapshot(self.layout), before)
        self.assertEqual(self.manager.providers.read()["revision"], self.settings["revision"])
        self.assertEqual(read_json(self.transaction())["phase"], "prepared")
        self.assertEqual({p.name for p in (self.layout.config / "config-layer-maintenance").iterdir()}, {"worker", "gateway"})
        self.system.unknown = False
        recover_config_layer(self.manager, self.transaction(), read_json(self.transaction()))
        self.assertEqual(snapshot(self.layout), before)
        self.assertEqual(self.system.active, {"worker", "gateway"})

    def test_host_conflict_rejects_before_stop_or_missing_target_creation(self):
        host = self.layout.root / "etc/codex"
        mkdir(host)
        atomic_write(host / "managed_config.toml", b'model_provider = "host-required"\n', 0o644)
        with self.assertRaises(DeployError) as caught:
            change_config_layer(self.manager)
        self.assertEqual(caught.exception.code, "configuration_conflict")
        self.assertFalse((host / "config.toml").exists())
        self.assertFalse((host / "requirements.toml").exists())
        self.assertFalse(any(isinstance(item, tuple) for item in self.system.events))

    def test_start_failure_restores_original_files_pointer_and_activity(self):
        before = snapshot(self.layout)
        self.system.fail_start = True
        with self.assertRaises(DeployError):
            change_config_layer(self.manager)
        self.assertEqual(snapshot(self.layout), before)
        self.assertEqual(self.manager.providers.read()["revision"], self.settings["revision"])
        self.assertEqual(self.system.active, {"worker", "gateway"})
        self.assertEqual(read_json(self.transaction())["phase"], "recovered")

    def test_power_loss_journal_phases_are_recoverable(self):
        before = snapshot(self.layout)
        for phase in ("prepared", "stopped", "selected"):
            def crash(path, value, **kwargs):
                write_json(path, value, **kwargs)
                if path.name == "state.json" and value.get("kind") == "config-layer" and value.get("phase") == phase:
                    raise PowerLoss()
            with patch("deploy.config_layer.write_json", side_effect=crash), self.assertRaises(PowerLoss):
                change_config_layer(self.manager)
            pending = [(path, read_json(path)) for path in (self.layout.state / "transactions").glob("*/state.json") if read_json(path)["phase"] != "recovered"]
            self.assertEqual(len(pending), 1)
            recover_config_layer(self.manager, *pending[0])
            self.assertEqual(snapshot(self.layout), before)
            self.assertEqual(self.manager.providers.read()["revision"], self.settings["revision"])
            self.assertEqual(self.system.active, {"worker", "gateway"})

    def test_power_loss_between_file_publications_can_finish_candidate(self):
        original = atomic_write
        def crash(path, value, *args, **kwargs):
            original(path, value, *args, **kwargs)
            if path == paths(self.layout)["worker"]:
                raise PowerLoss()
        with patch("deploy.config_layer.atomic_write", side_effect=crash), self.assertRaises(PowerLoss):
            change_config_layer(self.manager)
        self.assertFalse(paths(self.layout)["check"].exists())
        result = recover_config_layer(self.manager, self.transaction(), read_json(self.transaction()), candidate=True)
        self.assertEqual(result["direction"], "candidate")
        self.assertTrue(verify_system_layers(self.layout)["hostPolicyVerified"])
        self.assertEqual(self.system.active, {"worker", "gateway"})

    def test_host_drift_blocks_check_and_explicit_refresh_rebuilds_new_generation(self):
        change_config_layer(self.manager)
        old_revision = self.manager.providers.read()["revision"]
        host = self.layout.root / "etc/codex/config.toml"
        atomic_write(host, b'developer_instructions = "new host policy"\n', 0o644)
        with self.assertRaises(DeployError) as caught:
            verify_system_layers(self.layout)
        self.assertEqual(caught.exception.code, "configuration_conflict")
        self.assertTrue(change_config_layer(self.manager)["changed"])
        self.assertNotEqual(self.manager.providers.read()["revision"], old_revision)
        self.assertTrue(verify_system_layers(self.layout)["hostPolicyVerified"])

    def test_generated_layer_tamper_blocks_check_and_is_not_silently_refreshed(self):
        change_config_layer(self.manager)
        generation = self.layout.config / "providers" / self.manager.providers.read()["revision"]
        atomic_write(generation / "requirements.toml", b'model_provider = "wrong"\n', 0o640, 0, 65534)
        self.system.events.clear()
        with self.assertRaises(DeployError) as caught:
            change_config_layer(self.manager)
        self.assertEqual(caught.exception.code, "integrity")
        self.assertFalse(any(isinstance(item, tuple) for item in self.system.events))

    def test_user_symlink_fifo_hardlink_and_parent_link_fail_without_follow_or_block(self):
        other = self.layout.root / "other"
        for defect in ("symlink", "fifo", "hardlink", "parent"):
            if defect == "symlink":
                self.user.rename(other); self.user.symlink_to(other)
            elif defect == "fifo":
                self.user.rename(other); os.mkfifo(self.user, 0o600)
            elif defect == "hardlink":
                os.link(self.user, other)
            else:
                self.user.parent.rename(other); self.user.parent.symlink_to(other)
            with self.subTest(defect=defect), self.assertRaises(DeployError):
                user_layer(self.manager)
            if defect in ("symlink", "fifo"):
                self.user.unlink(); other.rename(self.user)
            elif defect == "hardlink":
                other.unlink()
            else:
                self.user.parent.unlink(); other.rename(self.user.parent)
        self.assertEqual(self.user.read_bytes(), self.user_bytes)

    def test_user_config_change_after_stop_is_retained_and_invalid_bytes_abort(self):
        before = snapshot(self.layout)
        original = self.system.stop
        def stop(units):
            original(units)
            atomic_write(self.user, b'invalid TOML [', 0o600, 65534, 65534)
        with patch.object(self.system, "stop", side_effect=stop), self.assertRaises(DeployError):
            change_config_layer(self.manager)
        self.assertEqual(snapshot(self.layout), before)
        self.assertEqual(self.user.read_bytes(), b'invalid TOML [')


if __name__ == "__main__":
    unittest.main()
