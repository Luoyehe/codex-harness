"""Service-identity, descriptor-confined access to the managed environment.

No privileged process may follow links or change ownership in service data.
Pinned directory descriptors and O_NOFOLLOW keep concurrent link replacement
from changing the destination after validation.
"""
import contextlib
import os
from pathlib import Path
import stat
import sys
import uuid


MAX_ENVIRONMENT_BYTES = 1024 * 1024


class ServiceIdentityError(ValueError):
    """Fixed, operator-facing identity errors contain no configuration data."""


def service_account(user):
    import pwd
    if not user:
        raise ServiceIdentityError("root maintenance requires RUN_USER=<dedicated non-root service account>; migrate existing state ownership deliberately before retrying")
    try:
        account = pwd.getpwnam(user)
    except KeyError:
        raise ServiceIdentityError("RUN_USER must name an existing dedicated non-root service account") from None
    if account.pw_uid == 0:
        raise ServiceIdentityError("root service accounts are unsupported; create a dedicated non-root account and migrate CODEX_HOME and ENV_FILE before retrying (ALLOW_ROOT_SERVICE does not bypass this)")
    return account


def drop_service_privileges(user):
    if os.geteuid() != 0:
        return
    account = service_account(user)
    # Match runuser/systemd account access while discarding root's inherited
    # supplementary groups before permanently changing the effective UID.
    os.initgroups(user, account.pw_gid)
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)


def open_directory(path):
    path = Path(os.path.abspath(path))
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_regular(directory, name, missing=False):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except FileNotFoundError:
        if missing:
            return None
        raise
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid():
            raise ValueError("environment must be a singly linked regular file owned by the service account")
        if info.st_size > MAX_ENVIRONMENT_BYTES:
            raise ValueError("environment exceeds the byte limit")
        # The inode may grow after fstat. A bounded second check prevents a
        # concurrent writer from turning maintenance into an unbounded read.
        data = stream.read(MAX_ENVIRONMENT_BYTES + 1)
        if len(data) > MAX_ENVIRONMENT_BYTES:
            raise ValueError("environment exceeds the byte limit")
        after = os.fstat(stream.fileno())
        identity = lambda value: (
            value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns,
        )
        if len(data) != info.st_size or identity(info) != identity(after):
            raise ValueError("environment changed while it was read")
        return data.decode("utf-8")


def write_regular(directory, name, text):
    temporary = ".service-env-" + uuid.uuid4().hex
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass


@contextlib.contextmanager
def locked_environment(home, env_file):
    import fcntl
    home = Path(os.path.abspath(home))
    env_file = Path(os.path.abspath(env_file))
    descriptors = []
    try:
        home_fd = open_directory(home)
        descriptors.append(home_fd)
        lock_fd = os.open(".provider-transaction.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=home_fd)
        descriptors.append(lock_fd)
        info = os.fstat(lock_fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid():
            raise ValueError("invalid provider lock ownership or type")
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("another provider transaction is running") from None
        parent_fd = open_directory(env_file.parent)
        descriptors.append(parent_fd)
        try:
            alias = os.readlink(env_file.name, dir_fd=parent_fd)
        except FileNotFoundError:
            alias = None
        except OSError:
            # read_regular below still rejects non-regular files.
            alias = None
        if alias is not None:
            expected = home / "providers" / ".active" / "secrets.env"
            if Path(os.path.abspath(env_file.parent / alias)) != expected:
                raise ValueError("environment link is not the managed active-secret alias")
            providers_fd = os.open("providers", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=home_fd)
            descriptors.append(providers_fd)
            active = os.readlink(".active", dir_fd=providers_fd)
            active_path = Path(os.path.abspath(home / "providers" / active))
            versions = home / "providers" / ".versions"
            if active_path.parent != versions or not active_path.name.startswith("generation-"):
                raise ValueError("active environment is outside the managed generation layout")
            versions_fd = os.open(".versions", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=providers_fd)
            descriptors.append(versions_fd)
            parent_fd = os.open(active_path.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=versions_fd)
            descriptors.append(parent_fd)
            name = "secrets.env"
        else:
            if env_file == home / "config.toml" or env_file.is_relative_to(home / "providers"):
                raise ValueError("environment overlaps managed provider configuration")
            name = env_file.name
        yield parent_fd, name, read_regular(parent_fd, name, missing=True)
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def prepare(home, env_file):
    with locked_environment(home, env_file) as (directory, name, text):
        # Rewrite atomically to set mode on our own newly created inode. Never
        # chmod/chown a pathname that can be replaced by another process.
        write_regular(directory, name, text if text is not None else "# Extra environment for the codex-harness service.\n")


if __name__ == "__main__":
    try:
        drop_service_privileges(os.environ.get("RUN_USER"))
        prepare(*sys.argv[1:3])
    except ServiceIdentityError as error:
        raise SystemExit("[service-env] " + str(error)) from None
    except (ValueError, OSError, RuntimeError) as error:
        raise SystemExit(f"[service-env] environment preparation refused ({type(error).__name__}); check service ownership and managed paths") from None
