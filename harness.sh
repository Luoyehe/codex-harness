#!/bin/sh
set -eu
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
    printf '%s\n' '需要 Python 3；请先运行 sudo apt-get install -y python3。' >&2
    exit 1
fi
if [ "$#" -eq 0 ]; then
    exec python3 -B -m deploy.cli manage
fi
exec python3 -B -m deploy.cli "$@"
