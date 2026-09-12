#!/usr/bin/env bash
# Read-only public edge probe. Never creates users, stores cookies, modifies
# authentication databases, or restarts services.
set -euo pipefail
EDGE="${EDGE_URL:?Set EDGE_URL to the deployed HTTPS entry}"
case "$EDGE" in https://*) ;; *) echo 'EDGE_URL must use HTTPS' >&2; exit 1 ;; esac
declare -a tls_args=()
if [ "${EDGE_INSECURE:-0}" = 1 ]; then tls_args=(-k); fi
response="$(curl -sS "${tls_args[@]}" --max-time 15 -D - -o /dev/null -w $'\n%{http_code}' "${EDGE%/}/")" \
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
