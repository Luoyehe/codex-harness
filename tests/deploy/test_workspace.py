"""Native workspace validators and Linux descriptor/transaction regressions."""
import hashlib
import os
import struct
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout
from deploy.workspace import Workspace, blocked_paths, failure, validate
from deploy.workspace_git import GIT_ENV, GIT_PREFIX, query_args
from deploy.workspace_paths import MAX_FILE, Root, relative


class WorkspaceFailureTests(unittest.TestCase):
    def test_missing_resource_code_never_reclassifies_a_dispatched_mutation(self):
        for dispatched, delivery in ((False, "not_sent"), (True, "unknown")):
            result = failure(FileNotFoundError("private internal path"), dispatched=dispatched)
            self.assertEqual(result, {"ok": False, "error": {"code": "not_found", "message": "Workspace resource does not exist", "delivery": delivery}})

    def test_explicit_errors_preserve_their_code_and_generic_failures_hide_internal_paths(self):
        self.assertEqual(failure(DeployError("conflict", "Resource changed"), dispatched=True)["error"],
                         {"code": "conflict", "message": "Resource changed", "delivery": "unknown"})
        self.assertEqual(failure(OSError("private internal path"), dispatched=False)["error"],
                         {"code": "workspace_error", "message": "Workspace operation failed", "delivery": "not_sent"})


class WorkspaceValidationTests(unittest.TestCase):
    def request(self, action, params, **extra):
        return {"version": 1, "root": "/registered/project", "action": action, "params": params, **extra}

    def test_paths_reject_escapes_metadata_controls_and_oversized_components(self):
        for path in ("/absolute", "../outside", "a/../b", "a//b", "a/./b", "a\\b", ".git/config", ".harness-workspace/state", "a\0b", "a\nb", "x" * 256):
            with self.subTest(path=repr(path)), self.assertRaises(DeployError):
                relative(path)
        self.assertEqual(relative("src/AGENTS.md"), ["src", "AGENTS.md"])
        self.assertEqual(relative("", empty=True), [])

    def test_write_requires_explicit_revision_and_canonical_operation(self):
        for params, operation in (({"path": "a", "text": "new"}, str(uuid.uuid4())),
                                  ({"path": "a", "text": "new", "expectedRevision": None}, "invalid"),
                                  ({"path": "a", "text": "new", "expectedRevision": "bad"}, str(uuid.uuid4()))):
            with self.assertRaises(DeployError):
                validate(self.request("write", params, operationId=operation))
        self.assertEqual(validate(self.request("write", {"path": "AGENTS.md", "text": "", "expectedRevision": None}, operationId=str(uuid.uuid4())))["action"], "write")

    def test_delete_never_defaults_to_recursive_or_forced(self):
        base = {"path": "a", "expectedRevision": "a" * 64}
        for flags in ({}, {"confirm": True}, {"confirm": True, "recursive": True}, {"confirm": False, "recursive": False}):
            with self.assertRaises(DeployError):
                validate(self.request("remove", {**base, **flags}, operationId=str(uuid.uuid4())))
        validate(self.request("remove", {**base, "confirm": True, "recursive": False}, operationId=str(uuid.uuid4())))

    def test_unknown_methods_fields_root_overrides_and_read_receipts_are_rejected(self):
        for request in (self.request("shell", {"command": "anything"}), self.request("read", {"path": "a", "root": "/other"}),
                        self.request("git/status", {"argv": []}), self.request("list", {}, operationId=str(uuid.uuid4())),
                        {**self.request("read", {"path": "a"}), "environment": {}},
                        {**self.request("read", {"path": "a"}), "version": True}):
            with self.assertRaises(DeployError):
                validate(request)

    def test_binary_and_large_edits_and_stale_copy_contract_rejected(self):
        for text in ("binary\0data", "x" * (MAX_FILE + 1)):
            with self.assertRaises(DeployError):
                validate(self.request("write", {"path": "a", "text": text, "expectedRevision": None}, operationId=str(uuid.uuid4())))
        with self.assertRaises(DeployError):
            validate(self.request("copy", {"path": "a", "destination": "a", "expectedRevision": "a" * 64}, operationId=str(uuid.uuid4())))

    def test_git_queries_cannot_enable_hooks_programs_network_or_recursive_submodules(self):
        self.assertIn("core.fsmonitor=false", GIT_PREFIX)
        self.assertIn("core.hooksPath=/dev/null", GIT_PREFIX)
        self.assertIn("protocol.allow=never", GIT_PREFIX)
        self.assertEqual(GIT_ENV["GIT_CONFIG_GLOBAL"], "/dev/null")
        diff = query_args("git/diff", {"staged": True})
        self.assertIn("--no-ext-diff", diff)
        self.assertIn("--no-textconv", diff)
        self.assertIn("--ignore-submodules=all", diff)
        for action, params in (("git/status", {"path": "-c"}), ("git/diff", {"staged": "true"}), ("git/refs", {"ref": "--exec"}), ("git/commit", {})):
            with self.assertRaises(DeployError):
                query_args(action, params)

    def test_all_control_and_native_config_paths_are_explicitly_excluded(self):
        layout = Layout("fixture", Path("/"))
        paths = blocked_paths(layout, {"home": "/var/lib/native/codex", "cwd": "/var/lib/native"})
        self.assertIn(layout.config, paths)
        self.assertIn(layout.state / "gateway", paths)
        self.assertIn(layout.state / "supervisor", paths)
        self.assertIn(layout.state / "requests", paths)
        self.assertIn(Path("/var/lib/native/codex"), paths)

    def test_binary_download_requires_scoped_path_and_current_revision(self):
        for params in ({"path": "file"}, {"path": "/absolute", "expectedRevision": "a" * 64}, {"path": "file", "expectedRevision": None}):
            with self.assertRaises(DeployError):
                validate(self.request("download", params))
        validate(self.request("download", {"path": "file", "expectedRevision": "a" * 64}))


@unittest.skipUnless(os.name == "posix", "Requires real Linux descriptor paths and renameat2")
class WorkspaceFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="workspace-descriptor-")
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name).resolve()
        self.path = base / "project"
        self.path.mkdir()
        native = base / "native"
        native.mkdir()
        self.root = Root(str(self.path), [])
        self.addCleanup(self.root.close)
        self.workspace = Workspace(self.root, [], native / "workspace-state")
        self.recovery = self.workspace.store.storage / self.workspace.store.project

    def call(self, action, params, operation=None):
        request = {"version": 1, "root": str(self.path), "action": action, "params": params}
        if action in ("write", "copy", "mkdir", "remove"):
            request["operationId"] = operation or str(uuid.uuid4())
        return self.workspace.dispatch(validate(request))

    def test_execute_only_ancestors_allow_scoped_read_write_without_listing_parent(self):
        ancestor = Path(self.temp.name) / "search-only"
        ancestor.mkdir()
        project = ancestor / "project"
        project.mkdir()
        (project / "file.txt").write_text("before")
        subprocess.run(["git", "-C", str(project), "init", "-q"], check=True, env={**GIT_ENV, "PATH": os.environ.get("PATH", "/usr/bin:/bin")})
        ancestor.chmod(0o111)
        opened = None
        try:
            if os.geteuid() != 0:
                with self.assertRaises(PermissionError): list(ancestor.iterdir())
            opened = Root(str(project), [])
            scoped = Workspace(opened, [], self.workspace.store.storage)
            before = scoped.read("read", {"path": "file.txt"})
            request = validate({"version": 1, "root": str(project), "action": "write", "operationId": str(uuid.uuid4()),
                                "params": {"path": "file.txt", "text": "after", "expectedRevision": before["revision"]}})
            self.assertTrue(scoped.dispatch(request)["ok"])
            self.assertEqual(scoped.read("read", {"path": "file.txt"})["text"], "after")
            self.assertIn("file.txt", [entry.name for entry in os.scandir(opened.fd)])
            self.assertTrue(scoped.read("git/status", {})["complete"])
            os.fsync(opened.fd)
        finally:
            if opened is not None: opened.close()
            ancestor.chmod(0o700)

    def test_unresolvable_protected_boundary_is_not_silently_omitted(self):
        protected = Path(self.temp.name) / "protected"
        protected.mkdir()
        child = protected / "private"
        child.mkdir()
        original = Path.resolve
        def denied(path, *args, **kwargs):
            if path == child: raise PermissionError("fixture inaccessible ancestor")
            return original(path, *args, **kwargs)
        with patch.object(Path, "resolve", denied), self.assertRaises(DeployError) as caught:
            Root(str(self.path), [child])
        self.assertEqual(caught.exception.code, "protected_path_unresolved")

    def test_binary_download_is_exact_bounded_and_requires_current_bytes(self):
        import base64
        data = b"\0\xffbinary" * 100000
        target = self.path / "feedback.zip"
        target.write_bytes(data)
        meta = self.call("metadata", {"path": target.name})["result"]
        self.assertTrue(meta["downloadable"])
        self.assertFalse(meta["editable"])
        result = self.call("download", {"path": target.name, "expectedRevision": meta["revision"]})["result"]
        self.assertEqual(base64.b64decode(result["base64"], validate=True), data)
        self.assertEqual(result["bytes"], len(data))
        target.write_bytes(b"changed")
        with self.assertRaises(DeployError) as caught:
            self.call("download", {"path": target.name, "expectedRevision": meta["revision"]})
        self.assertEqual(caught.exception.code, "conflict")

    def test_download_rejects_large_and_linked_files_without_receipts(self):
        target = self.path / "large"
        target.write_bytes(b"x" * (8 * 1024 * 1024 + 1))
        self.assertFalse(self.call("metadata", {"path": target.name})["result"]["downloadable"])
        with self.assertRaises(DeployError):
            self.call("download", {"path": target.name, "expectedRevision": "a" * 64})
        target.write_bytes(b"small")
        (self.path / "alias").symlink_to(target)
        with self.assertRaises((OSError, DeployError)):
            self.call("download", {"path": "alias", "expectedRevision": "a" * 64})
        self.assertFalse(self.recovery.exists())

    def test_text_create_edit_readback_and_replay_preserve_before_image(self):
        first = self.call("write", {"path": "AGENTS.md", "text": "old\n", "expectedRevision": None})["result"]
        operation = str(uuid.uuid4())
        params = {"path": "AGENTS.md", "text": "new\n", "expectedRevision": first["revision"]}
        changed = self.call("write", params, operation)
        self.assertEqual(self.call("write", params, operation), changed)
        self.assertEqual(self.call("read", {"path": "AGENTS.md"})["result"]["text"], "new\n")
        self.assertEqual((self.recovery / operation / "before").read_text(), "old\n")
        self.assertEqual(sorted(item.name for item in self.path.iterdir()), ["AGENTS.md"])
        self.assertEqual(self.call("operation/read", {"operationId": operation})["result"]["state"], "completed")

    def test_revision_conflict_preserves_current_file(self):
        first = self.call("write", {"path": "a", "text": "first", "expectedRevision": None})["result"]
        (self.path / "a").write_text("external")
        with self.assertRaises(DeployError) as caught:
            self.call("write", {"path": "a", "text": "mine", "expectedRevision": first["revision"]})
        self.assertEqual(caught.exception.code, "conflict")
        self.assertEqual((self.path / "a").read_text(), "external")

    def test_collision_between_capture_and_publish_preserves_both_versions(self):
        first = self.call("write", {"path": "a", "text": "original", "expectedRevision": None})["result"]
        operation = str(uuid.uuid4())
        from deploy.workspace import rename_absent
        def race(source_fd, source, target_fd, target):
            if source == "next":
                (self.path / "a").write_text("concurrent")
            rename_absent(source_fd, source, target_fd, target)
        with patch("deploy.workspace.rename_absent", side_effect=race), self.assertRaises(DeployError):
            self.call("write", {"path": "a", "text": "mine", "expectedRevision": first["revision"]}, operation)
        self.assertEqual((self.path / "a").read_text(), "concurrent")
        self.assertEqual((self.recovery / operation / "before").read_text(), "original")
        self.assertEqual((self.recovery / operation / "next").read_text(), "mine")

    def test_copy_and_delete_are_explicit_and_recoverable(self):
        first = self.call("write", {"path": "a", "text": "copy me", "expectedRevision": None})["result"]
        copy = self.call("copy", {"path": "a", "destination": "b", "expectedRevision": first["revision"]})["result"]
        operation = str(uuid.uuid4())
        self.call("remove", {"path": "b", "expectedRevision": copy["revision"], "confirm": True, "recursive": False}, operation)
        self.assertFalse((self.path / "b").exists())
        self.assertEqual((self.path / "a").read_text(), "copy me")
        self.assertEqual((self.recovery / operation / "before").read_text(), "copy me")

    def test_only_empty_directories_can_be_removed(self):
        self.call("mkdir", {"path": "folder"})
        info = self.call("metadata", {"path": "folder"})["result"]
        (self.path / "folder/child").write_text("keep")
        with self.assertRaises(DeployError):
            self.call("remove", {"path": "folder", "expectedRevision": info["revision"], "confirm": True, "recursive": False})
        self.assertEqual((self.path / "folder/child").read_text(), "keep")
        (self.path / "folder/child").unlink()
        info = self.call("metadata", {"path": "folder"})["result"]
        self.call("remove", {"path": "folder", "expectedRevision": info["revision"], "confirm": True, "recursive": False})
        self.assertFalse((self.path / "folder").exists())

    def test_symlink_hardlink_and_special_file_previews_are_rejected(self):
        (self.path / "real").write_text("private")
        (self.path / "link").symlink_to(self.path / "real")
        os.link(self.path / "real", self.path / "hard")
        os.mkfifo(self.path / "pipe")
        for name in ("link", "hard", "real", "pipe"):
            with self.subTest(name=name), self.assertRaises((DeployError, OSError)):
                self.call("read", {"path": name})

    def test_directory_symlink_swap_does_not_follow_outside_root(self):
        with tempfile.TemporaryDirectory() as outside:
            Path(outside, "secret").write_text("outside")
            (self.path / "folder").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(OSError):
                self.call("read", {"path": "folder/secret"})
            self.assertEqual(Path(outside, "secret").read_text(), "outside")

    def test_protected_root_and_reserved_metadata_roots_rejected(self):
        protected = self.path / "secret"
        protected.mkdir()
        for name, forbidden in ((self.path, [protected]), (protected, [protected]), (self.path / ".git", [])):
            if not name.exists():
                name.mkdir()
            with self.assertRaises(DeployError):
                Root(str(name), forbidden)

    def test_binary_large_preview_and_listing_budget_are_explicit(self):
        (self.path / "binary").write_bytes(b"\0\xff")
        self.assertTrue(self.call("read", {"path": "binary"})["result"]["binary"])
        (self.path / "large").write_bytes(b"x" * (MAX_FILE + 1))
        self.assertEqual(self.call("metadata", {"path": "large"})["result"]["reason"], "preview_too_large")
        with self.assertRaises(DeployError):
            self.call("read", {"path": "large"})
        with patch("deploy.workspace.MAX_ENTRIES", 1):
            self.assertTrue(self.call("list", {})["result"]["truncated"])

    def test_retained_receipt_budget_blocks_new_writes(self):
        self.call("write", {"path": "a", "text": "keep", "expectedRevision": None})
        with patch("deploy.workspace_store.MAX_RECORDS", 1), self.assertRaises(DeployError):
            self.call("write", {"path": "b", "text": "blocked", "expectedRevision": None})
        self.assertFalse((self.path / "b").exists())

    def test_real_git_status_diff_refs_disable_repository_programs(self):
        if not Path("/usr/bin/git").is_file():
            self.fail("Required disposable Linux Git executable is absent")
        def git(*args):
            subprocess.run(["/usr/bin/git", "-C", str(self.path), *args], env=GIT_ENV, check=True, capture_output=True, timeout=10)
        git("init", "-q")
        git("config", "user.name", "Isolated Fixture")
        git("config", "user.email", "fixture@example.invalid")
        (self.path / "file.txt").write_text("base\n")
        git("add", "--", "file.txt")
        git("commit", "-q", "-m", "isolated fixture")
        hook = self.path / "must-not-run.sh"
        hook.write_text("#!/bin/sh\nprintf ran > \"" + str(self.path / "ran") + "\"\n")
        hook.chmod(0o700)
        git("config", "core.fsmonitor", str(hook))
        git("config", "diff.external", str(hook))
        git("config", "diff.fixture.textconv", str(hook))
        filter_hook = self.path / "filter-must-not-run.sh"
        filter_hook.write_text("#!/bin/sh\nprintf ran > \"" + str(self.path / "filter-ran") + "\"\ncat\n")
        filter_hook.chmod(0o700)
        git("config", "filter.fixture.clean", str(filter_hook))
        (self.path / ".gitattributes").write_text("file.txt diff=fixture filter=fixture\n")
        # Equal byte length forces status to compare converted content too.
        (self.path / "file.txt").write_text("edit\n")
        status = self.call("git/status", {})["result"]
        self.assertTrue(any(item["path"] == "file.txt" and item["worktree"] == "M" for item in status["entries"]))
        diff = self.call("git/diff", {})["result"]["text"]
        self.assertIn("+edit", diff)
        refs = self.call("git/refs", {})["result"]["refs"]
        self.assertTrue(any(item["name"].startswith("refs/heads/") for item in refs))
        self.assertFalse((self.path / "ran").exists())
        self.assertFalse((self.path / "filter-ran").exists())

    def test_git_view_preserves_staged_unstaged_and_unborn_index_semantics(self):
        def git(*args):
            subprocess.run(["/usr/bin/git", "-C", str(self.path), *args], env=GIT_ENV, check=True, capture_output=True, timeout=10)
        git("init", "-q")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        (self.path / "file").write_text("base\n")
        git("add", "file")
        self.assertTrue(any(item["index"] == "A" for item in self.call("git/status", {})["result"]["entries"]))
        git("commit", "-qm", "fixture")
        (self.path / "file").write_text("staged\n")
        git("add", "file")
        (self.path / "file").write_text("unstaged\n")
        index_before = (self.path / ".git/index").read_bytes()
        self.assertIn("+staged", self.call("git/diff", {"staged": True})["result"]["text"])
        self.assertIn("+unstaged", self.call("git/diff", {})["result"]["text"])
        self.assertEqual((self.path / ".git/index").read_bytes(), index_before)

    def test_git_view_detects_racy_equal_size_edit_without_refreshing_original_index(self):
        def git(*args):
            return subprocess.run(["/usr/bin/git", "-C", str(self.path), *args], env=GIT_ENV, check=True,
                                  capture_output=True, timeout=10).stdout
        git("init", "-q", "--object-format=sha1")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        target = self.path / "file.txt"
        target.write_text("base\n")
        git("add", "--", "file.txt")
        git("commit", "-qm", "fixture")
        git("update-index", "--index-version=2")
        target.write_text("edit\n")
        os.utime(target, ns=(1_000_000_000, 1_000_000_000))
        info = target.stat()
        index = self.path / ".git/index"
        data = bytearray(index.read_bytes())
        self.assertEqual(struct.unpack_from(">4sII", data), (b"DIRC", 2, 1))
        # Reproduce a stat-cache collision without relying on wall-clock timing
        # or the filesystem's timestamp resolution. Keep the original blob ID;
        # only the cached ctime/mtime match the equal-size edited working file.
        struct.pack_into(">IIII", data, 12, info.st_ctime_ns // 1_000_000_000, info.st_ctime_ns % 1_000_000_000,
                         info.st_mtime_ns // 1_000_000_000, info.st_mtime_ns % 1_000_000_000)
        data[-20:] = hashlib.sha1(data[:-20]).digest()
        index.write_bytes(data)
        os.utime(index, ns=(info.st_mtime_ns, info.st_mtime_ns))
        original = index.read_bytes(), index.stat().st_mtime_ns
        self.assertIn(b" M file.txt\0", git("status", "--porcelain=v1", "-z"))
        status = self.call("git/status", {})["result"]
        self.assertTrue(any(item["path"] == "file.txt" and item["worktree"] == "M" for item in status["entries"]))
        self.assertIn("+edit", self.call("git/diff", {})["result"]["text"])
        self.assertEqual((index.read_bytes(), index.stat().st_mtime_ns), original)

    def test_edit_preserves_executable_mode_and_git_metadata_symlinks_are_rejected(self):
        (self.path / "script").write_text("old")
        (self.path / "script").chmod(0o755)
        info = self.call("read", {"path": "script"})["result"]
        self.call("write", {"path": "script", "text": "new", "expectedRevision": info["revision"]})
        self.assertEqual((self.path / "script").stat().st_mode & 0o777, 0o755)
        (self.path / ".git").symlink_to(self.path, target_is_directory=True)
        with self.assertRaises(DeployError) as caught:
            self.call("git/status", {})
        self.assertEqual(caught.exception.code, "unsafe_path")


if __name__ == "__main__":
    unittest.main()
