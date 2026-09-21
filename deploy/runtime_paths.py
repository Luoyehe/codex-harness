"""Resolve the npm tool directory without persisting ambient PATH entries."""
import argparse
import os
from pathlib import Path, PurePosixPath
import re
import signal
import shutil
import subprocess
import sys
import threading
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from trusted_paths import trusted_path


MAX_NPM_PREFIX_BYTES = 4096
NPM_PREFIX_TIMEOUT_SECONDS = 10


def _kill_process_group(process):
    """Terminate npm and any helper that inherited its output pipe."""
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (AttributeError, ProcessLookupError, PermissionError, OSError):
        try:
            process.kill()
        except ProcessLookupError:
            pass


def _npm_prefix(npm, *, timeout_seconds=NPM_PREFIX_TIMEOUT_SECONDS,
                max_output_bytes=MAX_NPM_PREFIX_BYTES):
    """Read npm's global prefix without inheriting Node injection settings."""
    if timeout_seconds <= 0 or max_output_bytes <= 0:
        raise ValueError("invalid npm prefix resource budget")
    search_path = os.pathsep.join((str(Path(npm).parent), "/usr/local/sbin",
                                   "/usr/local/bin", "/usr/sbin", "/usr/bin",
                                   "/sbin", "/bin"))
    environment = {"PATH": search_path, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
    process = subprocess.Popen(
        [npm, "prefix", "-g"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, env=environment, start_new_session=True)
    output = []
    failures = []

    def read_output():
        try:
            output.append(process.stdout.read(max_output_bytes + 1))
        except BaseException as error:  # surfaced in the controlling thread
            failures.append(error)

    reader = threading.Thread(target=read_output, daemon=True)
    deadline = time.monotonic() + timeout_seconds
    reader.start()
    reader.join(max(0, deadline - time.monotonic()))
    if reader.is_alive():
        _kill_process_group(process)
        process.wait()
        reader.join(1)
        if reader.is_alive():
            raise ValueError("npm prefix output pipe did not close after termination")
        process.stdout.close()
        raise ValueError("npm prefix discovery timed out")
    if failures:
        _kill_process_group(process)
        process.wait()
        process.stdout.close()
        raise OSError("failed to read npm prefix output") from failures[0]
    raw = output[0]
    if len(raw) > max_output_bytes:
        _kill_process_group(process)
        process.wait()
        process.stdout.close()
        raise ValueError("npm prefix output exceeds its byte limit")
    try:
        status = process.wait(timeout=max(0.001, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        _kill_process_group(process)
        process.wait()
        raise ValueError("npm prefix discovery timed out") from None
    finally:
        process.stdout.close()
    if status:
        raise subprocess.CalledProcessError(status, [npm, "prefix", "-g"])
    try:
        prefix = raw.decode("utf-8").strip()
    except UnicodeDecodeError:
        raise ValueError("npm prefix output is not UTF-8") from None
    if not prefix:
        raise ValueError("npm returned an empty global prefix")
    return prefix


def trusted_tools_bin(value, allow_missing=False, stat_fn=None):
    if not value.startswith("/") or not re.fullmatch(r"[A-Za-z0-9_./@+-]+", value):
        raise ValueError("TOOLS_BIN_DIR must be an absolute path with safe characters")
    target = PurePosixPath(value)
    if target.name != "bin":
        raise ValueError("TOOLS_BIN_DIR must be the bin directory of an npm prefix")
    try:
        target = PurePosixPath(trusted_path(value, missing=allow_missing, directory=True, lstat_fn=stat_fn))
    except FileNotFoundError:
        raise ValueError("TOOLS_BIN_DIR does not exist; install its tools first") from None
    if target.name != "bin" or not re.fullmatch(r"[A-Za-z0-9_./@+-]+", str(target)):
        raise ValueError("canonical TOOLS_BIN_DIR must be a safe npm bin directory")
    tool = target / "zai-mcp-server"
    if os.path.lexists(tool):
        # npm bin entries are symlinks. Their 0777 link mode is harmless, but
        # the executable target and its real parents must not be writable by
        # an unprivileged account before adding this directory to service PATH.
        trusted_path(str(tool), lstat_fn=stat_fn)
    return str(target)


def resolve_tools_bin(value="", allow_missing=False, stat_fn=None, prefix_fn=None):
    if not value:
        if prefix_fn is None:
            npm = trusted_path(os.environ.get("NPM_BIN") or shutil.which("npm") or "")
            prefix_fn = lambda: _npm_prefix(npm)
        value = prefix_fn().rstrip("/") + "/bin"
    return trusted_tools_bin(value, allow_missing, stat_fn)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", nargs="?", default="")
    parser.add_argument("--allow-missing", action="store_true")
    args = parser.parse_args()
    try:
        print(resolve_tools_bin(args.directory, args.allow_missing))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error
