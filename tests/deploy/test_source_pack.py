"""Package source without visiting unrelated checkout data or its own output."""
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.build import pack_source
from deploy.common import DeployError


class SourcePackTests(unittest.TestCase):
    def test_ignored_trees_are_not_visited_and_allowed_nested_source_is_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "checkout"
            source.mkdir()
            for name in ("package.json", "src/nested/main.ts", "web/index.html", "protocol/types.ts",
                         ".work/private/state", "node_modules/cache/data", "web/node_modules/cache/data",
                         "web/dist/assets/bundle.js", "src/.env.private/key", "src/auth.json"):
                file = source / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(name, encoding="utf-8")
            ignored = {source / name for name in (".work", "node_modules", "web/node_modules", "web/dist", "src/.env.private")}
            original_scandir, original_listdir = os.scandir, os.listdir
            visited = []
            def check(path):
                candidate = Path(path)
                self.assertFalse(any(candidate == item or item in candidate.parents for item in ignored),
                                 "packaging tried to visit excluded data")
                visited.append(candidate)
            def guarded_scandir(path):
                check(path)
                return original_scandir(path)
            def guarded_listdir(path):
                check(path)
                return original_listdir(path)
            archive = root / "source.tgz"
            # pathlib uses listdir on Python 3.12 and scandir on newer Python.
            # Guard both enumeration APIs instead of assuming its implementation.
            with patch("os.scandir", side_effect=guarded_scandir), patch("os.listdir", side_effect=guarded_listdir):
                pack_source(source, archive)
            self.assertTrue(visited)
            with tarfile.open(archive) as packed:
                self.assertEqual(set(packed.getnames()), {"package.json", "src/nested/main.ts", "web/index.html", "protocol/types.ts"})
                self.assertEqual(packed.extractfile("src/nested/main.ts").read(), b"src/nested/main.ts")

    def test_output_within_packaged_inputs_is_rejected_before_creation(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)
            (source / "src").mkdir()
            for output in (source / "src/source.tgz", source / "package.json"):
                with self.subTest(output=output.name), self.assertRaisesRegex(DeployError, "outside the packaged inputs"):
                    pack_source(source, output)
                self.assertFalse(output.exists())

    def test_existing_output_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)
            output = source / "source.tgz"
            output.write_bytes(b"retained archive")
            with self.assertRaises(DeployError):
                pack_source(source, output)
            self.assertEqual(output.read_bytes(), b"retained archive")


if __name__ == "__main__":
    unittest.main()
