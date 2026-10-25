"""Trusted no-turn probe, executed as the offline builder, never as root."""
from __future__ import annotations

import argparse
import errno
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from deploy.common import CODEX_VERSION, require
from deploy.provider import validate_catalog


def denied_open(path: Path, flags: int) -> None:
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        require(exc.errno in (errno.EACCES, errno.EPERM, errno.EROFS, errno.ENOENT), "Unexpected boundary failure")
    else:
        os.close(descriptor)
        raise RuntimeError("Sandbox allowed protected file access")


def probe_cli(binary: Path, home: Path) -> dict:
    home.mkdir(mode=0o700)
    model = "harness-installation-probe"
    catalog = validate_catalog({"expectedRevision": "a" * 32, "models": [
        {"id": model, "defaultEffort": "none", "efforts": []}]},
        {"revision": "a" * 32, "kind": "responses", "models": []})["nativeCatalog"]
    (home / "models.json").write_text(json.dumps(catalog), encoding="utf-8")
    (home / "config.toml").write_text(
        'model = ' + json.dumps(model) + '\nmodel_catalog_json = ' + json.dumps(str(home / "models.json")) +
        '\nmodel_provider = "probe"\n[analytics]\nenabled = false\n[model_providers.probe]\n'
        'name = "Installation probe"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n', encoding="utf-8")
    environment = {key: value for key, value in os.environ.items() if key in ("PATH", "SYSTEMROOT", "WINDIR", "LANG", "TMPDIR", "TMP", "TEMP")}
    environment.update(HOME=str(home), CODEX_HOME=str(home))
    version = subprocess.run([str(binary), "--version"], cwd=home, env=environment, capture_output=True, text=True, timeout=15, check=True)
    require(version.stdout.strip() == "codex-cli " + CODEX_VERSION, "Pinned CLI version probe failed")
    child = subprocess.Popen([str(binary), "app-server", "--listen", "stdio://"], cwd=home, env=environment,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    received = 0
    def send(value):
        child.stdin.write(json.dumps(value).encode() + b"\n")
        child.stdin.flush()
    def response(ident):
        nonlocal received
        for _ in range(128):
            line = child.stdout.readline(1024 * 1024 + 1)
            received += len(line)
            require(line and line.endswith(b"\n") and received <= 1024 * 1024, "Invalid or oversized native probe response")
            value = json.loads(line)
            require("method" not in value or "id" not in value, "Unexpected native server request during initialization")
            if value.get("id") == ident:
                require("result" in value and "error" not in value, "Native initialization probe failed")
                return value["result"]
        raise RuntimeError("Native probe message budget exceeded")
    try:
        send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "harness_install_probe", "version": "1.0.0"}, "capabilities": {"experimentalApi": True}}})
        response(1)
        send({"method": "initialized"})
        send({"id": 2, "method": "model/list", "params": {}})
        result = response(2)
        require([item["id"] for item in result.get("data", [])] == [model], "Native model catalog probe failed")
        child.stdin.close()
        require(child.wait(timeout=10) == 0, "Native probe did not exit cleanly")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)
        child.stdout.close()
        if not child.stdin.closed:
            child.stdin.close()
    return {"codexVersion": CODEX_VERSION, "initialized": True, "modelCatalog": True, "turns": 0}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--token", type=Path, required=True)
    args = parser.parse_args()
    require(os.geteuid() != 0, "Runtime probe must not execute as root")
    import resource
    require(resource.getrlimit(resource.RLIMIT_NOFILE)[0] <= 4096, "Sandbox FD bound absent")
    require(not any(key in os.environ for key in ("OPENAI_API_KEY", "HARNESS_PROVIDER_API_KEY", "Z_AI_API_KEY", "CODEX_HOME")),
            "Inherited credential environment reached candidate probe")
    denied_open(args.token, os.O_RDONLY)
    denied_open(args.source / "package.json", os.O_WRONLY)
    try:
        connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    except OSError as exc:
        require(exc.errno in (errno.EPERM, errno.EACCES, errno.EAFNOSUPPORT), "Unexpected network boundary failure")
    else:
        connection.close()
        raise RuntimeError("Offline candidate can create an Internet socket")
    def expired(signum, frame):
        raise TimeoutError("Native initialization probe exceeded 45 seconds")
    signal.signal(signal.SIGALRM, expired)
    signal.alarm(45)
    try:
        probe_cli(args.codex, args.workspace / "runtime-probe-home")
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    main()
