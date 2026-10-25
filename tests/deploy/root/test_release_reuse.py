"""Root-owned release reuse fixtures; no service or process changes."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

from deploy.build import publish_release
from deploy.common import DeployError, Layout, digest, mkdir, read_json, write_json
from deploy.safe_fs import inspect_tree


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root ownership fixture")
class ReleaseReuseTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.layout = Layout("fixture", Path(self.folder.name))
        mkdir(self.layout.app / "releases")
        mkdir(self.layout.config / "manifests")

    def export(self, name):
        path = self.layout.app / "releases" / name
        mkdir(path)
        (path / "fixture.txt").write_bytes(b"identical verified runtime")
        return path, inspect_tree(path, root_owned=True)

    def test_identical_release_is_reused_without_replacing_it(self):
        first, manifest = self.export(".candidate-one")
        release = publish_release(self.layout, first, manifest)
        target = self.layout.app / "releases" / release
        identity = target.stat().st_ino
        second, repeated = self.export(".candidate-two")
        self.assertEqual(publish_release(self.layout, second, repeated), release)
        self.assertEqual(target.stat().st_ino, identity)
        self.assertTrue(second.exists())  # Retained, bounded candidate evidence.
        self.assertEqual(inspect_tree(target, root_owned=True), manifest)

    def test_rename_before_manifest_interruption_is_recoverable(self):
        first, manifest = self.export(".candidate-one")
        release = digest(manifest)
        first.rename(self.layout.app / "releases" / release)
        second, repeated = self.export(".candidate-two")
        self.assertEqual(publish_release(self.layout, second, repeated), release)
        self.assertEqual(read_json(self.layout.config / "manifests" / (release + ".json")), manifest)

    def test_changed_existing_tree_or_manifest_is_not_overwritten(self):
        for corrupt in ("tree", "manifest"):
            with self.subTest(corrupt=corrupt), tempfile.TemporaryDirectory() as temp:
                layout = Layout("fixture", Path(temp))
                mkdir(layout.app / "releases")
                mkdir(layout.config / "manifests")
                export = layout.app / "releases/.candidate-first"
                mkdir(export)
                (export / "fixture.txt").write_bytes(b"original")
                manifest = inspect_tree(export, root_owned=True)
                release = publish_release(layout, export, manifest)
                target = layout.app / "releases" / release
                record = layout.config / "manifests" / (release + ".json")
                if corrupt == "tree":
                    (target / "fixture.txt").write_bytes(b"changed")
                else:
                    write_json(record, {})
                before = (target / "fixture.txt").read_bytes(), record.read_bytes()
                with self.assertRaises(DeployError):
                    publish_release(layout, export, manifest)
                self.assertEqual(((target / "fixture.txt").read_bytes(), record.read_bytes()), before)


if __name__ == "__main__":
    unittest.main()
