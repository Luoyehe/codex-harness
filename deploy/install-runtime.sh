#!/usr/bin/env bash
# Install an immutable, versioned CLI without changing another app's global CLI.
set -euo pipefail
umask 022
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo 'runtime installation requires root' >&2; exit 1; }
version="${1:?Codex version required}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'invalid Codex version' >&2; exit 1; }
base="${CODEX_RUNTIME_ROOT:-/usr/local/lib/codex-harness/codex}"
case "$base" in /*) ;; *) echo 'runtime root must be absolute' >&2; exit 1 ;; esac
case "$base" in *[!A-Za-z0-9_./@+-]*) echo 'unsafe runtime root' >&2; exit 1 ;; esac
# Do not let a custom runtime prefix redirect root's directory creation or an
# existing executable before register-service gets a chance to validate it.
base="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" missing-directory "$base")"
target="$base/$version"
cli="$target/node_modules/.bin/codex"
if [ -e "$target" ] || [ -L "$target" ]; then
  target="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" tree "$target")"
  cli="$target/node_modules/.bin/codex"
fi
if [ ! -x "$cli" ]; then
  install -d -o root -g root -m 755 "$base"
  staging="$(mktemp -d "$base/.install-${version}.XXXXXX")"
  trap 'rm -rf -- "$staging"' EXIT
  npm_bin="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" file "${NPM_BIN:-$(command -v npm)}")"
  "$npm_bin" install --prefix "$staging" --no-audit --no-fund "@openai/codex@$version" >&2
  "$staging/node_modules/.bin/codex" --version | grep -Fx "codex-cli $version" >/dev/null
  chmod 755 "$staging"
  # A failed/interrupted install is never published at the final path.
  [ ! -e "$target" ] || { echo "incomplete runtime exists: $target" >&2; exit 1; }
  mv -- "$staging" "$target"
  trap - EXIT
fi
checked_cli="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" file "$cli")"
"$checked_cli" --version | grep -Fx "codex-cli $version" >/dev/null
printf '%s\n' "$cli"
