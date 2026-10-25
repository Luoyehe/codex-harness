"""Commit the exact staged index with Git's prepared ref transaction and CAS."""
from __future__ import annotations

import os
import re
import stat
from pathlib import Path

from .common import DeployError, digest, require
from .workspace_git import git, repository_paths
from .workspace_git_view import INDEX_LIMIT, VIEW_LIMIT, content_view, directory
from .workspace_paths import read_file, revision, valid_revision

OID = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
FIELDS = {"expectedHead", "expectedHeadRevision", "expectedIndexRevision", "author", "message"}
UNRESOLVED = object()


def validate(params: dict) -> None:
    require(set(params) == FIELDS and (params["expectedHead"] is None or isinstance(params["expectedHead"], str) and OID.fullmatch(params["expectedHead"])), "Commit requires the selected HEAD and index versions")
    valid_revision(params["expectedHeadRevision"])
    valid_revision(params["expectedIndexRevision"])
    author = params["author"]
    require(isinstance(author, dict) and set(author) == {"name", "email"}, "Explicit commit author is required")
    for key, maximum in (("name", 256), ("email", 254)):
        value = author[key]
        require(isinstance(value, str) and value.strip() == value and 0 < len(value.encode()) <= maximum and
                not any(ord(char) < 32 or ord(char) == 127 or char in "<>" for char in value), "Invalid commit author")
    require(re.fullmatch(r"[^\s@]+@[^\s@]+", author["email"]) is not None, "Invalid commit author email")
    require(isinstance(params["message"], str) and bool(params["message"].strip()) and "\0" not in params["message"] and
            len(params["message"].encode()) <= 65536, "Commit message must be nonempty and bounded")


def file_data(parent, name, limit):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        return read_file(fd, limit)
    finally:
        os.close(fd)


def state(root, paths: list[Path], *, locked_head=UNRESOLVED) -> dict:
    metadata = directory(paths[0])
    try:
        head_bytes, head_info = file_data(metadata, "HEAD", 8192)
        text = head_bytes.decode("ascii", "strict").strip()
        symbolic = text[5:] if text.startswith("ref: ") else None
        if symbolic is not None:
            require(re.fullmatch(r"refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}", symbolic) is not None and
                    ".." not in symbolic and "//" not in symbolic and not symbolic.endswith(("/", ".", ".lock")),
                    "Unsupported symbolic HEAD", "git_unavailable")
        else:
            require(OID.fullmatch(text) is not None, "Invalid Git HEAD", "git_unavailable")
        # During a prepared ref transaction Git already holds the expected-old
        # CAS and HEAD/ref locks. Do not start another Git child in that phase:
        # the native subreaper cleanup intentionally supervises the whole tree.
        head = (git(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], allow_missing=True).decode().strip() or None) if locked_head is UNRESOLVED else locked_head
        require(head is None or OID.fullmatch(head), "Invalid resolved Git HEAD", "git_unavailable")
        require(head is not None or symbolic is not None, "Detached HEAD cannot be unborn", "git_unavailable")
        entries, total = [], 0
        with os.scandir(metadata) as listing:
            for entry in listing:
                if entry.name == "index" or re.fullmatch(r"sharedindex\.[0-9a-f]{40}(?:[0-9a-f]{24})?", entry.name):
                    require(len(entries) < 33, "Index snapshot exceeds entry budget", "budget")
                    data, info = file_data(metadata, entry.name, INDEX_LIMIT)
                    total += len(data)
                    require(total <= VIEW_LIMIT, "Index snapshot exceeds byte budget", "budget")
                    entries.append({"name": entry.name, "revision": revision(info, data)})
        require(file_data(metadata, "HEAD", 8192)[0] == head_bytes, "HEAD changed during read", "conflict")
        return {"head": head, "symbolicTarget": symbolic, "headRevision": revision(head_info, head_bytes),
                "indexRevision": digest(sorted(entries, key=lambda entry: entry["name"]))}
    finally:
        os.close(metadata)


def expected(current, params):
    require(current["head"] == params["expectedHead"] and current["headRevision"] == params["expectedHeadRevision"] and
            current["indexRevision"] == params["expectedIndexRevision"], "HEAD or staged index changed; refresh before committing", "conflict")


def safe_metadata(metadata, common, *, allow_in_progress=False):
    def owned(fd):
        info = os.fstat(fd)
        require(info.st_uid == os.geteuid() and not info.st_mode & 0o022, "Git write directory is shared or not native-owned", "unsafe_path")
    owned(metadata)
    owned(common)
    for name in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer"):
        if allow_in_progress: break
        try: os.stat(name, dir_fd=metadata, follow_symlinks=False)
        except FileNotFoundError: continue
        require(False, "Finish the current Git operation before committing", "git_in_progress")
    count = 0
    def walk(parent, name, depth=0):
        nonlocal count
        count += 1
        require(count <= 4096 and depth <= 32, "Git write metadata exceeds scan budget", "budget")
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        require(info.st_uid == os.geteuid() and not info.st_mode & 0o022, "Git write metadata is shared or not native-owned", "unsafe_path")
        if stat.S_ISDIR(info.st_mode):
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                owned(fd)
                with os.scandir(fd) as children:
                    for child in children: walk(fd, child.name, depth + 1)
            finally: os.close(fd)
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "Unsafe Git write metadata file", "unsafe_path")
    for parent, names in ((common, ("refs", "logs", "packed-refs", "config", "reftable")), (metadata, ("logs",)) if metadata != common else (metadata, ())):
        for name in names:
            try: walk(parent, name)
            except FileNotFoundError: pass
    objects = os.open("objects", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=common)
    try:
        owned(objects)
        with os.scandir(objects) as entries:
            for index, entry in enumerate(entries):
                require(index < 260, "Git object directory exceeds budget", "budget")
                # All object write prefixes are existing real directories. Pack
                # and info are read-only to these plumbing commands.
                require(re.fullmatch(r"[0-9a-f]{2}|info|pack", entry.name), "Unexpected Git object entry", "unsafe_path")
                child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=objects)
                try: owned(child)
                finally: os.close(child)
    finally: os.close(objects)


class IndexLease:
    def __init__(self, metadata, identity):
        self.metadata, self.safe, self.fd = metadata, True, None
        self.token = ("harness-commit:" + identity + "\n").encode()
        self.fd = os.open("index.lock", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=metadata)
        os.write(self.fd, self.token)
        os.fsync(self.fd)
        os.fsync(metadata)

    def verify(self):
        data, info = file_data(self.metadata, "index.lock", 256)
        actual = os.fstat(self.fd)
        require(data == self.token and (actual.st_dev, actual.st_ino) == (info.st_dev, info.st_ino), "Commit index lock ownership changed", "cleanup_unknown")

    def close(self):
        try:
            require(self.safe, "Git shutdown is unknown; index lock retained for inspection", "cleanup_unknown")
            self.verify()
            os.unlink("index.lock", dir_fd=self.metadata)
            os.fsync(self.metadata)
        finally:
            os.close(self.fd)


def publish(root, paths, new, current, params, lease, record, environment, request_digest):
    from .workspace_git_transaction import prepared_refs
    with prepared_refs(root, paths, current, lease, environment, new_commit=new):
        expected(state(root, paths, locked_head=current["head"]), params)
        lease.verify()
        record.save({"state": "running", "commitCandidate": new, "previousHead": current["head"],
                     "requestDigest": request_digest})


def run(workspace, params, record, request_digest):
    validate(params)
    root = workspace.root
    paths = repository_paths(root, workspace.forbidden)
    metadata, common = directory(paths[0]), directory(paths[1])
    lease = None
    try:
        safe_metadata(metadata, common)
        lease = IndexLease(metadata, record.identity)
        current = state(root, paths)
        expected(current, params)
        author = params["author"]
        identity = {"GIT_AUTHOR_NAME": author["name"], "GIT_AUTHOR_EMAIL": author["email"],
                    "GIT_COMMITTER_NAME": author["name"], "GIT_COMMITTER_EMAIL": author["email"]}
        with content_view(root, *paths) as (environment, descriptors):
            tree = git(root, ["write-tree"], environment=environment, descriptors=descriptors).decode().strip()
            require(OID.fullmatch(tree), "Invalid staged tree", "git_unavailable")
            previous_tree = git(root, ["rev-parse", "HEAD^{tree}"], environment=environment, descriptors=descriptors).decode().strip() if current["head"] else None
            if previous_tree is None:
                require(bool(git(root, ["ls-tree", tree], environment=environment, descriptors=descriptors)), "There are no staged changes", "empty_commit")
            else:
                require(tree != previous_tree, "There are no staged changes", "empty_commit")
            new = git(root, ["-c", "commit.gpgSign=false", "commit-tree", tree, *(["-p", current["head"]] if current["head"] else []), "-F", "-"],
                      environment={**environment, **identity}, descriptors=descriptors, input_bytes=params["message"].encode()).decode().strip()
            require(OID.fullmatch(new), "Invalid created commit", "git_unavailable")
        expected(state(root, paths), params)
        record.failure_details = {"commitCandidate": new, "previousHead": current["head"]}
        publish(root, paths, new, current, params, lease, record, identity, request_digest)
        final = state(root, paths)
        require(final["head"] == new and final["symbolicTarget"] == current["symbolicTarget"] and final["indexRevision"] == current["indexRevision"],
                "Git changed after publication; inspect the original operation", "conflict")
        return {"commitId": new, "previousHead": current["head"], "indexRevision": current["indexRevision"], "recoveryOperationId": record.identity}
    finally:
        try:
            if lease is not None: lease.close()
        finally:
            os.close(metadata)
            os.close(common)
