"""Initialization interruptions use real files and recorded plans, no host mutation."""
import contextlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout, fsync_directory, read_json
from deploy.install_recovery import CreationPlan, initialize_recorded, record_path


class FakeSystem:
    def state(self, unit):
        return {"stopped": True}

    def reload(self):
        pass


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root ownership fixture")
class InitializationResumeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.layout = Layout("resume", Path(self.directory.name))
        self.layout.config.parent.mkdir(parents=True)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        identities = {role: {"name": self.layout.prefix + "-" + role, "gid": 800 + index,
                              **({"uid": 800 + index, "home": str(Path("/nonexistent") if role == "build" else
                                 self.layout.state / ("supervisor" if role == "control" else role))} if role != "ipc" else {})}
                      for index, role in enumerate(("gateway", "worker", "control", "build", "ipc"))}
        self.stack.enter_context(patch("deploy.install_recovery.initialization_lock", return_value=contextlib.nullcontext()))
        self.stack.enter_context(patch("deploy.install_recovery.identity_plan", return_value=identities))
        self.identities = self.stack.enter_context(patch("deploy.install_recovery.ensure_identities"))
        self.stack.enter_context(patch("deploy.install_recovery.System", return_value=FakeSystem()))
        self.stack.enter_context(patch("deploy.ownership.preflight_new"))
        self.stack.enter_context(patch("deploy.install.trusted_ancestors"))
        self.material = {"manage": (b"fixed helper", 0o755), "deploy/cli.py": (b"pass\n", 0o644)}
        self.stack.enter_context(patch("deploy.install.control_material", side_effect=lambda layout: self.material))
        self.stack.enter_context(patch("deploy.build.architecture", return_value="x64"))
        self.stack.enter_context(patch("deploy.ports.require_ports_available"))
        self.stack.enter_context(patch("deploy.sandbox.require_host"))
        self.stack.enter_context(patch("deploy.provider_layers.prepare_host_targets"))
        self.stack.enter_context(patch("deploy.provider_layers.generation_layers", return_value=({"system-config.toml": b"# expected\n"}, {"host": "fixed"})))
        self.command = self.stack.enter_context(patch("deploy.install_recovery.run"))
        # Only the pointer primitive is substituted on Windows, whose test token
        # cannot create symlinks. Linux exercises the real symlink path.
        if os.name == "nt":
            self.stack.enter_context(patch.object(CreationPlan, "link", lambda plan, path, target: plan.file(path, target.encode(), 0o644)))
            chmod = os.chmod
            self.stack.enter_context(patch("os.chmod", side_effect=lambda path, mode: chmod(path, mode | 0o200)))

    def start(self):
        return initialize_recorded(self.layout, origin="http://127.0.0.1:3300", port=3300,
                                   account={"fixture": "retained account hash"})

    def test_dns_build_recipe_parent_is_planned_and_resumed(self):
        for name in ("main.go", "main_test.go", "go.mod", "go.sum"):
            self.material["deploy/caddy_dns_source/" + name] = (b"fixed recipe fixture\n", 0o644)
        saved = self.interrupt_after("usr/lib/codex-harness/resume/deploy/caddy_dns_source")
        initialize_recorded(self.layout, resume=True)
        self.assertEqual(saved["plan"]["usr/lib/codex-harness/resume/deploy/caddy_dns_source"]["kind"], "directory")
        for name in ("main.go", "main_test.go", "go.mod", "go.sum"):
            self.assertEqual((self.layout.control / "deploy/caddy_dns_source" / name).read_bytes(), b"fixed recipe fixture\n")

    def test_shared_container_parent_failure_blocks_identities_and_retries_existing_names(self):
        def fail(path, **kwargs):
            if path == self.layout.app.parent.parent:
                raise OSError("Injected shared container publication failure")
            return fsync_directory(path, **kwargs)
        with patch("deploy.common.fsync_directory", side_effect=fail), self.assertRaises(OSError):
            self.start()
        self.assertTrue(self.layout.app.parent.exists())
        self.assertFalse(self.layout.app.exists())
        self.identities.assert_not_called()
        with patch("deploy.common.fsync_directory", side_effect=fail), self.assertRaises(OSError):
            initialize_recorded(self.layout, resume=True)
        self.identities.assert_not_called()
        initialize_recorded(self.layout, resume=True)
        self.assertEqual(read_json(record_path(self.layout))["phase"], "initialized")

    def test_interrupted_shared_container_chmod_blocks_retry_until_operator_repairs_mode(self):
        shared = self.layout.app.parent
        original = os.fchmod
        def fail(fd, mode):
            if shared.exists() and os.fstat(fd).st_ino == shared.stat().st_ino:
                raise OSError("Injected loss before shared container chmod")
            return original(fd, mode)
        old = os.umask(0o077)
        try:
            with patch("deploy.common.os.fchmod", side_effect=fail), self.assertRaises(OSError):
                self.start()
        finally:
            os.umask(old)
        self.identities.assert_not_called()
        with self.assertRaisesRegex(DeployError, "Shared service directory"):
            initialize_recorded(self.layout, resume=True)
        self.identities.assert_not_called()
        self.assertEqual(shared.stat().st_mode & 0o777, 0o700)
        shared.chmod(0o755)
        initialize_recorded(self.layout, resume=True)
        self.assertEqual(read_json(record_path(self.layout))["phase"], "initialized")

    def interrupt_after(self, relative):
        original = CreationPlan.publish
        target = self.layout.root / relative

        def publish(plan, path):
            original(plan, path)
            if path == target: raise KeyboardInterrupt("simulated loss after publication")

        with patch.object(CreationPlan, "publish", publish), self.assertRaises(KeyboardInterrupt): self.start()
        return read_json(record_path(self.layout))

    def test_resume_after_early_directory_preserves_planned_identity_and_secret(self):
        saved = self.interrupt_after("opt/codex-harness/resume")
        initialize_recorded(self.layout, resume=True)
        done = read_json(record_path(self.layout))
        self.assertEqual(done["phase"], "initialized")
        self.assertEqual(done["identities"], saved["identities"])
        self.assertEqual((self.layout.config / "gateway-token").read_text().strip(), saved["token"])
        self.assertEqual(read_json(self.layout.config / "auth-bootstrap.json"), saved["account"])

    def test_resume_after_partial_units_and_sudo_validation_failure(self):
        self.command.side_effect = DeployError("command_failed", "visudo fixture")
        with self.assertRaises(DeployError): self.start()
        saved = read_json(record_path(self.layout))
        token = (self.layout.config / "gateway-token").read_bytes()
        self.assertTrue((self.layout.units / self.layout.unit("gateway")).exists())
        self.assertFalse((self.layout.root / "etc/sudoers.d/codex-harness-resume").exists())
        self.command.side_effect = None
        initialize_recorded(self.layout, resume=True)
        self.assertEqual((self.layout.config / "gateway-token").read_bytes(), token)
        self.assertEqual(read_json(record_path(self.layout))["providerRevision"], saved["providerRevision"])

    def test_changed_recorded_material_is_not_overwritten(self):
        self.interrupt_after("etc/codex-harness/resume/gateway-token")
        token = self.layout.config / "gateway-token"
        token.write_bytes(b"unrecognized replacement")
        before = token.read_bytes()
        with self.assertRaises(DeployError): initialize_recorded(self.layout, resume=True)
        self.assertEqual(token.read_bytes(), before)

    def test_unclaimed_state_and_different_checkout_are_rejected(self):
        self.interrupt_after("opt/codex-harness/resume")
        foreign = self.layout.app / "foreign"
        foreign.write_bytes(b"retain me")
        with self.assertRaises(DeployError) as caught: initialize_recorded(self.layout, resume=True)
        self.assertEqual(caught.exception.code, "ownership_conflict")
        self.assertEqual(foreign.read_bytes(), b"retain me")
        foreign.unlink()
        self.material["deploy/cli.py"] = (b"changed\n", 0o644)
        with self.assertRaises(DeployError) as caught: initialize_recorded(self.layout, resume=True)
        self.assertEqual(caught.exception.code, "integrity")

    def test_no_record_and_repeated_install_never_claim_existing_paths(self):
        with self.assertRaises(DeployError): initialize_recorded(self.layout, resume=True)
        self.interrupt_after("opt/codex-harness/resume")
        with self.assertRaises(DeployError) as caught: self.start()
        self.assertEqual(caught.exception.code, "collision")

    def test_unknown_stop_precedes_creating_any_instance_material(self):
        with patch.object(FakeSystem, "state", return_value={"stopped": False}), self.assertRaises(DeployError) as caught:
            self.start()
        self.assertEqual(caught.exception.code, "stop_unknown")
        self.assertFalse(self.layout.app.exists())
        self.identities.assert_not_called()

    def test_known_partial_staging_write_is_replaced_without_new_secret(self):
        saved = self.interrupt_after("opt/codex-harness/resume")
        from deploy.install_recovery import build_plan
        plan = build_plan(self.layout, saved, self.material)
        self.layout.config.mkdir(exist_ok=True)
        os.chmod(self.layout.config, 0o751)
        target = self.layout.config / "gateway-token"
        staging = plan.temporary(target)
        staging.write_bytes(b"interrupted partial bytes")
        os.chmod(staging, 0o600)
        initialize_recorded(self.layout, resume=True)
        self.assertFalse(staging.exists())
        self.assertEqual(target.read_text().strip(), saved["token"])

    def checkpoint(self, target, operation):
        original = CreationPlan.publish
        real = getattr(os, operation)
        def publish(plan, path):
            if path != target:
                return original(plan, path)
            def interrupt(*args, **kwargs):
                if operation == "link": real(*args, **kwargs)
                raise KeyboardInterrupt("loss at staging metadata/publication checkpoint")
            with patch("os." + operation, side_effect=interrupt): original(plan, path)
        with patch.object(CreationPlan, "publish", publish), self.assertRaises(KeyboardInterrupt): self.start()
        saved = read_json(record_path(self.layout))
        initialize_recorded(self.layout, resume=True)
        self.assertEqual(read_json(record_path(self.layout))["phase"], "initialized")
        self.assertEqual((self.layout.config / "gateway-token").read_text().strip(), saved["token"])

    def test_resume_after_file_chmod_before_chown(self):
        self.checkpoint(self.layout.config / "gateway-token", "chown")

    def test_resume_after_directory_chmod_before_chown(self):
        self.checkpoint(self.layout.state / "worker", "chown")

    def test_resume_after_file_link_before_staging_unlink(self):
        self.checkpoint(self.layout.config / "gateway-token", "link")

    def test_complete_files_without_initialized_commit_block_update_and_control_gate(self):
        from deploy.common import write_json
        from deploy.transactions import require_recovered, require_initialization_complete
        def interrupt(path, value, **kwargs):
            if path == record_path(self.layout) and value.get("phase") == "initialized":
                raise KeyboardInterrupt("all files published before initialized commit")
            return write_json(path, value, **kwargs)
        with patch("deploy.install_recovery.write_json", side_effect=interrupt), self.assertRaises(KeyboardInterrupt): self.start()
        for action in (lambda: require_recovered(self.layout), lambda: require_recovered(self.layout, control=False),
                       lambda: require_initialization_complete(self.layout)):
            with self.assertRaises(DeployError) as caught: action()
            self.assertEqual(caught.exception.code, "initialization_pending")
        self.assertFalse((self.layout.config / "management.lock").exists())
        initialize_recorded(self.layout, resume=True)
        require_recovered(self.layout, control=False)

    def test_private_journal_reserves_numeric_ids_before_any_account_is_created(self):
        from deploy.install_recovery import reserved_identities
        with patch.object(FakeSystem, "state", return_value={"stopped": False}), self.assertRaises(DeployError): self.start()
        saved = read_json(record_path(self.layout))
        uids, gids = reserved_identities(Layout("other", self.layout.root))
        self.assertEqual(uids, {value["uid"] for value in saved["identities"].values() if "uid" in value})
        self.assertEqual(gids, {value["gid"] for value in saved["identities"].values()})
        self.identities.assert_not_called()


if __name__ == "__main__": unittest.main()
