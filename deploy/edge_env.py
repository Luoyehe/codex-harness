"""Update only edge fields while sharing the provider generation lock."""
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR / "providers"))
from atomic_write import atomic_write
from bounded_read import read_text_bounded
from service_env import ServiceIdentityError, drop_service_privileges, locked_environment, service_account, write_regular

KEYS = ("TRUSTED_HOSTS=", "GATEWAY_HTTPS=")
MAX_EDGE_SNAPSHOT_BYTES = 16 * 1024
MAX_WORKER_PAYLOAD_BYTES = 64 * 1024
WORKER_TIMEOUT_SECONDS = 15


def replace_edge_fields(text, fields):
    lines = [line for line in text.splitlines() if not line.startswith(KEYS)]
    return "\n".join(lines + fields) + "\n"


def update(home, env_file, action, value):
    with locked_environment(home, env_file) as (directory, name, current):
        current = current or ""
        if action == "snapshot":
            return [line for line in current.splitlines() if line.startswith(KEYS)]
        if action == "restore":
            fields = value
            if not isinstance(fields, list) or not all(isinstance(line, str) and line.startswith(KEYS) and "\n" not in line and "\r" not in line for line in fields):
                raise ValueError("invalid edge environment snapshot")
        elif action == "set":
            if "\n" in value or "\r" in value:
                raise ValueError("invalid trusted hosts")
            fields = ["TRUSTED_HOSTS=" + value, "GATEWAY_HTTPS=" + ("true" if value else "false")]
        else:
            raise ValueError("unknown edge environment operation")
        write_regular(directory, name, replace_edge_fields(current, fields))


def main():
    if len(sys.argv) < 2:
        raise ValueError("usage: edge_env.py HOME ENV_FILE snapshot|restore|set VALUE")
    if sys.argv[1] == "--worker":
        if len(sys.argv) != 3:
            raise ValueError("invalid edge environment worker invocation")
        drop_service_privileges(sys.argv[2])
        raw = sys.stdin.buffer.read(MAX_WORKER_PAYLOAD_BYTES + 1)
        if len(raw) > MAX_WORKER_PAYLOAD_BYTES:
            raise ValueError("edge environment worker payload exceeds its byte limit")
        arguments = json.loads(raw)
        if not isinstance(arguments, list) or len(arguments) != 4:
            raise ValueError("invalid edge environment worker payload")
        result = update(*arguments)
        print(json.dumps(result))
        return
    if len(sys.argv) != 5:
        raise ValueError("usage: edge_env.py HOME ENV_FILE snapshot|restore|set VALUE")
    home, env_file, action, value = sys.argv[1:5]
    # Rollback snapshots live in root's private transaction directory. Only
    # the scalar edge fields cross the privilege boundary; all service paths
    # and locks are opened after the child permanently drops its identity.
    payload = json.loads(read_text_bounded(value, MAX_EDGE_SNAPSHOT_BYTES)) if action == "restore" else value
    if os.geteuid() == 0:
        import subprocess
        user = os.environ.get("RUN_USER", "")
        account = service_account(user)
        worker_environment = {
            "HOME": account.pw_dir,
            "USER": account.pw_name,
            "LOGNAME": account.pw_name,
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
        }
        try:
            child = subprocess.run([sys.executable, "-I", __file__, "--worker", user],
                                   input=json.dumps([home, env_file, action, payload]),
                                   text=True, capture_output=True, check=False,
                                   timeout=WORKER_TIMEOUT_SECONDS,
                                   env=worker_environment)
        except subprocess.TimeoutExpired:
            raise ValueError("service environment operation timed out") from None
        if child.returncode:
            raise ValueError("service environment operation refused; check RUN_USER, ownership and managed links")
        if len(child.stdout.encode("utf-8")) > MAX_WORKER_PAYLOAD_BYTES:
            raise ValueError("service environment response exceeds its byte limit")
        result = json.loads(child.stdout)
    else:
        result = update(home, env_file, action, payload)
    if action == "snapshot":
        atomic_write(value, json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except ServiceIdentityError as error:
        raise SystemExit("[edge-env] " + str(error)) from None
    except (ValueError, OSError, RuntimeError) as error:
        raise SystemExit(f"[edge-env] operation refused ({type(error).__name__}); check RUN_USER, ownership and managed paths") from None
