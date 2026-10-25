"""HTTPS transaction faults with local files and substituted OS/edge services."""
import hashlib
import json
import os
import sys
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout, atomic_write, mkdir, read_json, write_json
from deploy.https import EDGE_ROLES, setup_https, tls_paths, transaction_paths
from deploy.manager import Manager
from deploy.units import render_units, render_edge_units, sudo_rule


class FixtureSystem:
    def __init__(self, layout):
        self.layout = layout
        self.active = set(EDGE_ROLES)
        self.enabled = {"worker", "gateway", "caddy"}
        self.events = []
        self.fail = None
        self.failed = False
        self.stop_unknown = False

    def role(self, unit):
        return next(role for role in EDGE_ROLES if self.layout.unit(role) == unit)

    def fault(self, action):
        if self.fail == action and not self.failed:
            self.failed = True
            raise DeployError("injected", "One-time " + action + " failure")

    def state(self, unit):
        active = self.role(unit) in self.active
        return {"LoadState": "loaded", "ActiveState": "active" if active else "inactive",
                "SubState": "running" if active else "dead", "MainPID": "123" if active else "0",
                "ControlPID": "0", "stopped": not active}

    def stop(self, units):
        self.events.append("stop")
        if self.stop_unknown:
            raise DeployError("stop_unknown", "Injected unknown stop")
        self.fault("stop")
        self.active.difference_update(self.role(unit) for unit in units)

    def start(self, units):
        self.events.append("start")
        if units:
            self.active.add(self.role(units[0]))
        self.fault("start")
        allowed = {role for role in EDGE_ROLES if not (self.layout.config / "https-recovery" / role).exists()}
        self.active.update(self.role(unit) for unit in units if self.role(unit) in allowed)
        # Actual gateway units use Wants=worker. Conditions must prevent an
        # inactive worker from starting during gateway-only restoration.
        if "gateway" in self.active and "worker" in allowed:
            self.active.add("worker")

    def reload(self):
        self.events.append("reload")
        self.fault("reload")

    def enable(self, units):
        self.events.append("enable")
        if units:
            self.enabled.add(self.role(units[0]))
        self.fault("enable")
        self.enabled.update(self.role(unit) for unit in units)


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root ownership fixture")
class HttpsTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.layout = Layout("fixture", self.root)
        for folder in (self.layout.config, self.layout.units, self.layout.state / "transactions", self.layout.config / "identity", self.layout.state / "identity", self.layout.config / "tls"):
            mkdir(folder)
        self.config = {"port": 3300, "origin": "https://work.example.test:18443", "workerGid": 1,
                       "gatewayUid": 1, "gatewayGid": 1, "codexRelative": "vendor/fixture/codex"}
        write_json(self.layout.config / "instance.json", self.config)
        self.metadata = {"host": "work.example.test", "authHost": "auth.example.test", "domain": "example.test",
                         "authPort": 19091, "tls": "provided", "httpPort": 18080, "httpsPort": 18443,
                         "identityId": "fixture-identity", "phase": "active"}
        self.old_cert = b"-----BEGIN CERTIFICATE-----\nold fixture certificate\n"
        marker = b"-----BEGIN " + b"PRIVATE KEY-----\n"
        self.old_key = marker + b"old fixture key\n"
        self.new_cert = b"-----BEGIN CERTIFICATE-----\nnew fixture certificate\n"
        self.new_key = marker + b"new fixture key\n"
        for name, field, content in (("certificate.pem", "certificateSha256", self.old_cert), ("private-key.pem", "privateKeySha256", self.old_key)):
            atomic_write(self.layout.config / "tls" / name, content, 0o640)
            self.metadata[field] = hashlib.sha256(content).hexdigest()
        write_json(self.layout.config / "https.json", self.metadata)
        self.identity_files = [self.layout.config / "identity/secrets.json", self.layout.config / "identity/configuration.json",
                               self.layout.state / "identity/users.json", self.layout.state / "identity/db.sqlite3"]
        for file in self.identity_files:
            atomic_write(file, b"opaque paired identity fixture")
        self.write_owned_units()
        mkdir(self.layout.root / "etc/sudoers.d")
        atomic_write(self.layout.root / "etc/sudoers.d" / ("codex-harness-" + self.layout.instance), sudo_rule(self.layout).encode(), 0o644)
        self.system = FixtureSystem(self.layout)
        self.manager = Manager(self.layout, self.system, worker_gid=1)
        self.manager.recover_control = lambda: self.system.events.append("recover-control")
        self.manager.healthy = lambda: self.system.fault("health")
        self.kwargs = {"host": "work.example.test", "auth_host": "auth.example.test", "domain": "example.test", "username": "admin",
                       "email": "admin@example.test", "auth_port": 19091, "tls": "provided", "http_port": 18080, "https_port": 18443}
        self.new_cert_path, self.new_key_path = self.root / "new-cert.pem", self.root / "new-key.pem"
        self.new_cert_path.write_bytes(self.new_cert)
        self.new_key_path.write_bytes(self.new_key)
        self.validated_config = []
        self.validation_failure = False
        self.stack = ExitStack()
        self.stack.enter_context(patch("deploy.https.edge_binary", side_effect=lambda layout, kind: self.root / kind))
        self.stack.enter_context(patch("deploy.https.ensure_account", return_value=(0, 0)))
        self.stack.enter_context(patch("deploy.https.render_caddy", side_effect=self.render))
        self.stack.enter_context(patch("deploy.https.run", side_effect=self.command))
        for name in ("O_NOFOLLOW", "O_NONBLOCK"):
            if not hasattr(os, name):
                self.stack.enter_context(patch.object(os, name, 0, create=True))
        old_paths = tls_paths(self.layout, self.metadata)
        atomic_write(self.layout.config / "Caddyfile", self.render(self.kwargs["host"], self.kwargs["auth_host"], 3300, 19091,
                     tls="provided", http_port=18080, https_port=18443, certificate=str(old_paths[0]), private_key=str(old_paths[1])).encode(), 0o644)
        self.before = {name: file.read_bytes() for name, file in transaction_paths(self.layout).items()}

    def tearDown(self):
        self.stack.close()
        self.temp.cleanup()

    def render(self, *args, **kwargs):
        return json.dumps({"args": args, **kwargs}, sort_keys=True)

    def write_owned_units(self):
        for name, content in {**render_units(self.layout, self.config, self.config["codexRelative"]), **render_edge_units(self.layout)}.items():
            atomic_write(self.layout.units / name, content.encode(), 0o644)

    def command(self, argv, **kwargs):
        if argv[1] == "is-enabled":
            enabled = self.system.role(argv[2]) in self.system.enabled
            return subprocess.CompletedProcess(argv, 0 if enabled else 1, "enabled\n" if enabled else "disabled\n", "")
        if argv[1] == "disable":
            self.system.enabled.difference_update(self.system.role(unit) for unit in argv[2:])
        elif "validate" in argv and "--adapter" in argv:
            self.validated_config.append(Path(argv[argv.index("--config") + 1]).read_text())
            if self.validation_failure:
                raise DeployError("invalid_pair", "Injected Caddy pair validation failure")
        return subprocess.CompletedProcess(argv, 0, "", "")

    def rotate(self):
        return setup_https(self.manager, **self.kwargs, certificate=self.new_cert_path, private_key=self.new_key_path)

    def journal(self):
        paths = list((self.layout.state / "transactions").glob("*/state.json"))
        self.assertEqual(len(paths), 1)
        return paths[0], read_json(paths[0])

    def assert_identity_preserved(self):
        for file in self.identity_files:
            self.assertEqual(file.read_bytes(), b"opaque paired identity fixture")

    def assert_restored(self):
        self.assertEqual({name: file.read_bytes() for name, file in transaction_paths(self.layout).items()}, self.before)
        self.assertEqual(self.system.active, set(EDGE_ROLES))
        self.assertEqual(self.system.enabled, {"worker", "gateway", "caddy"})
        self.assertEqual(self.journal()[1]["phase"], "recovered")
        self.assert_identity_preserved()

    def test_provided_pair_rotation_is_validated_and_selected_together(self):
        result = self.rotate()
        self.assertTrue(result["certificateChanged"])
        selected = read_json(self.layout.config / "https.json")
        cert, key = tls_paths(self.layout, selected)
        self.assertEqual(cert.read_bytes(), self.new_cert)
        self.assertEqual(key.read_bytes(), self.new_key)
        self.assertEqual(cert.parent, key.parent)
        self.assertIn(selected["tlsRevision"], self.validated_config[0])
        self.assertIn(selected["tlsRevision"], (self.layout.config / "Caddyfile").read_text())
        self.assertEqual((self.layout.config / "tls/certificate.pem").read_bytes(), self.old_cert)
        self.assertEqual(self.journal()[1]["phase"], "committed")
        self.assert_identity_preserved()

    def test_candidate_validation_failure_does_not_stop_or_replace_the_old_pair(self):
        self.validation_failure = True
        with self.assertRaisesRegex(DeployError, "validation failure"):
            self.rotate()
        self.assertEqual(self.system.events, [])
        self.assertEqual({name: file.read_bytes() for name, file in transaction_paths(self.layout).items()}, self.before)
        self.assert_identity_preserved()

    def test_unit_write_reload_start_health_and_enable_failures_restore_previous_state(self):
        # Each subcase has an independent instance and checks saved bytes, service
        # liveness, enablement and identity pairing, not just command call counts.
        for fault in ("unit-write", "reload", "start", "health", "enable"):
            with self.subTest(fault=fault):
                self.system.fail = fault
                fired = False
                def fail_write(path, data, *args, **kwargs):
                    nonlocal fired
                    if fault == "unit-write" and not fired and self.system.events and path == self.layout.units / self.layout.unit("gateway"):
                        fired = True
                        raise OSError("Injected unit write failure")
                    return atomic_write(path, data, *args, **kwargs)
                with patch("deploy.https.atomic_write", side_effect=fail_write):
                    with self.assertRaises((DeployError, OSError)):
                        self.rotate()
                self.assert_restored()
                # Only remove this finished fixture record; retained candidate TLS
                # generations are intentionally left in place for subsequent cases.
                record, _ = self.journal()
                record.unlink()
                record.parent.rmdir()
                self.system.failed = False
                self.system.events.clear()

    def test_unknown_recovery_stop_preserves_selected_material_and_repair_restores_it(self):
        original_start = self.system.start
        def interrupted_start(units):
            self.system.stop_unknown = True
            raise DeployError("start_failed", "Injected startup failure followed by unknown stop")
        self.system.start = interrupted_start
        with self.assertRaisesRegex(DeployError, "recovery is unconfirmed"):
            self.rotate()
        path, journal = self.journal()
        self.assertEqual(journal["phase"], "selected")
        selected = read_json(self.layout.config / "https.json")
        self.assertNotEqual(selected.get("tlsRevision"), self.metadata.get("tlsRevision"))
        self.assertEqual(tls_paths(self.layout, selected)[0].read_bytes(), self.new_cert)
        self.assertEqual((self.layout.config / "tls/certificate.pem").read_bytes(), self.old_cert)
        self.assert_identity_preserved()
        self.system.stop_unknown = False
        self.system.start = original_start
        self.assertEqual(self.manager.repair(), {"repaired": True, "recoveredTransactions": 1})
        self.assert_restored()

    def test_process_interruption_after_snapshot_is_recoverable_by_repair(self):
        original = atomic_write
        def crash(path, data, *args, **kwargs):
            if path == self.layout.units / self.layout.unit("gateway") and "stop" in self.system.events:
                raise KeyboardInterrupt()
            return original(path, data, *args, **kwargs)
        with patch("deploy.https.atomic_write", side_effect=crash):
            with self.assertRaises(KeyboardInterrupt):
                self.rotate()
        self.assertEqual(self.journal()[1]["phase"], "stopped")
        with self.assertRaisesRegex(DeployError, "requires repair"):
            self.rotate()
        self.manager.repair()
        self.assert_restored()

    def test_unchanged_explicit_pair_is_reused_and_partial_pair_is_rejected(self):
        cert, key = tls_paths(self.layout, self.metadata)
        with self.assertRaisesRegex(DeployError, "Supply both"):
            setup_https(self.manager, **self.kwargs, certificate=cert)
        self.assertEqual(self.system.events, [])
        result = setup_https(self.manager, **self.kwargs, certificate=cert, private_key=key)
        self.assertFalse(result["certificateChanged"])
        self.assertNotIn("tlsRevision", read_json(self.layout.config / "https.json"))

    def test_failed_first_edge_activation_restores_absent_units_and_http_origin(self):
        # A prepared first-install identity may have initialized its DB during
        # validation/startup, while the original deployment had no edge units.
        self.system.active = {"worker", "gateway"}
        self.system.enabled = {"worker", "gateway"}
        self.config["origin"] = "http://127.0.0.1:3300"
        self.manager.config = dict(self.config)
        write_json(self.layout.config / "instance.json", self.config)
        self.write_owned_units()
        self.metadata["phase"] = "prepared"
        write_json(self.layout.config / "https.json", self.metadata)
        for path in (self.layout.units / self.layout.unit("caddy"), self.layout.units / self.layout.unit("authelia"), self.layout.config / "Caddyfile"):
            path.unlink()
        self.system.fail = "start"
        with self.assertRaises(DeployError):
            self.rotate()
        self.assertEqual(read_json(self.layout.config / "instance.json")["origin"], "http://127.0.0.1:3300")
        self.assertEqual(self.system.active, {"worker", "gateway"})
        self.assertEqual(self.system.enabled, {"worker", "gateway"})
        for path in (self.layout.units / self.layout.unit("caddy"), self.layout.units / self.layout.unit("authelia"), self.layout.config / "Caddyfile"):
            self.assertFalse(path.exists())
        self.assertEqual(read_json(self.layout.config / "https.json"), self.metadata)
        self.assertEqual(self.journal()[1]["phase"], "recovered")
        self.assert_identity_preserved()

    def test_prior_stopped_edge_services_are_not_started_by_recovery(self):
        self.system.active = {"worker", "gateway"}
        self.system.fail = "reload"
        with self.assertRaises(DeployError):
            self.rotate()
        self.assertEqual(self.system.active, {"worker", "gateway"})
        self.assertEqual({name: file.read_bytes() for name, file in transaction_paths(self.layout).items()}, self.before)
        self.assertEqual(self.system.enabled, {"worker", "gateway", "caddy"})
        self.assert_identity_preserved()

    def test_gateway_only_recovery_does_not_follow_wants_to_stopped_worker(self):
        self.system.active = {"gateway"}
        self.system.enabled = {"worker", "caddy"}
        self.system.fail = "reload"
        with self.assertRaises(DeployError):
            self.rotate()
        self.assertEqual(self.system.active, {"gateway"})
        self.assertEqual(self.system.enabled, {"worker", "caddy"})
        self.assertEqual(self.journal()[1]["phase"], "recovered")
        self.assertEqual(list((self.layout.config / "https-recovery").iterdir()), [])

    def test_gateway_only_repair_preserves_control_maintenance_dropin(self):
        self.system.active = {"gateway"}
        control = self.layout.units / (self.layout.unit("worker") + ".d")
        mkdir(control)
        content = f"[Unit]\nConditionPathExists=!{self.layout.config / 'control-maintenance/worker'}\n".encode()
        path = control / "90-codex-harness-control-maintenance.conf"
        atomic_write(path, content, 0o644)
        original = atomic_write
        def crash(target, data, *args, **kwargs):
            if target == self.layout.units / self.layout.unit("gateway") and "stop" in self.system.events:
                raise KeyboardInterrupt()
            return original(target, data, *args, **kwargs)
        with patch("deploy.https.atomic_write", side_effect=crash), self.assertRaises(KeyboardInterrupt):
            self.rotate()
        self.manager.repair()
        self.assertEqual(self.system.active, {"gateway"})
        self.assertEqual(path.read_bytes(), content)


if __name__ == "__main__":
    unittest.main()
