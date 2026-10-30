"""Actual native UID creates and edits a project through the installed helper protocol."""
import errno
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from deploy.common import Layout, write_json
from deploy.execution_identity import native_settings


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Actual Linux native identity")
class ProjectIdentity(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="harness-project-identity-")
        self.addCleanup(self.temporary.cleanup)
        self.layout = Layout("fixture", Path(self.temporary.name))
        os.chmod(self.layout.root, 0o755)
        self.layout.config.mkdir(parents=True)
        self.layout.control.mkdir(parents=True)
        package = self.layout.control / "deploy"
        package.mkdir()
        (package / "__init__.py").write_text("")
        source = Path(__file__).resolve().parents[3] / "deploy"
        for name in ("common.py", "native_launcher.py", "execution_identity.py"):
            shutil.copyfile(source / name, package / name)
        self.home = self.layout.state / "worker"
        self.home.mkdir(parents=True)
        os.chown(self.home, 65534, 65534)
        os.chmod(self.home, 0o700)
        self.root_home = self.layout.state / "worker-root"
        self.root_home.mkdir(mode=0o700)
        write_json(self.layout.config / "native.json", {"uid": 65534, "gid": 65534, "cwd": str(self.home), "home": str(self.home / "codex")}, mode=0o644)

    def invoke(self, body, *, mode="native", policy_mode=None, fail_sync=None, fail_readback=None, failure_errno=errno.EIO):
        selected = policy_mode or mode
        if selected == "root":
            config = {"executionMode": "root", "rootAllowed": True, "executionGeneration": "a" * 32,
                      "workerUid": 65534, "workerGid": 65534, "codexRelative": "vendor/codex"}
            write_json(self.layout.config / "instance.json", config)
            settings = native_settings(self.layout, config)
        else:
            settings = {"uid": 65534, "gid": 65534, "cwd": str(self.home), "home": str(self.home / "codex")}
        write_json(self.layout.config / "native.json", settings, mode=0o644)
        code = """
from pathlib import Path
import sys
from deploy.common import Layout
import deploy.native_launcher as launcher
root = Path(sys.argv[1])
failure_path, readback_path, failure_errno = sys.argv[2], sys.argv[3], int(sys.argv[4])
original_sync = launcher.fsync_directory
original_resolve = Path.resolve
def sync(path):
    if str(path) == failure_path:
        raise OSError(failure_errno, 'injected directory sync failure')
    original_sync(path)
def resolve(path, *args, **kwargs):
    if str(path) == readback_path:
        raise OSError(failure_errno, 'injected readback failure')
    return original_resolve(path, *args, **kwargs)
launcher.fsync_directory = sync
Path.resolve = resolve
launcher.Layout = lambda instance: Layout(instance, root)
sys.argv = ['native-launch', 'resolve-project']
launcher.native_main('fixture')
"""
        def identity():
            os.setgroups([])
            os.setgid(0 if mode == "root" else 65534)
            os.setuid(0 if mode == "root" else 65534)
        return subprocess.run([sys.executable, "-B", "-c", code, str(self.layout.root),
                               str(fail_sync) if fail_sync is not None else "",
                               str(fail_readback) if fail_readback is not None else "", str(failure_errno)],
                              cwd=self.layout.control, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                              input=json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                              capture_output=True, timeout=10, preexec_fn=identity)

    def test_long_unicode_paths_fit_the_utf8_request_and_complete_response_budgets(self):
        component = "\U0001f600" * 60
        self.assertEqual(len(component.encode("utf-8")), 240)
        for mode, home, uid in (("native", self.home, 65534), ("root", self.root_home, 0)):
            parent = home
            for _ in range(12):
                parent = parent / component
                parent.mkdir(mode=0o700)
                os.chown(parent, uid, uid)
            for operation in ("directory", "path"):
                with self.subTest(mode=mode, operation=operation):
                    target = parent / (operation + "-\U0001f600")
                    if operation == "path":
                        target.mkdir(mode=0o700)
                        os.chown(target, uid, uid)
                    request = {operation: str(target)}
                    expected = {"path": str(target), "name": target.name}
                    self.assertLessEqual(len(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")), 4096)
                    self.assertGreater(len(json.dumps(expected).encode("utf-8")), 8192)
                    result = self.invoke(request, mode=mode)
                    self.assertTrue(target.is_dir())
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout.decode("utf-8")), expected)
                    self.assertTrue(result.stdout.endswith(b"\n"))
                    self.assertLessEqual(len(result.stdout), 8192)

    def test_both_real_identities_accept_relative_absolute_and_parent_paths(self):
        for mode, home, uid in (("native", self.home, 65534), ("root", self.root_home, 0)):
            with self.subTest(mode=mode):
                relative = self.invoke({"directory": "./relative///"}, mode=mode)
                self.assertEqual(relative.returncode, 0, relative.stderr)
                self.assertEqual(json.loads(relative.stdout), {"path": str(home / "projects/relative"), "name": "relative"})
                for directory, target in ((str(home / "absolute"), home / "absolute"),
                                          ("../outside-default", home / "outside-default"),
                                          ("relative/nested", home / "projects/relative/nested")):
                    created = self.invoke({"directory": directory}, mode=mode)
                    self.assertEqual(created.returncode, 0, created.stderr)
                    self.assertEqual(json.loads(created.stdout), {"path": str(target), "name": target.name})
                    self.assertEqual((target.stat().st_uid, target.stat().st_gid, target.stat().st_mode & 0o777), (uid, uid, 0o700))
                    opened = self.invoke({"path": directory}, mode=mode)
                    self.assertEqual(opened.returncode, 0, opened.stderr)
                    self.assertEqual(json.loads(opened.stdout), json.loads(created.stdout))

    def test_absolute_creation_does_not_initialize_default_root_and_posix_names_are_literal(self):
        for mode, home in (("native", self.home), ("root", self.root_home)):
            with self.subTest(mode=mode):
                name = "Linux :?*\\name. " + "long-" * 18
                target = home / name
                request = "//" + str(home).lstrip("/") + "//./unused/../" + name + "///"
                created = self.invoke({"directory": request}, mode=mode)
                self.assertEqual(created.returncode, 0, created.stderr)
                self.assertEqual(json.loads(created.stdout), {"path": str(target), "name": name})
                self.assertFalse((home / "projects").exists())
                opened = self.invoke({"path": request}, mode=mode)
                self.assertEqual(opened.returncode, 0, opened.stderr)
                self.assertEqual(json.loads(opened.stdout), json.loads(created.stdout))
                self.assertFalse((home / "projects").exists())

    def test_native_absolute_permission_denial_is_os_based_and_root_is_explicit(self):
        for permissions, message in ((0o700, "无法进入"), (0o555, "不可写")):
            parent = self.layout.root / ("private-" + str(permissions))
            parent.mkdir(mode=permissions)
            target = parent / "new"
            denied = self.invoke({"directory": str(target)})
            self.assertEqual(denied.returncode, 1, denied.stderr)
            error = json.loads(denied.stdout)["error"]
            self.assertEqual((error["code"], error["delivery"]), ("project_permission_denied", "not_sent"))
            self.assertIn(message, error["message"])
            self.assertIn("服务器管理员授权后在网页开启 ROOT", error["message"])
            self.assertFalse(target.exists())
            created = self.invoke({"directory": str(target)}, mode="root")
            self.assertEqual(created.returncode, 0, created.stderr)
            self.assertEqual(target.stat().st_uid, 0)

    def test_missing_parent_existing_file_and_root_are_never_overwritten(self):
        for mode, home in (("native", self.home), ("root", self.root_home)):
            file = home / "keep-file"
            file.write_text("keep")
            for target, code in ((home / "missing/new", "project_parent_unavailable"),
                                 (file / "new", "project_parent_unavailable"),
                                 (file, "project_exists"), (Path("/"), "project_exists")):
                with self.subTest(mode=mode, target=target):
                    failed = self.invoke({"directory": str(target)}, mode=mode)
                    self.assertEqual(failed.returncode, 1, failed.stderr)
                    self.assertEqual(json.loads(failed.stdout)["error"]["code"], code)
                    self.assertEqual(json.loads(failed.stdout)["error"]["delivery"], "not_sent")
            self.assertEqual(file.read_text(), "keep")
            self.assertFalse((home / "missing").exists())
            opened = self.invoke({"path": "/"}, mode=mode)
            self.assertEqual(opened.returncode, 0, opened.stderr)
            self.assertEqual(json.loads(opened.stdout)["path"], "/")

    def test_absolute_postcreation_sync_and_readback_failures_remain_unknown(self):
        for mode, home in (("native", self.home), ("root", self.root_home)):
            for stage in ("project", "parent", "readback"):
                for number in (errno.EACCES, errno.EPERM, errno.EROFS, errno.ENOENT, errno.ENAMETOOLONG):
                    with self.subTest(mode=mode, stage=stage, errno=number):
                        target = home / (stage + "-" + str(number))
                        options = {"fail_readback": target} if stage == "readback" else {"fail_sync": target if stage == "project" else home}
                        failed = self.invoke({"directory": str(target)}, mode=mode, failure_errno=number, **options)
                        self.assertEqual(failed.returncode, 1)
                        self.assertEqual(failed.stdout, b"")
                        self.assertIn(b"Native launcher failed", failed.stderr)
                        self.assertTrue(target.is_dir())

    def test_payload_cannot_switch_identity_and_mismatched_root_policy_does_not_elevate(self):
        target = self.layout.root / "unauthorized"
        injected = self.invoke({"directory": str(target), "mode": "root"})
        self.assertEqual(injected.returncode, 1)
        self.assertEqual(json.loads(injected.stdout)["error"]["delivery"], "not_sent")
        mismatch = self.invoke({"directory": str(target)}, mode="native", policy_mode="root")
        self.assertEqual(mismatch.returncode, 1)
        self.assertEqual(mismatch.stdout, b"")
        self.assertIn(b"Native launcher failed", mismatch.stderr)
        self.assertFalse(target.exists())

    def test_new_project_is_owned_by_executor_and_existing_project_opens(self):
        created = self.invoke({"directory": "new-project"})
        self.assertEqual(created.returncode, 0, created.stderr)
        result = json.loads(created.stdout)
        project = Path(result["path"])
        self.assertEqual(project.stat().st_uid, 65534)
        self.assertEqual(project.stat().st_gid, 65534)
        self.assertEqual(project.stat().st_mode & 0o777, 0o700)
        self.assertEqual(project.parent.stat().st_uid, 65534)
        self.assertEqual(project.parent.stat().st_mode & 0o777, 0o700)
        next_project = self.invoke({"directory": "second-project"})
        self.assertEqual(next_project.returncode, 0, next_project.stderr)
        self.assertEqual(Path(json.loads(next_project.stdout)["path"]).stat().st_uid, 65534)
        existing = self.invoke({"path": str(project)})
        self.assertEqual(existing.returncode, 0, existing.stderr)
        self.assertEqual(json.loads(existing.stdout), result)
        duplicate = self.invoke({"directory": "new-project"})
        self.assertEqual(json.loads(duplicate.stdout)["error"]["code"], "project_exists")

    def test_sync_failures_report_not_sent_only_before_project_creation(self):
        for stage in ("home", "project", "root"):
            for failure_errno in (errno.EACCES, errno.EIO, errno.EEXIST):
                with self.subTest(stage=stage, failure_errno=failure_errno):
                    name = f"failed-{stage}-{failure_errno}"
                    project = self.home / "projects" / name
                    target = {"home": self.home, "project": project, "root": project.parent}[stage]
                    result = self.invoke({"directory": name}, fail_sync=target, failure_errno=failure_errno)
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(project.exists(), stage != "home")
                    if stage == "home" and failure_errno in (errno.EACCES, errno.EEXIST):
                        self.assertEqual(json.loads(result.stdout)["error"]["delivery"], "not_sent")
                    else:
                        # No structured definite failure: runtime preserves unknown.
                        self.assertEqual(result.stdout, b"")
                        self.assertIn(b"Native launcher failed", result.stderr)

    def test_missing_and_root_private_directories_have_distinct_structured_failures(self):
        inaccessible = self.layout.root / "root-private"
        inaccessible.mkdir(mode=0o700)
        for target, code in ((inaccessible, "project_permission_denied"), (self.home / "missing", "project_not_found")):
            result = self.invoke({"path": str(target)})
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)["error"]["code"], code)
            self.assertEqual(json.loads(result.stdout)["error"]["delivery"], "not_sent")


if __name__ == "__main__":
    unittest.main()
