#!/usr/bin/env bash
# Scan every blob in the git object database for credential shapes. Output is
# deliberately redacted: only blob/path/line numbers are printed. Optional
# AUDIT_EXTRA entries are pipe-delimited literals, never executable regexes.
set -euo pipefail
umask 077

cd "${1:-.}"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repository" >&2; exit 2; }

PATTERNS='sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|[0-9a-f]{32}\.[A-Za-z0-9]{12,}|\$argon2id\$|BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY'
EXTRA_FILE=""
cleanup() { [ -z "$EXTRA_FILE" ] || rm -f -- "$EXTRA_FILE"; }
trap cleanup EXIT
if [ -n "${AUDIT_EXTRA:-}" ]; then
  EXTRA_FILE="$(mktemp "${TMPDIR:-/tmp}/codex-harness-audit-extra.XXXXXX")"
  printf '%s' "$AUDIT_EXTRA" | tr '|' '\n' | sed '/^[[:space:]]*$/d' > "$EXTRA_FILE"
fi

mapfile -t BLOBS < <(git cat-file --batch-all-objects --batch-check='%(objecttype) %(objectname)' | awk '$1=="blob"{print $2}')
echo "blobs: ${#BLOBS[@]}"
found=0
for blob in "${BLOBS[@]}"; do
  lines="$({ git cat-file blob "$blob" | grep -a -n -i -E "$PATTERNS" || true; } | cut -d: -f1)"
  if [ -n "$EXTRA_FILE" ] && [ -s "$EXTRA_FILE" ]; then
    extra_lines="$(git cat-file blob "$blob" | grep -a -n -i -F -f "$EXTRA_FILE" 2>/dev/null | cut -d: -f1 || true)"
    lines="${lines}${lines:+$'\n'}${extra_lines}"
  fi
  lines="$(printf '%s\n' "$lines" | sed '/^$/d' | sort -nu | paste -sd, -)"
  [ -n "$lines" ] || continue
  name="$(git rev-list --objects --all | awk -v object="$blob" '$1==object{$1=""; print substr($0,2); exit}')"
  printf 'HIT blob %s path=%s lines=%s\n' "$blob" "${name:-?}" "$lines"
  found=1
done

if [ "$found" -ne 0 ]; then
  echo "OBJECT-AUDIT-FAILED (matching contents redacted)" >&2
  exit 1
fi
echo "OBJECT-AUDIT-OK"
