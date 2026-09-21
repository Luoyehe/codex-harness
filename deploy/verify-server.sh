#!/usr/bin/env bash
# Server-side verification for the bare-metal (systemd) gateway deployment.
#   PORT          gateway port                  (default 8080)
#   SERVICE_NAME  systemd unit                  (default codex-harness)
#   EDGE_URL      optional https edge to probe  (e.g. https://codex.example.com)
#   GATEWAY_CONTROL_HOME  private gateway state (discovered from the unit)
set -euo pipefail
PORT="${PORT:-8080}"
SERVICE_NAME="${SERVICE_NAME:-codex-harness}"
EDGE_URL="${EDGE_URL:-}"
case "$PORT" in ''|*[!0-9]*) echo 'FAIL: PORT must be an integer from 1 to 65535' >&2; exit 1 ;; esac
[ "${#PORT}" -le 5 ] || { echo 'FAIL: PORT must be an integer from 1 to 65535' >&2; exit 1; }
PORT_NUMBER=$((10#$PORT))
if (( PORT_NUMBER < 1 || PORT_NUMBER > 65535 )); then
  echo 'FAIL: PORT must be an integer from 1 to 65535' >&2
  exit 1
fi
PORT="$PORT_NUMBER"
GATEWAY="http://127.0.0.1:${PORT}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$SERVICE_NAME" in ''|[-_]*|*[!A-Za-z0-9_-]*) echo 'FAIL: invalid SERVICE_NAME' >&2; exit 1 ;; esac
[ "${#SERVICE_NAME}" -le 128 ] || { echo 'FAIL: invalid SERVICE_NAME' >&2; exit 1; }
if [ -z "${GATEWAY_CONTROL_HOME:-}" ] && [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
  GATEWAY_CONTROL_HOME="$(sed -n 's/^Environment=GATEWAY_CONTROL_HOME=//p' "/etc/systemd/system/${SERVICE_NAME}.service" | head -1)"
  [ -n "$GATEWAY_CONTROL_HOME" ] || [ -n "${GATEWAY_TOKEN:-}" ] \
    || { echo 'FAIL: installed unit has no GATEWAY_CONTROL_HOME; migrate the service or set it explicitly' >&2; exit 1; }
fi
# Match the development gateway default, never its worker CODEX_HOME.
GATEWAY_CONTROL_HOME="${GATEWAY_CONTROL_HOME:-$HOME/.codex-harness-control}"
export GATEWAY_CONTROL_HOME

echo "=== 1. healthz (wait for ready)"
STATE=""
for i in $(seq 1 20); do
  R=$(curl -fsS --max-filesize 65536 --max-time 3 "$GATEWAY/healthz" 2>/dev/null || true)
  STATE=$(echo "$R" | grep -o '"codexState":"[a-z]*"' || true)
  if echo "$STATE" | grep -q ready; then echo "ready after $i tries: $R"; break; fi
  sleep 3
done
if ! echo "$STATE" | grep -q ready; then
  echo "FAIL: not ready ($STATE)"
  journalctl -u "$SERVICE_NAME" --no-pager | tail -20
  exit 1
fi

echo "=== 2. SPA root"
# The Node verifier performs descriptor-pinned bounded token, HTML, asset and
# readiness checks.  Never materialize a possibly growing credential or SPA
# response in a shell variable.
node "$SCRIPT_DIR/ws-token.mjs" --check \
  || { echo 'FAIL: no readable control-plane token; set GATEWAY_CONTROL_HOME or GATEWAY_TOKEN' >&2; exit 1; }
PORT="$PORT" node "$SCRIPT_DIR/verify-spa.mjs" \
  || { echo "FAIL: authenticated SPA verification failed"; exit 1; }

echo "=== 3. WebSocket auth (token/origin/host triple-check)"
GATEWAY_PORT="$PORT" node "$SCRIPT_DIR/verify-ws-auth.mjs" \
  || { echo "WS AUTH FAILED（4001=token 问题，4003=Host/Origin 不被信任——检查本实例 GATEWAY_CONTROL_HOME/gateway.env 的 TRUSTED_HOSTS）"; exit 1; }

echo "=== 4. Read-only WebSocket checks"
GATEWAY_WS="ws://127.0.0.1:${PORT}/ws" node "$SCRIPT_DIR/verify-ws.mjs" || { echo "WS E2E FAILED"; exit 1; }

echo "=== 5. Read-only thread pagination / search / archived listing"
GATEWAY_WS="ws://127.0.0.1:${PORT}/ws" node "$SCRIPT_DIR/verify-threads.mjs" || { echo "THREADS FAILED"; exit 1; }

echo "=== 6. MCP servers status (via gateway)"
GATEWAY_WS="ws://127.0.0.1:${PORT}/ws" node "$SCRIPT_DIR/list-mcp-tools.mjs" || { echo "MCP STATUS FAILED"; exit 1; }
if [ "${HARNESS_ALLOW_PAID_TESTS:-0}" = 1 ]; then
  echo "=== Explicit paid model verification"
  GATEWAY_WS="ws://127.0.0.1:${PORT}/ws" node "$SCRIPT_DIR/verify-full.mjs"
fi

if [ -n "$EDGE_URL" ]; then
  echo "=== 7. edge probe (expect 302/401 when auth is in front, not 502)"
  EDGE_URL="$EDGE_URL" bash "$SCRIPT_DIR/verify-login.sh"
fi

echo "ALL SERVER CHECKS PASSED"
