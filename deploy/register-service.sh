#!/usr/bin/env bash
# Reconcile the system files for exactly one already-built deployment.
# Caller snapshots these files during updates and controls restart/rollback.
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
SERVICE_UID="$(id -u "$RUN_USER")" || { echo 'RUN_USER must name an existing service account' >&2; exit 1; }
if [ "$SERVICE_UID" -eq 0 ]; then
  echo 'migrate this service to an unprivileged RUN_USER before updating (ALLOW_ROOT_SERVICE no longer bypasses this requirement)' >&2; exit 1
fi
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
if [ ! -d "$(dirname "$GATEWAY_CONTROL_HOME")" ]; then
  install -d -o root -g root -m 755 "$(dirname "$GATEWAY_CONTROL_HOME")"
fi
if [ ! -d "$GATEWAY_CONTROL_HOME" ]; then
  install -d -o "$GATEWAY_USER" -g "$GATEWAY_GROUP" -m 700 "$GATEWAY_CONTROL_HOME"
fi
# Do not import the old worker-readable gateway token or full secret store.
if [ ! -e "$GATEWAY_ENV_FILE" ]; then
  # Carry only validated non-secret ingress settings across the identity
  # migration. Never reuse a token the worker could already have read.
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
  runuser -u "$GATEWAY_USER" -- python3 -I - "$GATEWAY_ENV_FILE" "$ingress" <<'PY'
import json, os, sys
fields = json.loads(sys.argv[2])
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, "w") as stream:
    stream.write("# Gateway-only settings; provider credentials belong in the worker ENV_FILE.\n")
    for key, value in fields.items(): stream.write(key + "=" + value + "\n")
PY
fi
TOOLS_BIN_DIR="$(PATH="$NODE_BIN_DIR:$PATH" python3 "$SCRIPT_DIR/runtime_paths.py" "${TOOLS_BIN_DIR:-}")"
SERVICE_PATH="$CODEX_BIN_DIR:$NODE_BIN_DIR:$TOOLS_BIN_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
runuser -u "$RUN_USER" -- test -x "$NODE_BIN"
runuser -u "$RUN_USER" -- test -x "$CODEX_BIN"
runuser -u "$RUN_USER" -- test -x "$TOOLS_BIN_DIR"
runuser -u "$GATEWAY_USER" -- test -r "$INSTALL_DIR/apps/gateway/dist/index.js"
runuser -u "$RUN_USER" -- test -r "$INSTALL_DIR/apps/gateway/dist/worker.js"
unit="/etc/systemd/system/$SERVICE_NAME.service"
legacy_helper=0
grep -qxF 'Environment=CODEX_HARNESS_ADMIN_HELPER=/usr/local/libexec/codex-harness-admin' "$unit" 2>/dev/null && legacy_helper=1
if [ -f "$unit" ] && ! grep -qxF "WorkingDirectory=$INSTALL_DIR/apps/gateway" "$unit"; then
  echo "refusing to replace another checkout's unit: $unit" >&2; exit 1
fi
helper="/usr/local/libexec/codex-harness-admin-$SERVICE_NAME"
conf="/etc/codex-harness/$SERVICE_NAME.conf"
grant="/etc/sudoers.d/codex-harness-$SERVICE_NAME"
command_name="codex-harness-$SERVICE_NAME"
[ "$SERVICE_NAME" != codex-harness ] || command_name=codex-harness
temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
cat > "$temporary/unit" <<EOF
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
ExecStart=$NODE_BIN $INSTALL_DIR/apps/gateway/dist/index.js
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
# CODEX_BIN is set on the command itself: EnvironmentFile cannot override it.
sed -i "s|^ExecStart=.*|ExecStart=/usr/bin/env CODEX_BIN=$CODEX_BIN $NODE_BIN $INSTALL_DIR/apps/gateway/dist/index.js|" "$temporary/unit"
printf 'SERVICE_NAME=%s\nRUN_USER=%s\nRUN_HOME=%s\nINSTALL_DIR=%s\nCODEX_HOME=%s\nCODEX_WORKSPACE=%s\nENV_FILE=%s\nCODEX_BIN=%s\nNODE_BIN=%s\nSERVICE_PATH=%s\n' \
  "$SERVICE_NAME" "$RUN_USER" "$RUN_HOME" "$INSTALL_DIR" "$CODEX_HOME" "$CODEX_WORKSPACE" "$ENV_FILE" "$CODEX_BIN" "$NODE_BIN" "$SERVICE_PATH" > "$temporary/conf"
printf '%s ALL=(root) NOPASSWD: %s restart-service, %s recent-logs, %s worker-backend\n' "$GATEWAY_USER" "$helper" "$helper" "$helper" > "$temporary/grant"
visudo -cf "$temporary/grant" >/dev/null
cat > "$temporary/wrapper" <<EOF
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
install -d -o root -g root -m 755 /usr/local/libexec /etc/codex-harness "$BIN_DIR"
install -o root -g root -m 755 "$INSTALL_DIR/deploy/privileged-helper.sh" "$helper"
install -o root -g root -m 755 "$INSTALL_DIR/deploy/worker_launcher.py" "/usr/local/libexec/codex-harness-worker-$SERVICE_NAME"
install -o root -g root -m 600 "$temporary/conf" "$conf"
install -o root -g root -m 440 "$temporary/grant" "$grant"
install -o root -g root -m 644 "$temporary/unit" "$unit"
install -o root -g root -m 755 "$temporary/wrapper" "$BIN_DIR/$command_name"
if [ "$SERVICE_NAME" != codex-harness ] \
   && grep -qxF "exec bash \"$INSTALL_DIR/deploy/manage.sh\" \"\$@\"" "$BIN_DIR/codex-harness" 2>/dev/null \
   && ! grep -qxF '# Managed instance: codex-harness' "$BIN_DIR/codex-harness" \
   && ! grep -qxF "WorkingDirectory=$INSTALL_DIR/apps/gateway" /etc/systemd/system/codex-harness.service 2>/dev/null; then
  rm -f "$BIN_DIR/codex-harness"
fi
if [ "$legacy_helper" = 1 ] && ! grep -lxF 'Environment=CODEX_HARNESS_ADMIN_HELPER=/usr/local/libexec/codex-harness-admin' /etc/systemd/system/*.service >/dev/null 2>&1; then
  rm -f /usr/local/libexec/codex-harness-admin /etc/codex-harness/admin.conf /etc/sudoers.d/codex-harness
fi
printf '%s\n' "$BIN_DIR/$command_name"
