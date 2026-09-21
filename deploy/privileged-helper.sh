#!/usr/bin/env bash
# Root-owned, sudoers-gated helper used by the unprivileged gateway. Its
# surface contains only fixed instance-scoped operations; browser parameters
# never become root command arguments.
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
[ "$#" -eq 1 ] || { echo "exactly one action is required" >&2; exit 2; }

HELPER_NAME="${0##*/}"
INSTANCE=""
case "$HELPER_NAME" in
  codex-harness-admin-*) INSTANCE="${HELPER_NAME#codex-harness-admin-}"; CONF="/etc/codex-harness/${INSTANCE}.conf" ;;
  codex-harness-admin) CONF=/etc/codex-harness/admin.conf ;; # legacy deployment
  *) echo "unexpected helper name" >&2; exit 1 ;;
esac

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
[ -f "$CONF" ] || { echo "missing $CONF" >&2; exit 1; }
[ "$(stat -c '%u' "$CONF")" = "0" ] || { echo "unsafe config owner" >&2; exit 1; }
case "$(stat -c '%a' "$CONF")" in 600|400) ;; *) echo "unsafe config mode" >&2; exit 1 ;; esac
# Shell metadata checks above retain a useful, terse diagnostic.  The actual
# parse is descriptor-pinned and repeated in Python: mapfile can allocate an
# unbounded single line and the path could otherwise be replaced after stat.
SERVICE_NAME="$(/usr/bin/python3 -I - "$CONF" <<'PY'
import os,re,stat,sys

path=sys.argv[1]
limit=64*1024
before=os.lstat(path)
if (not stat.S_ISREG(before.st_mode) or before.st_uid!=0
        or stat.S_IMODE(before.st_mode) not in (0o400,0o600)
        or before.st_nlink!=1 or before.st_size>limit):
    raise SystemExit('unsafe bounded helper config')
fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
try:
    opened=os.fstat(fd)
    identity=lambda value:(value.st_dev,value.st_ino,value.st_mode,value.st_uid,value.st_gid,
                           value.st_nlink,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
    if identity(before)!=identity(opened) or identity(opened)!=identity(os.lstat(path)):
        raise SystemExit('helper config changed while opening')
    chunks=[]; remaining=limit+1
    while remaining:
        chunk=os.read(fd,min(65536,remaining))
        if not chunk: break
        chunks.append(chunk); remaining-=len(chunk)
    raw=b''.join(chunks); after=os.fstat(fd)
    if len(raw)>limit or len(raw)!=before.st_size or identity(before)!=identity(after) or identity(after)!=identity(os.lstat(path)):
        raise SystemExit('helper config changed or exceeds its limit')
finally:
    os.close(fd)
try:
    text=raw.decode('utf-8')
except UnicodeError:
    raise SystemExit('helper config is not UTF-8') from None
if '\0' in text or '\r' in text:
    raise SystemExit('helper config contains control characters')
lines=text.splitlines()
if len(lines) not in (1,10):
    raise SystemExit('invalid helper config shape')
allowed={'SERVICE_NAME','RUN_USER','RUN_HOME','INSTALL_DIR','CODEX_HOME','CODEX_WORKSPACE',
         'ENV_FILE','CODEX_BIN','NODE_BIN','SERVICE_PATH'}
values={}
for line in lines:
    key,separator,value=line.partition('=')
    if (not separator or key not in allowed or key in values or not value
            or any(ord(character)<32 for character in value)):
        raise SystemExit('invalid helper config entry')
    values[key]=value
if set(values)!={'SERVICE_NAME'} and set(values)!=allowed:
    raise SystemExit('incomplete helper config')
service=values['SERVICE_NAME']
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}',service):
    raise SystemExit('invalid service name')
print(service)
PY
)" || { echo "unsafe helper config" >&2; exit 1; }
case "$SERVICE_NAME" in ''|[-_]*|*[!A-Za-z0-9_-]*) echo "invalid service name" >&2; exit 1 ;; esac
[ "${#SERVICE_NAME}" -le 128 ] || { echo "invalid service name" >&2; exit 1; }
[ -z "$INSTANCE" ] || [ "$INSTANCE" = "$SERVICE_NAME" ] \
  || { echo "helper/config instance mismatch" >&2; exit 1; }

case "${1:-}" in
  worker-backend) exec /usr/bin/python3 -I "/usr/local/libexec/codex-harness-worker-${SERVICE_NAME}" "$CONF" ;;
  restart-service) exec systemctl restart -- "${SERVICE_NAME}.service" ;;
  recent-logs) exec journalctl --unit "${SERVICE_NAME}.service" --lines 300 --no-pager --output short ;;
  *) echo "unsupported action" >&2; exit 2 ;;
esac
