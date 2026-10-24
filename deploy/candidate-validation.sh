#!/usr/bin/env bash
# Offline validation of a private candidate copy; invoked only by the trusted coordinator.
set -euo pipefail
umask 077
[ "$EUID" != 0 ] || { echo '[candidate-test] refusing to run candidate work as root' >&2; exit 1; }
[ "$#" = 4 ] || { echo 'usage: candidate-validation.sh RUNTIME PNPM_RELATIVE VERSION AUDIT_CLOSEOUT' >&2; exit 1; }
runtime=$1; pnpm_relative=$2; version=$3; audit_closeout=$4
[[ "$runtime" =~ ^/[A-Za-z0-9_./@+-]+$ ]] && [[ "$runtime/" != *'/../'* ]] && [ "$runtime" != / ] || exit 1
[[ "$pnpm_relative" =~ ^[A-Za-z0-9_./@+-]+$ ]] && [[ "/$pnpm_relative/" != *'/../'* ]] && [[ "$pnpm_relative" != /* ]] || exit 1
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
case "$audit_closeout" in 0|1) ;; *) exit 1 ;; esac
[ ! -e "$runtime/accepted" ] && [ ! -L "$runtime/accepted" ] || {
  echo '[candidate-test] acknowledgement already exists before validation' >&2; exit 1;
}
workspace="$runtime/executable"; worktree="$workspace/worktree"
mkdir -p "$worktree/apps/gateway" "$worktree/apps/web" "$HOME" "$CODEX_HOME" "$XDG_CACHE_HOME" "$TMPDIR" "$workspace/bin"
ln -s "$runtime/node" "$workspace/bin/node"
printf '#!/bin/sh\nexport pnpm_config_verify_deps_before_run=\nexec "%s" "%s" --config.verify-deps-before-run=false --config.manage-package-manager-versions=false "$@"\n' \
  "$runtime/node" "$runtime/pnpm/$pnpm_relative" > "$workspace/bin/pnpm"
chmod 700 "$workspace/bin/pnpm"
ln -s "$runtime/codex-runtime/node_modules/.bin/codex" "$workspace/bin/codex"
cp -a --no-preserve=ownership -- "$runtime/source/." "$worktree/"
find -P "$worktree" -type d -exec chmod u+rwx -- {} +
find -P "$worktree" -type f -exec chmod u+rw -- {} +
rm -rf -- "$worktree/node_modules" "$worktree/apps/gateway/node_modules" "$worktree/apps/web/node_modules"
cp -R --no-preserve=ownership -- "$runtime/seed-store" "$workspace/store"
cp -R --no-preserve=ownership -- "$runtime/seed-cache/." "$XDG_CACHE_HOME/"
cd -- "$worktree"
pnpm install --offline --frozen-lockfile --store-dir "$workspace/store"
pnpm typecheck
pnpm build
node scripts/release-audit.mjs .
if [ "$audit_closeout" = 1 ]; then
  pnpm test
else
  # Fixed deployment-critical regressions, not a candidate-provided list.
  node --test scripts/candidate-validation.test.mjs scripts/service-registration.test.mjs \
    scripts/dependency-preparation.test.mjs scripts/deploy-lifecycle.test.mjs scripts/provider-transaction.test.mjs \
    scripts/worker-supervision.test.mjs scripts/install-sandbox.test.mjs scripts/deploy-round4.test.mjs
  pnpm --filter @codex-harness/gateway exec vitest run test/http-auth.test.ts \
    test/control-requests.test.ts test/control-unknown-start.test.ts test/worker.test.ts \
    test/terminal-ws.test.ts test/management-control.test.ts
fi
# Tests are candidate-controlled too. Re-audit their final source state before
# smoke and export so a test-side mutation cannot bypass the release gate.
node scripts/release-audit.mjs .
node scripts/gateway-smoke.mjs
export_root="$runtime/export"
payload="$export_root/payload"
mkdir "$export_root"
mkdir "$payload"
mkdir -p "$payload/artifacts/apps/gateway" "$payload/artifacts/apps/web" "$payload/runtime" "$payload/service"
# Recursive copies intentionally do not preserve hardlink topology; the
# trusted bridge rejects multiply-linked files in every published tree.
cp -R --no-preserve=ownership -- node_modules "$payload/artifacts/node_modules"
cp -R --no-preserve=ownership -- apps/gateway/node_modules "$payload/artifacts/apps/gateway/node_modules"
cp -R --no-preserve=ownership -- apps/web/node_modules "$payload/artifacts/apps/web/node_modules"
cp -R --no-preserve=ownership -- apps/gateway/dist "$payload/artifacts/apps/gateway/dist"
cp -R --no-preserve=ownership -- apps/web/dist "$payload/artifacts/apps/web/dist"
# install-runtime.sh's complete tree is the identity: root package metadata,
# hidden npm lock, optional platform package, CLI links and executable bits.
cp -R --no-preserve=ownership -- "$runtime/codex-runtime/." "$payload/runtime/"
cp --no-preserve=ownership -- deploy/privileged-helper.sh "$payload/service/privileged-helper.sh"
cp --no-preserve=ownership -- deploy/worker_launcher.py "$payload/service/worker_launcher.py"
printf '{"format":1,"version":"%s"}\n' "$version" > "$payload/manifest.json"
: > "$export_root/ready"
while [ ! -e "$runtime/accepted" ] && [ ! -L "$runtime/accepted" ]; do sleep 0.1; done
[ -f "$runtime/accepted" ] && [ ! -L "$runtime/accepted" ] \
  && [ "$(/usr/bin/stat -c '%u:%h:%a' -- "$runtime/accepted")" = 0:1:444 ] || {
    echo '[candidate-test] invalid root acknowledgement' >&2; exit 1;
  }
