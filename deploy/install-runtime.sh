#!/usr/bin/env bash
# Install an immutable, versioned CLI without changing another app's global CLI.
set -euo pipefail
umask 022
[ "$(id -u)" -eq 0 ] || { echo 'runtime installation requires root' >&2; exit 1; }
version="${1:?Codex version required}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'invalid Codex version' >&2; exit 1; }
base="${CODEX_RUNTIME_ROOT:-/usr/local/lib/codex-harness/codex}"
case "$base" in /*) ;; *) echo 'runtime root must be absolute' >&2; exit 1 ;; esac
case "$base" in *[!A-Za-z0-9_./@+-]*) echo 'unsafe runtime root' >&2; exit 1 ;; esac
target="$base/$version"
cli="$target/node_modules/.bin/codex"
if [ ! -x "$cli" ]; then
  install -d -o root -g root -m 755 "$base"
  staging="$(mktemp -d "$base/.install-${version}.XXXXXX")"
  trap 'rm -rf -- "$staging"' EXIT
  npm install --prefix "$staging" --no-audit --no-fund "@openai/codex@$version" >&2
  "$staging/node_modules/.bin/codex" --version | grep -Fx "codex-cli $version" >/dev/null
  chmod 755 "$staging"
  # A failed/interrupted install is never published at the final path.
  [ ! -e "$target" ] || { echo "incomplete runtime exists: $target" >&2; exit 1; }
  mv -- "$staging" "$target"
  trap - EXIT
fi
"$cli" --version | grep -Fx "codex-cli $version" >/dev/null
printf '%s\n' "$cli"
