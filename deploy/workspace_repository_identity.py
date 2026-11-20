"""Identity of Git's verified shared metadata, read using the native project account."""
import hashlib
import os

from .workspace_git import repository_paths
from .workspace_git_view import directory


def repository_identity(workspace):
    _, common = repository_paths(workspace.root, workspace.forbidden)
    fd = directory(common)
    try:
        info = os.fstat(fd)
        return hashlib.sha256(f"{info.st_dev}:{info.st_ino}".encode("ascii")).hexdigest()
    finally:
        os.close(fd)
