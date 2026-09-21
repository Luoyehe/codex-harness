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
mkdir -p "$seed/node_modules" "$seed/apps/gateway/node_modules" "$seed/apps/web/node_modules"
mkdir -p "$runtime/node_modules/.bin" "$runtime/node_modules/@openai/codex/bin" "$tools"
printf '{"name":"candidate-fixture","private":true}\n' > "$candidate/package.json"
printf '#!/bin/sh\nexit 0\n' > "$candidate/deploy/privileged-helper.sh"
printf 'raise SystemExit(0)\n' > "$candidate/deploy/worker_launcher.py"
printf 'fixture\n' > "$seed/node_modules/root-marker"
printf 'fixture\n' > "$seed/apps/gateway/node_modules/gateway-marker"
printf 'fixture\n' > "$seed/apps/web/node_modules/web-marker"
printf '{"version":"0.149.0"}\n' > "$runtime/node_modules/@openai/codex/package.json"
printf '#!/bin/sh\nexit 0\n' > "$runtime/node_modules/@openai/codex/bin/codex.js"
chmod 755 "$runtime/node_modules/@openai/codex/bin/codex.js"
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
  command=$3
  shift 3
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
    [ "${1:-}" = --offline ] && [ "${2:-}" = --frozen-lockfile ] ;;
  typecheck|test|scripts/release-audit.mjs) ;;
  build)
    mkdir -p apps/gateway/dist apps/web/dist
    cp "$HOME/sandbox-proof" apps/gateway/dist/index.js
    printf 'web\n' > apps/web/dist/index.html ;;
  scripts/gateway-smoke.mjs)
    [ -x "$CODEX_BIN" ] ;;
  *) echo "unexpected fake node command: $command" >&2; exit 92 ;;
esac
FAKE_NODE
chmod 755 "$tools/node"
chmod -R a+rX "$candidate" "$seed" "$runtime" "$tools"

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
