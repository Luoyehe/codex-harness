"""Search never follows links and never represents a bounded scan as complete."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError
from deploy.workspace_paths import Root
from deploy.workspace_search import search, validate


class SearchValidationTests(unittest.TestCase):
    def test_search_is_literal_and_scoped_with_bounded_inputs(self):
        validate({"query": "[a.*]", "path": "sub", "mode": "text", "limit": 1})
        for params in ({"query": ""}, {"query": "x\ny"}, {"query": "x", "path": "../"},
                       {"query": "x", "limit": True}, {"query": "x", "mode": "shell"},
                       {"query": "x", "caseSensitive": 1}, {"query": "x", "root": "/"}):
            with self.subTest(params=params), self.assertRaises(DeployError):
                validate(params)


@unittest.skipUnless(os.name == "posix", "Requires Linux descriptors and procfs")
class SearchFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="workspace-search-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.project = self.base / "project"
        self.project.mkdir()
        self.root = Root(str(self.project), [])
        self.addCleanup(self.root.close)

    def test_path_and_literal_text_search_report_matching_lines(self):
        (self.project / "src").mkdir()
        (self.project / "src/Hello.ts").write_text("nothing\nNeedle [a.*]\nNEEDLE again\n", encoding="utf-8")
        by_path = search(self.root, {"query": "hello"})
        self.assertEqual(by_path["matches"], [{"path": "src/Hello.ts"}])
        self.assertTrue(by_path["complete"])
        text = search(self.root, {"query": "needle", "mode": "text", "path": "src"})
        self.assertEqual([item["line"] for item in text["matches"]], [2, 3])
        literal = search(self.root, {"query": "[a.*]", "mode": "text"})
        self.assertEqual(len(literal["matches"]), 1)
        sensitive = search(self.root, {"query": "NEEDLE", "mode": "text", "caseSensitive": True})
        self.assertEqual([item["line"] for item in sensitive["matches"]], [3])

    def test_links_metadata_fifo_and_binary_are_never_traversed_as_text(self):
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "secret").write_text("private needle")
        (self.project / "escape").symlink_to(outside, target_is_directory=True)
        (self.project / "linked").symlink_to(outside / "secret")
        os.link(outside / "secret", self.project / "hard")
        os.mkfifo(self.project / "pipe")
        (self.project / "binary").write_bytes(b"\x00needle")
        for name in (".git", ".harness-workspace"):
            (self.project / name).mkdir()
            (self.project / name / "private").write_text("needle")
        result = search(self.root, {"query": "needle", "mode": "text"})
        self.assertEqual(result["matches"], [])
        self.assertFalse(result["complete"])
        self.assertEqual(result["skippedEntries"], 5)

    def test_result_entry_byte_depth_and_time_budgets_report_incomplete(self):
        (self.project / "one").write_text("needle\nneedle")
        (self.project / "two").write_text("needle")
        limited = search(self.root, {"query": "needle", "mode": "text", "limit": 1})
        self.assertFalse(limited["complete"])
        self.assertEqual(len(limited["matches"]), 1)
        for name, value, reason in (("MAX_NODES", 1, "entry_limit"), ("MAX_BYTES", 2, "byte_limit"), ("MAX_SECONDS", 0, "time_limit")):
            with self.subTest(name=name), patch("deploy.workspace_search." + name, value):
                result = search(self.root, {"query": "needle", "mode": "text"})
                self.assertIn(reason, result["reasons"])
        (self.project / "sub").mkdir()
        with patch("deploy.workspace_search.MAX_DEPTH", 0):
            self.assertIn("depth_limit", search(self.root, {"query": "needle"})["reasons"])

    def test_moved_root_or_scope_cannot_return_outside_results(self):
        (self.project / "one").write_text("needle")
        self.project.rename(self.base / "moved")
        with self.assertRaises(DeployError):
            search(self.root, {"query": "needle", "mode": "text"})
