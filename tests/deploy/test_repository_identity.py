"""Native helper returns the same identity for linked worktrees and verifies it before writes."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from deploy.common import DeployError
from deploy.workspace import Workspace, validate
from deploy.workspace_paths import Root


@unittest.skipUnless(sys.platform == "linux", "The production Git reader uses Linux descriptors")
class RepositoryIdentityTests(unittest.TestCase):
    def test_two_real_repositories_and_linked_worktree(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            first, second, linked = (base / name for name in ("first", "second", "linked"))
            for repository in (first, second):
                subprocess.run(["git", "init", "-q", str(repository)], check=True)
            subprocess.run(["git", "-C", str(first), "-c", "user.name=test", "-c", "user.email=test@example.org",
                            "commit", "--allow-empty", "-qm", "initial"], check=True)
            subprocess.run(["git", "-C", str(first), "worktree", "add", "-q", "--detach", str(linked), "HEAD"], check=True)
            ids = []
            for repository in (first, second, linked):
                root = Root(str(repository), [])
                try:
                    workspace = Workspace(root, [], base / "state")
                    request = {"version": 1, "root": str(repository), "action": "repository/identity", "params": {}}
                    ids.append(workspace.dispatch(validate(request))["result"]["identity"])
                finally:
                    root.close()
            self.assertEqual(ids[0], ids[2])
            self.assertNotEqual(ids[0], ids[1])
            root = Root(str(first), [])
            try:
                workspace = Workspace(root, [], base / "state")
                with self.assertRaisesRegex(DeployError, "Repository changed"):
                    workspace.dispatch({"action": "git/commit", "params": {}, "repositoryIdentity": ids[1]})
            finally:
                root.close()
