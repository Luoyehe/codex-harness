"""Fixed-identity worktree lifecycle; local Git only, no network or root paths."""
import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from deploy.common import DeployError
from deploy.workspace import Workspace, WRITES, validate
from deploy.workspace_git import GIT_ENV
from deploy.workspace_paths import Root
from deploy.workspace_worktrees import MAX_TREE_ENTRIES, checkout_data, ref, validate_binding


class WorktreeValidationTests(unittest.TestCase):
    def checkout_fixture(self, paths):
        object_id = b"e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
        listing = b"".join(b"100644 blob " + object_id + b" 0\t" + path.encode() + b"\0" for path in paths)
        data = (object_id + b" blob 0\n\n") * len(paths)
        return patch("deploy.workspace_worktrees.git", side_effect=[listing, data])

    def test_checkout_rejects_implicit_directory_entries_and_depth_before_reading_blobs(self):
        cases = [[f"d{index}/file" for index in range(MAX_TREE_ENTRIES // 2 + 1)],
                 ["/".join(["d"] * 33 + ["file"])]]
        for paths in cases:
            with self.subTest(files=len(paths)), self.checkout_fixture(paths) as git:
                with self.assertRaises(DeployError) as caught:
                    checkout_data(SimpleNamespace(root=None), "a" * 40)
                self.assertEqual(caught.exception.code, "budget")
                self.assertEqual(git.call_count, 1)

    def test_checkout_exact_entry_budget_counts_shared_parents_once(self):
        for paths in ([f"file{index}" for index in range(MAX_TREE_ENTRIES)],
                      [f"shared/nested/file{index}" for index in range(MAX_TREE_ENTRIES - 2)]):
            with self.subTest(files=len(paths)), self.checkout_fixture(paths) as git:
                files, data = checkout_data(SimpleNamespace(root=None), "a" * 40)
                self.assertEqual([entry[0] for entry in files], paths)
                self.assertEqual(git.call_count, 2)
                self.assertTrue(data)

    def test_checkout_accepts_file_in_exactly_32_parent_directories(self):
        path = "/".join(["d"] * 32 + ["file"])
        with self.checkout_fixture([path]):
            files, _ = checkout_data(SimpleNamespace(root=None), "a" * 40)
        self.assertEqual(files[0][0], path)

    def test_refs_cannot_be_options_revspec_programs_or_arbitrary_paths(self):
        for value in ("HEAD", "refs/heads/main", "refs/remotes/origin/feature", "a" * 40):
            self.assertEqual(ref(value), value)
        for value in ("--exec=command", "HEAD~1", "/tmp/repository", "refs/heads/../other", "refs/heads/a.lock", "refs/heads/a\nb", "main"):
            with self.subTest(value=value), self.assertRaises(DeployError):
                ref(value)

    def test_existing_worktrees_require_complete_trusted_binding_not_native_record_paths(self):
        identity = str(uuid.uuid4())
        request = {"version": 1, "root": "/origin", "action": "worktree/read", "params": {"worktreeId": identity}}
        with self.assertRaises(DeployError):
            validate(request)
        with self.assertRaises(DeployError):
            validate({**request, "params": {"worktreeId": identity, "path": "/arbitrary"}})
        with self.assertRaises(DeployError):
            validate_binding({"version": 1, "worktreeId": identity, "originRoot": "/origin"}, identity, "/origin")

    def test_create_id_is_the_durable_operation_and_never_accepts_destination_or_binding(self):
        request = {"version": 1, "root": "/origin", "action": "worktree/create", "params": {"ref": "HEAD"}, "operationId": str(uuid.uuid4())}
        validate(request)
        for changed in ({"binding": {}}, {"params": {"ref": "HEAD", "destination": "/tmp/other"}}, {"operationId": "invalid"}):
            with self.assertRaises(DeployError):
                validate({**request, **changed})


@unittest.skipUnless(os.name == "posix", "Requires real Linux Git, descriptor paths and renameat2")
class WorktreeFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="workspace-worktree-")
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name).resolve()
        self.path, self.native = base / "project", base / "native"
        self.path.mkdir(); self.native.mkdir()
        self.root = Root(str(self.path), [])
        self.addCleanup(self.root.close)
        self.workspace = Workspace(self.root, [self.native / "worktree-state", self.native / "workspace-state"], self.native / "workspace-state")
        self.git(self.path, "init", "-q")
        self.git(self.path, "config", "user.name", "Fixture")
        self.git(self.path, "config", "user.email", "fixture@example.invalid")
        (self.path / "file").write_text("base\n")
        (self.path / ".gitignore").write_text("*.log\n")
        self.git(self.path, "add", "file", ".gitignore")
        self.git(self.path, "commit", "-qm", "fixture")

    def git(self, path, *args, input_bytes=None):
        return subprocess.run(["/usr/bin/git", "-C", str(path), *args], env=GIT_ENV, input=input_bytes,
                              check=True, capture_output=True, timeout=10).stdout

    def commit_paths(self, paths):
        """Build real local Git objects without populating the origin checkout."""
        blob = self.git(self.path, "hash-object", "-w", "--stdin", input_bytes=b"").strip()
        top, cache = {}, {}
        for path in paths:
            parts, parent = path.split("/"), top
            for part in parts[:-1]:
                parent = parent.setdefault(part, {})
            parent[parts[-1]] = None
        def tree(entries):
            payload = b"".join((b"040000 tree " + tree(value) if isinstance(value, dict) else b"100644 blob " + blob)
                               + b"\t" + name.encode() + b"\0" for name, value in sorted(entries.items()))
            if payload not in cache:
                cache[payload] = self.git(self.path, "mktree", "-z", input_bytes=payload).strip()
            return cache[payload]
        return self.git(self.path, "commit-tree", tree(top).decode(), "-m", "budget fixture").decode().strip()

    def call(self, action, params, binding=None, operation=None):
        request = {"version": 1, "root": str(self.path), "action": action, "params": params}
        if binding is not None:
            request["binding"] = binding
        if action in WRITES:
            request["operationId"] = operation or str(uuid.uuid4())
        return self.workspace.dispatch(validate(request))["result"]

    def create(self):
        operation = str(uuid.uuid4())
        return self.call("worktree/create", {"ref": "HEAD"}, operation=operation)

    def read(self, created):
        return self.call("worktree/read", {"worktreeId": created["worktreeId"]}, created["binding"])

    def move(self, action, current):
        return self.call("worktree/" + action, {"worktreeId": current["worktreeId"], "expectedRevision": current["revision"], "confirm": True}, current["binding"])

    def test_create_is_detached_scoped_and_materializes_raw_blobs_without_filters_or_hooks(self):
        marker = self.native / "program-ran"
        hook = self.native / "hook.sh"
        hook.write_text('#!/bin/sh\nprintf ran > "' + str(marker) + '"\ncat\n')
        hook.chmod(0o700)
        self.git(self.path, "config", "filter.fixture.clean", str(hook))
        self.git(self.path, "config", "filter.fixture.smudge", str(hook))
        (self.path / ".gitattributes").write_text("file filter=fixture\n")
        # Add attributes without invoking filters for file, which is unchanged.
        self.git(self.path, "add", ".gitattributes")
        self.git(self.path, "commit", "-qm", "attributes")
        marker.unlink(missing_ok=True)
        (self.path / ".git/hooks/post-checkout").write_bytes(hook.read_bytes())
        (self.path / ".git/hooks/post-checkout").chmod(0o700)
        operation = str(uuid.uuid4())
        created = self.call("worktree/create", {"ref": "HEAD"}, operation=operation)
        self.assertEqual(created["worktreeId"], operation)
        self.assertEqual(created["path"], str(self.native / "worktrees" / operation))
        self.assertEqual(created["phase"], "active")
        self.assertEqual(Path(created["path"], "file").read_text(), "base\n")
        self.assertFalse(marker.exists())
        self.assertEqual(self.git(Path(created["path"]), "rev-parse", "HEAD").decode().strip(), created["head"])
        self.assertEqual(self.call("worktree/create", {"ref": "HEAD"}, operation=operation), created)

    def test_over_budget_commit_creates_no_checkout_retention_holder_or_git_registration(self):
        from deploy.workspace_worktrees import git
        before = self.git(self.path, "worktree", "list", "--porcelain")
        cases = [[f"d{index}/file" for index in range(MAX_TREE_ENTRIES // 2 + 1)],
                 ["/".join(["d"] * 33 + ["file"])]]
        for paths in cases:
            with self.subTest(files=len(paths)):
                head, operation = self.commit_paths(paths), str(uuid.uuid4())
                with patch("deploy.workspace_worktrees.git", wraps=git) as calls, \
                     patch("deploy.workspace_worktrees.materialize") as materialize, self.assertRaises(DeployError) as caught:
                    self.call("worktree/create", {"ref": head}, operation=operation)
                self.assertEqual(caught.exception.code, "budget")
                materialize.assert_not_called()
                self.assertFalse(any(call.args[1][:2] == ["worktree", "add"] for call in calls.call_args_list))
                self.assertFalse((self.native / "worktrees" / operation).exists())
                self.assertFalse((self.native / "worktree-state" / operation).exists())
                self.assertFalse((self.path / ".git/worktrees").exists())
                self.assertEqual(self.git(self.path, "worktree", "list", "--porcelain"), before)

    def test_exact_entry_and_depth_boundaries_create_readable_real_worktrees(self):
        cases = [[f"shared/nested/file{index}" for index in range(MAX_TREE_ENTRIES - 2)],
                 ["/".join(["d"] * 32 + ["file"])]]
        for paths in cases:
            with self.subTest(files=len(paths)):
                head = self.commit_paths(paths)
                created = self.call("worktree/create", {"ref": head})
                self.assertEqual(created["phase"], "active")
                self.assertEqual(self.read(created)["revision"], created["revision"])
                target = Path(created["path"])
                self.assertEqual(sum(1 for entry in target.rglob("*") if entry.name != ".git"),
                                 MAX_TREE_ENTRIES if len(paths) > 1 else 33)
                self.assertTrue((target / paths[-1]).is_file())

    def test_archive_restore_preserve_dirty_staged_untracked_and_ignored_bytes_and_index(self):
        created = self.create(); path = Path(created["path"])
        (path / "file").write_text("staged\n")
        self.git(path, "add", "file")
        (path / "file").write_text("dirty\n")
        (path / "untracked").write_text("untracked")
        (path / "keep.log").write_text("ignored remains")
        index = Path(created["binding"]["gitDir"], "index").read_bytes()
        current = self.read(created)
        archived = self.move("archive", current)
        self.assertEqual(archived["phase"], "archived")
        self.assertFalse(path.exists())
        self.assertEqual(Path(archived["path"], "keep.log").read_text(), "ignored remains")
        restored = self.move("restore", archived)
        self.assertEqual(restored["phase"], "active")
        self.assertEqual(Path(restored["path"], "file").read_text(), "dirty\n")
        self.assertEqual(Path(restored["path"], "untracked").read_text(), "untracked")
        self.assertEqual(Path(created["binding"]["gitDir"], "index").read_bytes(), index)
        self.assertEqual(restored["revision"], current["revision"])

    def test_attach_requires_prior_binding_and_matching_current_revision(self):
        created = self.create()
        params = {"worktreeId": created["worktreeId"], "expectedRevision": created["revision"]}
        attached = self.call("worktree/attach", params, created["binding"])
        self.assertTrue(attached["attached"])
        for changed in ({"worktreeInode": created["binding"]["worktreeInode"] + 1}, {"commonInode": created["binding"]["commonInode"] + 1}):
            with self.assertRaises(DeployError) as caught:
                self.call("worktree/attach", params, {**created["binding"], **changed})
            self.assertEqual(caught.exception.code, "worktree_unbound")
        (Path(created["path"]) / "new").write_text("changed")
        with self.assertRaises(DeployError) as caught:
            self.call("worktree/attach", params, created["binding"])
        self.assertEqual(caught.exception.code, "conflict")

    def test_user_lock_nested_repository_and_shared_directory_are_not_archived(self):
        created = self.create(); target = Path(created["path"])
        self.git(self.path, "worktree", "lock", "--reason", "shared checkout", str(target))
        with self.assertRaises(DeployError) as caught:
            self.move("archive", created)
        self.assertEqual(caught.exception.code, "worktree_shared")
        self.git(self.path, "worktree", "unlock", str(target))
        (target / "nested/.git").mkdir(parents=True)
        with self.assertRaises(DeployError) as caught:
            self.move("archive", created)
        self.assertEqual(caught.exception.code, "worktree_nested")
        (target / "nested/.git").rmdir(); (target / "nested").rmdir()
        target.chmod(0o770)
        with self.assertRaises(DeployError) as caught:
            self.move("archive", created)
        self.assertEqual(caught.exception.code, "worktree_shared")
        self.assertTrue((target / "file").exists())

    def test_interruption_after_archive_move_keeps_whole_tree_and_explicit_restore_repairs_backlink(self):
        created = self.create()
        from deploy.workspace_worktrees import git
        def fail(root, arguments, **kwargs):
            if arguments[:2] == ["worktree", "repair"]:
                raise DeployError("interrupted", "Fixture interruption after atomic move")
            return git(root, arguments, **kwargs)
        with patch("deploy.workspace_worktrees.git", side_effect=fail), self.assertRaises(DeployError):
            self.move("archive", created)
        current = self.read(created)
        self.assertEqual(current["phase"], "recovery")
        self.assertEqual(Path(current["path"], "file").read_text(), "base\n")
        restored = self.move("restore", current)
        self.assertEqual(restored["phase"], "active")

    def test_restore_never_overwrites_an_occupied_active_uuid_and_forged_journal_is_not_authority(self):
        created = self.create(); archived = self.move("archive", created)
        state = self.native / "worktree-state" / created["worktreeId"] / "state.json"
        state.write_text('{"path":"/unrelated","phase":"active"}')
        target = Path(created["path"]); target.mkdir(); (target / "keep").write_text("concurrent")
        with self.assertRaises(DeployError):
            self.move("restore", archived)
        self.assertEqual((target / "keep").read_text(), "concurrent")
        self.assertEqual(Path(archived["path"], "file").read_text(), "base\n")
        (target / "keep").unlink(); target.rmdir()
        self.assertEqual(self.move("restore", archived)["path"], created["path"])

    def test_create_failure_and_retention_budget_preserve_all_partial_material(self):
        operation = str(uuid.uuid4())
        with patch("deploy.workspace_worktrees.materialize", side_effect=DeployError("interrupted", "Fixture interrupted materialization")), self.assertRaises(DeployError):
            self.call("worktree/create", {"ref": "HEAD"}, operation=operation)
        self.assertTrue((self.native / "worktrees" / operation / ".git").is_file())
        self.assertTrue((self.native / "worktree-state" / operation / "state.json").is_file())
        with patch("deploy.workspace_worktrees.MAX_WORKTREES", 1), self.assertRaises(DeployError):
            self.create()
        self.assertEqual(len(list((self.native / "worktrees").iterdir())), 1)

    def test_unsupported_tracked_symlink_is_rejected_before_git_worktree_creation(self):
        (self.path / "link").symlink_to("file")
        self.git(self.path, "add", "link")
        self.git(self.path, "commit", "-qm", "unsupported link")
        with self.assertRaises(DeployError) as caught:
            self.create()
        self.assertEqual(caught.exception.code, "unsupported_path")
        self.assertEqual(list((self.native / "worktrees").iterdir()), [])
        self.assertFalse((self.path / ".git/worktrees").exists())


if __name__ == "__main__":
    unittest.main()
