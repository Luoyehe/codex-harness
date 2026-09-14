"""Resolve the npm tool directory without persisting ambient PATH entries."""
import argparse
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from trusted_paths import trusted_path


def require_root_owned(path, stat_fn=os.stat, directory=True):
    info = stat_fn(path)
    kind_ok = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not kind_ok or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError(f"untrusted tools path: {path} (root ownership and no group/other write required)")


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
            prefix_fn = lambda: subprocess.check_output([npm, "prefix", "-g"], text=True).strip()
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
