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

    def test_standalone_and_nested_projects_follow_only_verified_git_metadata(self):
        # The runner's normal TMPDIR is inside the source checkout and therefore a Git project.
        with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
            base = Path(tmp)
            primary, linked, first, second = (base / name for name in ("primary", "linked", "plain-a", "plain-b"))
            first.mkdir()
            second.mkdir()
            subprocess.run(["git", "init", "-q", str(primary)], check=True)
            subprocess.run(["git", "-C", str(primary), "-c", "user.name=test", "-c", "user.email=test@example.org",
                            "commit", "--allow-empty", "-qm", "initial"], check=True)
            subprocess.run(["git", "-C", str(primary), "worktree", "add", "-q", "--detach", str(linked), "HEAD"], check=True)
            nested = linked / "deep" / "child"
            nested.mkdir(parents=True)

            def identity(path, forbidden=None):
                blocked = forbidden or []
                root = Root(str(path), blocked)
                try:
                    return Workspace(root, blocked, base / "state").dispatch({
                        "action": "repository/identity", "params": {}})["result"]["identity"]
                finally:
                    root.close()

            self.assertEqual(identity(primary), identity(nested))
            standalone = identity(first)
            self.assertNotIn(standalone, [identity(primary), identity(second)])
            first.rename(base / "renamed")
            self.assertEqual(identity(base / "renamed"), standalone)
            with self.assertRaisesRegex(DeployError, "protected storage"):
                identity(nested, [primary / ".git"])
            child = second / "child"
            child.mkdir()
            marker = second / ".git"
            marker.symlink_to(primary / ".git")
            for path in (second, child):
                with self.assertRaisesRegex(DeployError, "ordinary directory or worktree pointer"):
                    identity(path)
            marker.unlink()
            marker.write_text("gitdir: missing\n")
            with self.assertRaises(DeployError):
                identity(child)
