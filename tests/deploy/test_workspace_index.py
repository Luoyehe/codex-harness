"""Explicit staging, Git HEAD/index fences and retained index recovery."""
import json
import os
import subprocess
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError
from deploy.workspace import Workspace, WRITES, blocked_paths, validate
from deploy.workspace_index import validate as validate_index
from deploy.workspace_index_store import IndexStore
from deploy.workspace_git import GIT_ENV
from deploy.workspace_paths import Root


class IndexValidationTests(unittest.TestCase):
    def versions(self): return {"expectedHead": None, "expectedHeadRevision": "a" * 64, "expectedIndexRevision": "b" * 64}

    def test_stage_is_an_explicit_bounded_versioned_file_selection(self):
        item = {"path": "file", "expectedRevision": "c" * 64, "deleted": False}
        validate_index("git/stage", {**self.versions(), "files": [item]})
        for choices in ([], [item] * 33, [item, item], [{**item, "path": "../outside"}], [{**item, "path": ".git/index"}], [{**item, "deleted": True}], [{"path": "file", "deleted": False}]):
            with self.assertRaises(DeployError): validate_index("git/stage", {**self.versions(), "files": choices})
        validate_index("git/stage", {**self.versions(), "files": [{"path": "gone", "expectedRevision": None, "deleted": True}]})

    def test_unstage_and_recovery_cannot_select_commands_roots_or_unversioned_snapshots(self):
        validate_index("git/unstage", {**self.versions(), "paths": ["file"]})
        source = str(uuid.uuid4())
        valid = {**self.versions(), "recoveryOperationId": source, "slot": "before", "sourceRevision": "c" * 64}
        validate_index("git/index/recovery/restore", valid)
        for changed in ({"slot": "../../outside"}, {"sourceRevision": None}, {"root": "/"}, {"expectedHead": "HEAD"}):
            with self.assertRaises(DeployError): validate_index("git/index/recovery/restore", {**valid, **changed})
        with self.assertRaises(DeployError): validate_index("git/index/recovery/discard", {"recoveryOperationId": source, "expectedManifest": "a" * 64, "confirm": False})


@unittest.skipUnless(os.name == "posix", "Requires native Linux Git and descriptor transactions")
class IndexFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="workspace-index-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.native = self.base / "native"
        self.native.mkdir()
        self.repository("project")

    def repository(self, name, algorithm="sha1", initial=True):
        self.path = self.base / name
        self.path.mkdir()
        root = Root(str(self.path), [])
        self.addCleanup(root.close)
        self.workspace = Workspace(root, [self.native / "git-index-state"], self.native / "workspace-state")
        self.git("init", "-q", "--object-format=" + algorithm)
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        if initial:
            (self.path / "a").write_text("base a\n")
            (self.path / "b").write_text("base b\n")
            self.git("add", "a", "b")
            self.git("commit", "-qm", "initial")

    def git(self, *args, data=None, check=True):
        result = subprocess.run(["/usr/bin/git", *args], cwd=self.path, env=GIT_ENV, input=data, check=check, capture_output=True, timeout=10)
        return result.stdout if check else result

    def call(self, action, params=None, operation=None):
        request = {"version": 1, "root": str(self.path), "action": action, "params": params or {}}
        if action in WRITES: request["operationId"] = operation or str(uuid.uuid4())
        return self.workspace.dispatch(validate(request))

    def versions(self):
        current = self.call("git/status")["result"]["commitState"]
        return {"expectedHead": current["head"], "expectedHeadRevision": current["headRevision"], "expectedIndexRevision": current["indexRevision"]}

    def selected(self, name, deleted=False):
        return {"path": name, "deleted": deleted, "expectedRevision": None if deleted else self.call("metadata", {"path": name})["result"]["revision"]}

    def stage(self, names, operation=None):
        return self.call("git/stage", {**self.versions(), "files": [self.selected(name) for name in names]}, operation)["result"]

    def backup(self, operation): return self.call("git/index/recovery/read", {"operationId": operation})["result"]

    def restore(self, source, slot="before"):
        snapshot = self.backup(source)
        chosen = next(entry for entry in snapshot["entries"] if entry["slot"] == slot)
        return self.call("git/index/recovery/restore", {**self.versions(), "recoveryOperationId": source, "slot": slot, "sourceRevision": chosen["revision"]})["result"]

    def test_stage_unstage_and_commit_only_selected_paths_preserve_worktree_and_other_index_entries(self):
        (self.path / "a").write_text("changed a\n")
        (self.path / "b").write_text("changed b\n")
        self.git("add", "b")
        result = self.stage(["a"])
        self.assertEqual(self.git("show", ":a"), b"changed a\n")
        self.assertEqual(self.git("show", ":b"), b"changed b\n")
        unstaged = self.call("git/unstage", {**self.versions(), "paths": ["a"]})["result"]
        self.assertEqual(self.git("show", ":a"), b"base a\n")
        self.assertEqual(self.git("show", ":b"), b"changed b\n")
        self.assertEqual((self.path / "a").read_text(), "changed a\n")
        self.assertEqual(result["selectedCount"], 1)
        self.assertNotEqual(result["indexRevision"], unstaged["indexRevision"])
        self.call("git/commit", {**self.versions(), "author": {"name": "Fixture", "email": "fixture@example.invalid"}, "message": "staged b"})
        self.assertEqual(self.git("show", "HEAD:a"), b"base a\n")
        self.assertEqual(self.git("show", "HEAD:b"), b"changed b\n")

    def test_raw_staging_never_runs_filters_hooks_or_signing_and_binds_file_mode(self):
        target = self.path / "a"
        target.write_bytes(b"\0\xffraw data")
        marker = self.native / "program-ran"
        script = self.native / "callback"
        script.write_text('#!/bin/sh\nprintf ran > "' + str(marker) + '"\ncat\n'); script.chmod(0o700)
        for key in ("filter.fixture.clean", "filter.fixture.smudge", "gpg.program"): self.git("config", key, str(script))
        (self.path / ".gitattributes").write_text("a filter=fixture\n")
        hook = self.path / ".git/hooks/reference-transaction"
        hook.write_bytes(script.read_bytes()); hook.chmod(0o700)
        selected = self.selected("a")
        target.chmod(0o755)
        with self.assertRaises(DeployError): self.call("git/stage", {**self.versions(), "files": [selected]})
        self.stage(["a"])
        self.assertFalse(marker.exists())
        self.assertEqual(self.git("show", ":a"), b"\0\xffraw data")
        self.assertTrue(self.git("ls-files", "--stage", "a").startswith(b"100755 "))

    def test_deletions_are_explicit_and_symlink_hardlink_directory_selections_fail(self):
        params = {**self.versions(), "files": [self.selected("a", deleted=True)]}
        with self.assertRaises(DeployError): self.call("git/stage", params)
        (self.path / "a").unlink()
        self.call("git/stage", params)
        self.assertEqual(self.git("ls-files", "a"), b"")
        for kind in ("link", "hard", "directory"):
            target = self.path / kind
            if kind == "link": target.symlink_to(self.path / "b")
            elif kind == "hard": os.link(self.path / "b", target)
            else: target.mkdir()
            with self.assertRaises((OSError, DeployError)):
                self.call("git/stage", {**self.versions(), "files": [{"path": kind, "expectedRevision": "a" * 64, "deleted": False}]})
            target.rmdir() if kind == "directory" else target.unlink()

    def test_unborn_sha1_sha256_and_absent_original_index_restore(self):
        for algorithm in ("sha1", "sha256"):
            self.repository("unborn-" + algorithm, algorithm, initial=False)
            (self.path / "new").write_text("new file")
            result = self.stage(["new"])
            self.assertEqual(self.git("show", ":new"), b"new file")
            self.restore(result["recoveryOperationId"])
            self.assertFalse((self.path / ".git/index").exists())
            self.assertIsNone(self.versions()["expectedHead"])

    def test_stale_head_index_and_file_versions_never_publish(self):
        (self.path / "a").write_text("changed")
        params = {**self.versions(), "files": [self.selected("a")]}
        self.git("add", "b")
        before = (self.path / ".git/index").read_bytes()
        # Git may preserve a no-op index exactly; explicitly replace its inode.
        copy = self.path / ".git/replacement"
        copy.write_bytes(before); os.replace(copy, self.path / ".git/index")
        with self.assertRaises(DeployError): self.call("git/stage", params)
        self.assertEqual((self.path / ".git/index").read_bytes(), before)
        params = {**self.versions(), "files": [self.selected("a")]}
        (self.path / "a").write_text("later")
        with self.assertRaises(DeployError): self.call("git/stage", params)
        self.assertEqual(self.git("show", ":a"), b"base a\n")

    def test_prepared_fence_blocks_real_head_changes_and_git_add_before_index_publication(self):
        import deploy.workspace_index as index
        (self.path / "a").write_text("changed")
        original, attempted = index.capture_index, []
        def during(*args):
            attempted.append(self.git("symbolic-ref", "HEAD", "refs/heads/other", check=False).returncode)
            attempted.append(self.git("add", "a", check=False).returncode)
            return original(*args)
        with patch.object(index, "capture_index", side_effect=during): self.stage(["a"])
        self.assertEqual(len(attempted), 2)
        self.assertTrue(all(code != 0 for code in attempted))
        self.assertFalse((self.path / ".git/HEAD.lock").exists())
        self.assertFalse((self.path / ".git/index.lock").exists())

    def test_file_change_inside_prepared_fence_aborts_without_index_change(self):
        import deploy.workspace_index as index
        (self.path / "a").write_text("selected")
        original = index.prepared_refs
        before = (self.path / ".git/index").read_bytes()
        @contextmanager
        def race(*args, **kwargs):
            with original(*args, **kwargs):
                (self.path / "a").write_text("external change")
                yield
        with patch.object(index, "prepared_refs", race), self.assertRaises(DeployError): self.stage(["a"])
        self.assertEqual((self.path / ".git/index").read_bytes(), before)
        self.assertEqual((self.path / "a").read_text(), "external change")

    def test_publish_collision_preserves_old_external_and_candidate_indexes_and_explicit_restore(self):
        import deploy.workspace_index as index
        (self.path / "b").write_text("external staged")
        self.git("add", "b")
        external = (self.path / ".git/index").read_bytes()
        self.git("reset", "-q", "HEAD", "--", "b")
        (self.path / "a").write_text("selected")
        operation, original = str(uuid.uuid4()), index.rename_absent
        def race(source, name, target, destination):
            if name == "next": (self.path / ".git/index").write_bytes(external)
            return original(source, name, target, destination)
        with patch.object(index, "rename_absent", side_effect=race), self.assertRaises(DeployError): self.stage(["a"], operation)
        self.assertEqual((self.path / ".git/index").read_bytes(), external)
        backup = self.backup(operation)
        self.assertEqual({entry["slot"] for entry in backup["entries"]}, {"before", "captured", "next"})
        self.assertEqual(backup["state"], "failed")
        self.restore(operation)
        self.assertEqual(self.git("show", ":b"), b"base b\n")
        self.assertEqual((self.path / "a").read_text(), "selected")

    def test_split_index_snapshot_survives_original_shared_index_removal(self):
        self.git("update-index", "--split-index")
        before = self.git("ls-files", "--stage", "-z")
        (self.path / "a").write_text("selected")
        result = self.stage(["a"])
        for file in (self.path / ".git").glob("sharedindex.*"): file.unlink()
        self.restore(result["recoveryOperationId"])
        self.assertEqual(self.git("ls-files", "--stage", "-z"), before)

    def test_recovery_revision_conflicts_and_record_paths_cannot_redirect_index_restore(self):
        (self.path / "a").write_text("selected")
        result = self.stage(["a"])
        source = result["recoveryOperationId"]
        store = IndexStore(self.workspace)
        directory = store.store.storage / store.store.project / source
        record = json.loads((directory / "state.json").read_text())
        record["target"] = str(self.base / "outside")
        (directory / "state.json").write_text(json.dumps(record))
        before = (self.path / ".git/index").read_bytes()
        with self.assertRaises(DeployError):
            self.call("git/index/recovery/restore", {**self.versions(), "recoveryOperationId": source, "slot": "before", "sourceRevision": "0" * 64})
        self.assertEqual((self.path / ".git/index").read_bytes(), before)
        self.restore(source)
        self.assertFalse((self.base / "outside").exists())

    def test_discard_requires_completed_current_manifest_and_frees_retention_slot(self):
        import deploy.workspace_index_store as stores
        (self.path / "a").write_text("first")
        first = self.stage(["a"])["recoveryOperationId"]
        (self.path / "a").write_text("second")
        with patch.object(stores, "MAX_RECORDS", 2):
            self.stage(["a"])
            (self.path / "a").write_text("third")
            with self.assertRaises(DeployError): self.stage(["a"])
            with self.assertRaises(DeployError): self.call("git/index/recovery/discard", {"recoveryOperationId": first, "expectedManifest": "0" * 64, "confirm": True})
            current = self.backup(first)
            self.call("git/index/recovery/discard", {"recoveryOperationId": first, "expectedManifest": current["manifest"], "confirm": True})
            self.assertEqual(len(self.call("git/index/recovery/list")["result"]["records"]), 1)
            self.stage(["a"])
        self.assertEqual(self.call("operation/read", {"operationId": first})["result"]["state"], "completed")

    def test_replayed_stage_does_not_apply_again_or_recreate_discarded_material(self):
        (self.path / "a").write_text("selected")
        operation = str(uuid.uuid4())
        params = {**self.versions(), "files": [self.selected("a")]}
        result = self.call("git/stage", params, operation)
        before = (self.path / ".git/index").read_bytes()
        self.assertEqual(self.call("git/stage", params, operation), result)
        self.assertEqual((self.path / ".git/index").read_bytes(), before)
        current = self.backup(operation)
        self.call("git/index/recovery/discard", {"recoveryOperationId": operation, "expectedManifest": current["manifest"], "confirm": True})
        self.assertEqual(self.call("git/stage", params, operation), result)
        self.assertEqual(self.call("git/index/recovery/list")["result"]["records"], [])

    def test_foreign_primary_git_pointer_cannot_authorize_status_stage_or_commit(self):
        foreign = self.path
        expected_head = self.git("rev-parse", "HEAD")
        expected_index = (foreign / ".git/index").read_bytes()
        selected = self.base / "selected"
        selected.mkdir()
        (selected / ".git").write_text("gitdir: " + str(foreign / ".git") + "\n")
        (selected / "a").write_text("selected content")
        root = Root(str(selected), [])
        self.addCleanup(root.close)
        self.workspace = Workspace(root, [], self.native / "workspace-state")
        self.path = selected
        with self.assertRaises(DeployError) as caught: self.call("git/status")
        self.assertEqual(caught.exception.code, "git_scope")
        versions = {"expectedHead": expected_head.decode().strip(), "expectedHeadRevision": "a" * 64, "expectedIndexRevision": "b" * 64}
        with self.assertRaises(DeployError): self.call("git/stage", {**versions, "files": [self.selected("a")]})
        with self.assertRaises(DeployError): self.call("git/commit", {**versions, "author": {"name": "Fixture", "email": "fixture@example.invalid"}, "message": "wrong scope"})
        self.path = foreign
        self.assertEqual(self.git("rev-parse", "HEAD"), expected_head)
        self.assertEqual((foreign / ".git/index").read_bytes(), expected_index)

    def test_real_linked_worktree_backlinks_allow_scoped_stage_and_commit(self):
        target = self.base / "linked"
        original_head = self.git("rev-parse", "HEAD")
        original_index = (self.path / ".git/index").read_bytes()
        self.git("worktree", "add", "--detach", "-q", str(target), "HEAD")
        original = self.path
        self.path = target
        root = Root(str(target), [])
        self.addCleanup(root.close)
        self.workspace = Workspace(root, [], self.native / "workspace-state")
        (target / "a").write_text("linked changed")
        self.stage(["a"])
        self.call("git/commit", {**self.versions(), "author": {"name": "Fixture", "email": "fixture@example.invalid"}, "message": "linked"})
        self.assertEqual(self.git("show", "HEAD:a"), b"linked changed")
        self.path = original
        self.assertEqual(self.git("rev-parse", "HEAD"), original_head)
        self.assertEqual((original / ".git/index").read_bytes(), original_index)
