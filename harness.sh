#!/bin/sh
set -eu
harness_source=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v python3 >/dev/null 2>&1; then
    printf '%s\n' '需要 Python 3.11 或更高版本；请先安装受支持的 Python。' >&2
    exit 1
fi
if ! python3 -I -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
    printf '%s\n' '需要 Python 3.11 或更高版本。' >&2
    exit 1
fi
if [ "$#" -eq 0 ]; then set -- manage; fi
exec python3 -I -B -c 'import runpy,sys; source=sys.argv.pop(1); sys.path.insert(0,source); runpy.run_module("deploy.cli",run_name="__main__")' "$harness_source" "$@"
