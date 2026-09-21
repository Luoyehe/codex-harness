#!/usr/bin/env bash
# Manage immutable, versioned Codex runtimes without changing a global CLI.
set -euo pipefail
umask 022
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo 'runtime installation requires root' >&2; exit 1; }

action=install
case "${1:-}" in
  inspect|publish|remove|lock-path) action="$1"; shift ;;
esac
version="${1:-}"
if [ "$action" != lock-path ]; then
  [ -n "$version" ] || { echo 'Codex version required' >&2; exit 1; }
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'invalid Codex version' >&2; exit 1; }
fi
base="${CODEX_RUNTIME_ROOT:-/usr/local/lib/codex-harness/codex}"
case "$base" in /*) ;; *) echo 'runtime root must be absolute' >&2; exit 1 ;; esac
case "$base" in *[!A-Za-z0-9_./@+-]*) echo 'unsafe runtime root' >&2; exit 1 ;; esac
base="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" missing-directory "$base")"

if [ "$action" = lock-path ]; then
  install -d -o root -g root -m 755 "$base"
  python3 -I "$SCRIPT_DIR/update_candidate.py" runtime-lock "$base"
  exit 0
fi

install -d -o root -g root -m 755 "$base"
base="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" tree "$base")"
lock_path="$(python3 -I "$SCRIPT_DIR/update_candidate.py" runtime-lock "$base")"
exec 9>"$lock_path"
flock 9
target="$base/$version"

case "$action" in
  inspect)
    [ "$#" = 1 ] || { echo 'usage: install-runtime.sh inspect VERSION' >&2; exit 1; }
    python3 -I "$SCRIPT_DIR/update_candidate.py" runtime-info "$target" "$version"
    ;;
  publish)
    [ "$#" = 3 ] || { echo 'usage: install-runtime.sh publish VERSION SOURCE FINGERPRINT' >&2; exit 1; }
    python3 -I "$SCRIPT_DIR/update_candidate.py" publish-runtime "$2" "$base" "$version" "$3"
    ;;
  remove)
    [ "$#" = 2 ] || { echo 'usage: install-runtime.sh remove VERSION FINGERPRINT' >&2; exit 1; }
    python3 -I "$SCRIPT_DIR/update_candidate.py" remove-runtime "$base" "$version" "$2"
    ;;
  install)
    [ "$#" = 1 ] || { echo 'usage: install-runtime.sh VERSION' >&2; exit 1; }
    if [ -e "$target" ] || [ -L "$target" ]; then
      info="$(python3 -I "$SCRIPT_DIR/update_candidate.py" runtime-info "$target" "$version")"
      printf '%s\n' "${info%%$'\t'*}"
      exit 0
    fi
    staging="$(mktemp -d "$base/.install-${version}.XXXXXXXX")"
    cleanup() {
      if [ -n "${staging:-}" ] && [ "${staging%/*}" = "$base" ]; then rm -rf -- "$staging"; fi
    }
    trap cleanup EXIT
    npm_bin="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" file "${NPM_BIN:-$(command -v npm)}")"
    # Package lifecycle hooks are never trusted to run as root. Codex is a
    # self-contained JS/binary package; functional execution is verified later
    # by the unprivileged service/candidate smoke test.
    "$npm_bin" install --prefix "$staging" --ignore-scripts --no-audit --no-fund "@openai/codex@$version" >&2
    chmod 755 "$staging"
    info="$(python3 -I "$SCRIPT_DIR/update_candidate.py" runtime-info "$staging" "$version")"
    fingerprint="${info#*$'\t'}"
    publication="$(python3 -I "$SCRIPT_DIR/update_candidate.py" publish-runtime "$staging" "$base" "$version" "$fingerprint")"
    state="${publication%%$'\t'*}"
    remainder="${publication#*$'\t'}"
    cli="${remainder%%$'\t'*}"
    [ "$state" = created ] || [ "$state" = reused ] || { echo 'invalid runtime publication state' >&2; exit 1; }
    printf '%s\n' "$cli"
    ;;
esac
