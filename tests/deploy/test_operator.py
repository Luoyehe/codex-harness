"""Operator journeys exercise the real argument parser, without host mutations."""
import io
import json
import os
import tempfile
import unittest
from contextlib import nullcontext, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from deploy.cli import execute, main, parser
from deploy.common import DeployError, Layout
from deploy.https_guidance import https_plan
from deploy.operator import Cancelled, Console, installed_instances, manage


class OperatorTests(unittest.TestCase):
    def test_direct_domain_cli_distinguishes_preserve_replace_clear_and_rejects_ambiguous_input(self):
        configure = ["proxy-configure", "--config-file", "/private/node.json", "--version", "26.10.31"]
        preserved = parser().parse_args(configure)
        self.assertIsNone(preserved.direct_domain)
        self.assertFalse(preserved.clear_direct_domains)
        replaced = parser().parse_args(configure + ["--direct-domain", "API.Example.CN.", "--direct-domain", "second.example.cn"])
        self.assertEqual(replaced.direct_domain, ["api.example.cn", "second.example.cn"])
        self.assertTrue(parser().parse_args(configure + ["--clear-direct-domains"]).clear_direct_domains)
        for arguments in (["proxy-direct-domains"],
                          ["proxy-direct-domains", "--clear-direct-domains", "--direct-domain", "api.example.cn"],
                          ["proxy-direct-domains", "--clear-direct-domains", "--version", "26.10.31"],
                          configure + ["--direct-domain", "api.example.cn", "--clear-direct-domains"]):
            with self.subTest(arguments=arguments), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                parser().parse_args(arguments)
        for value in ("https://api.example.cn/v1", "api.example.cn:443", "user@api.example.cn", "*.example.cn", "192.168.1.2"):
            with self.subTest(value=value), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                parser().parse_args(["proxy-direct-domains", "--direct-domain", value])

    def test_direct_domain_cli_dispatches_through_the_existing_transaction(self):
        configure = ["proxy-configure", "--config-file", "/private/node.json", "--version", "26.10.31"]
        examples = [(configure, "configure", None),
                    (configure + ["--clear-direct-domains"], "configure", []),
                    (configure + ["--direct-domain", "API.Example.CN."], "configure", ["api.example.cn"]),
                    (["proxy-direct-domains", "--direct-domain", "api.example.cn"], "direct-domains", ["api.example.cn"]),
                    (["proxy-direct-domains", "--clear-direct-domains"], "direct-domains", []),
                    (["proxy-enable"], "enable", None)]
        with patch("deploy.cli.require_linux"), patch("deploy.transactions.require_initialization_complete"), \
             patch("deploy.cli.exclusive", return_value=nullcontext()), patch("deploy.control_update.require_no_pending_control"), \
             patch("deploy.cli.Manager") as manager, patch("deploy.proxy_transaction.change", return_value={"changed": True}) as change:
            for arguments, action, domains in examples:
                with self.subTest(arguments=arguments):
                    result = execute(parser().parse_args(arguments + ["--confirm-restart"]))
                    self.assertEqual(result, {"changed": True})
                    self.assertEqual(change.call_args.args, (manager.return_value,))
                    self.assertEqual(change.call_args.kwargs["action"], action)
                    self.assertEqual(change.call_args.kwargs["direct_domains"], domains)
                    self.assertTrue(change.call_args.kwargs["confirm_restart"])
                    if action in ("direct-domains", "enable"):
                        for key in ("input_file", "version", "download_proxy"):
                            self.assertIsNone(change.call_args.kwargs[key])

    def test_enable_saved_proxy_menu_reuses_materials_and_only_requests_confirmation(self):
        current = {"configured": True, "enabled": False, "coreVersion": "26.10.31", "directDomains": ["api.example.cn"]}
        with patch("deploy.proxy_core.latest_version") as latest:
            self.console(["7", "y"], lambda args: current if args.command == "proxy-status" else {}).service_proxy()
        latest.assert_not_called()
        self.assertEqual([args.command for args in self.calls], ["proxy-status", "proxy-enable"])
        self.assertTrue(self.calls[-1].confirm_restart)
        self.assertFalse(any(hasattr(self.calls[-1], key) for key in ("config_file", "version", "download_proxy", "direct_domain")))
        self.assertIn("不重新导入节点或下载核心", "\n".join(self.output))
        self.calls.clear()
        self.console(["7", "n"], lambda _: current).service_proxy()
        self.assertEqual([args.command for args in self.calls], ["proxy-status"])

    def test_enable_saved_proxy_menu_missing_configuration_and_enabled_noop_never_write(self):
        with self.assertRaisesRegex(DeployError, "尚无已保存代理配置") as raised:
            self.console(["7"], lambda _: {"configured": False}).service_proxy()
        self.assertEqual(raised.exception.code, "not_installed")
        self.assertEqual([args.command for args in self.calls], ["proxy-status"])
        self.calls.clear()
        self.console(["7"], lambda _: {"configured": True, "enabled": True}).service_proxy()
        self.assertEqual([args.command for args in self.calls], ["proxy-status"])
        self.assertIn("已保存代理已启用，无需重复操作。", self.output)

    def test_execution_permissions_describes_shared_login_and_separate_history(self):
        self.console(["3", "n"], lambda _: {"rootAllowed": True, "mode": "root"}).execution_permissions()
        self.assertEqual([args.command for args in self.calls], ["execution-mode-read"])
        text = "\n".join(self.output)
        for message in ("共享一个当前 ChatGPT 登录", "停机切换身份时转交", "历史及默认项目目录按身份独立", "不自动恢复"):
            self.assertIn(message, text)

    def test_direct_domain_menu_reuses_disabled_proxy_without_import_or_download(self):
        current = {"configured": True, "enabled": False, "coreVersion": "26.10.31", "directDomains": ["old.example.cn"]}
        menu = self.console(["6", "1", "SECOND.example.cn, API.Example.CN. api.example.cn", "y"],
                            lambda args: current if args.command == "proxy-status" else {})
        with patch("deploy.proxy_core.latest_version") as latest:
            menu.service_proxy()
        latest.assert_not_called()
        self.assertEqual([args.command for args in self.calls], ["proxy-status", "proxy-direct-domains"])
        args = self.calls[-1]
        self.assertEqual(args.direct_domain, ["api.example.cn", "second.example.cn"])
        self.assertTrue(args.confirm_restart)
        self.assertFalse(args.clear_direct_domains)
        self.assertFalse(any(hasattr(args, key) for key in ("config_file", "version", "download_proxy")))
        text = "\n".join(self.output)
        for message in ("old.example.cn", "全部端口", "不自动包含子域名", "保持代理启用或关闭状态"):
            self.assertIn(message, text)

    def test_direct_domain_menu_clear_and_decline_preserve_explicit_intent(self):
        current = {"configured": True, "enabled": True, "coreVersion": "26.10.31", "directDomains": ["api.example.cn"]}
        self.console(["6", "2", "y"], lambda args: current if args.command == "proxy-status" else {}).service_proxy()
        self.assertEqual([args.command for args in self.calls], ["proxy-status", "proxy-direct-domains"])
        self.assertTrue(self.calls[-1].clear_direct_domains)
        self.assertIsNone(self.calls[-1].direct_domain)
        self.calls.clear()
        self.console(["6", "2", "n"], lambda _: current).service_proxy()
        self.assertEqual([args.command for args in self.calls], ["proxy-status"])

    def test_direct_domain_menu_noop_cancel_and_unconfigured_never_mutate(self):
        current = {"configured": True, "enabled": False, "directDomains": ["api.example.cn"]}
        self.console(["6", "1", "API.Example.CN."], lambda _: current).service_proxy()
        self.assertEqual([args.command for args in self.calls], ["proxy-status"])
        self.assertIn("自定义直连名单未变化。", self.output)
        self.calls.clear()
        with self.assertRaises(Cancelled):
            self.console(["6", "1", "q"], lambda _: current).service_proxy()
        self.assertEqual([args.command for args in self.calls], ["proxy-status"])
        self.calls.clear()
        with self.assertRaises(DeployError) as raised:
            self.console(["6"], lambda _: {"configured": False, "directDomains": []}).service_proxy()
        self.assertEqual(raised.exception.code, "not_installed")
        self.assertEqual([args.command for args in self.calls], ["proxy-status"])

    def test_direct_domain_menu_rejects_invalid_or_unbounded_lists_before_confirmation(self):
        current = {"configured": True, "enabled": True, "directDomains": []}
        for value in ("https://api.example.cn/v1?token=fixture", "api.example.cn:443", "*.example.cn", "",
                      " ".join(f"host{number}.example.cn" for number in range(65)), "a" * (64 * 256 + 1)):
            with self.subTest(value=value[:80]):
                self.calls.clear()
                with self.assertRaises(DeployError):
                    self.console(["6", "1", value], lambda _: current).service_proxy()
                self.assertEqual([args.command for args in self.calls], ["proxy-status"])

    def test_direct_domain_menu_unknown_result_is_not_replayed_or_reported_successful(self):
        def run(args):
            if args.command == "proxy-status":
                return {"configured": True, "enabled": True, "directDomains": []}
            raise DeployError("unknown", "Fixture uncertain direct-list switch")
        with self.assertRaises(DeployError) as raised:
            self.console(["6", "1", "api.example.cn", "y"], run).service_proxy()
        self.assertEqual(raised.exception.code, "unknown")
        self.assertEqual([args.command for args in self.calls], ["proxy-status", "proxy-direct-domains"])
        self.assertNotIn("直连名单已更新", "\n".join(self.output))

    def test_service_proxy_configures_private_file_with_exact_core_and_confirmation(self):
        path = str(Path(self.temp.name).resolve() / "node.json")
        menu = self.console(["1", path, "18793", "26.10.29", "", "y"])
        menu.service_proxy()
        self.assertEqual([args.command for args in self.calls], ["proxy-status", "proxy-configure"])
        args = self.calls[-1]
        self.assertEqual((args.config_file, args.version, args.port, args.confirm_restart), (Path(path), "26.10.29", 18793, True))
        self.assertNotIn("apiKey", "\n".join(self.output))

    def test_proxy_latest_is_resolved_only_after_confirmation_and_failure_not_replayed(self):
        def status(args):
            if args.command == "proxy-status": return {"enabled": True, "coreVersion": "26.10.1", "port": 18793}
            raise DeployError("unknown", "Fixture uncertain switch")
        menu = self.console(["3", "latest", "", "y"], run=status)
        with patch("deploy.proxy_core.latest_version", return_value="26.10.29") as latest, self.assertRaises(DeployError): menu.service_proxy()
        latest.assert_called_once_with(download_proxy="http://127.0.0.1:18794")
        self.assertEqual([args.command for args in self.calls], ["proxy-status", "proxy-core-update"])
        self.assertEqual(self.calls[-1].version, "26.10.29")
        self.calls.clear()
        menu = self.console(["3", "latest", "", "n"], run=status)
        with patch("deploy.proxy_core.latest_version") as latest: menu.service_proxy()
        latest.assert_not_called(); self.assertEqual(len(self.calls), 1)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.calls = []
        self.output = []

    def console(self, inputs, run=None, secrets=()):
        answers = iter(inputs)
        passwords = iter(secrets)

        def dispatch(args):
            self.calls.append(args)
            if args.command == "pack-source":
                args.output.write_bytes(b"source fixture")
                return {"sourceArchive": str(args.output)}
            if args.command == "https-plan":
                return https_plan(host=args.host, tls=args.tls, dns_provider=args.dns_provider,
                                  http_port=args.http_port, https_port=args.https_port, public_origin=args.public_origin)
            return run(args) if run else {}
        return Console("fixture", source=self.directory, ask=lambda _: next(answers), secret=lambda _: next(passwords),
                       output=self.output.append, execute=dispatch)

    def test_discovery_excludes_non_instances_and_selects_only_existing_instance(self):
        for name in ("main", "other-2", "UPPER", "too-long-instance-name-xxxx", ".private"):
            (self.directory / name).mkdir()
        (self.directory / "file").write_text("not a directory")
        self.assertEqual(installed_instances(self.directory), ["main", "other-2"])
        menu = self.console([""])
        with patch("deploy.operator.installed_instances", return_value=["retained"]):
            menu.select_instance()
        self.assertEqual(menu.instance, "retained")
        explicit = self.console([""])
        with patch("deploy.operator.installed_instances", return_value=["retained"]):
            explicit.select_instance(prefer_current=True)
        self.assertEqual(explicit.instance, "fixture")

    def test_new_install_packages_source_and_keeps_gateway_local(self):
        menu = self.console(["3311", "operator", "y", "n"])
        with patch("deploy.operator.Layout", return_value=Layout("fixture", self.directory)), patch.object(menu, "prepare_dependencies"):
            menu.install()
        self.assertEqual([args.command for args in self.calls], ["pack-source", "install"])
        install = self.calls[-1]
        self.assertEqual((install.username, install.port, install.origin), ("operator", 3311, "http://127.0.0.1:3311"))
        self.assertFalse(install.source.exists())
        self.assertIn("http://127.0.0.1:3311", "\n".join(self.output))

    def test_install_offers_https_only_after_success(self):
        def fail(args):
            if args.command == "install":
                raise DeployError("fixture", "Interrupted after a side effect")
            return {}
        menu = self.console(["", "", "y"], fail)
        with patch("deploy.operator.Layout", return_value=Layout("fixture", self.directory)), patch.object(menu, "prepare_dependencies"), self.assertRaises(DeployError):
            menu.install()
        archive = self.calls[0].output
        try:
            self.assertTrue(archive.exists())
            self.assertEqual([args.command for args in self.calls], ["pack-source", "install"])
            self.assertNotIn("安装完成", "\n".join(self.output))
        finally:
            archive.unlink()
            archive.parent.rmdir()

    def test_existing_instance_cannot_accidentally_reinstall(self):
        layout = Layout("fixture", self.directory)
        layout.config.mkdir(parents=True)
        with patch("deploy.operator.Layout", return_value=layout), self.assertRaises(DeployError) as raised:
            self.console([]).install()
        self.assertEqual(raised.exception.code, "already_installed")
        self.assertFalse(self.calls)

    def test_upgrade_orders_control_configuration_and_application(self):
        menu = self.console(["y"])
        with patch.object(menu, "prepare_dependencies"), patch.object(menu, "status") as status:
            menu.update()
        self.assertEqual([args.command for args in self.calls], ["pack-source", "control-update", "config-layer-migrate", "update"])
        self.assertFalse(self.calls[-1].source.exists())
        status.assert_called_once()

    def test_upgrade_never_continues_after_uncertain_control_update(self):
        def fail(args):
            if args.command == "control-update":
                raise DeployError("recovery_required", "Stopped-tree recovery needed")
            return {}
        menu = self.console(["y"], fail)
        with patch.object(menu, "prepare_dependencies"), self.assertRaises(DeployError):
            menu.update()
        self.assertEqual([args.command for args in self.calls], ["pack-source", "control-update"])
        archive = self.calls[0].output
        self.assertTrue(archive.exists())
        archive.unlink()
        archive.parent.rmdir()

    def test_full_candidate_budget_stops_before_any_upgrade_step(self):
        layout = Layout("fixture", self.directory)
        for number in range(8):
            (layout.work / ("candidate-" + str(number))).mkdir(parents=True)
        menu = self.console([])
        with patch("deploy.operator.Layout", return_value=layout), self.assertRaisesRegex(DeployError, "归档已完成构建"):
            menu.update()
        self.assertEqual(self.calls, [])

    def test_archive_menu_selects_only_eligible_candidate_and_confirms_stop(self):
        candidate = "a" * 32
        def results(args):
            return {"candidates": [{"id": "b" * 32, "eligible": False, "reason": "mounted"},
                                   {"id": candidate, "eligible": True, "release": "c" * 64}]} if args.command == "candidate-list" else {}
        self.console(["6", "1", "y"], results).recover()
        self.assertEqual([args.command for args in self.calls], ["candidate-list", "candidate-archive"])
        self.assertEqual(self.calls[-1].candidate, candidate)
        self.assertTrue(self.calls[-1].confirm_stop)

    def test_declining_archival_does_not_remove_or_restart_services(self):
        result = {"candidates": [{"id": "a" * 32, "eligible": True, "release": "b" * 64}]}
        self.console(["1", "n"], lambda _: result).archive_candidates()
        self.assertEqual([args.command for args in self.calls], ["candidate-list"])

    def test_incomplete_candidates_only_offer_inspection(self):
        self.console([], lambda _: {"candidates": [{"id": "a" * 32, "eligible": False, "reason": "incomplete"}]}).archive_candidates()
        self.assertEqual([args.command for args in self.calls], ["candidate-list"])
        self.assertIn("没有通过完整验证", "\n".join(self.output))

    def test_cancelled_upgrade_and_account_reset_have_no_side_effects(self):
        self.console(["n"]).update()
        self.console(["operator", "n"]).reset_account()
        self.assertEqual(self.calls, [])

    def test_reset_prompts_new_username_and_distinguishes_pending_gateway(self):
        for verified in (False, True):
            with self.subTest(verified=verified):
                self.output.clear()
                self.console(["recovered-admin", "y"], lambda _: {"accountBootstrapWritten": True, "loginVerified": verified}).reset_account()
                args = self.calls[-1]
                self.assertEqual((args.command, args.username, args.password_stdin), ("account-reset", "recovered-admin", False))
                text = "\n".join(self.output)
                self.assertIn("清除两步验证", text)
                self.assertIn("通过登录验证" if verified else "尚未确认登录", text)

    def test_dns_input_uses_private_temporary_file_and_never_arguments_or_output(self):
        secret = "fixture-secret-123456789"
        menu = self.console(["1"], secrets=["fixture-access-123456", secret])
        with menu.dns_credentials("alidns", reuse=False) as name:
            path = Path(name)
            self.assertEqual(json.loads(path.read_text())["accessKeySecret"], secret)
            if os.name == "posix":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            self.assertNotIn(secret, "\n".join(self.output))
        self.assertFalse(path.exists())

    def test_dns_input_is_removed_even_when_https_setup_fails(self):
        menu = self.console(["1"], secrets=["fixture-token-123456789"])
        path = None
        with self.assertRaises(DeployError):
            with menu.dns_credentials("cloudflare", reuse=False) as name:
                path = Path(name)
                raise DeployError("fixture", "setup failed")
        self.assertFalse(path.exists())

    def test_dns_existing_credentials_can_be_reused_without_reading_or_prompting_them(self):
        with self.console([""]).dns_credentials("alidns", reuse=True) as value:
            self.assertIsNone(value)

    def test_new_dns_https_passes_exact_ports_and_credentials_after_preview(self):
        captured = []
        def run(args):
            if args.command == "https-read":
                raise DeployError("not_installed", "No HTTPS configuration")
            if args.command == "https":
                captured.append(json.loads(args.dns_credentials.read_text()))
                self.assertNotIn("fixture-secret", json.dumps(vars(args), default=str))
            return {}
        # host, TLS port, HTTP port, origin, DNS mode/provider, confirmation,
        # 2FA, credential input mode. Username is retained from installation.
        menu = self.console(["work.example.test", "10000", "", "", "1", "1", "y", "n", "1"], run,
                            ["fixture-access-123456", "fixture-secret-123456"])
        menu.https(username="admin")
        self.assertEqual([args.command for args in self.calls], ["https-read", "https-plan", "https"])
        args = self.calls[-1]
        self.assertEqual((args.https_port, args.http_port, args.dns_provider), (10000, 18081, "alidns"))
        self.assertEqual(args.public_origin, "https://work.example.test:10000")
        self.assertFalse(args.dns_credentials.exists())
        self.assertEqual(captured[0]["accessKeySecret"], "fixture-secret-123456")

    def test_https_migration_binds_revision_and_recomputes_changed_address(self):
        current = {"origin": "https://old.example.test:18443", "httpsRevision": "a" * 64,
                   "settings": {"host": "old.example.test", "httpsPort": 18443, "httpPort": 18081,
                                "publicOrigin": "https://old.example.test:18443", "tls": "acme", "dnsProvider": "alidns",
                                "authentication": "builtin", "phase": "active"}}
        menu = self.console(["new.example.test", "10000", "", "", "", "", "y", "n", ""],
                            lambda args: current if args.command == "https-read" else {})
        menu.https(username="admin")
        args = self.calls[-1]
        self.assertEqual(args.command, "https-migrate")
        self.assertEqual(args.expected_origin, current["origin"])
        self.assertEqual(args.expected_https_revision, current["httpsRevision"])
        self.assertEqual(args.public_origin, "https://new.example.test:10000")
        self.assertIsNone(args.dns_credentials)

    def test_https_resume_uses_retained_origin_semantics_and_only_active_builtin_migrates(self):
        for authentication, phase in (("builtin", "prepared"), (None, "active"), ("builtin", "active")):
            for public in (None, "https://work.example.test:18443", "https://work.example.test"):
                with self.subTest(authentication=authentication, phase=phase, public=public):
                    current = {"origin": public or "https://work.example.test:18443", "httpsRevision": "a" * 64,
                               "settings": {"host": "work.example.test", "tls": "internal", "httpPort": 18081,
                                            "httpsPort": 18443, "publicOrigin": public,
                                            "authentication": authentication, "phase": phase}}
                    self.console(["", "", "", "", "", "y", "n"],
                                 lambda args: current if args.command == "https-read" else {}).https(username="admin")
                    args = self.calls[-1]
                    migration = authentication == "builtin" and phase == "active"
                    self.assertEqual(args.command, "https-migrate" if migration else "https")
                    self.assertEqual(args.public_origin, public)
                    self.assertEqual(getattr(args, "expected_origin", None), current["origin"] if migration else None)

    def test_https_resume_preserves_omission_when_operator_enters_equivalent_origin(self):
        current = {"origin": "http://127.0.0.1:3300", "httpsRevision": "a" * 64,
                   "settings": {"host": "work.example.test", "tls": "internal", "httpPort": 18081,
                                "httpsPort": 18443, "publicOrigin": None, "authentication": "builtin", "phase": "prepared"}}
        self.console(["", "", "", "https://WORK.example.test:18443/", "", "y", "n"],
                     lambda args: current if args.command == "https-read" else {}).https(username="admin")
        self.assertEqual(self.calls[-1].command, "https")
        self.assertIsNone(self.calls[-1].public_origin)

    def test_https_resume_accepts_retained_standard_ports_without_forcing_an_address_change(self):
        current = {"origin": "https://work.example.test", "httpsRevision": "a" * 64,
                   "settings": {"host": "work.example.test", "tls": "internal", "httpPort": 80,
                                "httpsPort": 443, "publicOrigin": None, "authentication": None, "phase": "active"}}
        self.console(["", "", "", "", "", "y", "n"],
                     lambda args: current if args.command == "https-read" else {}).https(username="admin")
        args = self.calls[-1]
        self.assertEqual((args.command, args.http_port, args.https_port, args.public_origin), ("https", 80, 443, None))
        self.assertIn("访问地址：https://work.example.test", self.output)

    def test_other_certificate_modes_keep_exact_trust_and_two_factor_options(self):
        def run(args):
            if args.command == "https-read":
                raise DeployError("not_installed", "No HTTPS configuration")
            return {}
        for mode in ("2", "3", "4"):
            with self.subTest(mode=mode):
                inputs = ["work.example.test", "", "", "", mode, "y"]
                if mode == "3":
                    inputs += ["/root/cert.pem", "/root/key.pem", ""]
                inputs += ["y"]
                self.console(inputs, run).https(username="operator")
                args = self.calls[-1]
                self.assertTrue(args.two_factor)
                self.assertEqual(args.username, "operator")
                self.assertEqual(args.tls, {"2": "acme", "3": "provided", "4": "internal"}[mode])
                self.assertEqual(args.dns_provider, "none" if mode == "2" else None)
                if mode == "3":
                    self.assertTrue(args.tls_system_ca)
                    self.assertEqual(str(args.certificate).replace("\\", "/"), "/root/cert.pem")

    def test_missing_distribution_packages_are_explicit_and_fail_before_installation(self):
        with patch("deploy.operator.Path.is_file", return_value=False), patch("deploy.operator.subprocess.run") as run:
            with self.assertRaises(Cancelled):
                self.console(["n"]).prepare_dependencies()
            run.assert_not_called()
            run.return_value.returncode = 1
            with self.assertRaises(DeployError) as raised:
                self.console(["y"]).prepare_dependencies()
            self.assertEqual(raised.exception.code, "prerequisite")
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0], ["/usr/bin/apt-get", "update"])

    def test_package_preparation_uses_only_fixed_distribution_packages(self):
        with patch("deploy.operator.Path.is_file", return_value=False), patch("deploy.operator.subprocess.run") as run:
            run.return_value.returncode = 0
            self.console(["y"]).prepare_dependencies()
            self.assertEqual(run.call_count, 2)
            self.assertEqual(run.call_args.args[0], ["/usr/bin/apt-get", "install", "-y", "git", "sudo", "e2fsprogs", "util-linux", "mount", "bubblewrap", "ca-certificates"])
            self.assertNotIn("shell", run.call_args.kwargs)

    def test_https_read_integrity_failure_never_treated_as_new_installation(self):
        with self.assertRaises(DeployError):
            self.console([], lambda _: (_ for _ in ()).throw(DeployError("integrity", "tampered"))).https()
        self.assertEqual([args.command for args in self.calls], ["https-read"])

    def test_invalid_port_reprompts_and_q_cancels(self):
        self.assertEqual(self.console(["80", "65536", "abc", "10000"]).port("port", 18443), 10000)
        with self.assertRaises(Cancelled):
            self.console(["q"]).port("port", 18443)

    def test_menu_recovers_from_failed_command_without_retrying_or_exiting(self):
        def run(args):
            raise DeployError("recovery_required", "Inspect saved transaction")
        self.console(["7", "y", "0"], run).loop()
        self.assertEqual([args.command for args in self.calls], ["restart"])
        self.assertIn("不会自动重试", "\n".join(self.output))

    def test_recovery_routes_to_original_commands_without_replacing_credentials(self):
        for value, command in (("1", "repair"), ("2", "control-recover"), ("4", "restore-services"), ("5", "rollback")):
            self.console([value, "y"]).recover()
            self.assertEqual(self.calls[-1].command, command)
        self.console(["3", "y"]).recover()
        self.assertEqual(self.calls[-1].command, "install-resume")
        self.assertFalse(hasattr(self.calls[-1], "username"))

    def test_logs_unwraps_original_rpc_result(self):
        self.console(["2"], lambda _: {"ok": True, "result": {"text": "fixture worker log"}}).logs()
        self.assertIn("fixture worker log", self.output)
        self.assertEqual(self.calls[-1].service, "worker")

    def test_manage_requires_interactive_terminal_and_does_not_mutate(self):
        with patch("deploy.operator.sys.stdin", io.StringIO()), patch("deploy.operator.require_host") as host, self.assertRaises(DeployError) as raised:
            manage()
        self.assertEqual(raised.exception.code, "interactive_required")
        host.assert_not_called()

    def test_manage_cli_dispatches_without_loading_instance_or_json_wrapper(self):
        with patch("deploy.operator.manage") as menu, patch("deploy.cli.Layout", side_effect=AssertionError("unexpected layout")), redirect_stdout(io.StringIO()) as output:
            main(["--instance", "fixture", "manage"])
        menu.assert_called_once_with("fixture")
        self.assertEqual(output.getvalue(), "")

    def test_existing_cli_output_and_error_contract_are_preserved(self):
        with redirect_stdout(io.StringIO()) as output:
            main(["https-plan", "--host", "work.example.test"])
        self.assertTrue(json.loads(output.getvalue())["planOnly"])
        with patch("deploy.cli.execute", side_effect=DeployError("fixture", "after mutation")), redirect_stderr(io.StringIO()) as output, self.assertRaises(SystemExit):
            main(["restart"])
        self.assertNotIn("delivery", json.loads(output.getvalue())["error"])


if __name__ == "__main__":
    unittest.main()
