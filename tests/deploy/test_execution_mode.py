"""Portable policy/ABI tests; no personal homes, network or service mutations."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout
from deploy.execution_identity import native_settings, require_control, state
from deploy.execution_mode import validate_write
from deploy.manager import validate_request
from deploy.operator_origin import require_external_operator
from deploy.units import render_units, sudo_rule


CONFIG = {"workerUid": 1002, "workerGid": 1002, "origin": "http://127.0.0.1:3300", "port": 3300,
          "codexRelative": "vendor/codex", "providerConfigLayer": "system-v1"}


class ExecutionPolicyTests(unittest.TestCase):
    def setUp(self):
        self.layout = Layout("fixture", Path("/isolated-fixture"))

    def config(self, mode="native", allowed=True, generation="a" * 32):
        return {**CONFIG, "executionMode": mode, "rootAllowed": allowed, "executionGeneration": generation}

    def request(self, config, mode="root"):
        return {"mode": mode, "expectedRevision": state(config)["revision"], "confirmRestart": True, "confirmRoot": mode == "root"}

    def test_missing_policy_is_native_and_denied_without_changing_legacy_paths(self):
        result = state(CONFIG)
        self.assertEqual((result["mode"], result["rootAllowed"], result["effectiveUid"]), ("native", False, 1002))
        self.assertEqual(len(result["revision"]), 64)
        self.assertNotIn("executionMode", native_settings(self.layout, CONFIG))
        self.assertEqual(Path(native_settings(self.layout, CONFIG)["home"]).parts[-2:], ("worker", "codex"))

    def test_managed_native_identity_cannot_select_a_control_without_identity_verb(self):
        require_control({}, CONFIG)
        for config in (self.config(), self.config(allowed=False), self.config("root")):
            with self.subTest(mode=config["executionMode"], allowed=config["rootAllowed"]):
                with self.assertRaises(DeployError) as error:
                    require_control({}, config)
                self.assertEqual(error.exception.code, "execution_unsupported")
                require_control({"executionMode": 1}, config)

    def test_web_cannot_enable_without_server_authorization(self):
        with self.assertRaisesRegex(DeployError, "服务器尚未授权"):
            validate_write(CONFIG, self.request(CONFIG))

    def test_policy_change_and_aba_invalidate_prior_revision(self):
        granted = self.config()
        later = self.config(generation="b" * 32)
        self.assertNotEqual(state(CONFIG)["revision"], state(granted)["revision"])
        self.assertNotEqual(state(granted)["revision"], state(later)["revision"])
        with self.assertRaises(DeployError) as error:
            validate_write(later, self.request(granted))
        self.assertEqual(error.exception.code, "revision_conflict")

    def test_confirmation_is_exact_and_no_uid_path_or_authorization_inputs(self):
        config = self.config()
        for key, value in (("uid", 0), ("path", "/root"), ("rootAllowed", True)):
            with self.subTest(key=key), self.assertRaises(DeployError):
                validate_write(config, {**self.request(config), key: value})
        for key, value in (("confirmRoot", 1), ("confirmRoot", False), ("confirmRestart", False)):
            with self.subTest(key=key), self.assertRaises(DeployError):
                validate_write(config, {**self.request(config), key: value})
        validate_write(config, self.request(config))

    def test_rpc_never_exposes_server_grant_or_revoke(self):
        for method in ("root-access", "root-access/allow", "execution-mode/authorize"):
            with self.subTest(method=method), self.assertRaises(DeployError):
                validate_request({"method": method, "params": {"rootAllowed": True}})
        self.assertEqual(validate_request({"method": "execution-mode/read"})[0], "execution-mode/read")

    def test_root_native_homes_are_separate_and_provider_read_group_stays_fixed(self):
        native = native_settings(self.layout, self.config())
        root = native_settings(self.layout, self.config("root"))
        self.assertEqual((root["uid"], root["gid"], root["providerGid"]), (0, 0, 1002))
        self.assertNotEqual(root["cwd"], native["cwd"])
        self.assertEqual(Path(root["home"]).parts[-2:], ("worker-root", "codex"))
        self.assertEqual(root["bin"], native["bin"])

    def test_root_sudo_is_fixed_verbs_and_native_policy_has_no_root_target(self):
        for mode, target in (("native", "ch-fixture-worker"), ("root", "root")):
            rule = sudo_rule(self.layout, config=self.config(mode))
            control = next(line for line in rule.splitlines() if "-control ALL=" in line)
            self.assertIn("ALL=(" + target + ") NOPASSWD:", control)
            self.assertIn("native-launch identity,", control)
            self.assertNotIn("/bin/sh", control)
            self.assertNotIn("NOPASSWD: ALL", control)

    def test_root_worker_preserves_control_identity_and_removes_false_privilege_limits(self):
        standard = render_units(self.layout, self.config(), "vendor/codex")[self.layout.unit("worker")]
        root = render_units(self.layout, self.config("root"), "vendor/codex")[self.layout.unit("worker")]
        self.assertIn("User=ch-fixture-control", root)
        self.assertIn("HARNESS_NATIVE_USER=root", root)
        self.assertIn("HARNESS_ATTACHMENT_GID=1002", root)
        self.assertIn("NoNewPrivileges=no", root)
        self.assertNotIn("CapabilityBoundingSet=", root)
        self.assertNotIn("InaccessiblePaths=", root)
        self.assertNotIn("ProtectKernelModules=yes", root)
        self.assertIn("CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_AUDIT_WRITE", standard)
        self.assertIn("KillMode=control-group", root)

    def test_incomplete_or_denied_root_policy_is_rejected(self):
        for config in ({**CONFIG, "executionMode": "root"}, self.config("root", False), self.config("other")):
            with self.subTest(config=config), self.assertRaises(DeployError): state(config)


class ExternalOperatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.proc = Path(self.temp.name)

    def process(self, pid, parent, group):
        path = self.proc / str(pid);path.mkdir()
        (path / "stat").write_text(f"{pid} (fixture process) S {parent} " + "0 " * 17 + "123\n")
        (path / "cgroup").write_text("0::" + group + "\n")

    def check(self, pid):
        with patch("deploy.operator_origin.os.name", "posix"), patch("deploy.operator_origin.os.getuid", return_value=0, create=True), patch("deploy.operator_origin.os.geteuid", return_value=0, create=True):
            require_external_operator(proc=self.proc, pid=pid)

    def test_independent_ssh_or_console_allowed(self):
        self.process(1, 0, "/init.scope");self.process(10, 1, "/system.slice/ssh.service");self.process(11, 10, "/user.slice/session-2.scope")
        self.check(11)

    def test_worker_cgroup_rejected_even_at_real_uid_zero(self):
        self.process(1, 0, "/init.scope");self.process(11, 1, "/system.slice/codex-harness-fixture-worker.service")
        with self.assertRaises(DeployError) as error:self.check(11)
        self.assertEqual(error.exception.code, "operator_origin_forbidden")

    def test_parent_worker_chain_rejected_without_environment_marker(self):
        self.process(1, 0, "/init.scope");self.process(10, 1, "/system.slice/codex-harness-other-worker.service")
        self.process(11, 10, "/user.slice/new.scope")
        with self.assertRaises(DeployError):self.check(11)

    def test_missing_process_is_unknown_not_external_admin(self):
        with self.assertRaises(DeployError) as error:self.check(111)
        self.assertEqual(error.exception.code, "operator_origin_unknown")

    def test_already_authorized_full_root_is_not_restricted_by_workflow_origin(self):
        config={**CONFIG,"executionMode":"root","rootAllowed":True,"executionGeneration":"a"*32}
        with patch("deploy.operator_origin.os.name","posix"),patch("deploy.operator_origin.os.getuid",return_value=0,create=True),patch("deploy.operator_origin.os.geteuid",return_value=0,create=True):
            require_external_operator(config,proc=self.proc,pid=111)

    @unittest.skipUnless(os.name == "posix", "POSIX real uid admission")
    def test_nonroot_identity_cannot_authorize_even_outside_service(self):
        with patch("deploy.operator_origin.os.getuid", return_value=65534), patch("deploy.operator_origin.os.geteuid", return_value=65534), self.assertRaises(DeployError):
            require_external_operator(proc=self.proc, pid=1)
