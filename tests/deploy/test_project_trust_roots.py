import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from deploy.workspace_paths import Root
from deploy.workspace_resources import trust_roots


@unittest.skipUnless(os.name == "posix" and hasattr(os, "O_PATH"), "native Linux descriptor verification")
class ProjectTrustRoots(unittest.TestCase):
    def test_git_root_and_linked_primary_are_verified_but_ordinary_ancestors_are_excluded(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory).resolve()
            main = parent / "main"
            linked = parent / "linked"
            subprocess.run(["git", "init", "--quiet", str(main)], check=True)
            subprocess.run(["git", "-C", str(main), "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost",
                            "commit", "-q", "--allow-empty", "-m", "Test"], check=True)
            subprocess.run(["git", "-C", str(main), "worktree", "add", "--quiet", "--detach", str(linked)], check=True)
            for root, expected in [(main, [str(main)]), (linked, [str(linked), str(main)]), (parent, [])]:
                child = root / "scope"; child.mkdir()
                descriptor = Root(str(child), [])
                try:
                    self.assertEqual(trust_roots(descriptor, []), {"roots": expected})
                finally: descriptor.close()
