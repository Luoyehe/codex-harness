#!/usr/bin/env bash
# Registry-only dependency acquisition from the sanitized metadata projection.
set -euo pipefail
umask 077
[ "$EUID" != 0 ] || exit 1
[ "$#" = 2 ] || { echo 'usage: candidate-dependencies.sh RUNTIME PNPM_RELATIVE' >&2; exit 1; }
runtime=$1; pnpm_relative=$2
[[ "$runtime" =~ ^/[A-Za-z0-9_./@+-]+$ ]] && [[ "$runtime/" != *'/../'* ]] && [ "$runtime" != / ] || exit 1
[[ "$pnpm_relative" =~ ^[A-Za-z0-9_./@+-]+$ ]] && [[ "/$pnpm_relative/" != *'/../'* ]] && [[ "$pnpm_relative" != /* ]] || exit 1
[ ! -e "$runtime/accepted" ] && [ ! -L "$runtime/accepted" ] || {
  echo '[dependency-prepare] acknowledgement already exists before preparation' >&2; exit 1;
}
workspace="$runtime/executable"; worktree="$workspace/worktree"
mkdir -p "$worktree" "$HOME" "$XDG_CACHE_HOME" "$TMPDIR" "$workspace/bin" "$workspace/store"
ln -s "$runtime/node" "$workspace/bin/node"
cp -R --no-preserve=ownership -- "$runtime/source/." "$worktree/"
cd -- "$worktree"
"$runtime/node" "$runtime/pnpm/$pnpm_relative" \
  --config.verify-deps-before-run=false --config.manage-package-manager-versions=false \
  install --frozen-lockfile --ignore-scripts --ignore-pnpmfile \
  --registry=https://registry.npmjs.org/ --config.@jsr:registry=https://registry.npmjs.org/ \
  --package-import-method=copy --store-dir "$workspace/store"
export_root="$runtime/export"; payload="$export_root/payload"
mkdir "$export_root" "$payload"
# Export the newly acquired cache only. The offline phase installs from scratch,
# so no .modules.yaml paths or pending-build state crosses the unit boundary.
export_dependency_cache() {
  cp -R --no-preserve=ownership -- "$workspace/store" "$payload/store"
  # pnpm 11 records installation directories here as relative symlinks. This
  # index belongs to this disposable worktree, not to the portable package store.
  # Remove only the exported copy; never follow its entries or change the source.
  rm -rf -- "$payload/store/v11/projects"
  cp -R --no-preserve=ownership -- "$XDG_CACHE_HOME" "$payload/cache"
}
export_dependency_cache
cp --no-preserve=ownership -- "$runtime/source/dependency-inputs.json" "$payload/manifest.json"
: > "$export_root/ready"
while [ ! -e "$runtime/accepted" ] && [ ! -L "$runtime/accepted" ]; do sleep 0.1; done
[ -f "$runtime/accepted" ] && [ ! -L "$runtime/accepted" ] \
  && [ "$(/usr/bin/stat -c '%u:%h:%a' -- "$runtime/accepted")" = 0:1:444 ] || {
    echo '[dependency-prepare] invalid root acknowledgement' >&2; exit 1;
  }
