#!/usr/bin/env bash
# Full login roundtrip test through the real edge (Caddy forward-auth +
# Authelia firstfactor -> gateway SPA). Uses a throwaway user; restores
# users_database.yml afterwards.
#
# Environment (override for your deployment):
#   EDGE_URL            default https://codex.example.com   your public entry
#   AUTHELIA_UNIT       default authelia                    systemd unit name
#   AUTHELIA_CONTAINER  default authelia                    docker container
#                       (set AUTHELIA_CONTAINER="" if authelia runs bare-metal)
#   USERS_DB            default /etc/authelia/users_database.yml
set -eu

EDGE="${EDGE_URL:-https://codex.example.com}"
AUTHELIA_UNIT="${AUTHELIA_UNIT:-authelia}"
AUTHELIA_CONTAINER="${AUTHELIA_CONTAINER:-authelia}"
USERS_DB="${USERS_DB:-/etc/authelia/users_database.yml}"
TMPUSER="zz-e2e-test"
TMPPASS="E2eTest-$(date +%s)"

wait_authelia() {
  for i in $(seq 1 30); do
    if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:9091/api/verify"; then
      echo "authelia up after ${i} tries"; return 0
    fi
    sleep 2
  done
  echo "authelia did not come up"; return 1
}

echo "=== backup users database"
cp "$USERS_DB" /tmp/users_database.yml.bak

# Register cleanup BEFORE any mutation.
restore() {
  echo "=== restore users database"
  cp /tmp/users_database.yml.bak "$USERS_DB"
  systemctl restart "$AUTHELIA_UNIT"
  wait_authelia || true
}
trap restore EXIT

if [ -n "$AUTHELIA_CONTAINER" ]; then
  HASH=$(docker exec "$AUTHELIA_CONTAINER" authelia crypto hash generate argon2 --password "$TMPPASS" 2>/dev/null \
    | grep -o '\$argon2id\$[A-Za-z0-9$+/=.,_-]*' | head -1)
else
  HASH=$(authelia crypto hash generate argon2 --password "$TMPPASS" 2>/dev/null \
    | grep -o '\$argon2id\$[A-Za-z0-9$+/=.,_-]*' | head -1)
fi
if [ -z "$HASH" ]; then echo "FAIL: could not generate argon2 hash"; exit 1; fi
echo "=== add temp user"
cat >> "$USERS_DB" <<EOF
  ${TMPUSER}:
    displayname: 'E2E Test'
    password: '${HASH}'
    email: e2e@example.com
    groups:
      - admins
EOF
systemctl restart "$AUTHELIA_UNIT"
wait_authelia

echo "=== unauthenticated request (expect 302)"
curl -sk -o /dev/null -w "%{http_code} -> %{redirect_url}\n" "$EDGE/"

echo "=== firstfactor login"
curl -sk -c /tmp/e2e-cookies.txt -o /tmp/e2e-login.json -w "%{http_code}\n" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${TMPUSER}\",\"password\":\"${TMPPASS}\",\"keepMeLoggedIn\":true}" \
  "$EDGE/authelia/api/firstfactor"
cat /tmp/e2e-login.json; echo

echo "=== authenticated app request (expect 200 + SPA html)"
curl -sk -b /tmp/e2e-cookies.txt -o /tmp/e2e-app.html -w "%{http_code}\n" "$EDGE/"
grep -q '<div id="root">' /tmp/e2e-app.html && echo "SPA HTML SERVED" || { echo "NOT SPA HTML:"; head -5 /tmp/e2e-app.html; exit 1; }

echo "=== websocket endpoint through the edge, HTTP/1.1"
# curl cannot see WS close frames: both an accepted and a rejected connection
# report HTTP 101. Distinguish by duration — an accepted WS is held open until
# the 5s cap (exit 28, time_total ≈ 5), a rejected one closes within ~1s.
WS_OUT=$(curl -sk --http1.1 --max-time 5 -b /tmp/e2e-cookies.txt -o /dev/null \
  -w '%{http_code} %{time_total}' \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "$EDGE/ws" || true)
echo "ws upgrade: $WS_OUT (code seconds)"
WS_TT="${WS_OUT##* }"
if awk "BEGIN{exit !($WS_TT >= 4)}"; then
  echo "WS HELD OPEN (>=4s) — edge + gateway auth chain OK"
else
  echo "WS CLOSED EARLY — the upgrade was accepted then dropped"
  echo "(likely the proxy host is not in the gateway TRUSTED_HOSTS allowlist)"
  exit 1
fi

echo "LOGIN-ROUNDTRIP-PASS"
