#!/usr/bin/env bash
# Transactionally reconcile the system files for one already-built deployment.
# Updates can leave REGISTER_ACTIVATE=0 and control their own service restart;
# fresh/repair installs set REGISTER_ACTIVATE=1 so activation shares this rollback.
set -euo pipefail
umask 022
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo 'service registration requires root' >&2; exit 1; }
for name in SERVICE_NAME RUN_USER INSTALL_DIR CODEX_HOME CODEX_WORKSPACE ENV_FILE CODEX_BIN; do
  [ -n "${!name:-}" ] || { echo "missing $name" >&2; exit 1; }
done
case "$SERVICE_NAME" in ''|[-_]*|*[!A-Za-z0-9_-]*) exit 1 ;; esac
[ "${#SERVICE_NAME}" -le 128 ] || exit 1
case "$RUN_USER" in ''|[-.]*|*[!A-Za-z0-9_.-]*) exit 1 ;; esac
REGISTER_ACTIVATE="${REGISTER_ACTIVATE:-0}"
case "$REGISTER_ACTIVATE" in 0|1) ;; *) echo 'REGISTER_ACTIVATE must be 0 or 1' >&2; exit 1 ;; esac
SERVICE_UID="$(id -u "$RUN_USER")" || { echo 'RUN_USER must name an existing service account' >&2; exit 1; }
if [ "$SERVICE_UID" -eq 0 ]; then
  echo 'migrate this service to an unprivileged RUN_USER before updating (ALLOW_ROOT_SERVICE no longer bypasses this requirement)' >&2; exit 1
fi
REGISTRATION_HELPER="$SCRIPT_DIR/service_registration.py"
[ -f "$REGISTRATION_HELPER" ] || { echo 'missing service registration transaction helper' >&2; exit 1; }
command -v flock >/dev/null 2>&1 || { echo 'flock is required for service registration' >&2; exit 1; }
REGISTRATION_LOCK="$(python3 -I "$REGISTRATION_HELPER" prepare-lock)"
exec {REGISTRATION_LOCK_FD}<>"$REGISTRATION_LOCK"
flock -x "$REGISTRATION_LOCK_FD"
# Revalidate the public name after acquiring the descriptor lock.  Its parent is
# root-private, so a non-root actor cannot exchange it between these two opens.
[ "$(python3 -I "$REGISTRATION_HELPER" prepare-lock)" = "$REGISTRATION_LOCK" ] \
  || { echo 'registration lock changed while it was acquired' >&2; exit 1; }
[ "$(stat -Lc '%d:%i' "/proc/$$/fd/$REGISTRATION_LOCK_FD")" = "$(stat -Lc '%d:%i' "$REGISTRATION_LOCK")" ] \
  || { echo 'registration lock descriptor mismatch' >&2; exit 1; }
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
if [ -z "${GATEWAY_USER:-}" ]; then
  GATEWAY_USER="ch-gw-$(printf '%s' "$SERVICE_NAME" | sha256sum | cut -c1-16)"
  [ "$SERVICE_NAME" != codex-harness ] || GATEWAY_USER=codex-harness-gateway
  if ! id "$GATEWAY_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir "/var/lib/codex-harness-control/$SERVICE_NAME" --shell /usr/sbin/nologin "$GATEWAY_USER"
  fi
fi
case "$GATEWAY_USER" in ''|[-.]*|*[!A-Za-z0-9_.-]*) echo 'invalid GATEWAY_USER' >&2; exit 1 ;; esac
GATEWAY_UID="$(id -u "$GATEWAY_USER")"
[ "$GATEWAY_UID" -ne 0 ] && [ "$GATEWAY_UID" -ne "$SERVICE_UID" ] \
  || { echo 'GATEWAY_USER must be distinct from root and the worker RUN_USER' >&2; exit 1; }
GATEWAY_GROUP="$(id -gn "$GATEWAY_USER")"
GATEWAY_GID="$(id -g "$GATEWAY_USER")"
case "$GATEWAY_GROUP" in ''|[-.]*|*[!A-Za-z0-9_.-]*) echo 'invalid GATEWAY_GROUP' >&2; exit 1 ;; esac
GATEWAY_CONTROL_HOME="${GATEWAY_CONTROL_HOME:-/var/lib/codex-harness-control/$SERVICE_NAME}"
GATEWAY_ENV_FILE="$GATEWAY_CONTROL_HOME/gateway.env"
PORT="${PORT:-8080}"
case "$PORT" in ''|*[!0-9]*) exit 1 ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || exit 1
NODE_BIN="${NODE_BIN:-$(command -v node)}"
NODE_BIN_DIR="${NODE_BIN_DIR:-${NODE_BIN%/*}}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
for name in INSTALL_DIR CODEX_HOME CODEX_WORKSPACE ENV_FILE CODEX_BIN RUN_HOME NODE_BIN NODE_BIN_DIR BIN_DIR GATEWAY_CONTROL_HOME; do
  value="${!name}"
  case "$value" in /*) ;; *) echo "$name must be absolute" >&2; exit 1 ;; esac
  case "$value" in *[!A-Za-z0-9_./@+-]*) echo "unsafe $name" >&2; exit 1 ;; esac
done
# The gateway executes application code as the control identity. Neither the
# worker nor another local account may replace that code or its ancestors.
# Validate the original link entrance as well as its target, then persist only
# the canonical spelling that passed the same check. A writable alias must not
# become a permanent root/control execution entry point.
INSTALL_DIR="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" tree "$INSTALL_DIR")"
NODE_BIN="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" file "$NODE_BIN")"
NODE_BIN_DIR="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" directory "$NODE_BIN_DIR")"
[ "$(python3 -I "$SCRIPT_DIR/trusted_paths.py" file "$NODE_BIN_DIR/node")" = "$NODE_BIN" ] \
  || { echo 'NODE_BIN_DIR must expose the configured node runtime' >&2; exit 1; }
CODEX_BIN_DIR="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" directory "${CODEX_BIN%/*}")"
CODEX_BIN="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" file "$CODEX_BIN")"
BIN_DIR="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" missing-directory "$BIN_DIR")"
GATEWAY_CONTROL_HOME="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" control "$GATEWAY_CONTROL_HOME")"
GATEWAY_ENV_FILE="$GATEWAY_CONTROL_HOME/gateway.env"
python3 -I - "$INSTALL_DIR" "$NODE_BIN" "$GATEWAY_CONTROL_HOME" "$GATEWAY_UID" <<'PY'
import pathlib, stat, sys
home = pathlib.Path(sys.argv[3])
if home.resolve().is_relative_to(pathlib.Path(sys.argv[1]).resolve()):
    raise SystemExit("GATEWAY_CONTROL_HOME must remain outside the immutable application tree")
if home.exists() or home.is_symlink():
    if home.is_symlink() or not home.is_dir():
        raise SystemExit("GATEWAY_CONTROL_HOME must be a real private directory")
    info = home.stat()
    if info.st_uid != int(sys.argv[4]) or stat.S_IMODE(info.st_mode) != 0o700:
        raise SystemExit("existing GATEWAY_CONTROL_HOME must belong to GATEWAY_USER with mode 0700")
PY
# Do not import the old worker-readable gateway token or full secret store.
# Carry only validated non-secret ingress settings across the identity
# migration. Never reuse a token the worker could already have read.  The
# candidate is published only if gateway.env was absent in the locked snapshot.
ingress="$(runuser -u "$RUN_USER" -- python3 -I - "$ENV_FILE" <<'PY'
import json, re, shlex, sys
fields = {}
try:
    with open(sys.argv[1], encoding="utf-8") as stream: text = stream.read(1024 * 1024 + 1)
except FileNotFoundError:
    text = ""
if len(text) > 1024 * 1024: raise SystemExit("worker environment exceeds migration limit")
for line in text.splitlines():
    key, separator, value = line.partition("=")
    if not separator or key not in ("TRUSTED_HOSTS", "GATEWAY_HTTPS"): continue
    parsed = shlex.split(value, posix=True)
    value = parsed[0] if len(parsed) == 1 else ""
    if key == "TRUSTED_HOSTS" and (len(value) > 8192 or not re.fullmatch(r"[A-Za-z0-9.,:\[\]_-]*", value)):
        raise SystemExit("invalid legacy ingress settings; configure edge after migration")
    if key == "GATEWAY_HTTPS" and value not in ("true", "false", ""):
        raise SystemExit("invalid legacy HTTPS setting")
    fields[key] = value
print(json.dumps(fields))
PY
)"
TOOLS_BIN_DIR="$(PATH="$NODE_BIN_DIR:$PATH" python3 -I "$SCRIPT_DIR/runtime_paths.py" "${TOOLS_BIN_DIR:-}")"
SERVICE_PATH="$CODEX_BIN_DIR:$NODE_BIN_DIR:$TOOLS_BIN_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
runuser -u "$RUN_USER" -- test -x "$NODE_BIN"
runuser -u "$RUN_USER" -- test -x "$CODEX_BIN"
runuser -u "$RUN_USER" -- test -x "$TOOLS_BIN_DIR"
runuser -u "$GATEWAY_USER" -- test -r "$INSTALL_DIR/apps/gateway/dist/index.js"
runuser -u "$RUN_USER" -- test -r "$INSTALL_DIR/apps/gateway/dist/worker.js"
helper="/usr/local/libexec/codex-harness-admin-$SERVICE_NAME"
command_name="codex-harness-$SERVICE_NAME"
[ "$SERVICE_NAME" != codex-harness ] || command_name=codex-harness
REGISTRATION_TRANSACTION="$(python3 -I "$REGISTRATION_HELPER" begin "$SERVICE_NAME")"
REGISTRATION_SYSTEMD_TOUCHED=0
REGISTRATION_PRIOR_ENABLED=0
REGISTRATION_PRIOR_ACTIVE=0

registration_systemd_snapshot() {
  local value status
  value="$(/usr/bin/systemctl is-enabled "$SERVICE_NAME" 2>/dev/null)" && status=0 || status=$?
  case "$value:$status" in
    enabled:0|enabled-runtime:0|linked:0|linked-runtime:0|alias:0) REGISTRATION_PRIOR_ENABLED=1 ;;
    disabled:*|static:*|indirect:*|generated:*|transient:*|not-found:*) REGISTRATION_PRIOR_ENABLED=0 ;;
    *) echo "cannot determine prior enabled state for $SERVICE_NAME ($value)" >&2; return 1 ;;
  esac
  value="$(/usr/bin/systemctl is-active "$SERVICE_NAME" 2>/dev/null)" && status=0 || status=$?
  case "$value:$status" in
    active:0) REGISTRATION_PRIOR_ACTIVE=1 ;;
    inactive:*|failed:*|unknown:*) REGISTRATION_PRIOR_ACTIVE=0 ;;
    *) echo "cannot determine a stable prior active state for $SERVICE_NAME ($value)" >&2; return 1 ;;
  esac
}

activate_registration() {
  REGISTRATION_SYSTEMD_TOUCHED=1
  /usr/bin/systemctl daemon-reload
  /usr/bin/systemctl enable "$SERVICE_NAME"
  if [ "$REGISTRATION_PRIOR_ACTIVE" = 1 ]; then
    /usr/bin/systemctl restart "$SERVICE_NAME"
  else
    /usr/bin/systemctl start "$SERVICE_NAME"
  fi
}

rollback_registration() {
  local status="$?" rollback_failed=0 files_restored=0 service_stopped=1 probe probe_status
  trap - EXIT INT TERM
  if [ -z "${REGISTRATION_TRANSACTION:-}" ]; then exit "$status"; fi
  echo "service registration failed; restoring the previous installation" >&2
  if [ "$REGISTRATION_SYSTEMD_TOUCHED" = 1 ]; then
    if ! /usr/bin/systemctl stop "$SERVICE_NAME"; then
      probe="$(/usr/bin/systemctl is-active "$SERVICE_NAME" 2>/dev/null)" && probe_status=0 || probe_status=$?
      case "$probe:$probe_status" in
        inactive:3|failed:3|unknown:4)
          echo "service stop returned an error, but systemd proves the unit is not active; continuing rollback" >&2
          ;;
        *)
          echo "failed to stop the candidate service; refusing to replace files under a live process" >&2
          rollback_failed=1
          service_stopped=0
          ;;
      esac
    fi
    if [ "$REGISTRATION_PRIOR_ENABLED" = 0 ] && ! /usr/bin/systemctl disable "$SERVICE_NAME"; then
      rollback_failed=1
    fi
  fi
  if [ "$service_stopped" = 1 ]; then
    if python3 -I "$REGISTRATION_HELPER" restore "$REGISTRATION_TRANSACTION"; then
      files_restored=1
    else
      rollback_failed=1
    fi
  fi
  if [ "$files_restored" = 1 ] && [ "$REGISTRATION_SYSTEMD_TOUCHED" = 1 ]; then
    /usr/bin/systemctl daemon-reload || rollback_failed=1
    if [ "$REGISTRATION_PRIOR_ENABLED" = 1 ]; then
      /usr/bin/systemctl enable "$SERVICE_NAME" || rollback_failed=1
    fi
    if [ "$REGISTRATION_PRIOR_ACTIVE" = 1 ]; then
      /usr/bin/systemctl start "$SERVICE_NAME" || rollback_failed=1
    fi
  fi
  if [ "$rollback_failed" = 0 ] && python3 -I "$REGISTRATION_HELPER" discard "$REGISTRATION_TRANSACTION"; then
    echo "previous service registration restored" >&2
  else
    echo "ERROR: registration rollback incomplete; root-private recovery retained at $REGISTRATION_TRANSACTION" >&2
    echo "Resolve the reported runtime/filesystem issue, then retry: python3 -I '$REGISTRATION_HELPER' restore '$REGISTRATION_TRANSACTION'" >&2
  fi
  exit "$status"
}
trap rollback_registration EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$REGISTER_ACTIVATE" = 1 ]; then
  [ -x /usr/bin/systemctl ] || { echo '/usr/bin/systemctl is required for activated registration' >&2; exit 1; }
  registration_systemd_snapshot
fi

asset_dir="${REGISTER_ASSET_DIR:-$INSTALL_DIR/deploy}"
asset_dir="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" tree "$asset_dir")"
admin_asset="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" file "$asset_dir/privileged-helper.sh")"
worker_asset="$(python3 -I "$SCRIPT_DIR/trusted_paths.py" file "$asset_dir/worker_launcher.py")"
[ "$admin_asset" = "$asset_dir/privileged-helper.sh" ] \
  && [ "$worker_asset" = "$asset_dir/worker_launcher.py" ] \
  || { echo 'registration assets must be real files inside their validated directory' >&2; exit 1; }
stage="$REGISTRATION_TRANSACTION/stage"
umask 077
install -o root -g root -m 600 "$admin_asset" "$stage/admin-helper"
install -o root -g root -m 600 "$worker_asset" "$stage/worker-launcher"
cat > "$stage/unit" <<EOF
[Unit]
Description=Codex Harness WebUI gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$GATEWAY_USER
Group=$GATEWAY_GROUP
WorkingDirectory=$INSTALL_DIR/apps/gateway
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
Environment=HOME=$GATEWAY_CONTROL_HOME
Environment=RUN_USER=$RUN_USER
Environment=GATEWAY_USER=$GATEWAY_USER
Environment=GATEWAY_CONTROL_HOME=$GATEWAY_CONTROL_HOME
Environment=GATEWAY_ENV_FILE=$GATEWAY_ENV_FILE
Environment=GATEWAY_BOOTSTRAP_AUTH=required
Environment=CODEX_HOME=$CODEX_HOME
Environment=CODEX_WORKSPACE=$CODEX_WORKSPACE
Environment=GATEWAY_UNIT=$SERVICE_NAME
Environment=ENV_FILE=$ENV_FILE
Environment=NODE_BIN=$NODE_BIN
Environment=NODE_BIN_DIR=$NODE_BIN_DIR
Environment=TOOLS_BIN_DIR=$TOOLS_BIN_DIR
Environment=CODEX_HARNESS_ADMIN_HELPER=$helper
Environment=CODEX_WORKER_LAUNCHER=$helper
EnvironmentFile=-$GATEWAY_ENV_FILE
# Keep the protocol runtime fixed even if the optional secret store has CODEX_BIN.
UnsetEnvironment=CODEX_BIN
ExecStart=/usr/bin/env CODEX_BIN=$CODEX_BIN $NODE_BIN $INSTALL_DIR/apps/gateway/dist/index.js
ExecStartPre=/usr/bin/test -x $CODEX_BIN
Environment=PATH=$SERVICE_PATH
Restart=always
RestartSec=3
UMask=0077
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
TasksMax=512
KillMode=control-group
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
printf 'SERVICE_NAME=%s\nRUN_USER=%s\nRUN_HOME=%s\nINSTALL_DIR=%s\nCODEX_HOME=%s\nCODEX_WORKSPACE=%s\nENV_FILE=%s\nCODEX_BIN=%s\nNODE_BIN=%s\nSERVICE_PATH=%s\n' \
  "$SERVICE_NAME" "$RUN_USER" "$RUN_HOME" "$INSTALL_DIR" "$CODEX_HOME" "$CODEX_WORKSPACE" "$ENV_FILE" "$CODEX_BIN" "$NODE_BIN" "$SERVICE_PATH" > "$stage/admin.conf"
printf '%s ALL=(root) NOPASSWD: %s restart-service, %s recent-logs, %s worker-backend\n' "$GATEWAY_USER" "$helper" "$helper" "$helper" > "$stage/sudoers"
visudo -cf "$stage/sudoers" >/dev/null
cat > "$stage/command" <<EOF
#!/bin/bash
# Managed instance: $SERVICE_NAME
export SERVICE_NAME=$SERVICE_NAME
export BIN_DIR=$BIN_DIR
export NODE_BIN=$NODE_BIN
export NODE_BIN_DIR=$NODE_BIN_DIR
export TOOLS_BIN_DIR=$TOOLS_BIN_DIR
export GATEWAY_USER=$GATEWAY_USER
export GATEWAY_CONTROL_HOME=$GATEWAY_CONTROL_HOME
export PATH="$SERVICE_PATH"
exec /bin/bash "$INSTALL_DIR/deploy/manage.sh" "\$@"
EOF
python3 -I - "$stage/gateway.env" "$ingress" <<'PY'
import json, os, sys
fields = json.loads(sys.argv[2])
descriptor = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    payload = "# Gateway-only settings; provider credentials belong in the worker ENV_FILE.\n"
    payload += "".join(key + "=" + value + "\n" for key, value in fields.items())
    encoded = payload.encode("utf-8")
    offset = 0
    while offset < len(encoded):
        written = os.write(descriptor, encoded[offset:])
        if written <= 0: raise OSError("gateway environment staging write made no progress")
        offset += written
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY

python3 -I "$REGISTRATION_HELPER" apply "$REGISTRATION_TRANSACTION" "$SERVICE_NAME" "$BIN_DIR" \
  "$GATEWAY_CONTROL_HOME" "$GATEWAY_UID" "$GATEWAY_GID" "$INSTALL_DIR"
if [ "$REGISTER_ACTIVATE" = 1 ]; then
  activate_registration
fi
python3 -I "$REGISTRATION_HELPER" discard "$REGISTRATION_TRANSACTION"
REGISTRATION_TRANSACTION=""
trap - EXIT INT TERM
printf '%s\n' "$BIN_DIR/$command_name"
