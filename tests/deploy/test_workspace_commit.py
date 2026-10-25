"""Real local Git commits, native index locks and prepared ref transactions."""
import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError
from deploy.workspace import Workspace, WRITES, validate
from deploy.workspace_commit import validate as validate_commit
from deploy.workspace_git import GIT_ENV
from deploy.workspace_paths import Root


class CommitValidationTests(unittest.TestCase):
    def params(self):
        return {"expectedHead": "a" * 40, "expectedHeadRevision": "b" * 64, "expectedIndexRevision": "c" * 64,
                "author": {"name": "Fixture", "email": "fixture@example.invalid"}, "message": "Staged change"}

    def test_explicit_head_index_author_and_message_are_required(self):
        validate_commit(self.params())
        validate_commit({**self.params(), "expectedHead": None})
        for changed in ({"expectedHead": "HEAD"}, {"expectedHeadRevision": "bad"}, {"expectedIndexRevision": None},
                        {"author": {"name": "a\nb", "email": "f@example.invalid"}}, {"author": {"name": "a", "email": "not-email"}},
                        {"message": " "}, {"message": "nul\0text"}, {"message": "x" * 65537}, {"hooks": True}):
            with self.subTest(changed=changed), self.assertRaises(DeployError):
                validate_commit({**self.params(), **changed})

    def test_commit_is_a_durable_mutation_without_arbitrary_git_arguments(self):
        request = {"version": 1, "root": "/project", "action": "git/commit", "params": self.params(), "operationId": str(uuid.uuid4())}
        validate(request)
        for changed in ({"operationId": None}, {"params": {**self.params(), "args": ["--amend"]}}, {"binding": {}}):
            with self.assertRaises(DeployError): validate({**request, **changed})


@unittest.skipUnless(os.name == "posix", "Requires Linux descriptors and Git ref transactions")
class CommitFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="workspace-commit-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.path = self.base / "project"
        self.native = self.base / "native"
        self.path.mkdir(); self.native.mkdir()
        self.root = Root(str(self.path), [])
        self.addCleanup(self.root.close)
        self.workspace = Workspace(self.root, [], self.native / "workspace-state")
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (self.path / "file").write_text("base\n")
        self.git("add", "file")
        self.git("commit", "-qm", "initial")

    def git(self, *args, data=None):
        return subprocess.run(["/usr/bin/git", *args], cwd=self.path, env=GIT_ENV, input=data, check=True, capture_output=True, timeout=10).stdout

    def call(self, action, params=None, operation=None):
        request = {"version": 1, "root": str(self.path), "action": action, "params": params or {}}
        if action in WRITES: request["operationId"] = operation or str(uuid.uuid4())
        return self.workspace.dispatch(validate(request))

    def params(self):
        current = self.call("git/status")["result"]["commitState"]
        return {"expectedHead": current["head"], "expectedHeadRevision": current["headRevision"], "expectedIndexRevision": current["indexRevision"],
                "author": {"name": "Explicit Author", "email": "explicit@example.invalid"}, "message": "Exact staged commit\n\nBody text\n"}

    def stage(self, text="staged\n"):
        (self.path / "file").write_text(text)
        self.git("add", "file")

    def test_commit_only_staged_bytes_preserves_original_index_and_replays_once(self):
        self.stage()
        params, operation = self.params(), str(uuid.uuid4())
        (self.path / "file").write_text("unstaged\n")
        index = (self.path / ".git/index").read_bytes()
        response = self.call("git/commit", params, operation)
        result = response["result"]
        self.assertEqual(result["commitId"], self.git("rev-parse", "HEAD").decode().strip())
        self.assertEqual(self.git("show", "HEAD:file"), b"staged\n")
        self.assertEqual((self.path / "file").read_text(), "unstaged\n")
        self.assertEqual((self.path / ".git/index").read_bytes(), index)
        self.assertEqual(self.git("show", "-s", "--format=%an <%ae>").strip(), b"Explicit Author <explicit@example.invalid>")
        self.assertEqual(self.call("git/commit", params, operation), response)
        self.assertFalse((self.path / ".git/index.lock").exists())

    def test_callbacks_signing_and_filters_do_not_execute(self):
        self.stage()
        marker = self.native / "callback-ran"
        program = self.native / "callback"
        program.write_text('#!/bin/sh\nprintf ran > "' + str(marker) + '"\ncat\n')
        program.chmod(0o700)
        for key in ("filter.fixture.clean", "filter.fixture.smudge", "gpg.program"):
            self.git("config", key, str(program))
        self.git("config", "commit.gpgSign", "true")
        (self.path / ".gitattributes").write_text("file filter=fixture\n")
        for hook in ("pre-commit", "commit-msg", "post-commit", "reference-transaction"):
            target = self.path / ".git/hooks" / hook
            target.write_bytes(program.read_bytes()); target.chmod(0o700)
        self.call("git/commit", self.params())
        self.assertFalse(marker.exists())
        self.assertNotIn(b"gpgsig", self.git("cat-file", "-p", "HEAD"))

    def test_unborn_and_detached_heads_commit_without_changing_mode(self):
        self.git("checkout", "--detach", "-q")
        self.stage("detached\n")
        self.call("git/commit", self.params())
        self.assertFalse((self.path / ".git/HEAD").read_text().startswith("ref:"))
        self.git("symbolic-ref", "HEAD", "refs/heads/unborn")
        params = self.params()
        self.assertIsNone(params["expectedHead"])
        self.call("git/commit", params)
        self.assertEqual((self.path / ".git/HEAD").read_text(), "ref: refs/heads/unborn\n")
        self.assertEqual(self.git("rev-list", "--count", "HEAD").strip(), b"1")

    def test_head_and_index_version_conflicts_do_not_publish_or_overwrite(self):
        self.stage()
        params = self.params()
        self.stage("newer staged\n")
        index, head = (self.path / ".git/index").read_bytes(), self.git("rev-parse", "HEAD")
        with self.assertRaises(DeployError): self.call("git/commit", params)
        self.assertEqual((self.path / ".git/index").read_bytes(), index)
        self.assertEqual(self.git("rev-parse", "HEAD"), head)
        params = self.params()
        self.git("commit", "-qm", "external")
        newer = self.git("rev-parse", "HEAD")
        with self.assertRaises(DeployError): self.call("git/commit", params)
        self.assertEqual(self.git("rev-parse", "HEAD"), newer)

    def test_empty_in_progress_and_unmerged_indexes_are_rejected(self):
        with self.assertRaises(DeployError): self.call("git/commit", self.params())
        self.stage()
        params = self.params()
        marker = self.path / ".git/MERGE_HEAD"
        marker.write_bytes(self.git("rev-parse", "HEAD"))
        with self.assertRaises(DeployError): self.call("git/commit", params)
        marker.unlink()
        oid = self.git("rev-parse", "HEAD:file").strip()
        self.git("update-index", "--index-info", data=b"0 " + b"0" * 40 + b"\tfile\n100644 " + oid + b" 1\tfile\n100644 " + oid + b" 2\tfile\n")
        with self.assertRaises(DeployError): self.call("git/commit", self.params())

    def test_foreign_index_lock_and_symlinked_refs_are_not_modified(self):
        self.stage()
        params = self.params()
        lock = self.path / ".git/index.lock"
        lock.write_bytes(b"foreign operation")
        with self.assertRaises((OSError, DeployError)): self.call("git/commit", params)
        self.assertEqual(lock.read_bytes(), b"foreign operation")
        lock.unlink()
        refs = self.path / ".git/refs/heads"
        outside = self.base / "outside-heads"
        refs.rename(outside)
        refs.symlink_to(outside, target_is_directory=True)
        before = {entry.name: entry.read_bytes() for entry in outside.iterdir()}
        with self.assertRaises((OSError, DeployError)): self.call("git/commit", params)
        self.assertEqual({entry.name: entry.read_bytes() for entry in outside.iterdir()}, before)

    def test_prepared_transaction_rechecks_index_and_aborts_without_overwriting_external_change(self):
        import deploy.workspace_commit as commits
        self.stage()
        params, operation = self.params(), str(uuid.uuid4())
        head = self.git("rev-parse", "HEAD")
        original, count = commits.expected, 0
        def race(current, selected):
            nonlocal count
            count += 1
            if count == 3:
                (self.path / ".git/index").write_bytes(b"external replacement")
                current = {**current, "indexRevision": "0" * 64}
            return original(current, selected)
        with patch.object(commits, "expected", side_effect=race), self.assertRaises(DeployError):
            self.call("git/commit", params, operation)
        self.assertEqual(self.git("rev-parse", "HEAD"), head)
        self.assertEqual((self.path / ".git/index").read_bytes(), b"external replacement")
        self.assertFalse((self.path / ".git/index.lock").exists())
        self.assertFalse((self.path / ".git/HEAD.lock").exists())
        self.assertEqual(self.call("operation/read", {"operationId": operation})["result"]["state"], "failed")

    def test_lost_publication_result_stays_unknown_with_candidate_and_no_resend(self):
        import deploy.workspace_commit as commits
        self.stage()
        params, operation = self.params(), str(uuid.uuid4())
        original = commits.publish
        def lost(*args):
            # No query may create a second child while update-ref owns locks.
            with patch.object(commits, "git", side_effect=AssertionError("sibling Git child during prepared transaction")):
                original(*args)
            raise RuntimeError("lost result")
        with patch.object(commits, "publish", side_effect=lost), self.assertRaises(DeployError): self.call("git/commit", params, operation)
        head = self.git("rev-parse", "HEAD").decode().strip()
        saved = self.call("operation/read", {"operationId": operation})["result"]
        self.assertEqual(saved["commitCandidate"], head)
        self.assertEqual(saved["state"], "failed")
        self.assertEqual(self.call("git/commit", params, operation)["error"]["delivery"], "unknown")
        self.assertEqual(self.git("rev-parse", "HEAD").decode().strip(), head)

    def test_unknown_shutdown_retains_owned_lock_and_lock_replacement_is_never_unlinked(self):
        import deploy.workspace_commit as commits
        self.stage()
        params = self.params()
        def unknown(root, paths, new, current, selected, lease, *args):
            lease.safe = False
            raise DeployError("cleanup_unknown", "fixture uncertain shutdown")
        with patch.object(commits, "publish", side_effect=unknown), self.assertRaises(DeployError): self.call("git/commit", params)
        lock = self.path / ".git/index.lock"
        self.assertTrue(lock.read_bytes().startswith(b"harness-commit:"))
        lock.unlink()
        def replace(root, paths, new, current, selected, lease, *args):
            lock.unlink(); lock.write_bytes(b"foreign replacement")
            raise RuntimeError("lost ownership")
        with patch.object(commits, "publish", side_effect=replace), self.assertRaises(DeployError): self.call("git/commit", params)
        self.assertEqual(lock.read_bytes(), b"foreign replacement")

    def test_query_refuses_existing_child_without_reaping_or_starting_a_sibling(self):
        from deploy.workspace_git import git
        child = subprocess.Popen(["/usr/bin/sleep", "30"], start_new_session=True)
        try:
            with self.assertRaises(DeployError) as caught:
                git(self.root, ["rev-parse", "HEAD"])
            self.assertEqual(caught.exception.code, "busy")
            self.assertIsNone(child.poll())
        finally:
            child.terminate()
            child.wait(timeout=5)
