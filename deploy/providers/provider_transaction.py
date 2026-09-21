"""Stage, validate, then atomically publish a complete provider generation.

The public config, provider sets, and EnvironmentFile all traverse one .active
symlink. A single rename publishes their new generation. Failed setup never
touches active data. A bounded set of recent generations remains as private
rollback snapshots.
"""
import contextlib
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid

MODULE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(MODULE_DIR))
sys.path.insert(0, str(MODULE_DIR.parent))
from service_env import ServiceIdentityError, drop_service_privileges, open_directory
from atomic_write import atomic_write
from catalog_limits import dump_json_limited, load_json_path, validate_models_catalog
from toml_config import load_config, save_config, rebase_catalog

MODES = ("custom", "zhipu")
DEFAULT_GENERATION_HISTORY = 3
GENERATION_NAME = re.compile(r"generation-[A-Za-z0-9_][A-Za-z0-9._-]{0,127}\Z")
MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024
MAX_SNAPSHOT_TOTAL_BYTES = 8 * 1024 * 1024
MAX_SNAPSHOT_ENTRIES = 512
MAX_SNAPSHOT_DEPTH = 8
MAX_VERSIONS_BYTES = 128 * 1024 * 1024
MAX_VERSIONS_ENTRIES = 4096
MAX_VERSIONS_DEPTH = 16
PREVIOUS_GENERATION_FILE = ".previous-generation"
CHILD_ENVIRONMENT_BLOCKLIST = frozenset({
    # Shell startup hooks and inherited option/state variables can execute code
    # or materially change parsing before the trusted provider script starts.
    "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "CDPATH", "GLOBIGNORE",
    "PROMPT_COMMAND", "PS4", "IFS", "SUDO_ASKPASS",
    # Dynamic-loader and language runtime hooks must not cross the transaction
    # boundary. Network proxy variables deliberately remain available.
    "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH", "NODE_OPTIONS", "NODE_PATH", "RUBYOPT", "PERL5OPT",
    "PERL5LIB", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT",
    "PYTHONWARNINGS", "PYTHONBREAKPOINT",
})


def _identity(info):
    return info.st_dev, info.st_ino


def _provider_child_environment(generation):
    child_env = {key: value for key, value in os.environ.items()
                 if key not in CHILD_ENVIRONMENT_BLOCKLIST
                 and not key.startswith(("BASH_FUNC_", "GATEWAY_", "CODEX_HARNESS_"))}
    child_env.update(CODEX_HOME=str(generation),
                     ENV_FILE=str(generation / "secrets.env"),
                     HARNESS_PROVIDER_TRANSACTION="1",
                     PYTHONDONTWRITEBYTECODE="1",
                     PYTHONPATH=str(MODULE_DIR),
                     PYTHONSAFEPATH="1",
                     PYTHONNOUSERSITE="1")
    return child_env


def _stable_metadata(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _consume_budget(budget, *, entries=0, size=0, depth=0):
    budget["entries"] += entries
    budget["bytes"] += size
    if (depth > budget["max_depth"] or budget["entries"] > budget["max_entries"]
            or budget["bytes"] > budget["max_bytes"]):
        raise ValueError("provider snapshot exceeds its resource budget")


def _new_snapshot_budget():
    return {"entries": 0, "bytes": 0, "max_entries": MAX_SNAPSHOT_ENTRIES,
            "max_bytes": MAX_SNAPSHOT_TOTAL_BYTES, "max_depth": MAX_SNAPSHOT_DEPTH}


def _checked_source_info(info, *, regular=False, directory=False):
    kind_ok = stat.S_ISREG(info.st_mode) if regular else stat.S_ISDIR(info.st_mode) if directory else False
    if not kind_ok or info.st_uid != os.geteuid():
        raise ValueError("provider snapshot source has an unsafe type or owner")
    if regular and info.st_nlink != 1:
        raise ValueError("provider snapshot source is multiply linked")


def _write_all(descriptor, data):
    view = memoryview(data)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError("provider snapshot write made no progress")
        view = view[written:]


def _copy_regular_at(source_fd, source_name, target_fd, target_name, budget):
    before = os.stat(source_name, dir_fd=source_fd, follow_symlinks=False)
    _checked_source_info(before, regular=True)
    if before.st_size > MAX_SNAPSHOT_FILE_BYTES:
        raise ValueError("provider snapshot file exceeds its byte limit")
    _consume_budget(budget, entries=1, size=before.st_size)
    descriptor = os.open(source_name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=source_fd)
    try:
        opened = os.fstat(descriptor)
        _checked_source_info(opened, regular=True)
        if _stable_metadata(before) != _stable_metadata(opened):
            raise RuntimeError("provider snapshot source changed while opening")
        chunks = []
        remaining = min(MAX_SNAPSHOT_FILE_BYTES, before.st_size) + 1
        while remaining:
            chunk = os.read(descriptor, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    current = os.stat(source_name, dir_fd=source_fd, follow_symlinks=False)
    if (len(data) != before.st_size or _stable_metadata(before) != _stable_metadata(after)
            or _stable_metadata(before) != _stable_metadata(current)):
        raise RuntimeError("provider snapshot source changed while reading")
    output = os.open(target_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=target_fd)
    try:
        _write_all(output, data)
        os.fsync(output)
    finally:
        os.close(output)


def _copy_tree_at(source_fd, target_fd, budget, depth=0):
    _consume_budget(budget, depth=depth)
    entries = []
    with os.scandir(source_fd) as iterator:
        for entry in iterator:
            _consume_budget(budget, entries=1, depth=depth)
            entries.append((entry.name, entry.stat(follow_symlinks=False)))
    for name, before in entries:
        if stat.S_ISREG(before.st_mode):
            # The entry itself was counted above; the file helper accounts only bytes.
            budget["entries"] -= 1
            _copy_regular_at(source_fd, name, target_fd, name, budget)
        elif stat.S_ISDIR(before.st_mode):
            _checked_source_info(before, directory=True)
            source_child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                   dir_fd=source_fd)
            try:
                if _stable_metadata(before) != _stable_metadata(os.fstat(source_child)):
                    raise RuntimeError("provider snapshot directory changed while opening")
                os.mkdir(name, 0o700, dir_fd=target_fd)
                target_child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                       dir_fd=target_fd)
                try:
                    _copy_tree_at(source_child, target_child, budget, depth + 1)
                    os.fsync(target_child)
                finally:
                    os.close(target_child)
                current = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
                if _stable_metadata(before) != _stable_metadata(current):
                    raise RuntimeError("provider snapshot directory changed while copying")
            finally:
                os.close(source_child)
        else:
            raise ValueError("provider snapshot rejects links and special files")


def _empty_regular_at(directory_fd, name):
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory_fd)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_private_regular_at(directory_fd, name, data):
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory_fd)
    try:
        _write_all(descriptor, data)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _read_private_regular_at(directory_fd, name, limit=256):
    before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    _checked_source_info(before, regular=True)
    if before.st_mode & 0o077 or before.st_size > limit:
        raise ValueError("provider metadata file is unsafe")
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=directory_fd)
    try:
        opened = os.fstat(descriptor)
        if _stable_metadata(before) != _stable_metadata(opened):
            raise RuntimeError("provider metadata changed while opening")
        data = os.read(descriptor, limit + 1)
        if os.read(descriptor, 1):
            raise ValueError("provider metadata exceeds its byte limit")
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    if (_stable_metadata(before) != _stable_metadata(after)
            or _stable_metadata(before) != _stable_metadata(current)):
        raise RuntimeError("provider metadata changed while reading")
    return data


def _create_generation(versions, versions_fd):
    for _ in range(128):
        name = "generation-" + uuid.uuid4().hex
        try:
            os.mkdir(name, 0o700, dir_fd=versions_fd)
        except FileExistsError:
            continue
        info = os.stat(name, dir_fd=versions_fd, follow_symlinks=False)
        descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                             dir_fd=versions_fd)
        if _identity(info) != _identity(os.fstat(descriptor)):
            os.close(descriptor)
            raise RuntimeError("provider candidate changed while it was created")
        return versions / name, info, descriptor
    raise RuntimeError("could not allocate a unique provider generation")


def zhipu_sync_environment(generation, child_env):
    config = load_config(generation / "config.toml")
    if config.get("model_provider") != "ZAI":
        raise ValueError("活动供应商已改变，未同步过期的智谱目录")
    model, effort = config.get("model"), config.get("model_reasoning_effort")
    if not all(isinstance(value, str) and value for value in (model, effort)):
        raise ValueError("当前智谱配置缺少模型或 effort")
    child_env.update(ZHIPU_MODEL=model, ZHIPU_EFFORT=effort, ZHIPU_KEY="", PROBE_REASONING="0")
    # Preserve the active settings rather than a stale archived Zhipu set.
    target = generation / "providers" / "zhipu"
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    config["model_catalog_json"] = str(target / "models.json")
    save_config(target / "config.toml", config)


def environment_file(home, value):
    # Canonicalize the entry's parent, not the final symlink: a normal managed
    # EnvironmentFile must remain the stable public alias on every transaction.
    requested = Path(value).absolute()
    env_file = requested.parent.resolve() / requested.name
    config = home / "config.toml"
    providers = home / "providers"
    if env_file == config or env_file.is_relative_to(providers.resolve()):
        raise ValueError("ENV_FILE 不能与配置/供应商版本目录重叠")
    resolved = env_file.resolve()
    active = providers / ".active"
    managed_secret = active / "secrets.env"
    managed = (env_file.is_symlink() and active.is_symlink() and not managed_secret.is_symlink()
               and active.resolve().is_relative_to((providers / ".versions").resolve())
               and resolved == managed_secret.resolve())
    if not managed and (resolved == config.resolve() or resolved.is_relative_to(providers.resolve())):
        raise ValueError("ENV_FILE 链接不能指向配置/供应商版本目录")
    return env_file


def custom_sync_environment(generation, child_env):
    # adminSnapshot is taken before this lock. Ignore ALL caller-supplied
    # settings during a refresh, including replacement credentials: another
    # custom->custom transaction may already have changed the endpoint.
    config = load_config(generation / "config.toml")
    if config.get("model_provider") != "custom":
        raise ValueError("活动供应商已改变，未同步过期的端点配置")
    provider = config.get("model_providers", {}).get("custom", {})
    base_url, model, effort = provider.get("base_url"), config.get("model"), config.get("model_reasoning_effort")
    if not all(isinstance(value, str) and value for value in (base_url, model, effort)):
        raise ValueError("当前 custom 配置缺少端点、模型或 effort")
    env_key = provider.get("env_key")
    if env_key not in (None, "", "CUSTOM_OPENAI_API_KEY") or provider.get("experimental_bearer_token"):
        raise ValueError("当前认证配置需先通过供应商设置迁移，不能猜测同步使用的密钥")
    declared = config.get("model_catalog_json")
    if not isinstance(declared, str) or not declared:
        raise ValueError("当前 custom 配置缺少模型目录")
    catalog_path = Path(declared).expanduser()
    if not catalog_path.is_absolute():
        catalog_path = generation / catalog_path
    catalog = validate_models_catalog(
        load_json_path(catalog_path), allow_empty=True, include_unconfigured=True)
    entries = catalog.get("models")
    if not isinstance(entries, list):
        raise ValueError("当前模型目录无效")
    entry = next((item for item in entries if isinstance(item, dict) and item.get("slug") == model), None)
    context_window = entry.get("context_window") if entry else None
    modalities = entry.get("input_modalities") if entry else None
    if type(context_window) is not int or not 1024 <= context_window <= 16777216 or not isinstance(modalities, list):
        raise ValueError("当前模型目录缺少有效上下文窗口或输入类型")
    child_env.update(CUSTOM_BASE_URL=base_url, CUSTOM_MODEL=model, CUSTOM_EFFORT=effort,
                     CUSTOM_CTX=str(context_window), CUSTOM_VISION="1" if "image" in modalities else "0",
                     CUSTOM_API_KEY="", CUSTOM_REUSE_API_KEY="1" if env_key == "CUSTOM_OPENAI_API_KEY" else "0",
                     CUSTOM_MODEL_IDS="", PROBE_REASONING="0")
    # The active config can differ from the archived custom set (manual edits,
    # or a declared external catalog). Seed setup from the same locked snapshot
    # used above so its own effort/capability preservation reads identical data.
    custom = generation / "providers" / "custom"
    custom.mkdir(parents=True, exist_ok=True, mode=0o700)
    config["model_catalog_json"] = str(custom / "models.json")
    save_config(custom / "config.toml", config)
    atomic_write(custom / "models.json", dump_json_limited(catalog))


def atomic_link(source, destination):
    destination = Path(destination)
    temporary = destination.with_name(".provider-link-" + uuid.uuid4().hex)
    try:
        os.symlink(str(source), temporary, target_is_directory=Path(source).is_dir())
        os.replace(temporary, destination)
        if os.name != "nt":
            fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    finally:
        if temporary.is_symlink():
            temporary.unlink()


@contextlib.contextmanager
def _opened_or_create_layout(home, versions):
    home = Path(os.path.abspath(home))
    versions = Path(os.path.abspath(versions))
    if versions != home / "providers" / ".versions":
        raise ValueError("provider versions path does not match CODEX_HOME")
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    home_fd = open_directory(home)
    try:
        home_info = os.fstat(home_fd)
        if home_info.st_uid != os.geteuid() or home_info.st_mode & 0o022:
            raise ValueError("CODEX_HOME has an unsafe owner or mode")
        try:
            os.mkdir("providers", 0o700, dir_fd=home_fd)
            os.fsync(home_fd)
        except FileExistsError:
            pass
        providers_fd = os.open("providers", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                               dir_fd=home_fd)
        try:
            providers_info = os.fstat(providers_fd)
            if providers_info.st_uid != os.geteuid() or providers_info.st_mode & 0o022:
                raise ValueError("provider directory has an unsafe owner or mode")
            try:
                os.mkdir(".versions", 0o700, dir_fd=providers_fd)
                os.fsync(providers_fd)
            except FileExistsError:
                pass
            versions_fd = os.open(".versions", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                  dir_fd=providers_fd)
            try:
                versions_info = os.fstat(versions_fd)
                if versions_info.st_uid != os.geteuid() or versions_info.st_mode & 0o077:
                    raise ValueError("provider versions directory is not private")
                yield home_fd, providers_fd, versions_fd
            finally:
                os.close(versions_fd)
        finally:
            os.close(providers_fd)
    finally:
        os.close(home_fd)


@contextlib.contextmanager
def transaction_lock(home, home_fd=None):
    # Configuration setup is supported on Linux. Windows can exercise the
    # parser/snapshot unit tests, but must not fake a successful unlocked edit.
    import fcntl
    owned_home_fd = home_fd is None
    if owned_home_fd:
        home_fd = open_directory(home)
    fd = os.open(".provider-transaction.lock",
                 os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK,
                 0o600, dir_fd=home_fd)
    try:
        lock_info = os.fstat(fd)
        if (not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != os.geteuid()
                or lock_info.st_nlink != 1 or lock_info.st_mode & 0o077):
            raise ValueError("provider transaction lock has an unsafe identity")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("另一个供应商配置事务正在运行，请稍后重试") from None
        yield
    finally:
        os.close(fd)
        if owned_home_fd:
            os.close(home_fd)


def _copy_directory_entry(source_parent_fd, name, target_parent_fd, budget):
    try:
        before = os.stat(name, dir_fd=source_parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        os.mkdir(name, 0o700, dir_fd=target_parent_fd)
        return
    _checked_source_info(before, directory=True)
    source_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                        dir_fd=source_parent_fd)
    try:
        if _stable_metadata(before) != _stable_metadata(os.fstat(source_fd)):
            raise RuntimeError("provider snapshot directory changed while opening")
        os.mkdir(name, 0o700, dir_fd=target_parent_fd)
        target_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=target_parent_fd)
        try:
            _copy_tree_at(source_fd, target_fd, budget, 1)
            os.fsync(target_fd)
        finally:
            os.close(target_fd)
        current = os.stat(name, dir_fd=source_parent_fd, follow_symlinks=False)
        if _stable_metadata(before) != _stable_metadata(current):
            raise RuntimeError("provider snapshot directory changed while copying")
    finally:
        os.close(source_fd)


def _copy_active_config(source_fd, source_path, target_fd, budget):
    before = os.stat("config.toml", dir_fd=source_fd, follow_symlinks=False)
    if stat.S_ISREG(before.st_mode):
        _copy_regular_at(source_fd, "config.toml", target_fd, "config.toml", budget)
        return
    if not stat.S_ISLNK(before.st_mode) or before.st_uid != os.geteuid():
        raise ValueError("active provider config has an unsafe type or owner")
    target_input = Path(os.readlink("config.toml", dir_fd=source_fd))
    if ".." in target_input.parts:
        raise ValueError("active provider config link contains traversal")
    target = target_input if target_input.is_absolute() else source_path / target_input
    target = Path(os.path.abspath(target))
    allowed = {source_path / "providers" / mode / "config.toml" for mode in MODES}
    if target not in allowed:
        raise ValueError("active provider config link leaves its generation")
    providers_fd = os.open("providers", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                           dir_fd=source_fd)
    try:
        mode_fd = os.open(target.parent.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                          dir_fd=providers_fd)
        try:
            _copy_regular_at(mode_fd, "config.toml", target_fd, "config.toml", budget)
        finally:
            os.close(mode_fd)
    finally:
        os.close(providers_fd)
    current = os.stat("config.toml", dir_fd=source_fd, follow_symlinks=False)
    if _stable_metadata(before) != _stable_metadata(current):
        raise RuntimeError("active provider config link changed while copying")


def _snapshot_with_layout(home, env_file, versions, home_fd, providers_fd, versions_fd):
    generation, created, generation_fd = _create_generation(versions, versions_fd)
    budget = _new_snapshot_budget()
    try:
        os.mkdir("providers", 0o700, dir_fd=generation_fd)
        target_providers_fd = os.open("providers", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                      dir_fd=generation_fd)
        active_fd = None
        active_path = None
        try:
            try:
                os.stat(".active", dir_fd=providers_fd, follow_symlinks=False)
            except FileNotFoundError:
                source_providers_fd = providers_fd
                source_base = home / "providers"
            else:
                active_name, active_info = _active_generation(providers_fd, versions_fd, versions)
                active_fd = os.open(active_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                    dir_fd=versions_fd)
                if _identity(active_info) != _identity(os.fstat(active_fd)):
                    raise RuntimeError("active provider generation changed while opening")
                active_path = versions / active_name
                _validate_publish_tree(active_fd, active_path, require_private=True)
                source_providers_fd = os.open("providers", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                              dir_fd=active_fd)
                source_base = active_path / "providers"
            owns_source_providers = source_providers_fd != providers_fd
            try:
                for mode in MODES:
                    _copy_directory_entry(source_providers_fd, mode, target_providers_fd, budget)
                    config_path = generation / "providers" / mode / "config.toml"
                    target_mode_fd = os.open(mode, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                             dir_fd=target_providers_fd)
                    try:
                        os.stat("config.toml", dir_fd=target_mode_fd, follow_symlinks=False)
                    except FileNotFoundError:
                        continue
                    finally:
                        os.close(target_mode_fd)
                    config = load_config(config_path)
                    rebase_catalog(config, source_base / mode, generation / "providers" / mode)
                    save_config(config_path, config)
            finally:
                if owns_source_providers:
                    os.close(source_providers_fd)
            if active_fd is not None:
                _copy_active_config(active_fd, active_path, generation_fd, budget)
                _copy_regular_at(active_fd, "secrets.env", generation_fd, "secrets.env", budget)
            else:
                try:
                    os.stat("config.toml", dir_fd=home_fd, follow_symlinks=False)
                except FileNotFoundError:
                    _empty_regular_at(generation_fd, "config.toml")
                else:
                    _copy_regular_at(home_fd, "config.toml", generation_fd, "config.toml", budget)
                env_parent_fd = open_directory(Path(env_file).parent)
                try:
                    try:
                        os.stat(Path(env_file).name, dir_fd=env_parent_fd, follow_symlinks=False)
                    except FileNotFoundError:
                        _empty_regular_at(generation_fd, "secrets.env")
                    else:
                        _copy_regular_at(env_parent_fd, Path(env_file).name, generation_fd,
                                         "secrets.env", budget)
                finally:
                    os.close(env_parent_fd)
            config = load_config(generation / "config.toml")
            for mode in MODES:
                rebase_catalog(config, source_base / mode, generation / "providers" / mode)
            save_config(generation / "config.toml", config)
            os.fsync(target_providers_fd)
            os.fsync(generation_fd)
        finally:
            if active_fd is not None:
                os.close(active_fd)
            os.close(target_providers_fd)
        os.fsync(versions_fd)
        _assert_versions_budget(versions_fd, reserve_generations=0)
        return generation, created
    except BaseException:
        os.close(generation_fd)
        _cleanup_candidate_best_effort(
            versions, generation, created, (home_fd, providers_fd, versions_fd))
        raise
    finally:
        try:
            os.close(generation_fd)
        except OSError:
            pass


def snapshot(home, env_file, versions, layout=None):
    if layout is not None:
        return _snapshot_with_layout(home, env_file, versions, *layout)
    with _opened_or_create_layout(home, versions) as opened:
        return _snapshot_with_layout(home, env_file, versions, *opened)


def _same_identity(left, right):
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


def _generation_info(versions_fd, name, *, required=False, require_private=True):
    if not isinstance(name, str) or not GENERATION_NAME.fullmatch(name):
        if required:
            raise ValueError("active provider generation has an invalid name")
        return None
    try:
        before = os.stat(name, dir_fd=versions_fd, follow_symlinks=False)
    except FileNotFoundError:
        if required:
            raise ValueError("active provider generation is missing") from None
        return None
    if (not stat.S_ISDIR(before.st_mode) or before.st_uid != os.geteuid()
            or (require_private and before.st_mode & 0o077)):
        if required:
            raise ValueError("active provider generation has an unsafe identity or mode")
        return None
    try:
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=versions_fd)
    except OSError:
        if required:
            raise ValueError("active provider generation cannot be pinned safely") from None
        return None
    try:
        opened = os.fstat(fd)
        if not _same_identity(before, opened):
            if required:
                raise ValueError("active provider generation changed while it was pinned")
            return None
    finally:
        os.close(fd)
    return before


def _active_generation(providers_fd, versions_fd, versions):
    try:
        link_info = os.stat(".active", dir_fd=providers_fd, follow_symlinks=False)
        target_text = os.readlink(".active", dir_fd=providers_fd)
    except (FileNotFoundError, OSError):
        raise ValueError("managed active provider link is missing or invalid") from None
    if not stat.S_ISLNK(link_info.st_mode) or link_info.st_uid != os.geteuid():
        raise ValueError("managed active provider link has an unsafe identity")
    target_input = Path(target_text)
    if ".." in target_input.parts:
        raise ValueError("managed active provider link contains traversal")
    target = target_input if target_input.is_absolute() else versions.parent / target_input
    target = Path(os.path.abspath(target))
    if target.parent != versions:
        raise ValueError("managed active provider link leaves the versions directory")
    info = _generation_info(versions_fd, target.name, required=True)
    return target.name, info


def _bounded_directory_snapshot(directory_fd, budget, depth):
    _consume_budget(budget, depth=depth)
    snapshot = []
    with os.scandir(directory_fd) as entries:
        for entry in entries:
            before = entry.stat(follow_symlinks=False)
            _consume_budget(budget, entries=1,
                            size=before.st_size if stat.S_ISREG(before.st_mode) else 0,
                            depth=depth)
            snapshot.append((entry.name, before))
    return snapshot


def _remove_directory_contents(directory_fd, *, require_private=True, _budget=None, _depth=0):
    if _budget is None:
        _budget = _new_snapshot_budget()
    snapshot = _bounded_directory_snapshot(directory_fd, _budget, _depth)
    for name, before in snapshot:
        if before.st_uid != os.geteuid():
            raise ValueError("provider generation contains an entry owned by another identity")
        if require_private and not stat.S_ISLNK(before.st_mode) and before.st_mode & 0o077:
            raise ValueError("provider generation contains a non-private entry")
        if stat.S_ISDIR(before.st_mode):
            child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                if not _same_identity(before, os.fstat(child_fd)):
                    raise RuntimeError("provider generation directory changed during pruning")
                _remove_directory_contents(child_fd, require_private=require_private,
                                           _budget=_budget, _depth=_depth + 1)
            finally:
                os.close(child_fd)
            current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if not _same_identity(before, current) or not stat.S_ISDIR(current.st_mode):
                raise RuntimeError("provider generation directory changed before removal")
            os.rmdir(name, dir_fd=directory_fd)
        else:
            if require_private and stat.S_ISREG(before.st_mode) and before.st_nlink != 1:
                raise ValueError("provider generation contains a multiply linked file")
            current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if not _same_identity(before, current) or stat.S_IFMT(before.st_mode) != stat.S_IFMT(current.st_mode):
                raise RuntimeError("provider generation entry changed before removal")
            os.unlink(name, dir_fd=directory_fd)


def _validate_directory_contents(directory_fd, _budget=None, _depth=0):
    if _budget is None:
        _budget = _new_snapshot_budget()
    snapshot = _bounded_directory_snapshot(directory_fd, _budget, _depth)
    for name, before in snapshot:
        if before.st_uid != os.geteuid():
            raise ValueError("provider generation contains an entry owned by another identity")
        if not stat.S_ISLNK(before.st_mode) and before.st_mode & 0o077:
            raise ValueError("provider generation contains a non-private entry")
        if stat.S_ISDIR(before.st_mode):
            child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                               dir_fd=directory_fd)
            try:
                if not _same_identity(before, os.fstat(child_fd)):
                    raise RuntimeError("provider generation directory changed during validation")
                _validate_directory_contents(child_fd, _budget, _depth + 1)
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(before.st_mode):
            if before.st_nlink != 1:
                raise ValueError("provider generation contains a multiply linked file")
        elif not stat.S_ISLNK(before.st_mode):
            raise ValueError("provider generation contains an unsupported special entry")


def _validate_internal_config_link(directory_fd, name, before, generation, relative,
                                   *, require_private):
    if relative or name != "config.toml":
        raise ValueError("provider candidate contains an unmanaged link")
    target_input = Path(os.readlink(name, dir_fd=directory_fd))
    if ".." in target_input.parts:
        raise ValueError("provider candidate config link contains traversal")
    target = target_input if target_input.is_absolute() else generation / target_input
    target = Path(os.path.abspath(target))
    allowed = {generation / "providers" / mode / "config.toml" for mode in MODES}
    if target not in allowed:
        raise ValueError("provider candidate config link leaves its managed provider set")
    current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    if not _same_identity(before, current) or not stat.S_ISLNK(current.st_mode):
        raise RuntimeError("provider candidate config link changed during validation")
    providers_fd = os.open("providers", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                           dir_fd=directory_fd)
    try:
        mode_fd = os.open(target.parent.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                          dir_fd=providers_fd)
        try:
            file_fd = os.open("config.toml", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                              dir_fd=mode_fd)
            try:
                target_info = os.fstat(file_fd)
                if (not stat.S_ISREG(target_info.st_mode) or target_info.st_uid != os.geteuid()
                        or target_info.st_nlink != 1
                        or (require_private and target_info.st_mode & 0o077)):
                    raise ValueError("provider candidate config link target is unsafe")
            finally:
                os.close(file_fd)
        finally:
            os.close(mode_fd)
    finally:
        os.close(providers_fd)


def _validate_publish_tree(directory_fd, generation, relative=(), *, require_private,
                           _budget=None, _depth=0):
    if _budget is None:
        _budget = _new_snapshot_budget()
    _consume_budget(_budget, depth=_depth)
    root = os.fstat(directory_fd)
    if (not stat.S_ISDIR(root.st_mode) or root.st_uid != os.geteuid()
            or (require_private and root.st_mode & 0o077)):
        raise ValueError("provider candidate root has an unsafe identity or mode")
    snapshot = _bounded_directory_snapshot(directory_fd, _budget, _depth)
    for name, before in snapshot:
        if before.st_uid != os.geteuid():
            raise ValueError("provider candidate contains an entry owned by another identity")
        if stat.S_ISDIR(before.st_mode):
            if require_private and before.st_mode & 0o077:
                raise ValueError("provider candidate contains a non-private directory")
            child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                               dir_fd=directory_fd)
            try:
                if not _same_identity(before, os.fstat(child_fd)):
                    raise RuntimeError("provider candidate directory changed during validation")
                _validate_publish_tree(child_fd, generation, (*relative, name),
                                       require_private=require_private, _budget=_budget,
                                       _depth=_depth + 1)
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(before.st_mode):
            if before.st_size > MAX_SNAPSHOT_FILE_BYTES:
                raise ValueError("provider candidate file exceeds its byte limit")
            if require_private and before.st_mode & 0o077:
                raise ValueError("provider candidate contains a non-private file")
            if before.st_nlink != 1:
                raise ValueError("provider candidate contains a multiply linked file")
            file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                              dir_fd=directory_fd)
            try:
                if not _same_identity(before, os.fstat(file_fd)):
                    raise RuntimeError("provider candidate file changed during validation")
            finally:
                os.close(file_fd)
        elif stat.S_ISLNK(before.st_mode):
            _validate_internal_config_link(directory_fd, name, before, generation, relative,
                                           require_private=require_private)
        else:
            # Successful generations must be self-contained: even a harmless
            # symlink would make later validation, rollback, and pruning depend
            # on mutable storage outside this generation.
            raise ValueError("provider candidate contains a link or special entry")


def _privatize_publish_tree(directory_fd, generation, relative=(), _budget=None, _depth=0):
    if _budget is None:
        _budget = _new_snapshot_budget()
    snapshot = _bounded_directory_snapshot(directory_fd, _budget, _depth)
    for name, before in snapshot:
        if before.st_uid != os.geteuid():
            raise ValueError("provider candidate contains an entry owned by another identity")
        if stat.S_ISDIR(before.st_mode):
            child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                               dir_fd=directory_fd)
            try:
                if not _same_identity(before, os.fstat(child_fd)):
                    raise RuntimeError("provider candidate directory changed while privatizing")
                _privatize_publish_tree(child_fd, generation, (*relative, name),
                                        _budget, _depth + 1)
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(before.st_mode) and before.st_nlink == 1:
            file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                              dir_fd=directory_fd)
            try:
                opened = os.fstat(file_fd)
                if not _same_identity(before, opened) or opened.st_nlink != 1:
                    raise RuntimeError("provider candidate file changed while privatizing")
                os.fchmod(file_fd, 0o600)
            finally:
                os.close(file_fd)
        elif stat.S_ISLNK(before.st_mode):
            _validate_internal_config_link(directory_fd, name, before, generation, relative,
                                           require_private=False)
        else:
            raise ValueError("provider candidate contains a link, special, or multiply linked entry")
    os.fchmod(directory_fd, 0o700)


@contextlib.contextmanager
def _opened_versions(versions):
    versions_input = Path(versions)
    if not versions_input.is_absolute() or ".." in versions_input.parts:
        raise ValueError("provider versions path must be absolute without traversal")
    versions = Path(os.path.abspath(versions_input))
    if versions.name != ".versions":
        raise ValueError("provider versions path does not match the managed layout")
    providers_fd = open_directory(versions.parent)
    try:
        providers_info = os.fstat(providers_fd)
        if providers_info.st_uid != os.geteuid() or providers_info.st_mode & 0o022:
            raise ValueError("provider directory has an unsafe owner or mode")
        versions_fd = os.open(".versions", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                              dir_fd=providers_fd)
        try:
            versions_info = os.fstat(versions_fd)
            if versions_info.st_uid != os.geteuid() or versions_info.st_mode & 0o077:
                raise ValueError("provider versions directory is not private")
            yield providers_fd, versions_fd, versions
        finally:
            os.close(versions_fd)
    finally:
        os.close(providers_fd)


@contextlib.contextmanager
def _pinned_candidate(generation, expected, *, require_private):
    generation_input = Path(generation)
    if (not generation_input.is_absolute() or ".." in generation_input.parts
            or not GENERATION_NAME.fullmatch(generation_input.name)):
        raise ValueError("provider candidate path is invalid")
    generation = Path(os.path.abspath(generation_input))
    with _opened_versions(generation.parent) as (_, versions_fd, _):
        current = _generation_info(versions_fd, generation.name, required=True,
                                   require_private=require_private)
        if not _same_identity(expected, current):
            raise RuntimeError("provider candidate identity changed")
        fd = os.open(generation.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                     dir_fd=versions_fd)
        try:
            if not _same_identity(expected, os.fstat(fd)):
                raise RuntimeError("provider candidate changed while it was pinned")
            yield fd
        finally:
            os.close(fd)


def _open_candidate_fd(versions_fd, generation, expected, *, require_private):
    current = _generation_info(versions_fd, generation.name, required=True,
                               require_private=require_private)
    if not _same_identity(expected, current):
        raise RuntimeError("provider candidate identity changed")
    descriptor = os.open(generation.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                         dir_fd=versions_fd)
    if not _same_identity(expected, os.fstat(descriptor)):
        os.close(descriptor)
        raise RuntimeError("provider candidate changed while it was pinned")
    return descriptor


def _fsync_publish_tree(directory_fd, generation, relative=(), depth=0, _budget=None):
    if _budget is None:
        _budget = _new_snapshot_budget()
    entries = _bounded_directory_snapshot(directory_fd, _budget, depth)
    for name, before in entries:
        if stat.S_ISDIR(before.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=directory_fd)
            try:
                if not _same_identity(before, os.fstat(child)):
                    raise RuntimeError("provider directory changed before fsync")
                _fsync_publish_tree(child, generation, (*relative, name), depth + 1, _budget)
            finally:
                os.close(child)
        elif stat.S_ISREG(before.st_mode):
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                 dir_fd=directory_fd)
            try:
                if not _same_identity(before, os.fstat(descriptor)):
                    raise RuntimeError("provider file changed before fsync")
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        elif stat.S_ISLNK(before.st_mode):
            _validate_internal_config_link(directory_fd, name, before, generation, relative,
                                           require_private=True)
        else:
            raise ValueError("provider candidate contains an unsupported entry during fsync")
        current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if not _same_identity(before, current):
            raise RuntimeError("provider entry changed during fsync")
    os.fsync(directory_fd)


def _restore_active(providers_fd, previous_target, committed_link):
    current = os.stat(".active", dir_fd=providers_fd, follow_symlinks=False)
    if not _same_identity(committed_link, current) or not stat.S_ISLNK(current.st_mode):
        raise RuntimeError("active provider link changed before rollback")
    if previous_target is None:
        os.unlink(".active", dir_fd=providers_fd)
    else:
        temporary = ".provider-link-rollback-" + uuid.uuid4().hex
        try:
            os.symlink(previous_target, temporary, dir_fd=providers_fd)
            os.replace(temporary, ".active", src_dir_fd=providers_fd, dst_dir_fd=providers_fd)
        finally:
            try:
                os.unlink(temporary, dir_fd=providers_fd)
            except FileNotFoundError:
                pass
    os.fsync(providers_fd)


def _commit_active(providers_fd, versions_fd, versions, generation, expected):
    try:
        previous_target = os.readlink(".active", dir_fd=providers_fd)
        _active_generation(providers_fd, versions_fd, versions)
    except FileNotFoundError:
        previous_target = None
    temporary = ".provider-link-commit-" + uuid.uuid4().hex
    replaced = False
    committed_link = None
    try:
        os.symlink(str(generation), temporary, dir_fd=providers_fd)
        current = os.stat(generation.name, dir_fd=versions_fd, follow_symlinks=False)
        if not _same_identity(expected, current) or not stat.S_ISDIR(current.st_mode):
            raise RuntimeError("provider candidate changed immediately before commit")
        os.replace(temporary, ".active", src_dir_fd=providers_fd, dst_dir_fd=providers_fd)
        replaced = True
        committed_link = os.stat(".active", dir_fd=providers_fd, follow_symlinks=False)
        active_name, active_info = _active_generation(providers_fd, versions_fd, versions)
        if active_name != generation.name or not _same_identity(expected, active_info):
            raise RuntimeError("provider candidate changed during commit")
        os.fsync(providers_fd)
        active_name, active_info = _active_generation(providers_fd, versions_fd, versions)
        if active_name != generation.name or not _same_identity(expected, active_info):
            raise RuntimeError("provider candidate changed after durable commit")
    except BaseException as error:
        if replaced:
            try:
                _restore_active(providers_fd, previous_target, committed_link)
            except BaseException as rollback_error:
                raise RuntimeError("provider commit failed and active-link rollback was incomplete") from rollback_error
        raise error
    finally:
        try:
            os.unlink(temporary, dir_fd=providers_fd)
        except FileNotFoundError:
            pass


def private_generation(generation, expected):
    with _pinned_candidate(generation, expected, require_private=False) as fd:
        _validate_publish_tree(fd, generation, require_private=False)
        _privatize_publish_tree(fd, generation)
        _validate_publish_tree(fd, generation, require_private=True)


def _validate_publishable_generation(generation, expected):
    with _pinned_candidate(generation, expected, require_private=True) as fd:
        _validate_publish_tree(fd, generation, require_private=True)


def _candidate_path(versions, generation):
    versions = Path(os.path.abspath(versions))
    generation_input = Path(generation)
    if (not generation_input.is_absolute() or ".." in generation_input.parts
            or generation_input.parent != versions
            or not GENERATION_NAME.fullmatch(generation_input.name)):
        raise ValueError("provider candidate path leaves the managed versions directory")
    return generation_input


def _remove_candidate_generation_opened(versions, generation, expected,
                                        providers_fd, versions_fd):
    generation = _candidate_path(versions, generation)
    try:
        os.stat(".active", dir_fd=providers_fd, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        _, active_info = _active_generation(providers_fd, versions_fd, versions)
        if _same_identity(expected, active_info):
            raise RuntimeError("refusing to remove the active provider generation")
    current = _generation_info(versions_fd, generation.name, required=True,
                               require_private=False)
    if not _same_identity(expected, current):
        raise RuntimeError("provider candidate was replaced before cleanup")
    fd = os.open(generation.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                 dir_fd=versions_fd)
    try:
        if not _same_identity(expected, os.fstat(fd)):
            raise RuntimeError("provider candidate changed during cleanup")
        _remove_directory_contents(fd, require_private=False)
    finally:
        os.close(fd)
    current = os.stat(generation.name, dir_fd=versions_fd, follow_symlinks=False)
    if not _same_identity(expected, current) or not stat.S_ISDIR(current.st_mode):
        raise RuntimeError("provider candidate changed before final cleanup")
    os.rmdir(generation.name, dir_fd=versions_fd)
    os.fsync(versions_fd)


def _remove_candidate_generation(versions, generation, expected, layout=None):
    if layout is not None:
        return _remove_candidate_generation_opened(
            versions, generation, expected, layout[1], layout[2])
    with _opened_versions(versions) as (providers_fd, versions_fd, canonical_versions):
        return _remove_candidate_generation_opened(
            canonical_versions, generation, expected, providers_fd, versions_fd)


def _cleanup_candidate_best_effort(versions, generation, expected, layout=None):
    try:
        _remove_candidate_generation(versions, generation, expected, layout)
        return True
    except (OSError, RuntimeError, ValueError):
        return False


def _remove_managed_generation(versions_fd, name, expected):
    current = _generation_info(versions_fd, name)
    if current is None or not _same_identity(expected, current):
        raise RuntimeError("provider generation changed before pruning")
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=versions_fd)
    try:
        if not _same_identity(expected, os.fstat(fd)):
            raise RuntimeError("provider generation changed while pruning")
        # Refuse the whole candidate before removing its first byte when its
        # static tree contains an unexpected owner, mode, link, or file type.
        _validate_directory_contents(fd)
        _remove_directory_contents(fd)
    finally:
        os.close(fd)
    current = os.stat(name, dir_fd=versions_fd, follow_symlinks=False)
    if not _same_identity(expected, current) or not stat.S_ISDIR(current.st_mode):
        raise RuntimeError("provider generation changed before final removal")
    os.rmdir(name, dir_fd=versions_fd)


def _scan_versions_usage(directory_fd, usage, root_device, depth=0):
    if depth > MAX_VERSIONS_DEPTH:
        raise ValueError("provider versions tree exceeds its depth budget")
    with os.scandir(directory_fd) as iterator:
        for entry in iterator:
            before = entry.stat(follow_symlinks=False)
            usage["entries"] += 1
            if stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode):
                usage["bytes"] += before.st_size
            if usage["entries"] > MAX_VERSIONS_ENTRIES or usage["bytes"] > MAX_VERSIONS_BYTES:
                raise ValueError("provider versions tree exceeds its hard resource budget")
            if stat.S_ISDIR(before.st_mode):
                if before.st_dev != root_device:
                    raise ValueError("provider versions tree crosses a filesystem boundary")
                child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=directory_fd)
                try:
                    if not _same_identity(before, os.fstat(child)):
                        raise RuntimeError("provider versions entry changed while accounting")
                    _scan_versions_usage(child, usage, root_device, depth + 1)
                    current = os.stat(entry.name, dir_fd=directory_fd, follow_symlinks=False)
                    if not _same_identity(before, current):
                        raise RuntimeError("provider versions entry changed after accounting")
                finally:
                    os.close(child)


def _assert_versions_budget(versions_fd, reserve_generations=2):
    usage = {"entries": 0, "bytes": 0}
    _scan_versions_usage(versions_fd, usage, os.fstat(versions_fd).st_dev)
    if (usage["entries"] + reserve_generations * MAX_SNAPSHOT_ENTRIES > MAX_VERSIONS_ENTRIES
            or usage["bytes"] + reserve_generations * MAX_SNAPSHOT_TOTAL_BYTES > MAX_VERSIONS_BYTES):
        raise ValueError("provider versions tree lacks budget for another bounded generation")
    return usage


def _prune_generations_opened(versions, keep_history, problems,
                              providers_fd, versions_fd):
    providers_info = os.fstat(providers_fd)
    if providers_info.st_uid != os.geteuid() or providers_info.st_mode & 0o022:
        raise ValueError("provider directory has an unsafe owner or mode")
    versions_info = os.fstat(versions_fd)
    if versions_info.st_uid != os.geteuid() or versions_info.st_mode & 0o077:
        raise ValueError("provider versions directory is not private")
    _assert_versions_budget(versions_fd, reserve_generations=0)
    active_name, active_info = _active_generation(providers_fd, versions_fd, versions)
    history = []
    with os.scandir(versions_fd) as entries:
        for entry in entries:
            info = _generation_info(versions_fd, entry.name)
            if info is None:
                if problems is not None:
                    problems.append("unmanaged")
                continue
            if _same_identity(info, active_info):
                continue
            history.append((info.st_mtime_ns, entry.name, info))
    history.sort(key=lambda item: (item[0], item[1]), reverse=True)
    removed = []
    for _, name, expected in history[keep_history:]:
        # Re-read the active link before every destructive operation. A valid
        # concurrent transaction holds the same lock, while this also refuses
        # a surprising out-of-band link swap.
        current_name, current_info = _active_generation(providers_fd, versions_fd, versions)
        if name == current_name or _same_identity(expected, current_info):
            continue
        try:
            _remove_managed_generation(versions_fd, name, expected)
        except (OSError, RuntimeError, ValueError):
            if problems is not None:
                problems.append("unsafe")
            continue
        removed.append(name)
    if removed:
        os.fsync(versions_fd)
    return tuple(removed)


def prune_generations(versions, active, keep_history=DEFAULT_GENERATION_HISTORY,
                      problems=None, layout=None):
    """Keep the active generation plus a bounded number of private snapshots."""
    if type(keep_history) is not int or not 0 <= keep_history <= 32:
        raise ValueError("provider generation history limit is invalid")
    versions_input = Path(versions)
    active_input = Path(active)
    if (not versions_input.is_absolute() or not active_input.is_absolute()
            or ".." in versions_input.parts or ".." in active_input.parts):
        raise ValueError("provider generation paths must be absolute without traversal")
    versions = Path(os.path.abspath(versions_input))
    active = Path(os.path.abspath(active_input))
    if versions.name != ".versions" or active != versions.parent / ".active":
        raise ValueError("provider generation paths do not match the managed layout")
    if layout is not None:
        return _prune_generations_opened(
            versions, keep_history, problems, layout[1], layout[2])
    providers_fd = open_directory(versions.parent)
    try:
        versions_fd = os.open(".versions", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                              dir_fd=providers_fd)
        try:
            return _prune_generations_opened(
                versions, keep_history, problems, providers_fd, versions_fd)
        finally:
            os.close(versions_fd)
    finally:
        os.close(providers_fd)


def validate_generation(generation):
    config_path = generation / "config.toml"
    if not config_path.exists():
        # Native OpenAI defaults are represented by an empty managed config;
        # keeping the stable public link enables atomic credential switching.
        atomic_write(config_path, "")
    config = load_config(config_path)
    declared = config.get("model_catalog_json")
    if declared:
        catalog = validate_models_catalog(load_json_path(declared), include_unconfigured=True)
        model = config.get("model")
        if model and not any(entry.get("slug") == model for entry in catalog["models"] if isinstance(entry, dict)):
            raise ValueError("候选目录不包含当前模型")


def _read_bounded_regular(path, limit=MAX_SNAPSHOT_FILE_BYTES):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        _checked_source_info(before, regular=True)
        if before.st_size > limit:
            raise ValueError("provider file exceeds its byte limit")
        chunks = []
        remaining = before.st_size + 1
        while remaining:
            chunk = os.read(descriptor, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    current = os.stat(path, follow_symlinks=False)
    if (len(data) != before.st_size or _stable_metadata(before) != _stable_metadata(after)
            or _stable_metadata(before) != _stable_metadata(current)):
        raise RuntimeError("provider file changed while reading")
    return data


def effective_state(generation):
    """Compare behavior, not staging paths, JSON whitespace or file inodes."""
    config = load_config(generation / "config.toml")
    declared = config.pop("model_catalog_json", None)
    catalog = None
    if declared:
        catalog = validate_models_catalog(load_json_path(declared), include_unconfigured=True)
    return config, catalog, _read_bounded_regular(generation / "secrets.env")


def ensure_public_link(destination, source):
    if destination.is_symlink() and os.readlink(destination) == str(source):
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_dir() and not destination.is_symlink():
        # Keep legacy directories recoverable. Never recursively delete a
        # user-supplied provider directory during layout migration.
        backup = destination.with_name(destination.name + ".pre-transaction-" + uuid.uuid4().hex)
        os.replace(destination, backup)
        try:
            atomic_link(source, destination)
        except BaseException:
            os.replace(backup, destination)
            raise
    else:
        # The initial generation already contains the previous file bytes.
        atomic_link(source, destination)


def _publish_with_layout(home, env_file, versions, generation, generation_identity,
                         home_fd, providers_fd, versions_fd):
    active = home / "providers" / ".active"
    candidate_fd = _open_candidate_fd(versions_fd, generation, generation_identity,
                                      require_private=True)
    try:
        _validate_publish_tree(candidate_fd, generation, require_private=True)
        _fsync_publish_tree(candidate_fd, generation)
        # The generation directory entry must be durable before .active can be.
        os.fsync(versions_fd)
        try:
            active_info = os.stat(".active", dir_fd=providers_fd, follow_symlinks=False)
        except FileNotFoundError:
            active_info = None
        if active_info is None:
            initial, initial_identity = snapshot(home, env_file, versions,
                                                 layout=(home_fd, providers_fd, versions_fd))
            initial_linked = False
            try:
                private_generation(initial, initial_identity)
                initial_fd = _open_candidate_fd(versions_fd, initial, initial_identity,
                                                require_private=True)
                try:
                    _validate_publish_tree(initial_fd, initial, require_private=True)
                    _fsync_publish_tree(initial_fd, initial)
                    os.fsync(versions_fd)
                    _commit_active(providers_fd, versions_fd, versions, initial, initial_identity)
                finally:
                    os.close(initial_fd)
                initial_linked = True
            finally:
                if not initial_linked:
                    _cleanup_candidate_best_effort(
                        versions, initial, initial_identity,
                        (home_fd, providers_fd, versions_fd))
            previous_name = initial.name
        elif not stat.S_ISLNK(active_info.st_mode):
            raise ValueError("providers/.active 已存在但不是受管理链接")
        else:
            previous_name, _ = _active_generation(providers_fd, versions_fd, versions)
        # First migration installs aliases pointing at the OLD generation. Until
        # the final rename, every alias therefore still exposes the old values.
        ensure_public_link(home / "config.toml", active / "config.toml")
        for mode in MODES:
            ensure_public_link(home / "providers" / mode, active / "providers" / mode)
        ensure_public_link(env_file, active / "secrets.env")
        current_name, _ = _active_generation(providers_fd, versions_fd, versions)
        if current_name != previous_name:
            raise RuntimeError("active provider generation changed before publication")
        _write_private_regular_at(candidate_fd, PREVIOUS_GENERATION_FILE,
                                  (previous_name + "\n").encode("ascii"))
        _validate_publish_tree(candidate_fd, generation, require_private=True)
        _fsync_publish_tree(candidate_fd, generation)
        os.fsync(versions_fd)
        _commit_active(providers_fd, versions_fd, versions, generation, generation_identity)
    finally:
        os.close(candidate_fd)


def publish(home, env_file, versions, generation, generation_identity, layout=None):
    if layout is not None:
        return _publish_with_layout(home, env_file, versions, generation, generation_identity,
                                    *layout)
    with _opened_or_create_layout(home, versions) as opened:
        return _publish_with_layout(home, env_file, versions, generation, generation_identity,
                                    *opened)


def _assert_expected_active(providers_fd, versions_fd, versions, expected):
    if expected is None:
        return
    if expected == "none":
        try:
            os.stat(".active", dir_fd=providers_fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        raise RuntimeError("provider active generation changed before the transaction started")
    if not GENERATION_NAME.fullmatch(expected):
        raise ValueError("expected provider generation name is invalid")
    current, _ = _active_generation(providers_fd, versions_fd, versions)
    if current != expected:
        raise RuntimeError("provider active generation changed before the transaction started")


def _provider_home():
    home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).resolve()
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    return home


def active_generation_name():
    if os.geteuid() == 0:
        drop_service_privileges(os.environ.get("RUN_USER"))
    home = _provider_home()
    versions = home / "providers" / ".versions"
    with _opened_or_create_layout(home, versions) as layout, transaction_lock(home, layout[0]):
        try:
            os.stat(".active", dir_fd=layout[1], follow_symlinks=False)
        except FileNotFoundError:
            return None
        name, _ = _active_generation(layout[1], layout[2], versions)
        return name


def predecessor_generation_name():
    if os.geteuid() == 0:
        drop_service_privileges(os.environ.get("RUN_USER"))
    home = _provider_home()
    versions = home / "providers" / ".versions"
    with _opened_or_create_layout(home, versions) as layout, transaction_lock(home, layout[0]):
        name, expected = _active_generation(layout[1], layout[2], versions)
        generation = versions / name
        candidate_fd = _open_candidate_fd(layout[2], generation, expected, require_private=True)
        try:
            raw = _read_private_regular_at(candidate_fd, PREVIOUS_GENERATION_FILE)
        finally:
            os.close(candidate_fd)
        try:
            previous = raw.decode("ascii").rstrip("\n")
        except UnicodeDecodeError:
            raise ValueError("provider predecessor metadata is invalid") from None
        if not GENERATION_NAME.fullmatch(previous) or raw != (previous + "\n").encode("ascii"):
            raise ValueError("provider predecessor metadata is invalid")
        _generation_info(layout[2], previous, required=True)
        return previous


def restore_generation(name):
    if not isinstance(name, str) or not GENERATION_NAME.fullmatch(name):
        raise ValueError("provider restore generation name is invalid")
    if os.geteuid() == 0:
        drop_service_privileges(os.environ.get("RUN_USER"))
    home = _provider_home()
    versions = home / "providers" / ".versions"
    generation = versions / name
    with _opened_or_create_layout(home, versions) as layout, transaction_lock(home, layout[0]):
        expected = _generation_info(layout[2], name, required=True)
        candidate_fd = _open_candidate_fd(layout[2], generation, expected, require_private=True)
        try:
            _validate_publish_tree(candidate_fd, generation, require_private=True)
            _fsync_publish_tree(candidate_fd, generation)
            os.fsync(layout[2])
            _commit_active(layout[1], layout[2], versions, generation, expected)
        finally:
            os.close(candidate_fd)
    print("[provider-transaction] 已恢复上一供应商版本", flush=True)
    return 0


def execute(mode, command):
    if mode not in (*MODES, "openai"):
        raise ValueError("invalid provider transaction mode")
    if os.geteuid() == 0:
        # Root must never maintain a service-writable generation as root.
        drop_service_privileges(os.environ.get("RUN_USER"))
    if not command:
        raise ValueError("provider transaction command required")
    script = Path(command[0]).resolve(strict=True)
    if not script.is_file():
        raise ValueError("provider transaction command must be a file")
    home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).resolve()
    requested_env = os.environ.get("ENV_FILE", str(home / "secrets.env"))
    env_file = environment_file(home, requested_env)
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    versions = home / "providers" / ".versions"
    with _opened_or_create_layout(home, versions) as layout, transaction_lock(home, layout[0]):
        _assert_expected_active(layout[1], layout[2], versions,
                                os.environ.get("PROVIDER_EXPECTED_ACTIVE"))
        env_file = environment_file(home, requested_env)
        current = load_config(home / "config.toml")
        if os.environ.get("CUSTOM_SYNC_CATALOG") == "1" and current.get("model_provider") != "custom":
            raise ValueError("活动供应商已改变，未同步过期的端点配置")
        if os.environ.get("ZHIPU_SYNC_CATALOG") == "1" and (mode != "zhipu" or current.get("model_provider") != "ZAI"):
            raise ValueError("活动供应商已改变，未同步过期的智谱目录")
        _assert_versions_budget(layout[2])
        generation, generation_identity = snapshot(home, env_file, versions, layout=layout)
        child_env = _provider_child_environment(generation)
        published = False
        try:
            before = effective_state(generation)
            if os.environ.get("CUSTOM_SYNC_CATALOG") == "1":
                custom_sync_environment(generation, child_env)
            if os.environ.get("ZHIPU_SYNC_CATALOG") == "1":
                zhipu_sync_environment(generation, child_env)
            result = subprocess.run(["bash", str(script), *command[1:]], cwd=script.parent, env=child_env, check=False)
            if result.returncode:
                return result.returncode
            with _pinned_candidate(generation, generation_identity, require_private=False) as candidate_fd:
                _validate_publish_tree(candidate_fd, generation, require_private=False)
            _assert_versions_budget(layout[2], reserve_generations=0)
            validate_generation(generation)
            is_refresh = os.environ.get("CUSTOM_SYNC_CATALOG") == "1" or os.environ.get("ZHIPU_SYNC_CATALOG") == "1"
            if is_refresh and effective_state(generation) == before:
                print("[provider-transaction] 在线目录与当前配置相同；未发布新版本，无需重启", flush=True)
                print('[codex-harness-result] {"changed":false,"restartRequired":false}', flush=True)
                return 0
            private_generation(generation, generation_identity)
            publish(home, env_file, versions, generation, generation_identity, layout=layout)
            published = True
            try:
                retention_problems = []
                removed = prune_generations(versions, home / "providers" / ".active",
                                            problems=retention_problems, layout=layout)
            except (OSError, RuntimeError, ValueError):
                # Publishing has already committed. Retention failure must not
                # misreport a rollback, and no attacker-controlled path or
                # exception text is included in this warning.
                print("[provider-transaction] 警告：历史版本安全清理未完成；活动版本未受影响", file=sys.stderr, flush=True)
            else:
                if removed:
                    print(f"[provider-transaction] 已安全清理 {len(removed)} 个过期历史版本", flush=True)
                if retention_problems:
                    print(f"[provider-transaction] 警告：{len(retention_problems)} 个历史/未知条目未满足安全清理条件；达到总预算后将拒绝继续发布",
                          file=sys.stderr, flush=True)
            print("[provider-transaction] 配置、目录和密钥已作为同一版本提交；最近历史版本有限保留供恢复", flush=True)
            print('[codex-harness-result] {"changed":true,"restartRequired":true}', flush=True)
            return 0
        finally:
            if not published and not _cleanup_candidate_best_effort(
                    versions, generation, generation_identity, layout):
                # The original candidate may have been moved, or publication
                # may have committed before a durability error. In either case
                # never follow the old name into a replacement or active tree.
                print("[provider-transaction] 警告：候选版本身份已变化或仍处于活动状态，未执行路径清理",
                      file=sys.stderr, flush=True)


def main(argv):
    if not argv:
        raise ValueError("provider transaction mode required")
    if argv[0] == "active-name":
        if len(argv) != 1:
            raise ValueError("active-name takes no arguments")
        name = active_generation_name()
        if name is None:
            return 3
        print(name)
        return 0
    if argv[0] == "restore-active":
        if len(argv) != 2:
            raise ValueError("restore-active requires one generation name")
        return restore_generation(argv[1])
    if argv[0] == "predecessor-name":
        if len(argv) != 1:
            raise ValueError("predecessor-name takes no arguments")
        print(predecessor_generation_name())
        return 0
    return execute(argv[0], argv[1:])


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except ServiceIdentityError as error:
        print("[provider-transaction] " + str(error), file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        # Parser errors can include source fragments, so do not print arbitrary
        # exception strings that may contain an embedded historical credential.
        print(f"[provider-transaction] 配置操作未提交（{type(error).__name__}）；活动版本未替换", file=sys.stderr)
        raise SystemExit(1)
