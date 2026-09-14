#!/usr/bin/env bash
# Validate an already-built root-owned update without running its tests as root.
# Only the disposable DynamicUser copy is writable; never publish that copy.
set -euo pipefail
umask 077
[ "$(id -u)" = 0 ] || { echo '[candidate-test] root is required to start the isolated test unit' >&2; exit 1; }
[ "$#" = 2 ] || { echo 'usage: test-candidate.sh CANDIDATE_ROOT CANDIDATE_CLI' >&2; exit 1; }
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

# The private parent also holds the rollback snapshot. Do not expose or bind it.
# Unlike executable paths, a root-created mktemp directory may live below /tmp.
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
# The bind exposes only this entry inside the private runtime, not its parent.
os.chmod(candidate,0o755)
print(candidate)
CHECK_CANDIDATE
)"

trust() { python3 -I "$SCRIPT_DIR/trusted_paths.py" "$1" "$2"; }
node_bin="$(trust file "${NODE_BIN:-$(command -v node)}")"
# Preserve the command-name entry separately from its canonical executable.
node_entry="${NODE_BIN_DIR:-$(dirname -- "${NODE_BIN:-$(command -v node)}")}/node"
[ "$(trust file "$node_entry")" = "$node_bin" ] || { echo '[candidate-test] node command does not match NODE_BIN' >&2; exit 1; }
runtime_path="$(dirname -- "$node_entry"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
pnpm_launcher="$(PATH="$runtime_path" command -v pnpm)"
pnpm_launcher="$(trust file "$pnpm_launcher")"
cli="$(trust file "$2")"
systemd_run="$(trust file /usr/bin/systemd-run)"
systemctl="$(trust file /usr/bin/systemctl)"
env_bin="$(trust file /usr/bin/env)"
bash_bin="$(trust file /bin/bash)"
[ -x "$node_bin" ] && [ -x "$pnpm_launcher" ] && [ -x "$cli" ] || { echo '[candidate-test] runtime entry is not executable' >&2; exit 1; }

# Validate the launcher's implementation before executing any of it as root.
launcher_kind="$(python3 -I - "$SCRIPT_DIR" "$pnpm_launcher" <<'CHECK_LAUNCHER'
import json,sys
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from trusted_paths import trusted_tree
for package in Path(sys.argv[2]).parents:
    manifest=package/'package.json'
    if manifest.is_file():
        name=json.loads(manifest.read_text()).get('name')
        if name in ('pnpm','corepack'):
            trusted_tree(str(package))
            print(name)
            break
else:
    raise SystemExit('pnpm must be an installed trusted pnpm or Corepack package')
CHECK_LAUNCHER
)"
probe_home=''
unit=''
cleanup() {
  if [ -n "$unit" ]; then "$systemctl" stop "$unit.service" >/dev/null 2>&1 || true; fi
  # This is only our mktemp child of the previously checked root-private parent.
  if [ -n "$probe_home" ] && [ "${probe_home%/*}" = "${candidate_root%/*}" ]; then rm -rf -- "$probe_home"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
pnpm_entry="$pnpm_launcher"
if [ "$launcher_kind" = corepack ]; then
  # The cache contains only installed tools. Never reuse root's HOME or npmrc:
  # the Corepack resolution probe also receives a new, private HOME.
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
  # pnpm 11 exposes npm_execpath to run scripts, not exec commands. Probe
  # outside the candidate and disable verification explicitly, so root's build
  # can never be rewritten.
  pnpm_entry="$(cd -- "$probe_home" && "$env_bin" -i \
    HOME="$probe_home" XDG_CACHE_HOME="$probe_home/cache" PATH="$runtime_path" \
    COREPACK_HOME="$corepack_cache" COREPACK_ENABLE_NETWORK=0 COREPACK_DEFAULT_TO_LATEST=0 \
    pnpm_config_verify_deps_before_run= PNPM_CONFIG_OFFLINE=true \
    NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG="$probe_home/global.npmrc" \
    "$node_bin" "$pnpm_launcher" --config.verify-deps-before-run=false --silent run harness-pnpm-entry)"
fi
pnpm_entry="$(trust file "$pnpm_entry")"
mapfile -t runtime_packages < <(python3 -I - "$SCRIPT_DIR" "$pnpm_entry" "$cli" <<'CHECK_PACKAGES'
import json,sys
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from trusted_paths import trusted_path,trusted_tree
pnpm=Path(trusted_path(sys.argv[2])); cli=Path(trusted_path(sys.argv[3]))
for package in pnpm.parents:
    manifest=package/'package.json'
    if manifest.is_file() and json.loads(manifest.read_text()).get('name')=='pnpm':
        pnpm_root=Path(trusted_tree(str(package)))
        break
else:
    raise SystemExit('cannot locate the installed pnpm package')
for package in cli.parents:
    if package.name=='node_modules':
        cli_root=Path(trusted_tree(str(package)))
        break
else:
    raise SystemExit('candidate Codex CLI must belong to a trusted npm runtime')
for value in (pnpm_root,pnpm.relative_to(pnpm_root),cli_root,cli.relative_to(cli_root)):
    print(value)
CHECK_PACKAGES
)
[ "${#runtime_packages[@]}" = 4 ] || { echo '[candidate-test] runtime package validation failed' >&2; exit 1; }

unit="codex-harness-candidate-$(python3 -I -c 'import secrets; print(secrets.token_hex(12))')"
runtime="/run/$unit"
read -r -d '' runner <<'CANDIDATE_RUNNER' || true
set -euo pipefail
umask 077
[ "$EUID" != 0 ] || { echo '[candidate-test] refusing to run tests as root' >&2; exit 1; }
runtime=$1
pnpm_relative=$2
cli_relative=$3
workspace="$runtime/executable"
mkdir -p "$workspace/worktree" "$HOME" "$CODEX_HOME" "$XDG_CACHE_HOME" "$TMPDIR" "$workspace/bin"
ln -s "$runtime/node" "$workspace/bin/node"
# pnpm 11 passes the truthy string "false" to nested pnpm commands. Reset it
# on every invocation, in addition to the CLI flag, to prevent auto-installs.
printf '#!/bin/sh\nexport pnpm_config_verify_deps_before_run=\nexec "%s" "%s" --config.verify-deps-before-run=false "$@"\n' \
  "$runtime/node" "$runtime/pnpm/$pnpm_relative" > "$workspace/bin/pnpm"
chmod 700 "$workspace/bin/pnpm"
ln -s "$runtime/codex/node_modules/$cli_relative" "$workspace/bin/codex"
cp -a --no-preserve=ownership -- "$runtime/source/." "$workspace/worktree/"
# Git/package files may deliberately be read-only. Change only the new copy,
# without traversing links into the read-only source or runtime packages.
find -P "$workspace/worktree" -type d -exec chmod u+rwx -- {} +
find -P "$workspace/worktree" -type f -exec chmod u+rw -- {} +
cd -- "$workspace/worktree"
pnpm test
node scripts/gateway-smoke.mjs
echo 'CANDIDATE-VALIDATION-PASS (disposable unprivileged copy only)'
CANDIDATE_RUNNER

# /run itself may be noexec. This fresh exec tmpfs exists only in the unit's
# namespace, behind its 0700 RuntimeDirectory; its sticky root lets DynamicUser
# create private work/home/tmp directories without knowing that UID in advance.
"$systemd_run" --quiet --wait --pipe --collect --unit="$unit" \
  --property=DynamicUser=yes \
  --property="RuntimeDirectory=$unit" \
  --property=RuntimeDirectoryMode=0700 \
  --property=RuntimeDirectoryPreserve=no \
  --property=KillMode=control-group \
  --property=TimeoutStopSec=15s \
  --property=RuntimeMaxSec=30min \
  --property=ProtectSystem=strict \
  --property=ProtectHome=yes \
  --property=PrivateTmp=yes \
  --property=NoNewPrivileges=yes \
  --property="TemporaryFileSystem=$runtime/executable:rw,nodev,nosuid,exec,mode=1777" \
  --property="BindReadOnlyPaths=$candidate_root:$runtime/source" \
  --property="BindReadOnlyPaths=$node_bin:$runtime/node" \
  --property="BindReadOnlyPaths=${runtime_packages[0]}:$runtime/pnpm" \
  --property="BindReadOnlyPaths=${runtime_packages[2]}:$runtime/codex/node_modules" \
  "$env_bin" -i \
  "HOME=$runtime/executable/home" "USERPROFILE=$runtime/executable/home" "CODEX_HOME=$runtime/executable/codex-home" \
  "XDG_CACHE_HOME=$runtime/executable/cache" "TMPDIR=$runtime/executable/tmp" \
  "PATH=$runtime/executable/bin:/usr/bin:/bin" "CODEX_BIN=$runtime/executable/bin/codex" \
  COREPACK_ENABLE_NETWORK=0 PNPM_CONFIG_OFFLINE=true NPM_CONFIG_USERCONFIG=/dev/null \
  "NPM_CONFIG_GLOBALCONFIG=$runtime/executable/home/global.npmrc" LANG=C.UTF-8 \
  "$bash_bin" --noprofile --norc -c "$runner" -- "$runtime" "${runtime_packages[1]}" "${runtime_packages[3]}"
