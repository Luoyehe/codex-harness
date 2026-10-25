"""Read-only Git queries with fixed argv and bounded process output."""
from __future__ import annotations

import os
import selectors
import stat
import subprocess
import tempfile
import time
from pathlib import Path

from .common import DeployError, require
from .workspace_paths import Root, read_file

MAX_GIT_OUTPUT = 512 * 1024
GIT_PREFIX = ["/usr/bin/git", "--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
              "-c", "core.untrackedCache=false", "-c", "core.pager=cat", "-c", "core.attributesFile=/dev/null", "-c", "submodule.recurse=false",
              "-c", "protocol.allow=never"]
GIT_ENV = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "XDG_CONFIG_HOME": "/nonexistent", "LANG": "C.UTF-8",
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_CONFIG_GLOBAL": "/dev/null",
           "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0", "GIT_PAGER": "cat"}


def query_args(action: str, params: dict) -> list[str]:
    if action == "git/status":
        require(not params, "Git status takes no parameters")
        return ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"]
    if action == "git/diff":
        require(set(params) <= {"staged"} and type(params.get("staged", False)) is bool, "Invalid Git diff parameters")
        return ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-color", "--src-prefix=a/", "--dst-prefix=b/",
                *(["--cached"] if params.get("staged") else []), "--", ".", ":(exclude).harness-workspace"]
    require(action == "git/refs" and not params, "Unsupported Git query")
    return ["for-each-ref", "--count=1001", "--format=%(refname)%00%(objectname)%00%(symref)", "refs/heads/", "refs/remotes/", "refs/tags/"]


def git(root: Root, arguments: list[str], *, environment: dict[str, str] | None = None,
        descriptors: tuple[int, ...] = (), allow_missing: bool = False, input_bytes: bytes | None = None,
        output_limit: int = MAX_GIT_OUTPUT, seconds: int = 10, input_limit: int = 1024 * 1024) -> bytes:
    require(0 < output_limit <= 256 * 1024 * 1024 and 0 < seconds <= 60 and 0 < input_limit <= 8 * 1024 * 1024, "Invalid internal Git budget")
    from .native_launcher import clean_children, direct_children
    # Cleanup owns this helper's entire native descendant tree, including
    # detached descendants. A one-shot query must never run beside another
    # executor (for example a prepared ref transaction) and reap its children.
    require(not direct_children(), "Git query requires exclusive helper child ownership", "busy")
    source = None
    if input_bytes is not None:
        require(len(input_bytes) <= input_limit, "Git input exceeds byte budget", "budget")
        source = tempfile.TemporaryFile()
        source.write(input_bytes)
        source.seek(0)
    # Holding/passing the directory fd binds cwd even if its display path moves.
    try:
        child = subprocess.Popen([*GIT_PREFIX, *arguments], cwd=f"/proc/self/fd/{root.fd}", env={**GIT_ENV, **(environment or {})},
                                 stdin=source if source is not None else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 close_fds=True, pass_fds=(root.fd, *descriptors), start_new_session=True)
    except BaseException:
        if source is not None:
            source.close()
        raise
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ, "out")
    selector.register(child.stderr, selectors.EVENT_READ, "err")
    output, total = bytearray(), 0
    deadline = time.monotonic() + seconds
    try:
        while selector.get_map():
            require(time.monotonic() < deadline, "Git query exceeded its time budget", "timeout")
            for key, _ in selector.select(0.1):
                data = os.read(key.fd, 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                total += len(data)
                require(total <= output_limit, "Git query exceeds output budget; narrow the repository view", "budget")
                if key.data == "out":
                    output.extend(data)
        code = child.wait(timeout=max(0.1, deadline - time.monotonic()))
        require(code == 0 or allow_missing and code == 1 and not output, "Git query failed", "git_unavailable")
        return bytes(output)
    finally:
        selector.close()
        stopped = False
        try:
            stopped = clean_children(child, time.monotonic() + 3)
        finally:
            child.stdout.close()
            child.stderr.close()
            if source is not None:
                source.close()
        require(stopped, "Git descendants did not stop", "cleanup_unknown")


def repository_paths(root: Root, forbidden: list[Path]) -> list[Path]:
    info = os.stat(".git", dir_fd=root.fd, follow_symlinks=False)
    require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
            "Repository Git metadata is not an ordinary directory or worktree pointer", "unsafe_path")
    top = git(root, ["rev-parse", "--show-toplevel"]).decode("utf-8", "strict").strip()
    require(Path(top).resolve(strict=True) == root.path, "Git queries require the registered repository top-level", "not_repository_root")
    directories = []
    for command in (["rev-parse", "--absolute-git-dir"], ["rev-parse", "--path-format=absolute", "--git-common-dir"]):
        metadata = Path(git(root, command).decode("utf-8", "strict").strip()).resolve(strict=True)
        require(all(metadata != item and item not in metadata.parents for item in forbidden), "Git metadata overlaps protected storage", "forbidden_path")
        directories.append(metadata)
    git_dir, common = directories
    if stat.S_ISDIR(info.st_mode):
        require(git_dir == common == root.path / ".git", "Primary Git metadata must belong to the registered root", "git_scope")
    else:
        # A .git file is not sufficient authority to modify an unrelated
        # repository. Accept only Git's linked-worktree structure with both
        # directions pointing to this registered checkout.
        from .workspace_git_view import directory
        require(git_dir.parent == common / "worktrees", "Git pointer is not a linked worktree of its common repository", "git_scope")
        metadata_fd = directory(git_dir)
        def text(parent, name):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try: return read_file(fd, 8192)[0].decode("utf-8", "strict").strip()
            finally: os.close(fd)
        try:
            pointer = text(root.fd, ".git")
            require(pointer.startswith("gitdir: ") and (root.path / pointer[8:]).resolve(strict=True) == git_dir,
                    "Registered worktree pointer changed", "git_scope")
            require((git_dir / text(metadata_fd, "commondir")).resolve(strict=True) == common and
                    (git_dir / text(metadata_fd, "gitdir")).resolve(strict=True) == root.path / ".git",
                    "Git metadata backlink does not belong to the registered root", "git_scope")
        finally:
            os.close(metadata_fd)
    return directories


def query(root: Root, action: str, params: dict, forbidden: list[Path]) -> dict:
    args = query_args(action, params)
    directories = repository_paths(root, forbidden)
    commit_state = None
    if action == "git/status":
        from .workspace_commit import state
        commit_state = state(root, directories)
    if action in ("git/status", "git/diff"):
        from .workspace_git_view import content_view
        with content_view(root, *directories) as (environment, descriptors):
            data = git(root, args, environment=environment, descriptors=descriptors)
    else:
        data = git(root, args)
    if action == "git/diff":
        return {"text": data.decode("utf-8", "replace"), "staged": params.get("staged", False), "complete": True}
    if action == "git/refs":
        refs = []
        for line in data.decode("utf-8", "strict").splitlines():
            fields = line.split("\0")
            require(len(fields) == 3, "Invalid Git ref result", "git_unavailable")
            refs.append({"name": fields[0], "objectId": fields[1], "symbolicTarget": fields[2] or None})
        return {"refs": refs[:1000], "truncated": len(refs) > 1000}
    fields = data.decode("utf-8", "strict").split("\0")
    entries, index = [], 0
    while index < len(fields) and fields[index]:
        value = fields[index]
        index += 1
        require(len(value) > 3 and value[2] == " ", "Invalid Git status result", "git_unavailable")
        item = {"index": value[0], "worktree": value[1], "path": value[3:]}
        if "R" in value[:2] or "C" in value[:2]:
            require(index < len(fields) and bool(fields[index]), "Incomplete Git rename result", "git_unavailable")
            item["originalPath"] = fields[index]
            index += 1
        entries.append(item)
        require(len(entries) <= 1000, "Git status entry budget exceeded", "budget")
    require(state(root, directories) == commit_state, "Git HEAD or index changed during status", "conflict")
    return {"entries": entries, "complete": True, "commitState": commit_state}
