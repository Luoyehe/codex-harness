"""HTTPS transaction faults with local files and substituted OS/edge services."""
import hashlib
import json
import os
import secrets
import sys
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout, atomic_write, digest, fsync_directory, mkdir, read_json, write_json
from deploy.https import (EDGE_ROLES, caddy_configuration, https_revision, read_https_metadata, setup_https,
                          tls_ca_path, tls_paths, transaction_paths)
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


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root metadata ownership fixture")
class HttpsMetadataOwnershipTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.layout = Layout("fixture", Path(temporary.name))
        mkdir(self.layout.config)
        self.path = self.layout.config / "https.json"
        self.metadata = {"host": "fixture.example.test", "tls": "internal", "phase": "active"}
        write_json(self.path, self.metadata, mode=0o600, uid=0, gid=0)

    def assert_unsafe(self):
        with self.assertRaisesRegex(DeployError, "Unsafe HTTPS metadata") as error:
            read_https_metadata(self.layout)
        self.assertEqual(error.exception.code, "integrity")

    def test_root_owned_ordinary_metadata_is_read(self):
        self.assertEqual(self.path.stat().st_uid, 0)
        self.assertEqual(self.path.stat().st_nlink, 1)
        self.assertEqual(read_https_metadata(self.layout), self.metadata)

    def test_user_owned_metadata_is_rejected_without_changing_it(self):
        before = self.path.read_bytes()
        os.chown(self.path, 65534, 65534)
        self.assert_unsafe()
        self.assertEqual(self.path.stat().st_uid, 65534)
        self.assertEqual(self.path.read_bytes(), before)

    def test_group_or_world_writable_metadata_is_rejected(self):
        for mode in (0o620, 0o602):
            with self.subTest(mode=oct(mode)):
                self.path.chmod(mode)
                self.assert_unsafe()

    def test_directory_cannot_replace_metadata(self):
        self.path.unlink()
        self.path.mkdir()
        self.assert_unsafe()

    def test_symlink_cannot_replace_metadata(self):
        target = self.path.with_name("retained.json")
        self.path.rename(target)
        self.path.symlink_to(target)
        self.assert_unsafe()
        self.assertEqual(read_json(target), self.metadata)

    def test_hardlinked_metadata_is_rejected(self):
        os.link(self.path, self.path.with_name("retained.json"))
        self.assert_unsafe()
        self.assertEqual(read_json(self.path), self.metadata)


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
                       "email": "admin@example.test", "auth_port": 19091, "tls": "provided", "http_port": 18080, "https_port": 18443,
                       "password": secrets.token_urlsafe(24)}
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
        self.ports = self.stack.enter_context(patch("deploy.ports.require_edge_ports_available"))
        self.https_health = self.stack.enter_context(patch("deploy.https_health.require_https_ready", return_value={"ready": True}))
        self.account_login = self.stack.enter_context(patch("deploy.https.verify_account_login"))
        self.account_status = self.stack.enter_context(patch("deploy.accounts.account_request", return_value=(
            {"authenticationMode": "account", "initialized": True}, None)))
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

    def test_transaction_parent_sync_failure_precedes_https_stop_and_selection(self):
        def fail(path, **kwargs):
            if path == self.layout.state / "transactions":
                raise OSError("Injected HTTPS journal publication failure")
            return fsync_directory(path, **kwargs)
        with patch("deploy.common.fsync_directory", side_effect=fail), self.assertRaises(OSError):
            self.rotate()
        self.assertEqual(self.system.events, [])
        self.assertEqual({name: file.read_bytes() for name, file in transaction_paths(self.layout).items()}, self.before)
        self.assertEqual(list((self.layout.state / "transactions").glob("*/state.json")), [])

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
        self.assertEqual(self.system.active, {"worker", "gateway", "caddy"})
        self.assertEqual(self.system.enabled, {"worker", "gateway", "caddy"})
        self.assertFalse((self.layout.units / self.layout.unit("authelia")).exists())
        self.assertEqual(selected["authentication"], "builtin")
        self.assertTrue(result["migratedFromAuthelia"])
        self.account_login.assert_called_once()

    def test_unverified_account_cannot_remove_external_authentication(self):
        self.account_login.side_effect = DeployError("account_verification", "Rejected account")
        with self.assertRaisesRegex(DeployError, "Rejected account"):
            self.rotate()
        self.assertEqual(self.system.events, [])
        self.assertEqual({name: file.read_bytes() for name, file in transaction_paths(self.layout).items()}, self.before)

    def test_account_support_lost_during_restart_restores_external_authentication(self):
        self.account_status.return_value = ({"authenticated": False}, None)
        with self.assertRaisesRegex(DeployError, "not restored"):
            self.rotate()
        self.assert_restored()

    def test_first_builtin_setup_creates_no_authelia_unit_or_identity(self):
        self.system.active = {"worker", "gateway"}
        self.system.enabled = {"worker", "gateway"}
        for path in (self.layout.units / self.layout.unit("caddy"), self.layout.units / self.layout.unit("authelia"),
                     self.layout.config / "Caddyfile", self.layout.config / "https.json"):
            path.unlink()
        kwargs = {key: value for key, value in self.kwargs.items() if key not in ("auth_host", "domain", "email", "auth_port")}
        result = setup_https(self.manager, **kwargs, certificate=self.new_cert_path, private_key=self.new_key_path)
        self.assertFalse(result["migratedFromAuthelia"])
        self.assertEqual(self.system.active, {"worker", "gateway", "caddy"})
        self.assertFalse((self.layout.units / self.layout.unit("authelia")).exists())
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

    def builtin(self, mode="internal"):
        self.metadata = {key: value for key, value in self.metadata.items()
                         if key in ("host", "tls", "httpPort", "httpsPort", "phase", "certificateSha256", "privateKeySha256")}
        self.metadata.update(authentication="builtin", tls=mode)
        if mode != "provided":
            self.metadata.pop("certificateSha256")
            self.metadata.pop("privateKeySha256")
        write_json(self.layout.config / "https.json", self.metadata)
        self.system.active = {"worker", "gateway", "caddy"}
        self.system.enabled = {"worker", "gateway", "caddy"}
        (self.layout.units / self.layout.unit("authelia")).unlink()
        for name, value in render_edge_units(self.layout, builtin=True).items():
            atomic_write(self.layout.units / name, value.encode(), 0o644)
        atomic_write(self.layout.config / "Caddyfile", caddy_configuration(self.layout, self.config, self.metadata).encode(), 0o644)
        self.before = {name: file.read_bytes() if file.exists() else None for name, file in transaction_paths(self.layout).items()}
        self.state_before = {}
        for relative in ("gateway/auth.sqlite", "gateway/journal.sqlite", "worker/codex/config.toml", "worker/codex/auth.json"):
            path = self.layout.state / relative
            mkdir(path.parent)
            atomic_write(path, b"fixture persisted state: " + relative.encode(), 0o600)
            info = path.stat()
            self.state_before[path] = (path.read_bytes(), info.st_mode, info.st_uid, info.st_gid)
        return {"host": "public.example.test", "tls": "acme", "http_port": 18081, "https_port": 443,
                "expected_origin": self.config["origin"], "expected_https_revision": https_revision(self.metadata),
                "password": self.kwargs["password"]}

    def assert_builtin_data_preserved(self):
        self.assert_identity_preserved()
        for path, expected in self.state_before.items():
            info = path.stat()
            self.assertEqual((path.read_bytes(), info.st_mode, info.st_uid, info.st_gid), expected)

    def assert_builtin_restored(self):
        self.assertEqual({name: file.read_bytes() if file.exists() else None for name, file in transaction_paths(self.layout).items()}, self.before)
        self.assertEqual(self.system.active, {"worker", "gateway", "caddy"})
        self.assertEqual(self.system.enabled, {"worker", "gateway", "caddy"})
        self.assertEqual(self.journal()[1]["phase"], "recovered")
        self.assertEqual(list((self.layout.config / "https-recovery").iterdir()), [])
        self.assert_builtin_data_preserved()

    def test_builtin_internal_to_public_acme_changes_only_origin_and_edge_selection(self):
        args = self.builtin()
        old_stop = self.system.stop
        def stopped_with_barriers(units):
            for role in EDGE_ROLES:
                self.assertTrue((self.layout.config / "https-recovery" / role).is_file())
                self.assertTrue((self.layout.units / (self.layout.unit(role) + ".d") / "91-codex-harness-https-recovery.conf").is_file())
            old_stop(units)
        self.system.stop = stopped_with_barriers
        result = setup_https(self.manager, **args)
        self.assertEqual(read_json(self.layout.config / "instance.json"), {**self.config, "origin": "https://public.example.test"})
        self.assertEqual(result["previousOrigin"], self.config["origin"])
        self.assertTrue(result["loginRequired"])
        self.assertTrue(result["addressMigrated"])
        selected = read_json(self.layout.config / "https.json")
        self.assertEqual(selected["tls"], "acme")
        self.assertEqual(selected["httpsPort"], 443)
        self.assertEqual(selected["httpPort"], 18081)
        self.assertEqual(result["httpsRevision"], https_revision(selected))
        self.assertEqual(self.journal()[1]["phase"], "committed")
        self.assertEqual(list((self.layout.config / "https-recovery").iterdir()), [])
        self.account_login.assert_called_once()
        self.https_health.assert_called_once_with(self.manager, timeout=120)
        self.assert_builtin_data_preserved()

    def test_terminal_publication_error_retains_verified_https_without_new_barriers(self):
        args = self.builtin()
        def published(path, value, **kwargs):
            write_json(path, value, **kwargs)
            if value.get('kind') == 'https' and value.get('phase') == 'committed':
                raise OSError('Directory fsync failed after terminal replace')
        with patch('deploy.https.write_json', side_effect=published), self.assertRaises(OSError):
            setup_https(self.manager, **args)
        self.assertEqual(self.journal()[1]['phase'], 'committed')
        self.assertEqual(self.manager.config['origin'], 'https://public.example.test')
        self.assertEqual(self.system.active, {'worker', 'gateway', 'caddy'})
        self.assertEqual(self.system.events.count('stop'), 1)
        self.assertEqual(list((self.layout.config / 'https-recovery').iterdir()), [])
        self.manager.require_recovered_transactions(None)
        self.assert_builtin_data_preserved()

    def test_unpublished_terminal_record_leaves_a_verified_candidate_with_explicit_repair(self):
        args = self.builtin()
        def failed(path, value, **kwargs):
            if value.get('kind') == 'https' and value.get('phase') == 'committed':
                raise OSError('Terminal record was not replaced')
            write_json(path, value, **kwargs)
        with patch('deploy.https.write_json', side_effect=failed), self.assertRaises(OSError):
            setup_https(self.manager, **args)
        self.assertEqual(self.journal()[1]['phase'], 'selected')
        self.assertEqual(self.system.active, {'worker', 'gateway', 'caddy'})
        self.manager.repair()
        self.assert_builtin_restored()

    def test_migration_preflight_conflict_and_tampered_old_edge_leave_services_running(self):
        args = self.builtin()
        self.ports.side_effect = DeployError("port_conflict", "Occupied target port")
        with self.assertRaisesRegex(DeployError, "Occupied"):
            setup_https(self.manager, **args)
        self.assertEqual(self.system.events, [])
        self.account_login.assert_not_called()
        self.ports.side_effect = None
        atomic_write(self.layout.config / "Caddyfile", b"unknown operator edit", 0o644)
        with self.assertRaisesRegex(DeployError, "not owned"):
            setup_https(self.manager, **args)
        self.assertEqual(self.system.events, [])
        self.assertEqual(list((self.layout.state / "transactions").iterdir()), [])

    def test_address_migration_preserves_disabled_on_boot_choice(self):
        args = self.builtin()
        self.system.enabled = {"gateway", "caddy"}
        setup_https(self.manager, **args)
        self.assertEqual(self.system.enabled, {"gateway", "caddy"})
        self.assertNotIn("enable", self.system.events)
        self.assert_builtin_data_preserved()

    def test_https_proof_failure_restores_original_address_and_all_persistent_state(self):
        args = self.builtin()
        self.https_health.side_effect = DeployError("https_health", "Certificate or instance proof rejected")
        with self.assertRaisesRegex(DeployError, "proof rejected"):
            setup_https(self.manager, **args)
        self.assert_builtin_restored()

    def test_internal_to_provided_requires_pair_and_retains_selected_immutable_pair(self):
        args = {**self.builtin(), "tls": "provided"}
        with self.assertRaisesRegex(DeployError, "requires --certificate"):
            setup_https(self.manager, **args)
        self.assertEqual(self.system.events, [])
        result = setup_https(self.manager, **args, certificate=self.new_cert_path, private_key=self.new_key_path)
        selected = read_json(self.layout.config / "https.json")
        cert, key = tls_paths(self.layout, selected)
        self.assertEqual(cert.read_bytes(), self.new_cert)
        self.assertEqual(key.read_bytes(), self.new_key)
        self.assertEqual(cert.parent, key.parent)
        self.assertTrue(result["certificateChanged"])
        self.assert_builtin_data_preserved()

    def test_provided_to_acme_retains_previous_pair_for_recovery_but_clears_selection(self):
        args = self.builtin("provided")
        setup_https(self.manager, **args)
        selected = read_json(self.layout.config / "https.json")
        for key in ("tlsRevision", "certificateSha256", "privateKeySha256", "tlsCaRevision", "tlsCaSha256"):
            self.assertNotIn(key, selected)
        self.assertEqual((self.layout.config / "tls/certificate.pem").read_bytes(), self.old_cert)
        self.assertEqual((self.layout.config / "tls/private-key.pem").read_bytes(), self.old_key)
        self.assert_builtin_data_preserved()

    def test_provided_public_ca_is_imported_and_input_changes_cannot_change_selected_trust(self):
        args = {**self.builtin(), "tls": "provided"}
        ca, key = self.root / "public-ca.pem", self.root / "ca-key.pem"
        subprocess.run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key),
                        "-out", str(ca), "-subj", "/CN=Isolated HTTPS migration fixture", "-days", "1"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        expected = ca.read_bytes()
        from deploy.https import stage_tls_ca
        with self.assertRaisesRegex(DeployError, "only public certificates"):
            stage_tls_ca(self.layout, expected + key.read_bytes())
        self.assertFalse((self.layout.config / "tls-ca").exists())
        setup_https(self.manager, **args, certificate=self.new_cert_path, private_key=self.new_key_path, tls_ca_certificate=ca)
        selected = read_json(self.layout.config / "https.json")
        retained = tls_ca_path(self.layout, selected)
        self.assertEqual(retained.read_bytes(), expected)
        ca.write_bytes(b"operator source subsequently changed")
        self.assertEqual(tls_ca_path(self.layout, selected).read_bytes(), expected)
        self.assertEqual(retained.stat().st_uid, 0)
        self.assertFalse(retained.stat().st_mode & 0o022)
        self.assert_builtin_data_preserved()
        # A subsequent public certificate can explicitly return to system trust;
        # omitting a CA alone preserves the existing private trust selection.
        with self.assertRaisesRegex(DeployError, "either the system"):
            setup_https(self.manager, host=selected["host"], tls="provided", http_port=selected["httpPort"],
                        https_port=selected["httpsPort"], password=self.kwargs["password"],
                        tls_system_ca=True, tls_ca_certificate=ca)
        setup_https(self.manager, host=selected["host"], tls="provided", http_port=selected["httpPort"],
                    https_port=selected["httpsPort"], password=self.kwargs["password"], tls_system_ca=True)
        self.assertIsNone(tls_ca_path(self.layout, read_json(self.layout.config / "https.json")))
        self.assertEqual(retained.read_bytes(), expected)

    def test_public_origin_translation_updates_gateway_and_is_retained_on_repair(self):
        args = {**self.builtin(), "https_port": 18444, "public_origin": "https://public.example.test"}
        original_start = self.system.start
        def unknown_start(units):
            self.system.stop_unknown = True
            raise DeployError("start_failed", "Injected unknown recovery")
        self.system.start = unknown_start
        with self.assertRaisesRegex(DeployError, "recovery is unconfirmed"):
            setup_https(self.manager, **args)
        selected = read_json(self.layout.config / "https.json")
        self.assertEqual(selected["httpsPort"], 18444)
        self.assertEqual(selected["publicOrigin"], "https://public.example.test")
        self.assertEqual(read_json(self.layout.config / "instance.json")["origin"], "https://public.example.test")
        self.assertEqual(self.journal()[1]["phase"], "selected")
        self.system.stop_unknown = False
        self.system.start = original_start
        self.manager.repair()
        self.assert_builtin_restored()

    def test_process_interruption_during_address_change_keeps_boot_barriers_until_repair(self):
        args = self.builtin()
        def crash(path, data, *values, **options):
            if path == self.layout.units / self.layout.unit("gateway") and "stop" in self.system.events:
                raise KeyboardInterrupt()
            return atomic_write(path, data, *values, **options)
        with patch("deploy.https.atomic_write", side_effect=crash), self.assertRaises(KeyboardInterrupt):
            setup_https(self.manager, **args)
        self.assertEqual(self.journal()[1]["phase"], "stopped")
        self.assertEqual({path.name for path in (self.layout.config / "https-recovery").iterdir()}, set(EDGE_ROLES))
        self.assertEqual(self.system.active, set())
        self.manager.repair()
        self.assert_builtin_restored()

    def dns_binary_fixture(self, recipe):
        revision = digest(recipe)
        binary = self.layout.control / "edge/caddy/dns" / revision / "caddy"
        mkdir(binary.parent, 0o755)
        atomic_write(binary, b"isolated fixture binary never executed", 0o755)
        sha = hashlib.sha256(binary.read_bytes()).hexdigest()
        write_json(binary.parent / "manifest.json", {"format": 1, "recipe": recipe, "sha256": sha})
        selected_binary = {"dnsBinaryRevision": revision, "dnsBinarySha256": sha}
        return selected_binary, binary

    def dns_fixture(self, *, first=False, retained=False, provider="alidns"):
        """Real protected generations; only building/executing Caddy is substituted."""
        from deploy.dns_tls import read_dns_credentials, stage_dns_credentials
        from deploy.dns_providers import PROVIDERS
        from deploy.dns_caddy_build import recipe as current_recipe
        args = {**self.builtin("acme"), "https_port": 18443, "dns_provider": provider}
        source = self.root / (provider + ".json")
        if provider == "alidns":
            data = b'{"accessKeyId":"isolated-fake-access-id","accessKeySecret":"isolated-fake-access-secret"}'
            recipe = {"format": 1, "provider": "alidns", "caddyVersion": "2.11.7", "providerVersion": "1.0.29",
                      "goVersion": "1.26.10", "goArchiveSha256": "a" * 64, "architecture": "amd64",
                      "sources": {name: "b" * 64 for name in ("main.go", "main_test.go", "go.mod", "go.sum")},
                      "buildPolicy": "go-readonly-offline-v1"}
        else:
            data = json.dumps({field.name: "us-east-1" if field.kind == "region" else "isolated-fake-" + field.name
                               for field in PROVIDERS[provider].fields}).encode()
            recipe = current_recipe("amd64")
        atomic_write(source, data, 0o600)
        selected_binary, binary = self.dns_binary_fixture(recipe)
        self.dns_builder = self.stack.enter_context(patch("deploy.dns_caddy_build.provision_dns_caddy", return_value=selected_binary))
        self.dns_validator = self.stack.enter_context(patch("deploy.dns_tls.subprocess.run",
                                                          return_value=subprocess.CompletedProcess([], 0)))
        if retained:
            self.metadata.update(dnsProvider=provider, **selected_binary,
                                 **stage_dns_credentials(self.layout, read_dns_credentials(source, provider)))
            write_json(self.layout.config / "https.json", self.metadata)
            for name, value in render_edge_units(self.layout, builtin=True, dns_metadata=self.metadata).items():
                atomic_write(self.layout.units / name, value.encode(), 0o644)
            atomic_write(self.layout.config / "Caddyfile", caddy_configuration(self.layout, self.config, self.metadata).encode(), 0o644)
            args["expected_https_revision"] = https_revision(self.metadata)
        else:
            args["dns_credentials"] = source
        if first:
            args = {key: value for key, value in args.items() if not key.startswith("expected_")}
            self.config["origin"] = "http://127.0.0.1:3300"
            self.manager.config = dict(self.config)
            write_json(self.layout.config / "instance.json", self.config)
            for name, value in render_units(self.layout, self.config, self.config["codexRelative"]).items():
                atomic_write(self.layout.units / name, value.encode(), 0o644)
            for path in (self.layout.config / "https.json", self.layout.config / "Caddyfile", self.layout.units / self.layout.unit("caddy")):
                path.unlink()
            self.system.active = self.system.enabled = {"worker", "gateway"}
            self.system.active = set(self.system.active)
        self.before = {name: file.read_bytes() if file.exists() else None for name, file in transaction_paths(self.layout).items()}
        return args, source, binary

    def test_dns_inputs_and_managed_generations_require_root_0600_and_reject_tampering(self):
        from deploy.dns_tls import dns_credentials_path, read_dns_credentials
        _, source, _ = self.dns_fixture(retained=True)
        expected = read_dns_credentials(source)
        for mode in (0o400, 0o640, 0o644):
            source.chmod(mode)
            with self.subTest(mode=oct(mode)), self.assertRaisesRegex(DeployError, "0600"):
                read_dns_credentials(source)
        source.chmod(0o600)
        os.chown(source, 65534, 65534)
        with self.assertRaisesRegex(DeployError, "root-owned"):
            read_dns_credentials(source)
        os.chown(source, 0, 0)
        path = dns_credentials_path(self.layout, self.metadata)
        self.assertEqual(path.read_bytes(), expected)
        self.assertEqual((path.stat().st_uid, path.stat().st_gid, path.stat().st_mode & 0o777), (0, 0, 0o600))
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        atomic_write(path, expected.replace(b"access-secret", b"changed-secret"), 0o600)
        with self.assertRaisesRegex(DeployError, "Retained DNS credentials changed"):
            dns_credentials_path(self.layout, self.metadata)
        path.unlink()
        path.symlink_to(source)
        with self.assertRaises(DeployError):
            dns_credentials_path(self.layout, self.metadata)
        path.unlink()
        atomic_write(path, expected, 0o600)
        real_directory = path.parent.with_name("retained-private-generation")
        path.parent.rename(real_directory)
        path.parent.symlink_to(real_directory, target_is_directory=True)
        with self.assertRaisesRegex(DeployError, "Unsafe DNS credential directory"):
            dns_credentials_path(self.layout, self.metadata)
        self.assertEqual(self.system.events, [])

    def test_initial_dns_activation_binds_protected_material_without_disclosing_values(self):
        from deploy.dns_tls import dns_credentials_path
        args, source, binary = self.dns_fixture(first=True)
        result = setup_https(self.manager, **args)
        selected = read_json(self.layout.config / "https.json")
        credentials = dns_credentials_path(self.layout, selected)
        self.assertEqual(result["origin"], "https://public.example.test:18443")
        self.assertEqual(selected["dnsProvider"], "alidns")
        self.assertEqual(selected["phase"], "active")
        self.assertEqual(self.system.active, {"worker", "gateway", "caddy"})
        self.assertEqual(self.system.enabled, {"worker", "gateway", "caddy"})
        unit = (self.layout.units / self.layout.unit("caddy")).read_text()
        self.assertIn("ExecStart=" + str(binary), unit)
        self.assertIn("EnvironmentFile=" + str(credentials), unit)
        for value in ("isolated-fake-access-id", "isolated-fake-access-secret"):
            for text in (unit, json.dumps(result), json.dumps(selected), (self.layout.config / "Caddyfile").read_text(),
                         self.journal()[0].read_text(), " ".join(self.dns_validator.call_args.args[0])):
                self.assertNotIn(value, text)
        source.write_bytes(b"input changed after activation")
        self.assertTrue(credentials.read_bytes().endswith(b"isolated-fake-access-secret\n"))
        self.https_health.assert_called_once_with(self.manager, timeout=300)
        self.assert_builtin_data_preserved()

    def test_pending_first_dns_validation_retry_failure_restores_http_and_absent_units(self):
        from deploy.dns_tls import dns_credentials_path
        args, _, _ = self.dns_fixture(first=True)
        self.dns_validator.return_value = subprocess.CompletedProcess([], 1)
        with self.assertRaisesRegex(DeployError, "validation failed"):
            setup_https(self.manager, **args)
        prepared = read_json(self.layout.config / "https.json")
        credentials = dns_credentials_path(self.layout, prepared)
        self.assertEqual(prepared["phase"], "prepared")
        self.assertEqual(self.system.events, [])
        self.assertFalse((self.layout.units / self.layout.unit("caddy")).exists())
        self.assertEqual(list((self.layout.state / "transactions").iterdir()), [])
        self.dns_validator.return_value = subprocess.CompletedProcess([], 0)
        self.https_health.side_effect = DeployError("https_health", "Injected DNS readiness failure")
        retry = {key: value for key, value in args.items() if key not in ("dns_provider", "dns_credentials")}
        with self.assertRaisesRegex(DeployError, "DNS readiness failure"):
            setup_https(self.manager, **retry)
        self.assertEqual(read_json(self.layout.config / "instance.json")["origin"], "http://127.0.0.1:3300")
        self.assertEqual(read_json(self.layout.config / "https.json"), prepared)
        self.assertEqual(dns_credentials_path(self.layout, prepared), credentials)
        self.assertEqual(self.system.active, {"worker", "gateway"})
        self.assertEqual(self.system.enabled, {"worker", "gateway"})
        self.assertFalse((self.layout.units / self.layout.unit("caddy")).exists())
        self.assertFalse((self.layout.config / "Caddyfile").exists())
        self.assertEqual(self.journal()[1]["phase"], "recovered")
        self.assert_builtin_data_preserved()
        self.https_health.side_effect = None
        setup_https(self.manager, **retry)
        self.assertEqual(read_json(self.layout.config / "https.json")["dnsCredentialsRevision"], prepared["dnsCredentialsRevision"])

    def test_new_provider_activation_binds_only_its_private_credentials(self):
        from deploy.dns_tls import dns_credentials_path
        args, _, binary = self.dns_fixture(first=True, provider="cloudflare")
        result = setup_https(self.manager, **args)
        selected = read_json(self.layout.config / "https.json")
        credentials = dns_credentials_path(self.layout, selected)
        self.assertEqual(selected["dnsProvider"], "cloudflare")
        self.assertEqual(credentials.read_bytes(), b"HARNESS_CLOUDFLARE_API_TOKEN=isolated-fake-apiToken\n")
        self.assertEqual(credentials.stat().st_uid, 0)
        self.assertEqual(credentials.stat().st_mode & 0o777, 0o600)
        unit = (self.layout.units / self.layout.unit("caddy")).read_text()
        self.assertIn("ExecStart=" + str(binary), unit)
        self.assertIn("EnvironmentFile=" + str(credentials), unit)
        caddyfile = (self.layout.config / "Caddyfile").read_text()
        self.assertEqual(json.loads(caddyfile)["dns_provider"], "cloudflare")
        self.assertNotIn("HARNESS_ALIDNS", caddyfile)
        for text in (unit, caddyfile, json.dumps(result), json.dumps(selected), self.journal()[0].read_text(),
                     " ".join(self.dns_validator.call_args.args[0])):
            self.assertNotIn("isolated-fake-apiToken", text)
        self.assert_builtin_data_preserved()

    def test_provider_change_requires_new_credentials_and_retains_previous_generation(self):
        from deploy.dns_tls import dns_credentials_path
        from deploy.dns_caddy_build import recipe
        args, source, original_binary = self.dns_fixture(retained=True)
        original = dns_credentials_path(self.layout, self.metadata)
        original_bytes = original.read_bytes()
        with self.assertRaisesRegex(DeployError, "requires --dns-credentials"):
            setup_https(self.manager, **{**args, "dns_provider": "cloudflare"})
        self.assertEqual(self.system.events, [])
        self.dns_builder.assert_not_called()
        selected_binary, new_binary = self.dns_binary_fixture(recipe("amd64"))
        self.dns_builder.return_value = selected_binary
        atomic_write(source, b'{"apiToken":"isolated-new-api-token"}', 0o600)
        setup_https(self.manager, **{**args, "dns_provider": "cloudflare", "dns_credentials": source})
        selected = read_json(self.layout.config / "https.json")
        self.assertEqual(selected["dnsProvider"], "cloudflare")
        self.assertNotEqual(selected["dnsBinaryRevision"], self.metadata["dnsBinaryRevision"])
        self.assertNotEqual(dns_credentials_path(self.layout, selected), original)
        self.assertEqual(original.read_bytes(), original_bytes)
        self.assertTrue(original_binary.is_file())
        self.assertIn("ExecStart=" + str(new_binary), (self.layout.units / self.layout.unit("caddy")).read_text())
        self.assert_builtin_data_preserved()

    def test_failed_provider_change_restores_old_provider_credentials_binary_and_services(self):
        from deploy.dns_tls import dns_credentials_path
        from deploy.dns_caddy_build import recipe
        args, source, _ = self.dns_fixture(retained=True)
        original = dns_credentials_path(self.layout, self.metadata)
        original_bytes = original.read_bytes()
        selected_binary, _ = self.dns_binary_fixture(recipe("amd64"))
        self.dns_builder.return_value = selected_binary
        atomic_write(source, b'{"secretId":"isolated-tencent-id","secretKey":"isolated-tencent-key"}', 0o600)
        self.https_health.side_effect = DeployError("https_health", "Injected new provider readiness failure")
        with self.assertRaisesRegex(DeployError, "new provider readiness failure"):
            setup_https(self.manager, **{**args, "dns_provider": "tencentcloud", "dns_credentials": source})
        self.assert_builtin_restored()
        self.assertEqual(dns_credentials_path(self.layout, read_json(self.layout.config / "https.json")), original)
        self.assertEqual(original.read_bytes(), original_bytes)
        self.assertEqual(len(list((self.layout.config / "dns").glob("*/credentials.env"))), 2)

    def test_dns_credential_rotation_changes_only_selected_generation_and_preserves_old_one(self):
        from deploy.dns_tls import dns_credentials_path
        _, source, _ = self.dns_fixture(retained=True)
        old = dict(self.metadata)
        retained_path = dns_credentials_path(self.layout, old)
        retained_bytes = retained_path.read_bytes()
        atomic_write(source, b'{"accessKeyId":"isolated-new-access-id","accessKeySecret":"isolated-new-access-secret"}', 0o600)
        result = setup_https(self.manager, host=old["host"], tls="acme", http_port=old["httpPort"],
                             https_port=old["httpsPort"], password=self.kwargs["password"], dns_credentials=source)
        selected = read_json(self.layout.config / "https.json")
        self.assertNotEqual(selected["dnsCredentialsRevision"], old["dnsCredentialsRevision"])
        self.assertEqual(selected["dnsBinaryRevision"], old["dnsBinaryRevision"])
        self.assertEqual(result["origin"], self.config["origin"])
        self.assertEqual(retained_path.read_bytes(), retained_bytes)
        self.assertIn(b"isolated-new-access-secret", dns_credentials_path(self.layout, selected).read_bytes())
        self.assert_builtin_data_preserved()

    def test_existing_dns_migration_failure_restores_selected_material_and_state(self):
        from deploy.dns_tls import dns_credentials_path
        args, source, _ = self.dns_fixture(retained=True)
        old_path = dns_credentials_path(self.layout, self.metadata)
        old_bytes = old_path.read_bytes()
        atomic_write(source, b'{"accessKeyId":"isolated-new-access-id","accessKeySecret":"isolated-new-access-secret"}', 0o600)
        self.https_health.side_effect = DeployError("https_health", "Injected DNS readiness failure")
        with self.assertRaisesRegex(DeployError, "DNS readiness failure"):
            setup_https(self.manager, **{**args, "https_port": 18444, "dns_credentials": source})
        self.assert_builtin_restored()
        self.assertEqual(old_path.read_bytes(), old_bytes)
        self.assertEqual(dns_credentials_path(self.layout, read_json(self.layout.config / "https.json")), old_path)
        generations = list((self.layout.config / "dns").glob("*/credentials.env"))
        self.assertEqual(len(generations), 2)
        self.assertTrue(any(b"isolated-new-access-secret" in path.read_bytes() for path in generations))

    def test_dns_unit_publication_before_metadata_failure_remains_recoverable(self):
        args, source, _ = self.dns_fixture(retained=True)
        atomic_write(source, b'{"accessKeyId":"isolated-new-access-id","accessKeySecret":"isolated-new-access-secret"}', 0o600)
        # Raise only in the main publication path; recovery uses the same helper
        # but must be allowed to put the original Caddyfile back.
        fired = False
        def once(path, data, *values, **options):
            nonlocal fired
            if not fired and path == self.layout.config / "Caddyfile" and "stop" in self.system.events:
                fired = True
                raise OSError("Injected write failure after DNS unit publication")
            return atomic_write(path, data, *values, **options)
        with patch("deploy.https.atomic_write", side_effect=once), self.assertRaisesRegex(OSError, "after DNS unit publication"):
            setup_https(self.manager, **{**args, "dns_credentials": source})
        self.assert_builtin_restored()

    def test_unknown_dns_migration_stop_preserves_both_generations_until_repair(self):
        from deploy.dns_tls import dns_credentials_path
        args, source, _ = self.dns_fixture(retained=True)
        original = dns_credentials_path(self.layout, self.metadata)
        atomic_write(source, b'{"accessKeyId":"isolated-new-access-id","accessKeySecret":"isolated-new-access-secret"}', 0o600)
        start = self.system.start
        def uncertain(units):
            self.system.stop_unknown = True
            raise DeployError("start_failed", "Injected DNS start failure")
        self.system.start = uncertain
        with self.assertRaisesRegex(DeployError, "recovery is unconfirmed"):
            setup_https(self.manager, **{**args, "dns_credentials": source})
        selected = read_json(self.layout.config / "https.json")
        candidate = dns_credentials_path(self.layout, selected)
        self.assertNotEqual(candidate, original)
        self.assertTrue(original.exists())
        self.assertEqual(self.journal()[1]["phase"], "selected")
        self.assertEqual({path.name for path in (self.layout.config / "https-recovery").iterdir()}, set(EDGE_ROLES))
        self.system.stop_unknown = False
        self.system.start = start
        self.manager.repair()
        self.assert_builtin_restored()
        self.assertTrue(candidate.exists())
        self.assertTrue(original.exists())

    def test_tampered_dns_generation_blocks_migration_before_credentials_or_service_stop(self):
        from deploy.dns_tls import dns_credentials_path
        args, _, _ = self.dns_fixture(retained=True)
        path = dns_credentials_path(self.layout, self.metadata)
        atomic_write(path, b"tampered", 0o600)
        with self.assertRaisesRegex(DeployError, "Retained DNS credentials changed"):
            setup_https(self.manager, **args)
        self.account_login.assert_not_called()
        self.dns_validator.assert_not_called()
        self.assertEqual(self.system.events, [])
        self.assertEqual(list((self.layout.state / "transactions").iterdir()), [])

    def test_verify_stopped_dns_edge_checks_selected_unit_and_actual_credential_binary_hashes(self):
        from deploy.dns_tls import dns_credentials_path
        _, _, binary = self.dns_fixture(retained=True)
        credentials = dns_credentials_path(self.layout, self.metadata)
        credential_bytes, binary_bytes = credentials.read_bytes(), binary.read_bytes()
        self.system.active = {"worker", "gateway"}
        with patch("deploy.https_health.https_health") as probe:
            result = self.manager.verify_https(probe=False)
            self.assertTrue(result["configured"])
            self.assertEqual(result["failure"], "not_probed")
            self.assertFalse(result["ready"])
            atomic_write(credentials, b"modified credential bytes", 0o600)
            with self.assertRaisesRegex(DeployError, "Retained DNS credentials changed"):
                self.manager.verify_https(probe=False)
            atomic_write(credentials, credential_bytes, 0o600)
            atomic_write(binary, binary_bytes + b"modified", 0o755)
            with self.assertRaisesRegex(DeployError, "DNS Caddy binary changed"):
                self.manager.verify_https(probe=False)
            atomic_write(binary, binary_bytes, 0o755)
            unit = self.layout.unit("caddy")
            atomic_write(self.layout.units / unit, render_edge_units(self.layout, builtin=True)[unit].encode(), 0o644)
            with self.assertRaisesRegex(DeployError, "not owned"):
                self.manager.verify_https(probe=False)
            probe.assert_not_called()
        self.assertEqual(self.system.events, [])
        self.assertEqual(self.system.active, {"worker", "gateway"})
        self.assert_builtin_data_preserved()


if __name__ == "__main__":
    unittest.main()
