#!/usr/bin/env bash
# Diagnose what a browser actually receives: SPA html, asset loading, WS state.
#   PORT=8080                          gateway port (default 8080)
#   SERVICE_NAME=codex-harness         systemd unit
#   EDGE_URL=https://codex.example.com to also probe through the reverse proxy
set -u
PORT="${PORT:-8080}"
SERVICE_NAME="${SERVICE_NAME:-codex-harness}"
G="http://127.0.0.1:${PORT}"
EDGE="${EDGE_URL:-}"

echo "=== index.html asset references"
ASSETS=$(curl -s $G/ | grep -oE 'assets/[^"]+')
echo "$ASSETS"

echo "=== asset fetch status (direct)"
for a in $ASSETS; do
  curl -s -o /dev/null -w "$a -> %{http_code} %{size_download}B\n" "$G/$a"
done

if [ -n "$EDGE" ]; then
  echo "=== asset fetch status (through edge, unauth redirect check)"
  for a in $ASSETS; do
    curl -sk -o /dev/null -w "$a -> %{http_code}\n" "$EDGE/$a"
  done
fi

echo "=== gateway recent logs"
journalctl -u "$SERVICE_NAME" --since "30 min ago" --no-pager 2>/dev/null | tail -8 || true

echo "=== healthz"
curl -s $G/healthz; echo
