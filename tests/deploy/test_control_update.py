"""Unprivileged control maintenance interface checks."""
import base64
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.cli import parser
from deploy.common import DeployError, Layout, canonical, read_json, require, write_json
from deploy.control_update import ControlSystem, ControlUpdater
from deploy.install import stage_control
from deploy.dns_providers import PROVIDERS


def dns_selection(provider):
    return {"tls": "acme", "authentication": "builtin", "dnsProvider": provider,
            "dnsCredentialsRevision": "a" * 32, "dnsCredentialsSha256": "b" * 64,
            "dnsBinaryRevision": "c" * 64, "dnsBinarySha256": "d" * 64}


DNS_CAPABILITIES = {"dnsChallenge": "caddy-dns-v1", "dnsProviders": list(PROVIDERS)}


def previous_sudo_policy(layout, *, workspace=True):
    """Recorded pre-registry grammar, independent of the current renderer."""
    native = f"{layout.control}/native-launch"
    commands = [native + " version", native + " app-server", native + " resolve-project"]
    if workspace:
        commands.append(native + " workspace")
    return (f"Defaults:{layout.prefix}-gateway env_reset,!setenv\n"
            f"{layout.prefix}-gateway ALL=(root) NOPASSWD: {layout.control}/manage rpc\n"
            f"Defaults:{layout.prefix}-control env_reset,!setenv,!use_pty\n"
            f"{layout.prefix}-control ALL=({layout.prefix}-worker) NOPASSWD: {', '.join(commands)}\n").encode()


class SudoCompatibilityTests(unittest.TestCase):
    def test_only_exact_previous_or_current_policies_are_recognized(self):
        from deploy.ownership import require_owned
        from deploy.units import sudo_rule
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            policy = layout.root / "etc/sudoers.d/codex-harness-fixture"
            policy.parent.mkdir(parents=True)
            config = {"origin": "http://127.0.0.1:3300", "port": 3300, "workerGid": 102, "codexRelative": "vendor/fixture/codex"}
            # This portable test substitutes only the root-owned file boundary;
            # real owner/mode/hardlink rejection is covered by the root fixture.
            def boundary(path, expected):
                self.assertEqual(path, policy)
                require(path.read_bytes() in expected, "Unrecognized sudo policy", "ownership_conflict")
            with patch("deploy.ownership.regular", side_effect=boundary):
                for workspace in (False, True):
                    old = previous_sudo_policy(layout, workspace=workspace)
                    for value in (old, sudo_rule(layout, workspace=workspace).encode()):
                        policy.write_bytes(value)
                        require_owned(layout, config, allow_absent=True)
                    for value in (old + b"root ALL=(ALL) NOPASSWD: ALL\n", old.replace(b" app-server", b" shell"),
                                  old.replace(b" resolve-project", b" resolve-project *"), old + b"\n"):
                        with self.subTest(workspace=workspace, policy=value):
                            policy.write_bytes(value)
                            with self.assertRaises(DeployError) as raised:
                                require_owned(layout, config, allow_absent=True)
                            self.assertEqual(raised.exception.code, "ownership_conflict")


class ControlBoundaryTests(unittest.TestCase):
    def metadata_reader(self, layout):
        # These tests exercise control admission after the root-owned read.
        def read_fixture(actual):
            self.assertIs(actual, layout)
            return read_json(layout.config / "https.json")
        return patch("deploy.https.read_https_metadata", side_effect=read_fixture)

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
            "codex-harness-main-dns-build-" + "e" * 32 + ".service loaded active running DNS build",
            "codex-harness-main-other-dns-build-" + "f" * 32 + ".service loaded active running other DNS build",
            "codex-harness-main-dns-test-" + "a" * 32 + ".service loaded active running DNS test",
            "codex-harness-main-other-dns-test-" + "b" * 32 + ".service loaded active running other DNS test",
            "codex-harness-main-proxy.service loaded active running proxy",
            "codex-harness-main-proxy-routes.service loaded active exited routes",
            "codex-harness-main-other-proxy.service loaded active running other proxy",
            "codex-harness-main-other-proxy-routes.service loaded active exited other routes",
        ])
        with patch("deploy.control_update.run", return_value=subprocess.CompletedProcess([], 0, text, "")):
            units = ControlSystem().instance_units(Layout("main"))
        self.assertEqual(len(units), 7)
        self.assertFalse(any("main-other" in unit for unit in units))

    def test_proxy_selection_requires_capable_control_even_when_disabled(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            layout.config.mkdir(parents=True)
            write_json(layout.config / "instance.json", {})
            updater = ControlUpdater(layout)
            updater.require_dns_guard({})
            for enabled in (False, True):
                updater.config["serviceProxy"] = {"enabled": enabled, "port": 18793,
                                                  "core": "a" * 64, "configuration": "b" * 64}
                with self.subTest(enabled=enabled):
                    with self.assertRaises(DeployError) as failure:
                        updater.require_dns_guard({})
                    self.assertEqual(failure.exception.code, "proxy_unsupported")
                    updater.require_dns_guard({"serviceProxy": 1})

    def test_proxy_routes_snapshot_accepts_only_stable_oneshot_activity(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            layout.config.mkdir(parents=True)
            write_json(layout.config / "instance.json", {"serviceProxy": {
                "enabled": True, "port": 18793, "core": "a" * 64, "configuration": "b" * 64}})
            updater = ControlUpdater(layout)
            def state(unit):
                routes = unit == layout.unit("proxy-routes")
                return {"ActiveState": "active", "SubState": "exited" if routes else "running",
                        "MainPID": "0" if routes else "100", "ControlPID": "0", "stopped": False}
            with patch.object(updater.system, "state", side_effect=state), \
                 patch.object(updater.system, "enabled_state", return_value="static"):
                snapshot = updater.service_snapshot()
                self.assertEqual(set(snapshot), {"worker", "gateway", "authelia", "caddy", "proxy", "proxy-routes"})
                self.assertTrue(snapshot["proxy-routes"]["active"])
            with patch.object(updater.system, "state", return_value={"ActiveState": "activating", "SubState": "start",
                    "MainPID": "0", "ControlPID": "100", "stopped": False}), self.assertRaises(DeployError):
                updater.service_snapshot()

    def test_control_checks_retained_proxy_material_before_preparation_and_service_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            layout.config.mkdir(parents=True)
            write_json(layout.config / "instance.json", {"serviceProxy": {
                "enabled": True, "port": 18793, "core": "a" * 64, "configuration": "b" * 64}})
            updater = ControlUpdater(layout)
            with patch("deploy.control_update.require_recovered"), patch("deploy.control_update.require_owned"), \
                 patch("deploy.service_proxy.verify_selection", side_effect=DeployError("integrity", "changed proxy material")) as verify, \
                 patch.object(updater, "prepare_paths") as prepare, patch.object(updater.system, "start") as start:
                with self.assertRaisesRegex(DeployError, "changed proxy material"):
                    updater.update()
                verify.assert_called_once_with(layout, updater.config)
                prepare.assert_not_called()
                start.assert_not_called()
                with self.assertRaisesRegex(DeployError, "changed proxy material"):
                    updater.restore_services({})
                self.assertEqual(verify.call_count, 2)
                start.assert_not_called()

    def test_stage_has_fixed_real_paths_and_excludes_checkout_bytecode(self):
        with tempfile.TemporaryDirectory(prefix="stage-control-") as folder:
            layout = Layout("fixture", Path(folder))
            destination = Path(folder) / "staged"
            stage_control(layout, destination)
            self.assertEqual(read_json(destination / "capabilities.json")["authenticationGuard"], "account-v1")
            self.assertEqual(read_json(destination / "capabilities.json")["dnsChallenge"], "caddy-dns-v1")
            self.assertEqual(read_json(destination / "capabilities.json")["dnsProviders"], list(PROVIDERS))
            from deploy.dns_caddy_build import source_material
            for name, data in source_material().items():
                self.assertEqual((destination / "deploy/caddy_dns_source" / name).read_bytes(), data)
            self.assertTrue((destination / "deploy/control_update.py").is_file())
            self.assertEqual(list(destination.rglob("*.pyc")), [])
            self.assertFalse((destination / "deploy/README.md").exists())
            for name in ("manage", "native-launch"):
                content = (destination / name).read_text()
                self.assertIn("sys.dont_write_bytecode = True", content)
                self.assertIn(repr(str(layout.control)), content)
                self.assertFalse((destination / name).is_symlink())

    def test_initialization_plan_claims_recipe_parent_before_publication(self):
        from deploy.install_recovery import build_plan
        layout = Layout("fixture")
        state = {"identities": {name: {"uid": 800 + index, "gid": 800 + index}
                                for index, name in enumerate(("gateway", "worker", "control"))},
                 "config": {"codexRelative": "vendor/fixture/codex"}, "token": "fixture-token",
                 "providerRevision": "a" * 32, "account": None}
        material = {"deploy/caddy_dns_source/main.go": (b"package main\n", 0o644)}
        with patch("deploy.provider.native_config", return_value=b""), \
             patch("deploy.provider_layers.prepare_host_targets"), \
             patch("deploy.provider_layers.generation_layers", return_value=({}, {})), \
             patch("deploy.units.render_units", return_value={}), patch("deploy.units.sudo_rule", return_value=""):
            plan = build_plan(layout, state, material)
        parent = layout.control / "deploy/caddy_dns_source"
        self.assertEqual(plan.entries[parent], {"kind": "directory", "mode": 0o755, "uid": 0, "gid": 0})
        self.assertEqual(plan.content[parent / "main.go"], b"package main\n")

    def test_selected_dns_blocks_legacy_control_and_accepts_capable_control(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            layout.config.mkdir(parents=True)
            write_json(layout.config / "instance.json", {})
            updater = ControlUpdater(layout)
            updater.require_dns_guard({})
            write_json(layout.config / "https.json", {"tls": "internal"})
            with self.metadata_reader(layout) as reader:
                updater.require_dns_guard({})
                reader.assert_called_once_with(layout)
            for selection in (dns_selection("cloudflare"), {"dnsBinaryRevision": "a" * 64}, {"dnsProvider": None}):
                with self.subTest(selection=selection):
                    write_json(layout.config / "https.json", {"tls": "acme", **selection})
                    with self.metadata_reader(layout) as reader:
                        with self.assertRaises(DeployError) as error:
                            updater.require_dns_guard({})
                        self.assertEqual(error.exception.code, "dns_downgrade")
                        reader.assert_called_once_with(layout)
                        reader.reset_mock()
                        if selection == dns_selection("cloudflare"):
                            updater.require_dns_guard(DNS_CAPABILITIES)
                        else:
                            with self.assertRaises(DeployError):
                                updater.require_dns_guard(DNS_CAPABILITIES)
                        reader.assert_called_once_with(layout)

    def test_original_v1_control_supports_only_alidns_and_rejects_new_provider_or_damaged_selection(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            layout.config.mkdir(parents=True)
            write_json(layout.config / "instance.json", {})
            updater = ControlUpdater(layout)
            for provider in PROVIDERS:
                write_json(layout.config / "https.json", dns_selection(provider))
                with self.subTest(provider=provider), self.metadata_reader(layout):
                    updater.require_dns_guard(DNS_CAPABILITIES)
                    if provider == "alidns":
                        updater.require_dns_guard({"dnsChallenge": "caddy-dns-v1"})
                    else:
                        with self.assertRaises(DeployError) as error:
                            updater.require_dns_guard({"dnsChallenge": "caddy-dns-v1"})
                        self.assertEqual(error.exception.code, "dns_downgrade")
            for changes in ({"dnsProvider": "unknown"}, {"dnsCredentialsSha256": "bad"},
                            {"dnsExtraCapability": "required"}, {"tls": "internal"}, {"authentication": None}):
                write_json(layout.config / "https.json", {**dns_selection("alidns"), **changes})
                with self.subTest(changes=changes), self.metadata_reader(layout), self.assertRaises(DeployError):
                    updater.require_dns_guard(DNS_CAPABILITIES)

    def test_invalid_provider_capability_declarations_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            layout.config.mkdir(parents=True)
            write_json(layout.config / "instance.json", {})
            updater = ControlUpdater(layout)
            for capabilities in ({"dnsProviders": ["alidns"]}, {**DNS_CAPABILITIES, "dnsProviders": "alidns"},
                                 {**DNS_CAPABILITIES, "dnsProviders": ["unknown"]},
                                 {**DNS_CAPABILITIES, "dnsProviders": ["alidns", "alidns"]},
                                 {**DNS_CAPABILITIES, "dnsProviders": [{}]}):
                with self.subTest(capabilities=capabilities), self.assertRaises(DeployError):
                    updater.require_dns_guard(capabilities)

    def test_dns_material_is_checked_before_control_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            layout.config.mkdir(parents=True)
            write_json(layout.config / "instance.json", {})
            metadata = {"tls": "acme", "dnsProvider": "cloudflare"}
            write_json(layout.config / "https.json", metadata)
            updater = ControlUpdater(layout)
            with self.metadata_reader(layout) as reader, \
                 patch("deploy.dns_tls.validate_dns_selection", side_effect=DeployError("integrity", "changed DNS material")) as validate:
                with self.assertRaisesRegex(DeployError, "changed DNS material"):
                    updater.restore_services({})
                reader.assert_called_once_with(layout)
                validate.assert_called_once_with(layout, metadata)

    def test_pending_https_snapshot_prevents_dns_recovery_downgrade(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            layout.config.mkdir(parents=True)
            write_json(layout.config / "instance.json", {})
            write_json(layout.config / "https.json", {"tls": "internal"})
            journal = layout.state / "transactions" / ("a" * 32) / "state.json"
            journal.parent.mkdir(parents=True)
            value = {"kind": "https", "phase": "restoring", "before": {"metadata": {
                "data": base64.b64encode(canonical(dns_selection("cloudflare"))).decode(), "mode": 0o600}}}
            write_json(journal, value)
            updater = ControlUpdater(layout)
            with self.metadata_reader(layout) as reader:
                with self.assertRaises(DeployError) as error:
                    updater.require_dns_guard({})
                self.assertEqual(error.exception.code, "dns_downgrade")
                reader.assert_called_once_with(layout)
                reader.reset_mock()
                with self.assertRaises(DeployError):
                    updater.require_dns_guard({"dnsChallenge": "caddy-dns-v1"})
                reader.reset_mock()
                updater.require_dns_guard(DNS_CAPABILITIES)
                reader.assert_called_once_with(layout)
            write_json(journal, {**value, "phase": "recovered"})
            with self.metadata_reader(layout) as reader:
                updater.require_dns_guard({})
                reader.assert_called_once_with(layout)

    def test_pending_candidate_dns_before_metadata_publication_prevents_downgrade(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            layout.config.mkdir(parents=True)
            write_json(layout.config / "instance.json", {})
            write_json(layout.config / "https.json", {"tls": "internal"})
            journal = layout.state / "transactions" / ("a" * 32) / "state.json"
            journal.parent.mkdir(parents=True)
            write_json(journal, {"kind": "https", "phase": "prepared", "candidateHttps": dns_selection("tencentcloud"),
                       "before": {"metadata": {"data": base64.b64encode(canonical({"tls": "internal"})).decode(), "mode": 0o600}}})
            updater = ControlUpdater(layout)
            with self.metadata_reader(layout) as reader:
                with self.assertRaises(DeployError) as error:
                    updater.require_dns_guard({})
                self.assertEqual(error.exception.code, "dns_downgrade")
                reader.assert_called_once_with(layout)
                reader.reset_mock()
                with self.assertRaises(DeployError):
                    updater.require_dns_guard({"dnsChallenge": "caddy-dns-v1"})
                reader.reset_mock()
                updater.require_dns_guard(DNS_CAPABILITIES)
                reader.assert_called_once_with(layout)


if __name__ == "__main__":
    unittest.main()
