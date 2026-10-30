"""Portable proxy admission/journal contracts; no services, downloads or credentials.

Positive filesystem fixtures substitute only the POSIX root-ownership condition.
File bytes, modes recorded in journals, path sets, selection hashes and generated
unit comparisons remain production code. Actual root ownership has separate tests.
"""
import base64
import contextlib
import copy
import io
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from deploy import proxy_transaction as transaction
from deploy.cli import parser
from deploy.common import DeployError, Layout, write_json
from deploy.manager import validate_request
from deploy.service_proxy import PROXY_ROLES
from deploy.units import render_units, sudo_rule


def selection(enabled=True, core="a", configuration="b"):
    return {"enabled": enabled, "port": 18793, "core": core * 64, "configuration": configuration * 64}


class ProxyCommandTests(unittest.TestCase):
    def test_cli_requires_explicit_version_and_file_and_keeps_confirmation_opt_in(self):
        args = parser().parse_args(["--instance", "fixture", "proxy-configure", "--config-file", "/private/node.json", "--version", "26.10.29"])
        self.assertEqual((args.instance, args.config_file, args.version, args.port), ("fixture", Path("/private/node.json"), "26.10.29", 18793))
        self.assertFalse(args.confirm_restart)
        update = parser().parse_args(["proxy-core-update", "--version", "26.10.29", "--confirm-restart", "--download-proxy", "http://127.0.0.1:18794"])
        self.assertTrue(update.confirm_restart)
        self.assertEqual(update.download_proxy, "http://127.0.0.1:18794")
        for command in (["proxy-configure", "--version", "26.10.29"], ["proxy-core-update"],
                        ["proxy-recover", "--target", "foreign"], ["proxy-configure", "--url", "vless://fixture"]):
            with self.subTest(command=command), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                parser().parse_args(command)
        self.assertEqual(parser().parse_args(["proxy-recover"]).target, "old")
        self.assertEqual(parser().parse_args(["proxy-recover", "--target", "candidate"]).target, "candidate")

    def test_proxy_commands_are_not_gateway_management_rpcs(self):
        for method in ("proxy-status", "proxy-configure", "proxy-core-update", "proxy-disable", "proxy-rollback", "proxy-recover", "service-proxy/write"):
            with self.subTest(method=method), self.assertRaises(DeployError) as error:
                validate_request({"method": method, "params": {}})
            self.assertEqual(error.exception.code, "method_not_found")


class ProxyTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout("fixture", Path(self.temp.name))
        for directory in (self.layout.config, self.layout.control, self.layout.units, self.layout.state / "transactions",
                          self.layout.root / "etc/sudoers.d"):
            directory.mkdir(parents=True, exist_ok=True)
        self.config = {"workerUid": 1002, "workerGid": 1002, "gatewayUid": 1001, "gatewayGid": 1001,
                       "port": 3300, "origin": "http://127.0.0.1:3300", "codexRelative": "vendor/fixture/codex"}
        self.manager = types.SimpleNamespace(layout=self.layout, config=copy.deepcopy(self.config), system=Mock(),
                                             require_update_ready=Mock(), verify=Mock())
        self.manager.system.state.return_value = {"stopped": True, "ActiveState": "inactive", "SubState": "dead",
                                                  "MainPID": "0", "ControlPID": "0"}
        self.write_current(self.config)
        write_json(self.layout.control / "capabilities.json", {"serviceProxy": 1})
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        # Replace each module's OS view, not global os.name or pathlib semantics.
        # Windows already has this portable ownership branch; Linux root-specific
        # permission evidence belongs to tests/deploy/root/test_proxy_transaction.py.
        portable_os = types.SimpleNamespace(**vars(os)); portable_os.name = "nt"
        for module in ("deploy.proxy_transaction.os", "deploy.service_proxy.os", "deploy.ownership.os"):
            self.stack.enter_context(patch(module, portable_os))
        self.core = self.stack.enter_context(patch("deploy.proxy_core.verify_core", return_value={"version": "26.10.29"}))
        self.configuration = self.stack.enter_context(patch("deploy.proxy_transaction.verify_configuration"))

    def write_current(self, config):
        write_json(self.layout.config / "instance.json", config)
        for name, content in render_units(self.layout, config, config["codexRelative"]).items():
            path = self.layout.units / name; path.write_bytes(content.encode()); path.chmod(0o644)
        sudo = self.layout.root / "etc/sudoers.d/codex-harness-fixture"
        sudo.write_bytes(sudo_rule(self.layout, config=config).encode()); sudo.chmod(0o600)
        self.manager.config = copy.deepcopy(config)

    def journal(self, old=None, following=None):
        old = copy.deepcopy(self.config if old is None else old)
        self.write_current(old)
        candidate = {**old, "serviceProxy": selection()} if following is None else copy.deepcopy(following)
        journal = {"kind": "service-proxy", "phase": "prepared", "before": transaction.snapshot(self.manager),
                   "candidateConfig": candidate, "mainActive": [], "proxyActive": []}
        if os.name == "nt":
            # Windows chmod cannot represent the POSIX modes saved by the
            # Linux installer. Model only that snapshot field, not validation.
            for name, item in journal["before"].items():
                if item is not None: item["mode"] = 0o600 if name == "instance" else 0o644
        path = self.layout.state / "transactions" / ("1" * 32) / "state.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        write_json(path, journal)
        return path, journal

    def validate(self, path, journal):
        write_json(path, journal)
        return transaction.validate_journal(self.manager, path, journal)

    def test_confirmation_and_capability_fail_before_readiness_or_preparation(self):
        for consent in (False, None, 1, "true"):
            with self.subTest(consent=consent), self.assertRaises(DeployError) as error:
                transaction.change(self.manager, action="disable", confirm_restart=consent)
            self.assertEqual(error.exception.code, "confirmation_required")
        self.manager.require_update_ready.assert_not_called()
        write_json(self.layout.control / "capabilities.json", {})
        with self.assertRaises(DeployError) as error:
            transaction.change(self.manager, action="disable", confirm_restart=True)
        self.assertEqual(error.exception.code, "proxy_unsupported")
        self.manager.require_update_ready.assert_not_called()
        self.assertEqual(list((self.layout.state / "transactions").iterdir()), [])

    def test_busy_rejection_precedes_download_snapshot_and_stop(self):
        with patch("deploy.candidate_archive.require_idle", side_effect=DeployError("busy", "tasks active")), \
             patch("deploy.proxy_core.prepare_core") as prepare, patch.object(transaction, "snapshot") as snapshot:
            with self.assertRaises(DeployError) as error:
                transaction.change(self.manager, action="configure", confirm_restart=True, input_file=Path("node.json"), version="26.10.29")
            self.assertEqual(error.exception.code, "busy")
            prepare.assert_not_called(); snapshot.assert_not_called()
        self.manager.system.stop.assert_not_called()

    def test_disabling_an_unconfigured_proxy_is_a_read_only_noop(self):
        original = (self.layout.config / "instance.json").read_bytes()
        result = transaction.change(self.manager, action="disable", confirm_restart=True)
        self.assertEqual(result, {"configured": False, "enabled": False, "coreVersion": None,
                                  "changed": False, "servicesRestored": True})
        self.assertEqual((self.layout.config / "instance.json").read_bytes(), original)
        self.assertEqual(list((self.layout.state / "transactions").iterdir()), [])
        self.manager.system.stop.assert_not_called(); self.manager.system.start.assert_not_called()

    def test_same_core_update_preserves_disabled_selection_without_new_transaction(self):
        self.write_current({**self.config, "serviceProxy": selection(enabled=False)})
        original = (self.layout.config / "instance.json").read_bytes()
        with patch("deploy.proxy_core.prepare_core", return_value={"core": "a" * 64}) as prepare, \
             patch.object(transaction, "snapshot") as snapshot:
            result = transaction.change(self.manager, action="core-update", confirm_restart=True, version="26.10.29")
            prepare.assert_called_once_with(self.layout, "26.10.29", download_proxy=None)
            snapshot.assert_not_called()
        self.assertFalse(result["changed"]); self.assertFalse(result["enabled"])
        self.assertEqual((self.layout.config / "instance.json").read_bytes(), original)
        self.assertEqual(list((self.layout.state / "transactions").iterdir()), [])
        self.manager.system.stop.assert_not_called()

    def test_busy_after_preparation_never_creates_an_intent_or_stops_services(self):
        with patch("deploy.candidate_archive.require_idle", side_effect=[None, DeployError("busy", "new task")]) as idle, \
             patch.object(transaction, "prerequisites"), patch.object(transaction, "prepare_configuration", return_value="b" * 64), \
             patch("deploy.proxy_core.prepare_core", return_value={"core": "a" * 64}) as core, \
             patch.object(transaction, "check_core_config"), patch.object(transaction, "snapshot") as snapshot:
            with self.assertRaises(DeployError) as error:
                transaction.change(self.manager, action="configure", confirm_restart=True, input_file=Path("node.json"), version="26.10.29")
            self.assertEqual(error.exception.code, "busy")
            self.assertEqual(idle.call_count, 2); core.assert_called_once(); snapshot.assert_not_called()
        self.assertEqual(list((self.layout.state / "transactions").iterdir()), [])
        self.manager.system.stop.assert_not_called()

    def test_exact_old_and_candidate_instances_bind_the_same_generated_journal(self):
        path, journal = self.journal()
        old, candidate, before = transaction.validate_journal(self.manager, path, journal)
        self.assertEqual(old, self.config); self.assertEqual(candidate, journal["candidateConfig"])
        self.assertEqual(before["worker"], render_units(self.layout, old, old["codexRelative"])[self.layout.unit("worker")].encode())
        self.write_current(candidate)
        self.assertEqual(transaction.validate_journal(self.manager, path, journal)[:2], (old, candidate))
        self.core.assert_called_with(self.layout, candidate["serviceProxy"]["core"])
        self.configuration.assert_called_with(self.layout, candidate["serviceProxy"])

    def test_both_selected_generations_are_verified_and_incomplete_selection_is_rejected(self):
        old = {**self.config, "serviceProxy": selection()}
        following = {**self.config, "serviceProxy": selection(core="c", configuration="d")}
        path, journal = self.journal(old, following)
        journal["proxyActive"] = list(PROXY_ROLES)
        self.validate(path, journal)
        self.assertEqual([call.args for call in self.core.call_args_list],
                         [(self.layout, "a" * 64), (self.layout, "c" * 64)])
        self.assertEqual([call.args for call in self.configuration.call_args_list],
                         [(self.layout, old["serviceProxy"]), (self.layout, following["serviceProxy"])])
        modified = copy.deepcopy(journal); modified["candidateConfig"]["serviceProxy"].pop("configuration")
        with self.assertRaisesRegex(DeployError, "selection"):
            self.validate(path, modified)

    def test_unrelated_configuration_changes_and_unbound_current_instance_are_rejected(self):
        path, journal = self.journal()
        for key, value in (("port", 3301), ("rootAllowed", True), ("providerConfigLayer", "system-v1")):
            modified = copy.deepcopy(journal); modified["candidateConfig"][key] = value
            with self.subTest(field=key), self.assertRaisesRegex(DeployError, "unrelated"):
                self.validate(path, modified)
        write_json(path, journal)
        self.manager.config = {**self.config, "port": 3399}
        with self.assertRaisesRegex(DeployError, "no longer binds"):
            transaction.validate_journal(self.manager, path, journal)

    def test_partial_roles_duplicate_activity_and_unsafe_snapshot_modes_are_rejected(self):
        path, original = self.journal()
        mutations = [lambda j: j["before"].pop("proxy-routes"), lambda j: j["before"]["worker"].update(mode=0o666),
                     lambda j: j["before"]["worker"].update(mode=True), lambda j: j.update(mainActive=["worker", "worker"]),
                     lambda j: j.update(mainActive=["caddy"]), lambda j: j.update(proxyActive=["proxy"]),
                     lambda j: j.update(phase="unknown-phase")]
        for mutation in mutations:
            journal = copy.deepcopy(original); mutation(journal)
            with self.subTest(journal=journal), self.assertRaises(DeployError): self.validate(path, journal)

    def test_generated_before_units_and_current_file_bytes_cannot_be_substituted(self):
        path, original = self.journal()
        changed = copy.deepcopy(original)
        changed["before"]["worker"]["data"] = base64.b64encode(b"[Service]\nExecStart=/bin/false\n").decode()
        with self.assertRaisesRegex(DeployError, "generated service"):
            self.validate(path, changed)
        write_json(path, original)
        (self.layout.units / self.layout.unit("gateway")).write_bytes(b"foreign unit")
        with self.assertRaises(DeployError): transaction.validate_journal(self.manager, path, original)

    def test_journal_file_identity_private_read_and_exact_bytes_are_required(self):
        path, original = self.journal()
        other = copy.deepcopy(original); other["phase"] = "stopped"
        with self.assertRaisesRegex(DeployError, "journal"):
            transaction.validate_journal(self.manager, path, other)
        foreign = self.layout.state / "transactions" / "foreign" / "state.json"
        with self.assertRaisesRegex(DeployError, "path"):
            transaction.validate_journal(self.manager, foreign, original)
        with patch.object(transaction, "private_file", side_effect=DeployError("integrity", "not a private journal")) as private:
            with self.assertRaisesRegex(DeployError, "private journal"):
                transaction.validate_journal(self.manager, path, original)
            private.assert_called_once_with(path, limit=1024 * 1024)
        linked = path.parent / "alias.json"; os.link(path, linked)
        with self.assertRaisesRegex(DeployError, "regular file"):
            transaction.validate_journal(self.manager, path, original)

    def test_another_pending_transaction_blocks_recovery_before_stop(self):
        path, journal = self.journal()
        other = self.layout.state / "transactions" / ("2" * 32) / "state.json"
        other.parent.mkdir(); write_json(other, {"kind": "release", "phase": "prepared"})
        with patch.object(transaction, "stop") as stop, self.assertRaises(DeployError) as error:
            transaction.recover(self.manager, path, journal)
        self.assertEqual(error.exception.code, "recovery_required"); stop.assert_not_called()
        self.assertEqual(self.manager.config, self.config)


if __name__ == "__main__":
    unittest.main()
