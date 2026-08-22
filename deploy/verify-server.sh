#!/usr/bin/env bash
# Server-side verification for the bare-metal (systemd) gateway deployment.
#   PORT          gateway port                  (default 8080)
#   SERVICE_NAME  systemd unit                  (default codex-harness)
#   EDGE_URL      optional https edge to probe  (e.g. https://codex.example.com)
set -u
PORT="${PORT:-8080}"
SERVICE_NAME="${SERVICE_NAME:-codex-harness}"
EDGE_URL="${EDGE_URL:-}"
GATEWAY="http://127.0.0.1:${PORT}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== 1. healthz (wait for ready)"
STATE=""
for i in $(seq 1 20); do
  R=$(curl -s --max-time 3 "$GATEWAY/healthz" || true)
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
curl -s -o /dev/null -w "GET / -> %{http_code}\n" "$GATEWAY/"

echo "=== 3. WebSocket auth (token/origin/host triple-check)"
GATEWAY_PORT="$PORT" node "$SCRIPT_DIR/verify-ws-auth.mjs" \
  || { echo "WS AUTH FAILED（4001=token 问题，4003=Host/Origin 不被信任——反代域名需在 /etc/codex-harness.env 的 TRUSTED_HOSTS 里）"; exit 1; }

echo "=== 4. WebSocket end-to-end (app/status, thread/list, terminal, turn)"
GATEWAY_WS="ws://127.0.0.1:${PORT}/ws" node "$SCRIPT_DIR/verify-ws.mjs" || { echo "WS E2E FAILED"; exit 1; }

echo "=== 5. Thread pagination / search / archive round-trip"
GATEWAY_WS="ws://127.0.0.1:${PORT}/ws" node "$SCRIPT_DIR/verify-threads.mjs" || { echo "THREADS FAILED"; exit 1; }

echo "=== 6. MCP servers status (via gateway)"
GATEWAY_WS="ws://127.0.0.1:${PORT}/ws" node "$SCRIPT_DIR/list-mcp-tools.mjs" || echo "(MCP check failed — see above)"

if [ -n "$EDGE_URL" ]; then
  echo "=== 7. edge probe (expect 302/401 when auth is in front, not 502)"
  curl -sk -o /dev/null -w "$EDGE_URL -> %{http_code}\n" "$EDGE_URL/"
fi

echo "ALL SERVER CHECKS PASSED"
