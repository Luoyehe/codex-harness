#!/usr/bin/env bash
# Read-only public edge probe. Never creates users, stores cookies, modifies
# authentication databases, or restarts services.
set -euo pipefail
EDGE="${EDGE_URL:?Set EDGE_URL to the deployed HTTPS entry}"
EDGE="$(EDGE_CANDIDATE="$EDGE" python3 -I - <<'PY'
import os
from urllib.parse import urlsplit
value=os.environ['EDGE_CANDIDATE']
if any(ord(character)<32 for character in value) or len(value)>4096:
    raise SystemExit('invalid EDGE_URL')
parsed=urlsplit(value)
try: port=parsed.port
except ValueError: raise SystemExit('invalid EDGE_URL') from None
if (parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password
        or parsed.query or parsed.fragment or parsed.path not in ('','/') or port==0):
    raise SystemExit('EDGE_URL must be one HTTPS origin without credentials, query, fragment, or path')
print('https://'+parsed.netloc)
PY
)" || exit 1
case "${EDGE_INSECURE:-0}" in 0|1) ;; *) echo 'EDGE_INSECURE must be 0 or 1' >&2; exit 1 ;; esac
declare -a tls_args=()
if [ "${EDGE_INSECURE:-0}" = 1 ]; then tls_args=(-k); fi
response="$(curl -sS --proto '=https' --proto-redir '=https' "${tls_args[@]}" --connect-timeout 5 --max-time 15 -D - -o /dev/null -w $'\n%{http_code}' "${EDGE%/}/")" \
  || { echo 'FAIL: edge transport/TLS error'; exit 1; }
code="${response##*$'\n'}"
headers="${response%$'\n'*}"
case "$code" in
  401|403) ;;
  302|303|307|308)
    printf '%s\n' "$headers" | tr -d '\r' | grep -Ei '^location: (https://|/)' >/dev/null \
      || { echo 'FAIL: authentication redirect is missing or not HTTPS/relative'; exit 1; }
    ;;
  *) echo "FAIL: unauthenticated edge returned $code (expected authentication redirect/401/403)"; exit 1 ;;
esac
echo "PUBLIC EDGE PROBE PASSED ($code). Complete login in a browser; no accounts, cookies or services were changed."
