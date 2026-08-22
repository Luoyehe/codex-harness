#!/usr/bin/env bash
# Scan every blob in the git object database for sensitive patterns and print
# the offending file path + line. Deployment-specific literals come from
# $AUDIT_EXTRA (never committed). Usage: bash git-object-audit.sh [repo-dir]
set -eu
cd "${1:-.}"
PATTERNS='sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|[0-9a-f]{32}\.[A-Za-z0-9]{12,}|\$argon2id\$|BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY'
if [ -n "${AUDIT_EXTRA:-}" ]; then PATTERNS="$PATTERNS|$AUDIT_EXTRA"; fi
mapfile -t BLOBS < <(git cat-file --batch-all-objects --batch-check='%(objecttype) %(objectname)' | awk '$1=="blob"{print $2}')
echo "blobs: ${#BLOBS[@]}"
for b in "${BLOBS[@]}"; do
  HIT=$(git cat-file blob "$b" | grep -a -n -i -E "$PATTERNS" || true)
  if [ -n "$HIT" ]; then
    NAME=$(git rev-list --objects --all | awk -v b="$b" '$1==b{$1=""; print substr($0,2)}')
    echo "--- blob $b (${NAME:-?})"
    echo "$HIT"
  fi
done
echo OBJECT-AUDIT-DONE
