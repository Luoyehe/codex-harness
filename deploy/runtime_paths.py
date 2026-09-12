"""Resolve the npm tool directory without persisting ambient PATH entries."""
import argparse
import os
from pathlib import Path
import re
import stat
import subprocess


def require_root_owned(path, stat_fn=os.stat, directory=True):
    info = stat_fn(path)
    kind_ok = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not kind_ok or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError(f"untrusted tools path: {path} (root ownership and no group/other write required)")


def trusted_tools_bin(value, allow_missing=False, stat_fn=os.stat):
    if not value.startswith("/") or not re.fullmatch(r"[A-Za-z0-9_./@+-]+", value):
        raise ValueError("TOOLS_BIN_DIR must be an absolute path with safe characters")
    target = Path(value).resolve()
    if target.name != "bin":
        raise ValueError("TOOLS_BIN_DIR must be the bin directory of an npm prefix")
    for current in (target, *target.parents):
        try:
            require_root_owned(current, stat_fn)
        except FileNotFoundError:
            if allow_missing:
                continue
            raise ValueError("TOOLS_BIN_DIR does not exist; install its tools first") from None
    tool = target / "zai-mcp-server"
    if not allow_missing and (tool.exists() or tool.is_symlink()):
        # npm bin entries are symlinks. Their 0777 link mode is harmless, but
        # the executable target and its real parents must not be writable by
        # an unprivileged account before adding this directory to service PATH.
        executable = tool.resolve(strict=True)
        require_root_owned(executable, stat_fn, directory=False)
        for current in executable.parents:
            require_root_owned(current, stat_fn)
    return str(target)


def resolve_tools_bin(value="", allow_missing=False, stat_fn=os.stat, prefix_fn=None):
    if not value:
        if prefix_fn is None:
            prefix_fn = lambda: subprocess.check_output(["npm", "prefix", "-g"], text=True).strip()
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
