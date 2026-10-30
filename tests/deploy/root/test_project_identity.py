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
        for name in ("common.py", "native_launcher.py"):
            shutil.copyfile(source / name, package / name)
        self.home = self.layout.state / "worker"
        self.home.mkdir(parents=True)
        os.chown(self.home, 65534, 65534)
        os.chmod(self.home, 0o700)
        write_json(self.layout.config / "native.json", {"uid": 65534, "gid": 65534, "cwd": str(self.home), "home": str(self.home / "codex")}, mode=0o644)

    def invoke(self, body, *, fail_sync=None, failure_errno=errno.EIO):
        code = """
from pathlib import Path
import sys
from deploy.common import Layout
import deploy.native_launcher as launcher
root = Path(sys.argv[1])
failure_path, failure_errno = sys.argv[2], int(sys.argv[3])
original_sync = launcher.fsync_directory
def sync(path):
    if str(path) == failure_path:
        raise OSError(failure_errno, 'injected directory sync failure')
    original_sync(path)
launcher.fsync_directory = sync
launcher.Layout = lambda instance: Layout(instance, root)
sys.argv = ['native-launch', 'resolve-project']
launcher.native_main('fixture')
"""
        def identity():
            os.setgroups([])
            os.setgid(65534)
            os.setuid(65534)
        return subprocess.run([sys.executable, "-B", "-c", code, str(self.layout.root),
                               str(fail_sync) if fail_sync is not None else "", str(failure_errno)],
                              cwd=self.layout.control, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                              input=json.dumps(body).encode(), capture_output=True, timeout=10, preexec_fn=identity)

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
