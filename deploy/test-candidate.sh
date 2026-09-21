#!/usr/bin/env bash
# Build and validate an update in a secret-free, offline DynamicUser sandbox.
# Candidate output remains only in the resource-accounted transient runtime;
# the current trusted updater copies it by descriptor before acknowledging exit.
set -euo pipefail
umask 077
[ "$(id -u)" = 0 ] || { echo '[candidate-test] root is required to start the isolated unit' >&2; exit 1; }
[ "$#" = 5 ] || {
  echo 'usage: test-candidate.sh CANDIDATE_ROOT VERSION VALIDATED_DESTINATION ARTIFACT_SEED RUNTIME_SEED' >&2
  exit 1
}
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
version="$2"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo '[candidate-test] invalid candidate version' >&2; exit 1; }

candidate_root="$(python3 -I - "$1" <<'CHECK_CANDIDATE'
import os,re,stat,sys
from pathlib import Path
value=sys.argv[1]
if not re.fullmatch(r'/[A-Za-z0-9_./@+-]+',value) or '..' in Path(value).parts:
    raise SystemExit('candidate must be an absolute path without unsafe characters or traversal')
candidate=Path(value)
if candidate.parent==candidate or candidate.parent==Path('/'):
    raise SystemExit('candidate requires a separate private parent')
for entry in reversed((candidate,*candidate.parents)):
    info=entry.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0:
        raise SystemExit('candidate ancestors must be real root-owned directories')
    if info.st_mode & 0o022 and not (entry!=candidate and info.st_mode & stat.S_ISVTX):
        raise SystemExit('candidate ancestors must not be replaceable by other users')
parent=candidate.parent.stat()
if parent.st_mode & 0o077:
    raise SystemExit('candidate parent must remain root-private (0700)')
os.chmod(candidate,0o755)
print(candidate)
CHECK_CANDIDATE
)"

validated_destination="$3"

trust() { python3 -I "$SCRIPT_DIR/trusted_paths.py" "$1" "$2"; }
artifact_seed="$(trust directory "$4")"
runtime_seed="$(trust tree "$5")"
for relative in node_modules apps/gateway/node_modules apps/web/node_modules; do
  [ -d "$artifact_seed/$relative" ] || { echo "[candidate-test] missing artifact seed: $relative" >&2; exit 1; }
  trust tree "$artifact_seed/$relative" >/dev/null
done

node_bin="$(trust file "${NODE_BIN:-$(command -v node)}")"
node_entry="${NODE_BIN_DIR:-$(dirname -- "${NODE_BIN:-$(command -v node)}")}/node"
[ "$(trust file "$node_entry")" = "$node_bin" ] || { echo '[candidate-test] node command does not match NODE_BIN' >&2; exit 1; }
runtime_path="$(dirname -- "$node_entry"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
pnpm_launcher="$(PATH="$runtime_path" command -v pnpm)"
pnpm_launcher="$(trust file "$pnpm_launcher")"
cli="$(trust file "$runtime_seed/node_modules/.bin/codex")"
systemd_run="$(trust file /usr/bin/systemd-run)"
systemctl="$(trust file /usr/bin/systemctl)"
mount_bin="$(trust file /usr/bin/mount)"
umount_bin="$(trust file /usr/bin/umount)"
env_bin="$(trust file /usr/bin/env)"
bash_bin="$(trust file /bin/bash)"
[ -x "$node_bin" ] && [ -x "$pnpm_launcher" ] && [ -x "$cli" ] \
  || { echo '[candidate-test] runtime entry is not executable' >&2; exit 1; }

launcher_kind="$(python3 -I - "$SCRIPT_DIR" "$pnpm_launcher" <<'CHECK_LAUNCHER'
import json,sys
from pathlib import Path
sys.dont_write_bytecode=True; sys.path.insert(0,sys.argv[1])
from trusted_paths import trusted_tree
for package in Path(sys.argv[2]).parents:
    manifest=package/'package.json'
    if manifest.is_file():
        name=json.loads(manifest.read_text()).get('name')
        if name in ('pnpm','corepack'):
            trusted_tree(str(package)); print(name); break
else: raise SystemExit('pnpm must be an installed trusted pnpm or Corepack package')
CHECK_LAUNCHER
)"
probe_home=''; unit=''; scratch_root=''; scratch_tmp=''; scratch_var_tmp=''; scratch_mounts=0
cleanup() {
  local original_status=$? cleanup_status=0
  trap - EXIT
  if [ -n "$unit" ]; then
    "$systemctl" stop "$unit.service" >/dev/null 2>&1 || true
    "$systemctl" reset-failed "$unit.service" >/dev/null 2>&1 || true
  fi
  if [ "$scratch_mounts" -ge 2 ]; then
    "$umount_bin" -- "$scratch_var_tmp" >/dev/null 2>&1 || cleanup_status=1
  fi
  if [ "$scratch_mounts" -ge 1 ]; then
    "$umount_bin" -- "$scratch_tmp" >/dev/null 2>&1 || cleanup_status=1
  fi
  if [ -n "$scratch_root" ]; then
    rmdir -- "$scratch_var_tmp" "$scratch_tmp" "$scratch_root" >/dev/null 2>&1 || cleanup_status=1
  fi
  if [ -n "$probe_home" ] && [ "${probe_home%/*}" = "${candidate_root%/*}" ]; then rm -rf -- "$probe_home"; fi
  if [ "$cleanup_status" -ne 0 ]; then
    echo '[candidate-test] failed to remove a private scratch mount; manual inspection is required' >&2
    [ "$original_status" -ne 0 ] || original_status=1
  fi
  exit "$original_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
pnpm_entry="$pnpm_launcher"
if [ "$launcher_kind" = corepack ]; then
  corepack_cache="$(python3 -I -c 'import os,pwd; print(os.environ.get("COREPACK_HOME") or os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.join(pwd.getpwuid(0).pw_dir,".cache"),"node","corepack"))')"
  corepack_cache="$(trust tree "$corepack_cache")"
  probe_home="$(mktemp -d "${candidate_root%/*}/candidate-probe.XXXXXXXX")"
  python3 -I - "$candidate_root/package.json" "$probe_home/package.json" "$node_bin" <<'PREPARE_PROBE'
import json,re,sys
from pathlib import Path
manager=json.loads(Path(sys.argv[1]).read_text()).get('packageManager')
if not isinstance(manager,str) or not re.fullmatch(r'pnpm@\d+\.\d+\.\d+(?:\+sha(?:224|256|384|512)\.[a-fA-F0-9]+)?',manager):
    raise SystemExit('candidate must pin an exact pnpm packageManager version')
script=sys.argv[3]+' -p "process.env.npm_execpath"'
Path(sys.argv[2]).write_text(json.dumps({'private':True,'packageManager':manager,'scripts':{'harness-pnpm-entry':script}}))
PREPARE_PROBE
  pnpm_entry="$(cd -- "$probe_home" && "$env_bin" -i \
    HOME="$probe_home" XDG_CACHE_HOME="$probe_home/cache" PATH="$runtime_path" \
    COREPACK_HOME="$corepack_cache" COREPACK_ENABLE_NETWORK=0 COREPACK_DEFAULT_TO_LATEST=0 \
    pnpm_config_verify_deps_before_run= PNPM_CONFIG_OFFLINE=true \
    NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG="$probe_home/global.npmrc" \
    "$node_bin" "$pnpm_launcher" --config.verify-deps-before-run=false --silent run harness-pnpm-entry)"
fi
pnpm_entry="$(trust file "$pnpm_entry")"
mapfile -t pnpm_package < <(python3 -I - "$SCRIPT_DIR" "$pnpm_entry" <<'CHECK_PNPM'
import json,sys
from pathlib import Path
sys.dont_write_bytecode=True; sys.path.insert(0,sys.argv[1])
from trusted_paths import trusted_path,trusted_tree
pnpm=Path(trusted_path(sys.argv[2]))
for package in pnpm.parents:
    manifest=package/'package.json'
    if manifest.is_file() and json.loads(manifest.read_text()).get('name')=='pnpm':
        root=Path(trusted_tree(str(package))); print(root); print(pnpm.relative_to(root)); break
else: raise SystemExit('cannot locate the installed pnpm package')
CHECK_PNPM
)
[ "${#pnpm_package[@]}" = 2 ] || { echo '[candidate-test] pnpm package validation failed' >&2; exit 1; }

unit="codex-harness-candidate-$(python3 -I -c 'import secrets; print(secrets.token_hex(12))')"
runtime="/run/$unit"
# DynamicUser unconditionally implies PrivateTmp, whose host-backed bind mounts
# hide TemporaryFileSystem=/tmp. Create fixed-size scratch filesystems below a
# root-private /run parent and bind those over the private views instead.
scratch_root="/run/$unit-scratch"
scratch_tmp="$scratch_root/tmp"
scratch_var_tmp="$scratch_root/var-tmp"
mkdir -m 0700 -- "$scratch_root"
mkdir -m 0700 -- "$scratch_tmp" "$scratch_var_tmp"
"$mount_bin" -t tmpfs -o nodev,nosuid,noexec,size=512M,mode=1777 \
  codex-harness-candidate-tmp "$scratch_tmp"
scratch_mounts=1
"$mount_bin" -t tmpfs -o nodev,nosuid,noexec,size=512M,mode=1777 \
  codex-harness-candidate-var-tmp "$scratch_var_tmp"
scratch_mounts=2
read -r -d '' runner <<'CANDIDATE_RUNNER' || true
set -euo pipefail
umask 077
[ "$EUID" != 0 ] || { echo '[candidate-test] refusing to run candidate work as root' >&2; exit 1; }
runtime=$1; pnpm_relative=$2; version=$3
workspace="$runtime/executable"; worktree="$workspace/worktree"
mkdir -p "$worktree/apps/gateway" "$worktree/apps/web" "$HOME" "$CODEX_HOME" "$XDG_CACHE_HOME" "$TMPDIR" "$workspace/bin"
ln -s "$runtime/node" "$workspace/bin/node"
printf '#!/bin/sh\nexport pnpm_config_verify_deps_before_run=\nexec "%s" "%s" --config.verify-deps-before-run=false "$@"\n' \
  "$runtime/node" "$runtime/pnpm/$pnpm_relative" > "$workspace/bin/pnpm"
chmod 700 "$workspace/bin/pnpm"
ln -s "$runtime/codex-runtime/node_modules/.bin/codex" "$workspace/bin/codex"
cp -a --no-preserve=ownership -- "$runtime/source/." "$worktree/"
find -P "$worktree" -type d -exec chmod u+rwx -- {} +
find -P "$worktree" -type f -exec chmod u+rw -- {} +
rm -rf -- "$worktree/node_modules" "$worktree/apps/gateway/node_modules" "$worktree/apps/web/node_modules"
cp -a --no-preserve=ownership -- "$runtime/seed-root" "$worktree/node_modules"
cp -a --no-preserve=ownership -- "$runtime/seed-gateway" "$worktree/apps/gateway/node_modules"
cp -a --no-preserve=ownership -- "$runtime/seed-web" "$worktree/apps/web/node_modules"
cd -- "$worktree"
pnpm install --offline --frozen-lockfile
pnpm typecheck
pnpm build
node scripts/release-audit.mjs .
pnpm test
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
cp -R --no-preserve=ownership -- "$runtime/codex-runtime/node_modules" "$payload/runtime/node_modules"
cp --no-preserve=ownership -- deploy/privileged-helper.sh "$payload/service/privileged-helper.sh"
cp --no-preserve=ownership -- deploy/worker_launcher.py "$payload/service/worker_launcher.py"
printf '{"format":1,"version":"%s"}\n' "$version" > "$payload/manifest.json"
: > "$export_root/ready"
while [ ! -e "$runtime/accepted" ]; do sleep 0.1; done
[ -f "$runtime/accepted" ] && [ ! -L "$runtime/accepted" ]
CANDIDATE_RUNNER

"$systemd_run" --quiet --unit="$unit" \
  --property=DynamicUser=yes \
  --property="RuntimeDirectory=$unit" \
  --property=RuntimeDirectoryMode=0700 \
  --property=RuntimeDirectoryPreserve=no \
  --property=RemainAfterExit=yes \
  --property=UMask=0077 \
  --property=KillMode=control-group \
  --property=TimeoutStopSec=15s \
  --property=RuntimeMaxSec=30min \
  --property=MemoryMax=4G \
  --property=MemorySwapMax=0 \
  --property=TasksMax=512 \
  --property=CPUQuota=400% \
  --property=LimitNOFILE=8192 \
  --property=LimitFSIZE=512M \
  --property=StandardOutput=null \
  --property=StandardError=null \
  --property=ProtectSystem=strict \
  --property=ProtectHome=yes \
  --property=PrivateNetwork=yes \
  --property=PrivateDevices=yes \
  --property=ProtectKernelTunables=yes \
  --property=ProtectKernelModules=yes \
  --property=ProtectControlGroups=yes \
  --property=ProtectClock=yes \
  --property=ProtectHostname=yes \
  --property=LockPersonality=yes \
  --property=RestrictSUIDSGID=yes \
  --property=NoNewPrivileges=yes \
  --property=CapabilityBoundingSet= \
  --property=AmbientCapabilities= \
  --property="RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6" \
  --property=InaccessiblePaths=-/etc/codex-harness \
  --property="BindPaths=$scratch_tmp:/tmp" \
  --property="BindPaths=$scratch_var_tmp:/var/tmp" \
  --property="TemporaryFileSystem=$runtime/executable:rw,nodev,nosuid,exec,mode=1777" \
  --property="BindReadOnlyPaths=$candidate_root:$runtime/source" \
  --property="BindReadOnlyPaths=$node_bin:$runtime/node" \
  --property="BindReadOnlyPaths=${pnpm_package[0]}:$runtime/pnpm" \
  --property="BindReadOnlyPaths=$artifact_seed/node_modules:$runtime/seed-root" \
  --property="BindReadOnlyPaths=$artifact_seed/apps/gateway/node_modules:$runtime/seed-gateway" \
  --property="BindReadOnlyPaths=$artifact_seed/apps/web/node_modules:$runtime/seed-web" \
  --property="BindReadOnlyPaths=$runtime_seed:$runtime/codex-runtime" \
  "$env_bin" -i \
  "HOME=$runtime/executable/home" "USERPROFILE=$runtime/executable/home" "CODEX_HOME=$runtime/executable/codex-home" \
  "XDG_CACHE_HOME=$runtime/executable/cache" "TMPDIR=$runtime/executable/tmp" \
  "PATH=$runtime/executable/bin:/usr/bin:/bin" "CODEX_BIN=$runtime/executable/bin/codex" \
  COREPACK_ENABLE_NETWORK=0 PNPM_CONFIG_OFFLINE=true NPM_CONFIG_USERCONFIG=/dev/null \
  "NPM_CONFIG_GLOBALCONFIG=$runtime/executable/home/global.npmrc" LANG=C.UTF-8 \
  "$bash_bin" --noprofile --norc -c "$runner" -- "$runtime" "${pnpm_package[1]}" "$version"

unit_property() {
  "$systemctl" show "$unit.service" --property="$1" --value 2>/dev/null || true
}
fail_with_status() {
  local value="${1:-1}"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] && [ "$value" -le 255 ] || value=1
  exit "$value"
}
deadline=$((SECONDS + 1810))
ready="$runtime/export/ready"
while [ ! -f "$ready" ]; do
  state="$(unit_property ActiveState)"
  substate="$(unit_property SubState)"
  if [ "$state" = failed ] || [ "$state" = inactive ] || [ "$substate" = exited ]; then
    status="$(unit_property ExecMainStatus)"
    result="$(unit_property Result)"
    echo "[candidate-test] isolated validation exited before presenting output (result=${result:-unknown}, status=${status:-unknown})" >&2
    fail_with_status "$status"
  fi
  [ "$SECONDS" -lt "$deadline" ] || { echo '[candidate-test] timed out waiting for isolated output' >&2; exit 124; }
  sleep 0.2
done

# The helper belongs to the currently installed updater, not to the candidate.
# It pins /run and the DynamicUser-owned runtime by descriptor, validates the
# fixed bounded topology, and copies into the root-private transaction tree.
python3 -I "$SCRIPT_DIR/update_candidate.py" materialize-live \
  "$runtime/export" "$validated_destination" "$version" >/dev/null
python3 -I "$SCRIPT_DIR/update_candidate.py" accept-live "$runtime/export"

while :; do
  state="$(unit_property ActiveState)"
  substate="$(unit_property SubState)"
  [ "$state" != failed ] || break
  [ "$substate" != exited ] || break
  [ "$state" != inactive ] || break
  [ "$SECONDS" -lt "$deadline" ] || { echo '[candidate-test] timed out waiting for isolated shutdown' >&2; exit 124; }
  sleep 0.2
done
status="$(unit_property ExecMainStatus)"
result="$(unit_property Result)"
[ "$state" = active ] && [ "$substate" = exited ] && [ "$status" = 0 ] && [ "$result" = success ] || {
  echo "[candidate-test] isolated validation failed after output handoff (result=${result:-unknown}, status=${status:-unknown})" >&2
  fail_with_status "$status"
}
echo 'CANDIDATE-VALIDATION-PASS (offline disposable DynamicUser build)'
