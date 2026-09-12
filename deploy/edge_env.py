"""Update only edge fields while sharing the provider generation lock."""
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent / "providers"))
from atomic_write import atomic_write
from service_env import ServiceIdentityError, drop_service_privileges, locked_environment, service_account, write_regular

KEYS = ("TRUSTED_HOSTS=", "GATEWAY_HTTPS=")


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
    if sys.argv[1] == "--worker":
        drop_service_privileges(sys.argv[2])
        result = update(*json.load(sys.stdin))
        print(json.dumps(result))
        return
    home, env_file, action, value = sys.argv[1:5]
    # Rollback snapshots live in root's private transaction directory. Only
    # the scalar edge fields cross the privilege boundary; all service paths
    # and locks are opened after the child permanently drops its identity.
    payload = json.loads(Path(value).read_text(encoding="utf-8")) if action == "restore" else value
    if os.geteuid() == 0:
        import subprocess
        user = os.environ.get("RUN_USER", "")
        service_account(user)
        child = subprocess.run([sys.executable, __file__, "--worker", user],
                               input=json.dumps([home, env_file, action, payload]),
                               text=True, capture_output=True, check=False)
        if child.returncode:
            raise ValueError("service environment operation refused; check RUN_USER, ownership and managed links")
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
