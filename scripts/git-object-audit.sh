#!/usr/bin/env bash
# Scan every blob in the git object database for credential shapes. Output is
# deliberately redacted: only blob/path/line numbers are printed. Optional
# AUDIT_EXTRA entries are pipe-delimited literals, never executable regexes.
set -euo pipefail
umask 077

cd "${1:-.}"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repository" >&2; exit 2; }

PATTERNS='sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|[0-9a-f]{32}\.[A-Za-z0-9]{12,}|\$argon2id\$|BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY'
MAX_BLOBS=250000
MAX_BLOB_BYTES=$((50 * 1024 * 1024))
MAX_REACHABLE_PATHS=500000
MAX_REACHABLE_PATH_BYTES=$((32 * 1024 * 1024))
AUDIT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/codex-harness-object-audit.XXXXXX")"
EXTRA_FILE="$AUDIT_TMP/extra"
BLOBS_FILE="$AUDIT_TMP/blobs"
PATHS_FILE="$AUDIT_TMP/paths"
CONTENT_FILE="$AUDIT_TMP/content"
cleanup() {
  rm -f -- "$EXTRA_FILE" "$BLOBS_FILE" "$PATHS_FILE" "$CONTENT_FILE"
  rmdir -- "$AUDIT_TMP" 2>/dev/null || true
}
trap cleanup EXIT
if [ -n "${AUDIT_EXTRA:-}" ]; then
  printf '%s' "$AUDIT_EXTRA" | tr '|' '\n' \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; /^[[:space:]]*$/d' > "$EXTRA_FILE"
fi

if ! git cat-file --batch-all-objects --batch-check='%(objecttype) %(objectname) %(objectsize)' \
    | awk -v limit="$MAX_BLOBS" '$1=="blob" { if (++count > limit) exit 42; print $2, $3 }' > "$BLOBS_FILE"; then
  echo "OBJECT-AUDIT-FAILED (cannot enumerate git objects)" >&2
  exit 1
fi
if ! git --no-replace-objects rev-list --objects --all \
    | awk -v lines="$MAX_REACHABLE_PATHS" -v bytes="$MAX_REACHABLE_PATH_BYTES" \
      '{ used += length($0) + 1; if (NR > lines || used > bytes) exit 42; print }' > "$PATHS_FILE"; then
  echo "OBJECT-AUDIT-FAILED (cannot enumerate reachable paths)" >&2
  exit 1
fi
found=0
read_failed=0
# A credential in a historical filename is still committed data. Report the
# condition without copying that filename into CI logs.
if grep -a -i -E "$PATTERNS" "$PATHS_FILE" >/dev/null; then
  echo 'HIT reachable-path path=<redacted-path>'
  found=1
else
  status=$?
  if [ "$status" -ne 1 ]; then
    echo 'SCAN-FAILED reachable paths' >&2
    read_failed=1
  fi
fi
if [ -s "$EXTRA_FILE" ]; then
  if grep -a -i -F -f "$EXTRA_FILE" "$PATHS_FILE" >/dev/null; then
    echo 'HIT reachable-path path=<redacted-path>'
    found=1
  else
    status=$?
    if [ "$status" -ne 1 ]; then
      echo 'SCAN-FAILED reachable paths' >&2
      read_failed=1
    fi
  fi
fi
blob_count="$(wc -l < "$BLOBS_FILE")"
echo "blobs: $blob_count"
while read -r blob blob_size extra; do
  if [[ ! "$blob" =~ ^[0-9a-f]+$ ]] || [[ ! "$blob_size" =~ ^[0-9]+$ ]] || [ -n "${extra:-}" ]; then
    echo 'OBJECT-AUDIT-FAILED (invalid object inventory)' >&2
    read_failed=1
    continue
  fi
  if [ "$blob_size" -gt "$MAX_BLOB_BYTES" ]; then
    printf 'SKIP-LARGE blob %s bytes=%s\n' "$blob" "$blob_size" >&2
    read_failed=1
    continue
  fi
  # Replacement refs change normal cat-file output. Audit the actual stored
  # object, not a harmless replacement that can conceal its original contents.
  if ! git --no-replace-objects cat-file blob "$blob" > "$CONTENT_FILE"; then
    printf 'READ-FAILED blob %s\n' "$blob" >&2
    read_failed=1
    continue
  fi
  matches=""
  if matches="$(grep -a -n -i -E "$PATTERNS" "$CONTENT_FILE")"; then
    :
  else
    status=$?
    if [ "$status" -ne 1 ]; then
      printf 'SCAN-FAILED blob %s\n' "$blob" >&2
      read_failed=1
      continue
    fi
  fi
  lines="$(printf '%s\n' "$matches" | sed '/^$/d' | cut -d: -f1)"
  if [ -n "$EXTRA_FILE" ] && [ -s "$EXTRA_FILE" ]; then
    extra_matches=""
    if extra_matches="$(grep -a -n -i -F -f "$EXTRA_FILE" "$CONTENT_FILE")"; then
      :
    else
      status=$?
      if [ "$status" -ne 1 ]; then
        printf 'SCAN-FAILED blob %s\n' "$blob" >&2
        read_failed=1
        continue
      fi
    fi
    extra_lines="$(printf '%s\n' "$extra_matches" | sed '/^$/d' | cut -d: -f1)"
    lines="${lines}${lines:+$'\n'}${extra_lines}"
  fi
  lines="$(printf '%s\n' "$lines" | sed '/^$/d' | sort -nu | paste -sd, -)"
  [ -n "$lines" ] || continue
  # A Git pathname is attacker-controlled metadata too: it may itself contain
  # a credential, control sequence, or a future explicit audit pattern. The
  # blob ID remains sufficient for a
  # local investigator to resolve paths without copying them into CI logs.
  printf 'HIT blob %s path=<redacted-path> lines=%s\n' "$blob" "$lines"
  found=1
done < "$BLOBS_FILE"

if [ "$found" -ne 0 ] || [ "$read_failed" -ne 0 ]; then
  echo "OBJECT-AUDIT-FAILED (matching contents redacted)" >&2
  exit 1
fi
echo "OBJECT-AUDIT-OK"
