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
RUN_GROUP="$(id -gn "$RUN_USER")"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
PORT="${PORT:-8080}"
case "$PORT" in ''|*[!0-9]*) exit 1 ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || exit 1
NODE_BIN="${NODE_BIN:-$(command -v node)}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
for name in INSTALL_DIR CODEX_HOME CODEX_WORKSPACE ENV_FILE CODEX_BIN RUN_HOME NODE_BIN BIN_DIR; do
  value="${!name}"
  case "$value" in /*) ;; *) echo "$name must be absolute" >&2; exit 1 ;; esac
  case "$value" in *[!A-Za-z0-9_./@+-]*) echo "unsafe $name" >&2; exit 1 ;; esac
done
TOOLS_BIN_DIR="$(PATH="${NODE_BIN%/*}:$PATH" python3 "$SCRIPT_DIR/runtime_paths.py" "${TOOLS_BIN_DIR:-}")"
SERVICE_PATH="${CODEX_BIN%/*}:${NODE_BIN%/*}:$TOOLS_BIN_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
runuser -u "$RUN_USER" -- test -x "$NODE_BIN"
runuser -u "$RUN_USER" -- test -x "$CODEX_BIN"
runuser -u "$RUN_USER" -- test -x "$TOOLS_BIN_DIR"
runuser -u "$RUN_USER" -- test -r "$INSTALL_DIR/apps/gateway/dist/index.js"
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
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$INSTALL_DIR/apps/gateway
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
Environment=HOME=$RUN_HOME
Environment=CODEX_HOME=$CODEX_HOME
Environment=CODEX_WORKSPACE=$CODEX_WORKSPACE
Environment=GATEWAY_UNIT=$SERVICE_NAME
Environment=ENV_FILE=$ENV_FILE
Environment=NODE_BIN=$NODE_BIN
Environment=TOOLS_BIN_DIR=$TOOLS_BIN_DIR
Environment=CODEX_HARNESS_ADMIN_HELPER=$helper
EnvironmentFile=-$ENV_FILE
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

[Install]
WantedBy=multi-user.target
EOF
# CODEX_BIN is set on the command itself: EnvironmentFile cannot override it.
sed -i "s|^ExecStart=.*|ExecStart=/usr/bin/env CODEX_BIN=$CODEX_BIN $NODE_BIN $INSTALL_DIR/apps/gateway/dist/index.js|" "$temporary/unit"
printf 'SERVICE_NAME=%s\n' "$SERVICE_NAME" > "$temporary/conf"
printf '%s ALL=(root) NOPASSWD: %s restart-service, %s recent-logs\n' "$RUN_USER" "$helper" "$helper" > "$temporary/grant"
visudo -cf "$temporary/grant" >/dev/null
cat > "$temporary/wrapper" <<EOF
#!/bin/bash
# Managed instance: $SERVICE_NAME
export SERVICE_NAME=$SERVICE_NAME
export BIN_DIR=$BIN_DIR
export NODE_BIN=$NODE_BIN
export TOOLS_BIN_DIR=$TOOLS_BIN_DIR
export PATH="$SERVICE_PATH"
exec /bin/bash "$INSTALL_DIR/deploy/manage.sh" "\$@"
EOF
install -d -o root -g root -m 755 /usr/local/libexec /etc/codex-harness "$BIN_DIR"
install -o root -g root -m 755 "$INSTALL_DIR/deploy/privileged-helper.sh" "$helper"
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
