#!/bin/sh
set -eu
harness_source=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec sh "$harness_source/harness.sh" "$@"
