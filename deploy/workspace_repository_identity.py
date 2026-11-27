"""Lease identity of verified shared Git metadata or an independent project directory."""
import hashlib
import os

from .common import require
from .workspace_git import repository_paths
from .workspace_git_view import directory
from .workspace_paths import Root


def _identity(fd, prefix=""):
    info = os.fstat(fd)
    return hashlib.sha256(f"{prefix}{info.st_dev}:{info.st_ino}".encode("ascii")).hexdigest()


def repository_identity(workspace):
    root = workspace.root
    current = root.path
    fd = os.dup(root.fd)
    try:
        while True:
            require(os.path.samestat(os.fstat(fd), os.stat(current, follow_symlinks=False)),
                    "Project directory changed during identity verification", "unsafe_path")
            try:
                os.stat(".git", dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                if current == current.parent:
                    return _identity(root.fd, "dir:")
                parent_fd = os.open("..", os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = parent_fd
                current = current.parent
                continue

            # Validate the complete worktree and its backlink even when the registered
            # project is a nested directory. Malformed markers never become plain roots.
            checkout = root if current == root.path else Root(str(current), workspace.forbidden)
            try:
                require(os.path.samestat(os.fstat(checkout.fd), os.fstat(fd)),
                        "Enclosing repository changed during identity verification", "unsafe_path")
                _, common = repository_paths(checkout, workspace.forbidden)
                metadata_fd = directory(common)
                try:
                    return _identity(metadata_fd)
                finally:
                    os.close(metadata_fd)
            finally:
                if checkout is not root:
                    checkout.close()
    finally:
        os.close(fd)
