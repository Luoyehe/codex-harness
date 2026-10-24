#!/usr/bin/env bash
# The installed updater prepares data, then delegates network I/O to DynamicUser.
set -euo pipefail
umask 077
[ "$(id -u)" = 0 ] || { echo '[dependency-prepare] root required' >&2; exit 1; }
[ "$#" = 4 ] || { echo 'usage: prepare-candidate-deps.sh CANDIDATE VERSION DESTINATION RUNTIME_SEED' >&2; exit 1; }
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
INSTALLED_ROOT="$(dirname -- "$SCRIPT_DIR")"
trust() { python3 -I "$SCRIPT_DIR/trusted_paths.py" "$1" "$2"; }
trust tree "$SCRIPT_DIR" >/dev/null
trust tree "$INSTALLED_ROOT/node_modules/yaml" >/dev/null
trust file "$INSTALLED_ROOT/package.json" >/dev/null
candidate="$(trust directory "$1")"
parent="$(trust directory "$(dirname -- "$candidate")")"
[ "$(stat -c '%a' "$parent")" = 700 ] || { echo '[dependency-prepare] transaction parent must be private' >&2; exit 1; }
node_bin="$(trust file "${NODE_BIN:-$(command -v node)}")"
timeout_bin="$(trust file /usr/bin/timeout)"
env_bin="$(trust file /usr/bin/env)"
inputs="$parent/dependency-inputs"
digest="$("$env_bin" -i PATH="$(dirname -- "$node_bin"):/usr/bin:/bin" LANG=C.UTF-8 \
  "$timeout_bin" --signal=KILL 20s "$node_bin" --max-old-space-size=128 \
  "$SCRIPT_DIR/dependency-inputs.mjs" "$candidate" "$inputs")"
[[ "$digest" =~ ^[a-f0-9]{64}$ ]] || { echo '[dependency-prepare] invalid input identity' >&2; exit 1; }
echo '[dependency-prepare] downloading locked registry packages without candidate hooks or service credentials'
if ! bash "$SCRIPT_DIR/test-candidate.sh" --prepare-dependencies \
  "$inputs" "$2" "$3" "$digest" "$4"; then
  echo '[dependency-prepare] preparation failed before service shutdown; fix the reported prerequisite and retry update' >&2
  exit 1
fi
