"""Stage, validate, then atomically publish a complete provider generation.

The public config, provider sets, and EnvironmentFile all traverse one .active
symlink. A single rename publishes their new generation. Failed setup never
touches active data. Old generations remain private rollback snapshots.
"""
import contextlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from service_env import ServiceIdentityError, drop_service_privileges
from atomic_write import atomic_write
from toml_config import load_config, save_config, rebase_catalog

MODES = ("custom", "zhipu")


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
    with open(catalog_path, encoding="utf-8") as stream:
        catalog = json.load(stream)
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
    atomic_write(custom / "models.json", json.dumps(catalog, ensure_ascii=False) + "\n")


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
def transaction_lock(home):
    # Configuration setup is supported on Linux. Windows can exercise the
    # parser/snapshot unit tests, but must not fake a successful unlocked edit.
    import fcntl
    lock_path = home / ".provider-transaction.lock"
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("另一个供应商配置事务正在运行，请稍后重试") from None
        yield
    finally:
        os.close(fd)


def snapshot(home, env_file, versions):
    generation = Path(tempfile.mkdtemp(prefix="generation-", dir=versions))
    try:
        (generation / "providers").mkdir(mode=0o700)
        for mode in MODES:
            source = home / "providers" / mode
            target = generation / "providers" / mode
            if source.is_dir():
                shutil.copytree(source, target)
                config_path = target / "config.toml"
                if config_path.exists():
                    config = load_config(config_path)
                    rebase_catalog(config, source, target)
                    save_config(config_path, config)
            else:
                target.mkdir(mode=0o700)
        # Preserve the active configuration as data, not a link back into live
        # storage. The child activates its chosen candidate set within generation.
        config = load_config(home / "config.toml")
        for mode in MODES:
            rebase_catalog(config, home / "providers" / mode, generation / "providers" / mode)
        save_config(generation / "config.toml", config)
        if env_file.exists():
            shutil.copyfile(env_file, generation / "secrets.env")
            os.chmod(generation / "secrets.env", 0o600)
        else:
            atomic_write(generation / "secrets.env", "")
        return generation
    except BaseException:
        if generation.parent == versions:
            shutil.rmtree(generation)
        raise


def private_generation(generation):
    for directory, subdirs, files in os.walk(generation, followlinks=False):
        for name in [".", *subdirs, *files]:
            item = Path(directory) / name
            if item.is_symlink():
                continue
            os.chmod(item, 0o700 if item.is_dir() else 0o600)


def validate_generation(generation):
    config_path = generation / "config.toml"
    if not config_path.exists():
        # Native OpenAI defaults are represented by an empty managed config;
        # keeping the stable public link enables atomic credential switching.
        atomic_write(config_path, "")
    config = load_config(config_path)
    declared = config.get("model_catalog_json")
    if declared:
        with open(declared, encoding="utf-8") as stream:
            catalog = json.load(stream)
        if not isinstance(catalog.get("models"), list) or not catalog["models"]:
            raise ValueError("候选模型目录为空或无效")
        model = config.get("model")
        if model and not any(entry.get("slug") == model for entry in catalog["models"] if isinstance(entry, dict)):
            raise ValueError("候选目录不包含当前模型")


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


def publish(home, env_file, versions, generation):
    active = home / "providers" / ".active"
    if not active.is_symlink():
        if active.exists():
            raise ValueError("providers/.active 已存在但不是受管理链接")
        initial = snapshot(home, env_file, versions)
        private_generation(initial)
        atomic_link(initial, active)
    elif not active.resolve().is_relative_to(versions.resolve()):
        raise ValueError("providers/.active 指向受管理版本目录之外")
    # First migration installs aliases pointing at the OLD generation. Until
    # the final rename, every alias therefore still exposes the old values.
    ensure_public_link(home / "config.toml", active / "config.toml")
    for mode in MODES:
        ensure_public_link(home / "providers" / mode, active / "providers" / mode)
    ensure_public_link(env_file, active / "secrets.env")
    atomic_link(generation, active)  # the one commit point


def execute(mode, command):
    if mode not in (*MODES, "openai"):
        raise ValueError("invalid provider transaction mode")
    if os.geteuid() == 0:
        # Root must never maintain a service-writable generation as root.
        drop_service_privileges(os.environ.get("RUN_USER"))
    home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).resolve()
    requested_env = os.environ.get("ENV_FILE", str(home / "secrets.env"))
    env_file = environment_file(home, requested_env)
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    versions = home / "providers" / ".versions"
    versions.mkdir(parents=True, exist_ok=True, mode=0o700)
    with transaction_lock(home):
        env_file = environment_file(home, requested_env)
        current = load_config(home / "config.toml")
        if os.environ.get("CUSTOM_SYNC_CATALOG") == "1" and current.get("model_provider") != "custom":
            raise ValueError("活动供应商已改变，未同步过期的端点配置")
        if os.environ.get("ZHIPU_SYNC_CATALOG") == "1" and (mode != "zhipu" or current.get("model_provider") != "ZAI"):
            raise ValueError("活动供应商已改变，未同步过期的智谱目录")
        generation = snapshot(home, env_file, versions)
        child_env = dict(os.environ, CODEX_HOME=str(generation), ENV_FILE=str(generation / "secrets.env"),
                         HARNESS_PROVIDER_TRANSACTION="1", PYTHONDONTWRITEBYTECODE="1")
        try:
            if os.environ.get("CUSTOM_SYNC_CATALOG") == "1":
                custom_sync_environment(generation, child_env)
            if os.environ.get("ZHIPU_SYNC_CATALOG") == "1":
                zhipu_sync_environment(generation, child_env)
            result = subprocess.run(["bash", *command], env=child_env, check=False)
            if result.returncode:
                return result.returncode
            validate_generation(generation)
            private_generation(generation)
            publish(home, env_file, versions, generation)
            print("[provider-transaction] 配置、目录和密钥已作为同一版本提交；旧版本保留供恢复", flush=True)
            return 0
        finally:
            # Failed candidates contain private data; remove only this exact
            # freshly-created directory, never an active or legacy snapshot.
            active = home / "providers" / ".active"
            if generation.parent == versions and (not active.exists() or active.resolve() != generation.resolve()):
                shutil.rmtree(generation)


if __name__ == "__main__":
    try:
        raise SystemExit(execute(sys.argv[1], sys.argv[2:]))
    except ServiceIdentityError as error:
        print("[provider-transaction] " + str(error), file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        # Parser errors can include source fragments, so do not print arbitrary
        # exception strings that may contain an embedded historical credential.
        print(f"[provider-transaction] 配置操作未提交（{type(error).__name__}）；活动版本未替换", file=sys.stderr)
        raise SystemExit(1)
