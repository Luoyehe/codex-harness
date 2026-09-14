#!/usr/bin/env bash
# Root-owned, sudoers-gated helper used by the unprivileged gateway. Its
# surface contains only fixed instance-scoped operations; browser parameters
# never become root command arguments.
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
[ "$#" -eq 1 ] || { echo "exactly one action is required" >&2; exit 2; }

HELPER_NAME="${0##*/}"
INSTANCE=""
case "$HELPER_NAME" in
  codex-harness-admin-*) INSTANCE="${HELPER_NAME#codex-harness-admin-}"; CONF="/etc/codex-harness/${INSTANCE}.conf" ;;
  codex-harness-admin) CONF=/etc/codex-harness/admin.conf ;; # legacy deployment
  *) echo "unexpected helper name" >&2; exit 1 ;;
esac

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
[ -f "$CONF" ] || { echo "missing $CONF" >&2; exit 1; }
[ "$(stat -c '%u' "$CONF")" = "0" ] || { echo "unsafe config owner" >&2; exit 1; }
case "$(stat -c '%a' "$CONF")" in 600|400) ;; *) echo "unsafe config mode" >&2; exit 1 ;; esac
mapfile -t CONFIG_LINES < "$CONF"
[ "${#CONFIG_LINES[@]}" -ge 1 ] && [ "${#CONFIG_LINES[@]}" -le 10 ] || { echo "invalid config shape" >&2; exit 1; }
if [ "${#CONFIG_LINES[@]}" -ne 1 ]; then
  [ "${#CONFIG_LINES[@]}" -eq 10 ] || { echo 'incomplete worker config' >&2; exit 1; }
  declare -A SEEN=()
  for line in "${CONFIG_LINES[@]}"; do
    key="${line%%=*}"; value="${line#*=}"
    case "$key" in SERVICE_NAME|RUN_USER|RUN_HOME|INSTALL_DIR|CODEX_HOME|CODEX_WORKSPACE|ENV_FILE|CODEX_BIN|NODE_BIN|SERVICE_PATH) ;; *) echo 'invalid worker config key' >&2; exit 1 ;; esac
    [ -n "$value" ] && [ -z "${SEEN[$key]:-}" ] || { echo 'invalid worker config entry' >&2; exit 1; }
    SEEN[$key]=1
  done
fi
case "${CONFIG_LINES[0]}" in SERVICE_NAME=*) SERVICE_NAME="${CONFIG_LINES[0]#SERVICE_NAME=}" ;; *) echo "invalid config key" >&2; exit 1 ;; esac
case "$SERVICE_NAME" in ''|[-_]*|*[!A-Za-z0-9_-]*) echo "invalid service name" >&2; exit 1 ;; esac
[ "${#SERVICE_NAME}" -le 128 ] || { echo "invalid service name" >&2; exit 1; }
[ -z "$INSTANCE" ] || [ "$INSTANCE" = "$SERVICE_NAME" ] \
  || { echo "helper/config instance mismatch" >&2; exit 1; }

case "${1:-}" in
  worker-backend) exec /usr/bin/python3 -I "/usr/local/libexec/codex-harness-worker-${SERVICE_NAME}" "$CONF" ;;
  restart-service) exec systemctl restart -- "${SERVICE_NAME}.service" ;;
  recent-logs) exec journalctl --unit "${SERVICE_NAME}.service" --lines 300 --no-pager --output short ;;
  *) echo "unsupported action" >&2; exit 2 ;;
esac
