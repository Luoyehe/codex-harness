#!/usr/bin/env bash
# Coordinate the fixed dependency/validation stages and trusted output handoff.
# Candidate code runs only in the selected DynamicUser stage. Root validates
# inputs, owns sandbox lifetime, and accepts only the bridge's verified copy.
set -euo pipefail
umask 077
[ "$(id -u)" = 0 ] || { echo '[candidate-test] root is required to start the isolated unit' >&2; exit 1; }
phase=validation
if [ "${1:-}" = --prepare-dependencies ]; then phase=dependencies; shift; fi
[ "$#" = 5 ] || {
  echo 'usage: test-candidate.sh [--prepare-dependencies] INPUT_ROOT VERSION DESTINATION CACHE_SEED_OR_DIGEST RUNTIME_SEED' >&2
  exit 1
}
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
INSTALLED_ROOT="$(dirname -- "$SCRIPT_DIR")"
version="$2"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo '[candidate-test] invalid candidate version' >&2; exit 1; }
# Full regressions are only for the explicitly confirmed audit closeout. A
# routine update keeps the isolated build, security and lifecycle gates below.
audit_closeout="${CANDIDATE_AUDIT_CLOSEOUT:-0}"
case "$audit_closeout" in 0|1) ;; *) echo '[candidate-test] CANDIDATE_AUDIT_CLOSEOUT must be 0 or 1' >&2; exit 1 ;; esac

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

validated_destination="$(python3 -I - "$3" <<'CHECK_DESTINATION'
import os,re,stat,sys
from pathlib import Path
value=sys.argv[1]
if not re.fullmatch(r'/[A-Za-z0-9_./@+-]+',value) or '..' in Path(value).parts:
    raise SystemExit('destination must be an absolute path without unsafe characters or traversal')
destination=Path(value)
if destination.parent==destination or destination.parent==Path('/'):
    raise SystemExit('destination requires a separate private parent')
for entry in reversed((destination.parent,*destination.parent.parents)):
    info=entry.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0:
        raise SystemExit('destination ancestors must be real root-owned directories')
    if info.st_mode & 0o022 and not (entry!=destination.parent and info.st_mode & stat.S_ISVTX):
        raise SystemExit('destination ancestors must not be replaceable by other users')
if destination.parent.stat().st_mode & 0o077:
    raise SystemExit('destination parent must remain root-private (0700)')
if os.path.lexists(destination):
    raise SystemExit('destination must not already exist')
print(destination)
CHECK_DESTINATION
)"

trust() { python3 -I "$SCRIPT_DIR/trusted_paths.py" "$1" "$2"; }
SCRIPT_DIR="$(trust directory "$SCRIPT_DIR")"
bridge="$(trust file "$SCRIPT_DIR/update_candidate.py")"
runtime_seed="$(trust tree "$5")"
artifact_seed=''; dependency_inputs=''
if [ "$phase" = dependencies ]; then
  dependency_inputs="$4"
  [[ "$dependency_inputs" =~ ^[a-f0-9]{64}$ ]] || { echo '[candidate-test] invalid dependency identity' >&2; exit 1; }
else
  artifact_seed="$(trust tree "$4")"
  for relative in store cache; do
    [ -d "$artifact_seed/$relative" ] || { echo "[candidate-test] missing dependency cache: $relative" >&2; exit 1; }
  done
fi

# Capture the complete trusted runtime before any candidate process starts.
# runtime-info checks the CLI version, executable/link semantics and every file.
runtime_fingerprint() {
  local tree="$1" info fingerprint
  info="$(python3 -I "$bridge" runtime-info "$tree" "$version")" || return 1
  fingerprint="${info#*$'\t'}"
  [ "${info%%$'\t'*}" = "$tree/node_modules/.bin/codex" ] \
    && [[ "$fingerprint" =~ ^[a-f0-9]{64}$ ]] || {
      echo '[candidate-test] invalid trusted runtime identity' >&2; return 1;
    }
  printf '%s\n' "$fingerprint"
}
seed_fingerprint=''
if [ "$phase" = validation ]; then
  seed_fingerprint="$(runtime_fingerprint "$runtime_seed")"
fi

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
stop_isolated_unit() {
  local state status details line states=0 bit=0
  "$systemctl" stop "$unit.service" >/dev/null 2>&1 || true
  state="$("$systemctl" is-active "$unit.service" 2>/dev/null)" && status=0 || status=$?
  case "$state:$status" in
    inactive:3|failed:3) return 0 ;;
    inactive:4|unknown:4)
      # A stopped transient unit can be garbage-collected before is-active.
      # Corroborate not-found/inactive/dead; a bus/permission failure is not
      # evidence of shutdown even if a version reports the same exit code.
      if details="$("$systemctl" show "$unit.service" --property=LoadState \
          --property=ActiveState --property=SubState 2>/dev/null)"; then
        while IFS= read -r line; do
          case "$line" in
            LoadState=not-found) bit=1 ;;
            ActiveState=inactive) bit=2 ;;
            SubState=dead) bit=4 ;;
            *) states=-1; break ;;
          esac
          if [ "$((states & bit))" != 0 ]; then states=-1; break; fi
          states=$((states | bit))
        done <<<"$details"
        [ "$states" = 7 ] && return 0
      fi
      ;;
  esac
  echo "[candidate-test] isolated unit shutdown unconfirmed; retain $runtime and $scratch_root for recovery" >&2
  : > "${candidate_root%/*}/isolation-unconfirmed"
  return 1
}
cleanup() {
  local original_status=$? cleanup_status=0
  trap - EXIT
  if [ -n "$unit" ]; then
    if ! stop_isolated_unit; then exit 1; fi
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
  python3 -I - "$INSTALLED_ROOT/package.json" "$probe_home/package.json" "$node_bin" <<'PREPARE_PROBE'
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
mapfile -t pnpm_package < <(python3 -I - "$SCRIPT_DIR" "$pnpm_entry" "$INSTALLED_ROOT/package.json" <<'CHECK_PNPM'
import json,sys
from pathlib import Path
sys.dont_write_bytecode=True; sys.path.insert(0,sys.argv[1])
from trusted_paths import trusted_path,trusted_tree
pnpm=Path(trusted_path(sys.argv[2]))
expected=json.loads(Path(trusted_path(sys.argv[3])).read_text()).get('packageManager')
for package in pnpm.parents:
    manifest=package/'package.json'
    if manifest.is_file() and json.loads(manifest.read_text()).get('name')=='pnpm':
        root=Path(trusted_tree(str(package)))
        if expected!='pnpm@'+str(json.loads(manifest.read_text()).get('version')):
            raise SystemExit('installed pnpm differs from the trusted updater pin')
        print(root); print(pnpm.relative_to(root)); break
else: raise SystemExit('cannot locate the installed pnpm package')
CHECK_PNPM
)
[ "${#pnpm_package[@]}" = 2 ] || { echo '[candidate-test] pnpm package validation failed' >&2; exit 1; }

unit="codex-harness-candidate-$(python3 -I -c 'import secrets; print(secrets.token_hex(12))')"
runtime="/run/$unit"
# A closed policy table selects the installed runner, input mounts and network.
# Neither candidate metadata nor inherited environment supplies commands/options.
configure_phase() {
  case "$phase" in
    dependencies)
      runner_name=candidate-dependencies.sh
      private_network=no
      offline=false
      seed_mounts=()
      runner_args=("$runtime" "${pnpm_package[1]}")
      ;;
    validation)
      runner_name=candidate-validation.sh
      private_network=yes
      offline=true
      seed_mounts=(
        "--property=BindReadOnlyPaths=$artifact_seed/store:$runtime/seed-store"
        "--property=BindReadOnlyPaths=$artifact_seed/cache:$runtime/seed-cache"
        "--property=BindReadOnlyPaths=$runtime_seed:$runtime/codex-runtime"
      )
      runner_args=("$runtime" "${pnpm_package[1]}" "$version" "$audit_closeout")
      ;;
    *) echo '[candidate-test] unsupported phase' >&2; return 1 ;;
  esac
  stage_runner="$(trust file "$SCRIPT_DIR/$runner_name")"
  [ "$stage_runner" = "$SCRIPT_DIR/$runner_name" ] || {
    echo '[candidate-test] stage runner must be a canonical installed file' >&2; return 1;
  }
}
configure_phase

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
  --property="PrivateNetwork=$private_network" \
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
  "--property=BindReadOnlyPaths=$stage_runner:$runtime/runner.sh" \
  "${seed_mounts[@]}" \
  "$env_bin" -i \
  "HOME=$runtime/executable/home" "USERPROFILE=$runtime/executable/home" "CODEX_HOME=$runtime/executable/codex-home" \
  "XDG_CACHE_HOME=$runtime/executable/cache" "TMPDIR=$runtime/executable/tmp" \
  "PATH=$runtime/executable/bin:/usr/bin:/bin" "CODEX_BIN=$runtime/executable/bin/codex" \
  COREPACK_ENABLE_NETWORK=0 "PNPM_CONFIG_OFFLINE=$offline" NPM_CONFIG_USERCONFIG=/dev/null \
  "NPM_CONFIG_GLOBALCONFIG=$runtime/executable/home/global.npmrc" LANG=C.UTF-8 \
  "$bash_bin" --noprofile --norc "$runtime/runner.sh" "${runner_args[@]}"

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

# This is the only commit boundary. Ready merely requests descriptor copying;
# the bridge revalidates its root-owned copy. Runtime equality is checked on
# that copy before the root-exclusive acknowledgement lets the runner exit.
commit_output() {
  local copied_fingerprint
  case "$phase" in
    dependencies)
      python3 -I "$bridge" materialize-dependencies-live \
        "$runtime/export" "$validated_destination" "$dependency_inputs" >/dev/null || return 1
      ;;
    validation)
      python3 -I "$bridge" materialize-live \
        "$runtime/export" "$validated_destination" "$version" >/dev/null || return 1
      copied_fingerprint="$(runtime_fingerprint "$validated_destination/runtime")" || return 1
      [ "$copied_fingerprint" = "$seed_fingerprint" ] || {
        echo '[candidate-test] copied runtime differs from the trusted seed; refusing acknowledgement' >&2
        return 1
      }
      ;;
    *) return 1 ;;
  esac
  python3 -I "$bridge" accept-live "$runtime/export"
}
commit_output

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
stop_isolated_unit
if [ "$phase" = dependencies ]; then
  echo 'DEPENDENCY-PREPARATION-PASS (registry data only, no candidate hooks)'
else
  echo 'CANDIDATE-VALIDATION-PASS (offline disposable DynamicUser build)'
fi
