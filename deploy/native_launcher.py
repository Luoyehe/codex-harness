"""Fixed native-UID entrypoints; no caller-selected command, home or environment."""
from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import time

from .common import Layout, read_json, require


def project_from_input(data: bytes) -> dict:
    require(len(data) <= 4096, "Project request exceeds budget")
    value = json.loads(data)
    require(isinstance(value, dict) and set(value) == {"path"} and isinstance(value["path"], str), "Invalid project request")
    value = value["path"]
    require(value and Path(value).is_absolute() and not any(ord(char) < 32 for char in value), "Project path must be absolute")
    resolved = Path(value).resolve(strict=True)
    require(resolved.is_dir() and os.access(resolved, os.R_OK | os.X_OK), "Native identity cannot access this project")
    result = {"path": str(resolved), "name": resolved.name or str(resolved)}
    require(len(json.dumps(result).encode()) <= 8192, "Resolved project exceeds budget")
    return result


def security_process() -> None:
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
    require(all(key in status and int(status[key].strip(), 16) == 0 for key in ("CapInh", "CapPrm", "CapEff", "CapAmb")),
            "Native execution retained capabilities")
    libc = ctypes.CDLL(None, use_errno=True)
    # These settings survive child exec. Subreaping lets cleanup collect children
    # that create new sessions instead of treating a process group as containment.
    require(libc.prctl(38, 1, 0, 0, 0) == 0, "Cannot set no_new_privs")
    require(libc.prctl(36, 1, 0, 0, 0) == 0, "Cannot establish native child supervision")


def direct_children() -> list[int]:
    text = Path(f"/proc/self/task/{os.getpid()}/children").read_text()
    return [int(item) for item in text.split()]


def clean_children(child: subprocess.Popen, deadline: float) -> bool:
    def send(pid, signum, group=False):
        try:
            (os.killpg if group else os.kill)(pid, signum)
        except ProcessLookupError:
            pass
    send(child.pid, signal.SIGTERM, True)
    started = time.monotonic()
    while time.monotonic() < deadline:
        child.poll()
        children = direct_children()
        for pid in children:
            send(pid, signal.SIGKILL if time.monotonic() - started > 0.5 else signal.SIGTERM)
            if pid != child.pid:
                try:
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass
        if not direct_children() and child.poll() is not None:
            return True
        if time.monotonic() - started > 0.5:
            send(child.pid, signal.SIGKILL, True)
        time.sleep(0.025)
    return False


def supervise(command: list[str], environment: dict[str, str], cwd: str, *, streaming: bool) -> int:
    stop_requested = False
    def stop(signum, frame):
        nonlocal stop_requested
        stop_requested = True
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, stop)
    child = subprocess.Popen(command, cwd=cwd, env=environment, stdin=subprocess.PIPE if streaming else subprocess.DEVNULL,
                             stdout=sys.stdout.buffer, stderr=sys.stderr.buffer, start_new_session=True, close_fds=True)
    selector = selectors.DefaultSelector()
    pending = bytearray()
    input_ended = not streaming
    ended_at = time.monotonic() if input_ended else None
    stdin_registered = False
    output_registered = False
    input_capacity = 8 * 1024 * 1024
    if streaming:
        os.set_blocking(child.stdin.fileno(), False)
        selector.register(sys.stdin.fileno(), selectors.EVENT_READ, "input")
        stdin_registered = True
    try:
        while child.poll() is None and not stop_requested:
            if input_ended and not pending and child.stdin is not None and not child.stdin.closed:
                if output_registered:
                    selector.unregister(child.stdin.fileno())
                    output_registered = False
                child.stdin.close()
                ended_at = time.monotonic()
            if ended_at is not None and time.monotonic() - ended_at > (2 if streaming else 10):
                break
            for key, _ in selector.select(0.1):
                if key.data == "input":
                    data = os.read(sys.stdin.fileno(), min(65536, input_capacity - len(pending)))
                    if not data:
                        input_ended = True
                        selector.unregister(sys.stdin.fileno())
                        stdin_registered = False
                    else:
                        pending.extend(data)
                        if len(pending) == input_capacity:
                            selector.unregister(sys.stdin.fileno())
                            stdin_registered = False
                elif pending:
                    try:
                        count = os.write(child.stdin.fileno(), pending)
                        del pending[:count]
                    except BlockingIOError:
                        pass
            if streaming and not input_ended and not stdin_registered and len(pending) < input_capacity:
                selector.register(sys.stdin.fileno(), selectors.EVENT_READ, "input")
                stdin_registered = True
            if streaming and child.stdin is not None and not child.stdin.closed:
                if pending and not output_registered:
                    selector.register(child.stdin.fileno(), selectors.EVENT_WRITE, "output")
                    output_registered = True
                elif not pending and output_registered:
                    selector.unregister(child.stdin.fileno())
                    output_registered = False
        natural = child.poll()
    finally:
        selector.close()
        if child.stdin is not None and not child.stdin.closed:
            child.stdin.close()
        require(clean_children(child, time.monotonic() + 3), "Native descendants did not stop; supervisor must fail")
    # For the streaming bridge, zero acknowledges a requested, verified stop.
    # systemd signals the entire cgroup, and EOF can require forced cleanup;
    # neither implies an unconfirmed process tree after clean_children succeeds.
    # Spontaneous native exits and non-streaming helpers retain their exit code.
    if streaming and (stop_requested or input_ended):
        return 0
    return natural if natural is not None else 1


def native_main(instance: str) -> None:
    try:
        require(sys.argv[1:] in (["version"], ["app-server"], ["resolve-project"], ["workspace"], ["bedrock-token"]), "Unsupported native launcher invocation")
        layout = Layout(instance)
        settings = read_json(layout.config / "native.json")
        require(os.getuid() == os.geteuid() == settings["uid"] != 0 and os.getgid() == os.getegid() == settings["gid"],
                "Native launcher must run as its fixed unprivileged identity")
        require(set(os.getgroups()) <= {settings["gid"]}, "Unexpected native supplementary group")
        os.closerange(3, 8192)
        os.umask(0o077)
        security_process()
        if sys.argv[1] == "workspace":
            from .workspace import workspace_main
            workspace_main(layout, settings)
            return
        if sys.argv[1] == "resolve-project":
            result = project_from_input(sys.stdin.buffer.read(4097))
            print(json.dumps(result))
            return
        env_path = layout.config / "providers/current/native-env.json"
        mode = env_path.stat()
        require(stat.S_ISREG(mode.st_mode) and mode.st_uid == 0 and mode.st_gid == settings["gid"] and stat.S_IMODE(mode.st_mode) == 0o640,
                "Native provider environment ownership changed")
        secrets = read_json(env_path, 32768)
        require(isinstance(secrets, dict) and not set(secrets) - {"HARNESS_PROVIDER_API_KEY", "Z_AI_API_KEY", "Z_AI_MODE", "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"} and
                all(isinstance(value, str) and "\x00" not in value for value in secrets.values()), "Invalid native environment")
        if sys.argv[1] == "bedrock-token":
            token = secrets.get("AWS_BEARER_TOKEN_BEDROCK")
            require(isinstance(token, str) and 0 < len(token.encode()) <= 8192 and token == token.strip() and
                    not any(ord(char) < 32 or ord(char) == 127 for char in token), "Managed Bedrock bearer is unavailable")
            sys.stdout.write(token + "\n")
            return
        environment = {"HOME": settings["cwd"], "CODEX_HOME": settings["home"], "LANG": "C.UTF-8", "TERM": "xterm-256color",
                       "PATH": str(layout.app / "current/node/bin") + ":/usr/local/bin:/usr/bin:/bin", **secrets}
        if "AWS_BEARER_TOKEN_BEDROCK" in secrets:
            # AWS profile/credential_process paths never come from native .env
            # or user files. The fixed bearer command handles request auth;
            # the explicit region is also used by the native static catalog.
            environment.update(AWS_CONFIG_FILE="/dev/null", AWS_SHARED_CREDENTIALS_FILE="/dev/null", AWS_EC2_METADATA_DISABLED="true")
        arguments = [settings["bin"], "--version"] if sys.argv[1] == "version" else [settings["bin"], "app-server", "--listen", "stdio://"]
        raise SystemExit(supervise(arguments, environment, settings["cwd"], streaming=sys.argv[1] == "app-server"))
    except Exception:
        sys.stderr.write("Native launcher failed its fixed identity or lifecycle check.\n")
        raise SystemExit(1)
