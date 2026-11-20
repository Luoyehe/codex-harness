#!/bin/sh
set -eu
harness_source=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if ! command -v python3 >/dev/null 2>&1; then
    printf '%s\n' '需要 Python 3.11 或更高版本；请先安装受支持的 Python。' >&2
    exit 1
fi
if ! python3 -I -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
    printf '%s\n' '需要 Python 3.11 或更高版本。' >&2
    exit 1
fi
if [ "$#" -eq 0 ]; then set -- manage; fi
exec python3 -I -B -c '
import os, pathlib, runpy, stat, sys
source = pathlib.Path(sys.argv.pop(1))
if os.geteuid() == 0:
    owners = {0}
    if os.environ.get("SUDO_UID", "").isdigit():
        owners.add(int(os.environ["SUDO_UID"]))
    for path in (source / "deploy", source, *source.parents):
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in owners or info.st_mode & 0o022:
            sys.exit("管理源码目录的属主或权限不可信。请在 root 或当前 sudo 管理员私有且不可由其他用户写入的目录中运行。")
sys.path.insert(0, str(source))
runpy.run_module("deploy.cli", run_name="__main__")
' "$harness_source" "$@"
