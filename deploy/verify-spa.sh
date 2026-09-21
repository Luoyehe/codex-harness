#!/usr/bin/env bash
# Read-only authenticated SPA/asset diagnostics. Never prints credentials or
# application/log contents. EDGE_URL probes only the unauthenticated edge.
set -euo pipefail
SERVICE_NAME="${SERVICE_NAME:-codex-harness}"
case "$SERVICE_NAME" in ''|[-_]*|*[!A-Za-z0-9_-]*) echo 'FAIL: invalid SERVICE_NAME' >&2; exit 1 ;; esac
[ "${#SERVICE_NAME}" -le 128 ] || { echo 'FAIL: invalid SERVICE_NAME' >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${GATEWAY_CONTROL_HOME:-}" ] && [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
  GATEWAY_CONTROL_HOME="$(sed -n 's/^Environment=GATEWAY_CONTROL_HOME=//p' "/etc/systemd/system/${SERVICE_NAME}.service" | head -1)"
  [ -n "$GATEWAY_CONTROL_HOME" ] || [ -n "${GATEWAY_TOKEN:-}" ] \
    || { echo 'FAIL: installed unit has no control home; specify it explicitly' >&2; exit 1; }
  export GATEWAY_CONTROL_HOME
fi
exec node "$SCRIPT_DIR/verify-spa.mjs"
