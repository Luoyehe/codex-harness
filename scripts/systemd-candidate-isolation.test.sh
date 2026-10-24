#!/usr/bin/env bash
# Offline Linux integration test for the real transient DynamicUser boundary.
set -euo pipefail
umask 077
[ "$(id -u)" -eq 0 ] || { echo 'SKIP: root required'; exit 0; }
[ -d /run/systemd/system ] || { echo 'SKIP: systemd is not PID 1'; exit 0; }
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
fixture="$(mktemp -d /opt/codex-harness-candidate-isolation.XXXXXXXX)"
cleanup() { rm -rf -- "$fixture"; }
trap cleanup EXIT

candidate="$fixture/candidate"
seed="$fixture/seed"
runtime="$fixture/runtime"
validated="$fixture/validated"
tools="$fixture/tools"
mkdir -p "$candidate/apps/gateway" "$candidate/apps/web" "$candidate/scripts" "$candidate/deploy"
mkdir -p "$seed/store" "$seed/cache"
mkdir -p "$runtime/node_modules/.bin" "$runtime/node_modules/@openai/codex/bin" "$tools"
printf '{"name":"candidate-fixture","private":true}\n' > "$candidate/package.json"
printf '#!/bin/sh\nexit 0\n' > "$candidate/deploy/privileged-helper.sh"
printf 'raise SystemExit(0)\n' > "$candidate/deploy/worker_launcher.py"
# Candidate-controlled names must never replace the installed trusted runner.
printf '#!/bin/sh\necho CANDIDATE_RUNNER_EXECUTED >&2\nexit 93\n' > "$candidate/deploy/candidate-validation.sh"
printf '#!/bin/sh\necho CANDIDATE_RUNNER_EXECUTED >&2\nexit 93\n' > "$candidate/deploy/candidate-dependencies.sh"
printf 'fixture\n' > "$seed/store/store-marker"
printf 'fixture\n' > "$seed/cache/cache-marker"
printf '{"version":"0.149.0"}\n' > "$runtime/node_modules/@openai/codex/package.json"
printf '{"dependencies":{"@openai/codex":"0.149.0"}}\n' > "$runtime/package.json"
printf '{"lockfileVersion":3,"packages":{}}\n' > "$runtime/package-lock.json"
printf '{"lockfileVersion":3}\n' > "$runtime/node_modules/.package-lock.json"
printf 'normal additional runtime metadata\n' > "$runtime/runtime-note.txt"
mkdir -p "$runtime/node_modules/@openai/codex-linux-x64/vendor"
printf 'optional platform fixture\n' > "$runtime/node_modules/@openai/codex-linux-x64/vendor/marker"
printf '#!/bin/sh\nexit 0\n' > "$runtime/node_modules/@openai/codex/bin/codex.js"
printf '#!/bin/sh\nexit 0\n' > "$runtime/node_modules/@openai/codex/bin/alternate.js"
chmod 755 "$runtime/node_modules/@openai/codex/bin/codex.js"
chmod 755 "$runtime/node_modules/@openai/codex/bin/alternate.js"
ln -s ../@openai/codex/bin/codex.js "$runtime/node_modules/.bin/codex"

printf '{"name":"pnpm","version":"11.22.0"}\n' > "$tools/package.json"
printf '# fake pnpm entry; the sibling node fixture dispatches it\n' > "$tools/pnpm"
chmod 755 "$tools/pnpm"
cat > "$tools/node" <<'FAKE_NODE'
#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" -ne 0 ]
[ -z "${OPENAI_API_KEY:-}${Z_AI_API_KEY:-}${ZHIPU_KEY:-}${CUSTOM_API_KEY:-}${GATEWAY_TOKEN:-}" ]
cgroup="$(awk -F: '$1=="0" {print $3}' /proc/self/cgroup)"
memory="$(cat "/sys/fs/cgroup${cgroup}/memory.max")"
tasks="$(cat "/sys/fs/cgroup${cgroup}/pids.max")"
cpu="$(cat "/sys/fs/cgroup${cgroup}/cpu.max")"
no_new_privileges="$(awk '/^NoNewPrivs:/ {print $2}' /proc/self/status)"
printf 'SANDBOX uid=%s memory=%s tasks=%s cpu=%s no-new-privileges=%s cgroup=%s\n' \
  "$(id -u)" "$memory" "$tasks" "$cpu" "$no_new_privileges" "$cgroup" > "$HOME/sandbox-proof"
[ "$memory" != max ] && [ "$memory" -le 4294967296 ]
[ "$tasks" != max ] && [ "$tasks" -le 512 ]
[ "$cpu" = '400000 100000' ]
[ "$no_new_privileges" = 1 ]
for temporary in /tmp /var/tmp; do
  temporary_type="$(stat -f -c %T "$temporary")"
  temporary_bytes=$(($(stat -f -c %b "$temporary") * $(stat -f -c %S "$temporary")))
  printf 'SANDBOX tempfs=%s:%s:%s\n' "$temporary" "$temporary_type" "$temporary_bytes" >> "$HOME/sandbox-proof"
done
set +e
self_net="$(readlink /proc/self/ns/net)"
init_net="$(readlink /proc/1/ns/net)"
set -e
printf 'SANDBOX net=%s host-net=%s\n' "$self_net" "$init_net" >> "$HOME/sandbox-proof"
[ -n "$self_net" ]
if [ -n "$init_net" ]; then [ "$self_net" != "$init_net" ]; fi
route_rows="$(awk 'NR>1 {count++} END {print count+0}' /proc/net/route)"
[ "$route_rows" -eq 0 ]
if timeout 1 bash -c 'exec 3<>/dev/tcp/192.0.2.1/9' >/dev/null 2>&1; then
  echo 'private network unexpectedly reached an external address' >&2
  exit 91
fi
if [[ "${1:-}" == */pnpm ]]; then
  [ "$2" = --config.verify-deps-before-run=false ]
  [ "$3" = --config.manage-package-manager-versions=false ]
  command=$4
  shift 4
else
  command=${1:-}
  shift || true
fi
if [ -f attack-preack ] && [ "$command" = scripts/gateway-smoke.mjs ]; then
  runtime="${HOME%/executable/home}"
  : > "$runtime/accepted"
fi
case "$command" in
  install)
    [ "${1:-}" = --offline ] && [ "${2:-}" = --frozen-lockfile ]
    mkdir -p node_modules apps/gateway/node_modules apps/web/node_modules ;;
  typecheck|test|--test|--filter|scripts/release-audit.mjs) ;;
  build)
    mkdir -p apps/gateway/dist apps/web/dist
    cp "$HOME/sandbox-proof" apps/gateway/dist/index.js
    printf 'web\n' > apps/web/dist/index.html ;;
  scripts/gateway-smoke.mjs)
    [ -x "$CODEX_BIN" ]
    if [ -f attack-runtime ]; then
      # A candidate may alter its own PATH after tests. The trusted bridge and
      # coordinator must still reject a valid-looking, changed runtime before
      # acknowledgement. Interpose only this offline fixture's export copy.
      cat > "${HOME%/home}/bin/cp" <<'ATTACK_COPY'
#!/usr/bin/env bash
set -euo pipefail
/usr/bin/cp "$@"
destination="${!#}"
destination="${destination%/}"
runtime="${HOME%/executable/home}"
if [ "$destination" = "$runtime/export/payload/runtime" ]; then
  case "$(cat "$runtime/executable/worktree/attack-runtime")" in
    bytes) printf '\nchanged\n' >> "$destination/runtime-note.txt" ;;
    add) printf 'unexpected\n' > "$destination/new-metadata.txt" ;;
    remove) rm -- "$destination/package-lock.json" ;;
    executable) chmod 644 "$destination/node_modules/@openai/codex/bin/codex.js" ;;
    link) ln -sfn ../@openai/codex/bin/alternate.js "$destination/node_modules/.bin/codex" ;;
    *) exit 94 ;;
  esac
fi
ATTACK_COPY
      chmod 700 "${HOME%/home}/bin/cp"
    fi
    ;;
  *) echo "unexpected fake node command: $command" >&2; exit 92 ;;
esac
FAKE_NODE
chmod 755 "$tools/node"
chmod -R a+rX "$candidate" "$seed" "$runtime" "$tools"
seed_info="$(python3 -I "$REPO_ROOT/deploy/update_candidate.py" runtime-info "$runtime" 0.149.0)"
seed_fingerprint="${seed_info#*$'\t'}"

set +e
output="$(NODE_BIN="$tools/node" NODE_BIN_DIR="$tools" \
  bash "$REPO_ROOT/deploy/test-candidate.sh" \
  "$candidate" 0.149.0 "$validated" "$seed" "$runtime")"
status=$?
set -e
printf '%s\n' "$output"
[ "$status" -eq 0 ]
grep -q 'CANDIDATE-VALIDATION-PASS' <<<"$output"
proof="$(cat "$validated/artifacts/apps/gateway/dist/index.js")"
printf '%s\n' "$proof"
grep -q 'SANDBOX uid=' <<<"$proof"
grep -q 'SANDBOX net=' <<<"$proof"
grep -Eq 'SANDBOX tempfs=/tmp:tmpfs:[0-9]+' <<<"$proof"
grep -Eq 'SANDBOX tempfs=/var/tmp:tmpfs:[0-9]+' <<<"$proof"
while IFS=: read -r _ _ temporary_bytes; do
  [ "$temporary_bytes" -le 536870912 ]
done < <(grep '^SANDBOX tempfs=' <<<"$proof")
info="$(python3 -I "$REPO_ROOT/deploy/update_candidate.py" runtime-info \
  "$validated/runtime" 0.149.0)"
[[ "$info" == *$'\t'* ]]
[ "${info#*$'\t'}" = "$seed_fingerprint" ]
cmp "$runtime/package.json" "$validated/runtime/package.json"
cmp "$runtime/package-lock.json" "$validated/runtime/package-lock.json"
cmp "$runtime/node_modules/.package-lock.json" "$validated/runtime/node_modules/.package-lock.json"
cmp "$runtime/runtime-note.txt" "$validated/runtime/runtime-note.txt"

for alteration in bytes add remove executable link; do
  printf '%s\n' "$alteration" > "$candidate/attack-runtime"
  chmod 644 "$candidate/attack-runtime"
  set +e
  altered_output="$(NODE_BIN="$tools/node" NODE_BIN_DIR="$tools" \
    bash "$REPO_ROOT/deploy/test-candidate.sh" \
    "$candidate" 0.149.0 "$fixture/validated-$alteration" "$seed" "$runtime" 2>&1)"
  altered_status=$?
  set -e
  [ "$altered_status" -ne 0 ]
  ! grep -q 'CANDIDATE-VALIDATION-PASS' <<<"$altered_output"
  grep -Eq 'copied runtime differs|candidate update refused|runtime CLI' <<<"$altered_output"
done
rm -- "$candidate/attack-runtime"
final_seed_info="$(python3 -I "$REPO_ROOT/deploy/update_candidate.py" runtime-info "$runtime" 0.149.0)"
[ "${final_seed_info#*$'\t'}" = "$seed_fingerprint" ]

# A candidate cannot manufacture the root acknowledgement to make a payload
# publishable. The trusted O_EXCL acknowledgement must fail closed.
: > "$candidate/attack-preack"
set +e
attack_output="$(NODE_BIN="$tools/node" NODE_BIN_DIR="$tools" \
  bash "$REPO_ROOT/deploy/test-candidate.sh" \
  "$candidate" 0.149.0 "$fixture/validated-attack" "$seed" "$runtime" 2>&1)"
attack_status=$?
set -e
[ "$attack_status" -ne 0 ]
grep -Eq 'candidate update refused|isolated validation exited before presenting output' <<<"$attack_output"
echo 'SYSTEMD-CANDIDATE-ISOLATION-PASS'
