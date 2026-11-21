"""Scope, revision and durability of ordinary private MCP edits."""
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from deploy import mcp_user_config as editor
from deploy.common import DeployError, Layout, canonical


class UserMcpConfigTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name).resolve()
        self.path = self.home / "config.toml"

    def request(self, changes):
        return {"name": 'a.b "q"', "expectedVersion": editor.state(self.home)["fileVersion"], "changes": changes}

    def test_create_edit_race_and_private_readback(self):
        params = self.request({"command": "echo", "enabled": False, "env": {"TOKEN": "synthetic"}})
        self.assertIsNone(params["expectedVersion"])
        result = editor.apply(self.home, params)
        self.assertEqual(result["fileVersion"], editor.state(self.home)["fileVersion"])
        self.assertNotIn("synthetic", json.dumps(result))
        stale = self.request(None)
        self.path.write_bytes(self.path.read_bytes() + b"\n# operator edit\n")
        existing = self.path.read_bytes()
        with self.assertRaises(DeployError) as conflict:
            editor.apply(self.home, stale)
        self.assertEqual(conflict.exception.code, "config_conflict")
        self.assertEqual(self.path.read_bytes(), existing)
        editor.apply(self.home, self.request(None))
        self.assertIn("# operator edit", self.path.read_text())
        self.assertNotIn("synthetic", self.path.read_text())

    def test_unrelated_fields_or_destinations_are_rejected_before_writing(self):
        for extra in ({"path": "elsewhere"}, {"name": ""}, {"changes": {"outside": True}},
                      {"changes": {"enabled": True}}, {"changes": {"command": "echo", "url": "https://example.invalid"}},
                      {"changes": {"args": [True]}}, {"changes": {"bearer_token": "value"}}):
            with self.subTest(extra=extra), self.assertRaises(DeployError):
                editor.apply(self.home, {**self.request({"enabled": True}), **extra})
        self.assertFalse(self.path.exists())

    def test_edit_that_intervenes_before_publication_wins(self):
        self.path.write_bytes(b'# before\n')
        from deploy import mcp_enabled_override
        replace = mcp_enabled_override._replace
        def raced(path, data, before, limit):
            path.write_bytes(b'# written by another operator\n')
            return replace(path, data, before, limit)
        with patch.object(editor, "_replace", side_effect=raced), self.assertRaises(DeployError):
            editor.apply(self.home, self.request({"command": "echo"}))
        self.assertEqual(self.path.read_bytes(), b'# written by another operator\n')

    @unittest.skipUnless(os.name == "posix", "POSIX file identity")
    def test_symlinks_and_shared_files_cannot_be_replaced(self):
        original = self.home / "original"
        original.write_text("# keep\n")
        for link in (lambda: self.path.symlink_to(original), lambda: os.link(original, self.path)):
            link()
            with self.assertRaises((DeployError, OSError)):
                editor.apply(self.home, {"name": "new", "expectedVersion": None, "changes": {"command": "echo"}})
            self.assertEqual(original.read_text(), "# keep\n")
            self.path.unlink()

    @unittest.skipUnless(os.name == "posix", "managed workspace host")
    def test_managed_and_standalone_distinguish_failed_writes_from_uncertain_publication(self):
        from deploy import mcp_enabled_override, thread_history, workspace
        project = tempfile.TemporaryDirectory()
        self.addCleanup(project.cleanup)
        root = Path(project.name).resolve()

        def dispatch(managed, params):
            if managed:
                request = {"version": 1, "root": str(root), "action": "mcp/user-edit", "params": params}
                output = io.BytesIO()
                # Linux exercises the descriptor-backed project admission. The
                # other POSIX hosts can exercise the same dispatcher after admission.
                admission = patch.object(workspace, "Root", wraps=workspace.Root if hasattr(os, "O_PATH") else None)
                with admission, patch.object(workspace.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(canonical(request)))), \
                        patch.object(workspace.sys, "stdout", SimpleNamespace(buffer=output)), \
                        patch.object(workspace.signal, "signal"), patch.object(workspace.signal, "alarm"), \
                        patch.object(workspace, "blocked_paths", return_value=[self.home]):
                    workspace.workspace_main(Layout("fixture", self.home), {"home": str(self.home)})
                return json.loads(output.getvalue())["error"]["delivery"]
            with self.assertRaises(thread_history.HistoryError) as exc:
                thread_history.operate(self.home, os.geteuid(), {"action": "mcp-user-edit", **params})
            return exc.exception.delivery

        for managed in (True, False):
            for fault in ("replace", "fsync", "readback"):
                with self.subTest(managed=managed, fault=fault):
                    self.path.write_bytes(b"# before\n")
                    params = self.request({"command": "echo", "enabled": False})
                    if fault == "replace":
                        inject = patch.object(mcp_enabled_override.os, "replace", side_effect=PermissionError("denied"))
                    elif fault == "fsync":
                        inject = patch.object(mcp_enabled_override, "fsync_directory", side_effect=OSError("fsync failed"))
                    else:
                        before = editor._read(self.path, limit=editor.LIMIT)
                        inject = patch.object(editor, "_read", side_effect=[before, OSError("readback failed")])
                    with inject:
                        self.assertEqual(dispatch(managed, params), "not_sent" if fault == "replace" else "unknown")
                    self.assertEqual(b"echo" in self.path.read_bytes(), fault != "replace")
