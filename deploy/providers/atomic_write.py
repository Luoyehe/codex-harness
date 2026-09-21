"""Owner-only, same-directory atomic writes for provider configuration."""
import os
import tempfile


def atomic_write(path, text):
    # Preserve an existing live config symlink when a standalone helper targets
    # it; writes update its provider set instead of replacing the symlink.
    target = os.path.realpath(path)
    directory = os.path.dirname(target)
    os.makedirs(directory, exist_ok=True)
    try:
        old = os.stat(target)
    except FileNotFoundError:
        old = None
    fd, temporary = tempfile.mkstemp(prefix=".provider-config-", dir=directory)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        else:
            os.chmod(temporary, 0o600)
        if old is not None and hasattr(os, "fchown"):
            os.fchown(fd, old.st_uid, old.st_gid)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        if os.name != "nt":
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
