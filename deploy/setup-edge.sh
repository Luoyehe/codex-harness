#!/usr/bin/env bash
# Remote-access edge wizard: local-only (SSH tunnel) or Caddy(TLS) +
# Authelia(login) in front of the gateway.
#
#   bash deploy/setup-edge.sh                 # interactive
#   EDGE=none bash deploy/setup-edge.sh       # local only, no prompts
# Unattended full setup:
#   EDGE=caddy-authelia EDGE_DOMAIN=codex.example.com \
#   EDGE_TLS=auto|selfsigned|own [EDGE_CERT_DIR=...] \
#   [EDGE_USER=admin] [EDGE_PASS=...] bash deploy/setup-edge.sh
#
# Existing Caddy / Authelia are detected and reused: only the site block (and
# a first Authelia user when fresh) is added. Test/dry-run overrides:
#   SERVICE_MGR=none   skip systemctl (validate configs only)
#   CADDY_FILE/AUTHELIA_DIR/AUTHELIA_UNIT/AUTHELIA_ADDR
#   EDGE_LISTEN_PORT/GATEWAY_PORT
# External complex access_control rules require AUTHELIA_POLICY_REVIEWED=1
# after administrator review; this never substitutes for a browser login test.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GATEWAY_UNIT="${GATEWAY_UNIT:-codex-harness}"
case "$GATEWAY_UNIT" in ''|[-_]*|*[!A-Za-z0-9_-]*) echo 'invalid GATEWAY_UNIT' >&2; exit 1 ;; esac
# Remember custom edge paths so a later `manage edge disable` addresses the
# same resources. It is read only after the root transaction lock is held.
EDGE_STATE="/etc/codex-harness/${GATEWAY_UNIT}.edge.json"

EDGE="${EDGE:-}"
DOMAIN="${EDGE_DOMAIN:-}"
TLS_MODE="${EDGE_TLS:-}"
CERT_DIR="${EDGE_CERT_DIR:-}"
AUTH_USER="${EDGE_USER:-admin}"
AUTH_PASS="${EDGE_PASS:-}"
GATEWAY_PORT="${GATEWAY_PORT:-${PORT:-8080}}"
LISTEN_PORT="${EDGE_LISTEN_PORT:-443}"
LISTEN_PORT_EXPLICIT=""
[ -n "${EDGE_LISTEN_PORT:-}" ] && LISTEN_PORT_EXPLICIT=1
AUTH_USER_EXPLICIT=""
[ -n "${EDGE_USER:-}" ] && AUTH_USER_EXPLICIT=1
INPUT_CADDY_FILE="${CADDY_FILE:-}"
INPUT_AUTHELIA_DIR="${AUTHELIA_DIR:-}"
INPUT_AUTHELIA_UNIT="${AUTHELIA_UNIT:-}"
INPUT_AUTHELIA_ADDR="${AUTHELIA_ADDR:-}"
CADDY_FILE="${CADDY_FILE:-/etc/caddy/Caddyfile}"
AUTHELIA_DIR="${AUTHELIA_DIR:-/etc/authelia}"
AUTHELIA_UNIT="${AUTHELIA_UNIT:-authelia}"
AUTHELIA_STATE_DIR="/var/lib/${AUTHELIA_UNIT}"
CADDY_USER=caddy
MANAGED_TLS_DIR="/etc/codex-harness/tls/${GATEWAY_UNIT}"
# Loopback address Authelia listens on (fresh installs). Override when 9091
# is already taken by another Authelia.
AUTHELIA_ADDR="${AUTHELIA_ADDR:-127.0.0.1:9091}"
AUTHELIA_VERSION="${AUTHELIA_VERSION:-4.38.19}" # pinned; explicit override supported
SERVICE_MGR="${SERVICE_MGR:-systemd}"
ENV_FILE="${ENV_FILE:-}"
# `sudo bash setup-edge.sh` changes HOME to /root.  Prefer the canonical
# secret store recorded by the installed gateway instead of accidentally
# creating a second environment file under root's home.
if [ -z "$ENV_FILE" ]; then
  UNIT_PATH="/etc/systemd/system/${GATEWAY_UNIT}.service"
  if [ -f "$UNIT_PATH" ]; then
    ENV_FILE="$(sed -n 's/^Environment=ENV_FILE=//p' "$UNIT_PATH" | head -1)"
  fi
fi
ENV_FILE="${ENV_FILE:-${CODEX_HOME:-$HOME/.codex}/secrets.env}"
if [ -z "${CODEX_HOME:-}" ] && [ -f "/etc/systemd/system/${GATEWAY_UNIT}.service" ]; then
  CODEX_HOME="$(sed -n 's/^Environment=CODEX_HOME=//p' "/etc/systemd/system/${GATEWAY_UNIT}.service" | head -1)"
fi
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
if [ -z "${RUN_USER:-}" ] && [ -f "/etc/systemd/system/${GATEWAY_UNIT}.service" ]; then
  RUN_USER="$(sed -n 's/^User=//p' "/etc/systemd/system/${GATEWAY_UNIT}.service" | head -1)"
fi
export RUN_USER="${RUN_USER:-}"
# New managed deployments isolate gateway settings from worker credentials.
# The edge editor uses the gateway identity and its own lock/private directory.
UNIT_PATH="/etc/systemd/system/${GATEWAY_UNIT}.service"
if [ -f "$UNIT_PATH" ]; then
  CONTROL_HOME="$(sed -n 's/^Environment=GATEWAY_CONTROL_HOME=//p' "$UNIT_PATH" | head -1)"
  if [ -n "$CONTROL_HOME" ]; then
    CODEX_HOME="$CONTROL_HOME"
    ENV_FILE="$CONTROL_HOME/gateway.env"
    RUN_USER="$(sed -n 's/^User=//p' "$UNIT_PATH" | head -1)"
    export RUN_USER CODEX_HOME
  fi
fi

log() { echo "[edge] $*"; }
die() { echo "[edge] ERROR: $*" >&2; exit 1; }

systemctl_do() {
  if [ "$SERVICE_MGR" = "none" ]; then log "(dry-run) systemctl $*"; else
    if command -v systemctl >/dev/null 2>&1; then systemctl "$@"; else log "systemd 模式缺少 systemctl，未执行: $*"; return 1; fi
  fi
}

download_https() {
  local url="$1" output="$2" byte_limit="$3" actual_size
  if ! curl -fsSL --proto '=https' --proto-redir '=https' \
      --connect-timeout 10 --max-time 120 \
      --retry 2 --retry-delay 1 --retry-max-time 180 \
      --max-filesize "$byte_limit" \
      "$url" -o "$output"; then
    return 1
  fi
  actual_size="$(stat -c %s -- "$output")" || return 1
  if [ "$actual_size" -le 0 ] || [ "$actual_size" -gt "$byte_limit" ]; then
    return 1
  fi
}

wait_authelia() {
  [ "$SERVICE_MGR" = systemd ] || return 0
  local attempt
  for ((attempt=0; attempt<40; attempt++)); do
    if { [ "${1:-owned}" = external ] || systemctl is-active --quiet "$AUTHELIA_UNIT"; } \
       && curl -fsS --noproxy '*' --max-time 1 "http://${AUTHELIA_ADDR}/authelia/api/health" 2>/dev/null \
         | python3 -I -c 'import json,sys; assert json.load(sys.stdin).get("status") == "UP"' >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

need_root() {
  [ "$(id -u)" -eq 0 ] || die "请以 root 运行（或 sudo）"
}
lock_edge() {
  python3 -I "$SCRIPT_DIR/trusted_paths.py" missing-directory /etc/codex-harness >/dev/null \
    || die "edge 锁目录必须由 root 持有且不可被其它用户写入"
  install -d -o root -g root -m 755 /etc/codex-harness
  exec 9>/etc/codex-harness/.edge.lock
  flock -n 9 || die "另一个 edge 配置事务正在运行，请稍后重试"
}

check_edge_paths() {
  # Canonical root-owned ancestors prevent unprivileged replacement between
  # these checks and later shell metadata writes. Do not repair worker-owned
  # configuration automatically or follow linked configuration files as root.
  AUTHELIA_DIR="$(python3 -I "$SCRIPT_DIR/edge_metadata.py" configuration "$AUTHELIA_DIR")" || die "Authelia 配置路径不可信，请先人工迁移"
  CADDY_FILE="$(python3 -I "$SCRIPT_DIR/edge_metadata.py" file "$CADDY_FILE")" || die "Caddy 配置路径不可信"
  python3 -I "$SCRIPT_DIR/edge_metadata.py" file "$EDGE_STATE" >/dev/null || die "edge 状态路径不可信"
  python3 -I "$SCRIPT_DIR/edge_metadata.py" file "/etc/systemd/system/${AUTHELIA_UNIT}.service" >/dev/null || die "Authelia unit 路径不可信"
  python3 -I "$SCRIPT_DIR/edge_metadata.py" file "/etc/systemd/system/${AUTHELIA_UNIT}.service.d/codex-harness-hardening.conf" >/dev/null || die "Authelia drop-in 路径不可信"
}

load_saved_edge_state() {
  local saved name value
  saved="$(python3 -I "$SCRIPT_DIR/edge_metadata.py" state "$EDGE_STATE")" \
    || die "edge 状态文件不可信或读取失败"
  while IFS=$'\t' read -r name value; do
    [ -n "$name" ] || continue
    case "$name" in
      CADDY_FILE) [ -n "$INPUT_CADDY_FILE" ] || CADDY_FILE="$value" ;;
      AUTHELIA_DIR) [ -n "$INPUT_AUTHELIA_DIR" ] || AUTHELIA_DIR="$value" ;;
      AUTHELIA_UNIT) [ -n "$INPUT_AUTHELIA_UNIT" ] || AUTHELIA_UNIT="$value" ;;
      AUTHELIA_ADDR) [ -n "$INPUT_AUTHELIA_ADDR" ] || AUTHELIA_ADDR="$value" ;;
      *) die "edge 状态包含未知字段" ;;
    esac
  done <<< "$saved"
  AUTHELIA_STATE_DIR="/var/lib/${AUTHELIA_UNIT}"
}

validate_unit_name() {
  local label="$1" value="$2"
  case "$value" in
    ''|[-_]*|*[!A-Za-z0-9_-]*) die "$label 不是安全的 systemd unit 名称: $value" ;;
  esac
  [ "${#value}" -le 128 ] || die "$label 过长"
}
validate_port() {
  local label="$1" value="$2"
  case "$value" in ''|*[!0-9]*) die "$label 必须是数字: $value" ;; esac
  [ "$value" -ge 1 ] && [ "$value" -le 65535 ] || die "$label 必须在 1..65535: $value"
}
validate_path() {
  local label="$1" value="$2"
  case "$value" in /*) ;; *) die "$label 必须是绝对路径: $value" ;; esac
  case "$value" in *[!A-Za-z0-9_./@+-]*) die "$label 含不安全字符: $value" ;; esac
}
validate_edge_values() {
  validate_unit_name GATEWAY_UNIT "$GATEWAY_UNIT"
  validate_unit_name AUTHELIA_UNIT "$AUTHELIA_UNIT"
  validate_port GATEWAY_PORT "$GATEWAY_PORT"
  [[ "$AUTHELIA_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "AUTHELIA_VERSION 必须是 x.y.z 数字版本"
  validate_path CADDY_FILE "$CADDY_FILE"
  validate_path AUTHELIA_DIR "$AUTHELIA_DIR"
  validate_path ENV_FILE "$ENV_FILE"
  validate_path CODEX_HOME "$CODEX_HOME"
  AUTHELIA_ADDR="$AUTHELIA_ADDR" python3 -I - <<'PY' || die "AUTHELIA_ADDR 必须是带端口的回环地址"
import ipaddress, os
from urllib.parse import urlsplit
value = os.environ["AUTHELIA_ADDR"]
parsed = urlsplit("//" + value)
host = parsed.hostname
try: port = parsed.port
except ValueError: port = None
if host == "localhost":
    ok = True
else:
    try: ok = ipaddress.ip_address(host).is_loopback
    except ValueError: ok = False
raise SystemExit(0 if ok and port and not parsed.path else 1)
PY
}
validate_edge_values

# Symmetric local-only transition: remove only marker-owned Caddy blocks,
# clear gateway edge trust, and stop an Authelia unit only when this project
# created it. Existing unrelated Caddy/Authelia configuration is untouched.
if [ "${EDGE_ACTION:-}" = "disable" ]; then
  need_root
  lock_edge
  load_saved_edge_state
  validate_edge_values
  check_edge_paths
  DISABLE_BACKUP="$(mktemp -d)"
  DISABLE_CADDY_CHANGED=0
  DISABLE_ENV_CHANGED=0
  DISABLE_AUTH_CHANGED=0
  DISABLE_AUTH_ACTIVE=0
  DISABLE_AUTH_ENABLED=0
  DISABLE_EDGE_STATE_CHANGED=0
  DISABLE_EDGE_STATE_EXISTED=0
  DISABLE_TLS_CHANGED=0
  DISABLE_TLS_EXISTED=0
  DISABLE_TLS_PRESENT=0
  cleanup_disable() {
    local status=$?
    local rollback_failed=0
    local caddy_restore_ready=1
    trap - EXIT
    if [ "$status" -ne 0 ]; then
      set +e
      if [ "$DISABLE_CADDY_CHANGED" = 1 ]; then
        cp --remove-destination --preserve=mode,ownership,timestamps "$DISABLE_BACKUP/Caddyfile" "$CADDY_FILE" \
          || { rollback_failed=1; caddy_restore_ready=0; }
      fi
      if [ "${DISABLE_TLS_CHANGED:-0}" = 1 ] && [ "${DISABLE_TLS_EXISTED:-0}" = 1 ]; then
        python3 -I "$SCRIPT_DIR/edge_tls.py" restore "$GATEWAY_UNIT" "$DISABLE_BACKUP/tls" "$CADDY_USER" \
          || { rollback_failed=1; caddy_restore_ready=0; }
      fi
      if [ "$DISABLE_CADDY_CHANGED" = 1 ]; then
        if [ "$caddy_restore_ready" = 1 ]; then
          systemctl_do reload caddy || rollback_failed=1
        else
          rollback_failed=1
        fi
      fi
      if [ "$DISABLE_ENV_CHANGED" = 1 ]; then
        python3 -I "$SCRIPT_DIR/edge_env.py" "$CODEX_HOME" "$ENV_FILE" restore "$DISABLE_BACKUP/edge-env.json" || rollback_failed=1
        if [ "${EDGE_GATEWAY_STOPPED:-0}" != 1 ] && [ -f "/etc/systemd/system/${GATEWAY_UNIT}.service" ]; then systemctl_do restart "$GATEWAY_UNIT" || rollback_failed=1; fi
      fi
      if [ "$DISABLE_AUTH_CHANGED" = 1 ]; then
        if [ "$DISABLE_AUTH_ENABLED" = 1 ]; then systemctl_do enable "$AUTHELIA_UNIT" || rollback_failed=1; else systemctl_do disable "$AUTHELIA_UNIT" || rollback_failed=1; fi
        if [ "$DISABLE_AUTH_ACTIVE" = 1 ]; then systemctl_do start "$AUTHELIA_UNIT" || rollback_failed=1; else systemctl_do stop "$AUTHELIA_UNIT" || rollback_failed=1; fi
      fi
      if [ "$DISABLE_EDGE_STATE_CHANGED" = 1 ]; then
        if [ "$DISABLE_EDGE_STATE_EXISTED" = 1 ]; then
          cp --remove-destination --preserve=mode,ownership,timestamps "$DISABLE_BACKUP/edge-state.json" "$EDGE_STATE" || rollback_failed=1
        else
          rm -f -- "$EDGE_STATE" || rollback_failed=1
        fi
      fi
    fi
    if [ "$rollback_failed" = 1 ]; then
      log "自动恢复未完成；私有恢复副本保留在 $DISABLE_BACKUP，请人工恢复后再清理"
      exit "$status"
    fi
    rm -rf -- "$DISABLE_BACKUP"
    exit "$status"
  }
  trap cleanup_disable EXIT
  if [ -f "$CADDY_FILE" ]; then cp --preserve=mode,ownership,timestamps "$CADDY_FILE" "$DISABLE_BACKUP/Caddyfile"; fi
  if [ -f "$EDGE_STATE" ]; then
    cp --preserve=mode,ownership,timestamps "$EDGE_STATE" "$DISABLE_BACKUP/edge-state.json"
    DISABLE_EDGE_STATE_EXISTED=1
  fi
  python3 -I "$SCRIPT_DIR/edge_env.py" "$CODEX_HOME" "$ENV_FILE" snapshot "$DISABLE_BACKUP/edge-env.json"
  if [ -e "$MANAGED_TLS_DIR" ] || [ -L "$MANAGED_TLS_DIR" ]; then
    DISABLE_TLS_PRESENT=1
    if python3 -I "$SCRIPT_DIR/edge_tls.py" snapshot "$GATEWAY_UNIT" "$DISABLE_BACKUP/tls" "$CADDY_USER"; then
      DISABLE_TLS_EXISTED=1
    else
      tls_snapshot_status=$?
      [ "$tls_snapshot_status" = 3 ] \
        || die "现有实例 TLS 目录不可信；拒绝删除"
      log "检测到可信但不完整的实例 TLS 残留；禁用时一并清理"
    fi
  fi
  if [ "$SERVICE_MGR" = systemd ]; then
    systemctl is-active --quiet "$AUTHELIA_UNIT" && DISABLE_AUTH_ACTIVE=1
    systemctl is-enabled --quiet "$AUTHELIA_UNIT" && DISABLE_AUTH_ENABLED=1
  fi
  if [ -f "$CADDY_FILE" ]; then
    DISABLE_CADDY_CHANGED=1
    python3 -I "$SCRIPT_DIR/lifecycle.py" remove "$CADDY_FILE" "$GATEWAY_UNIT" "$GATEWAY_PORT"
    if ! cmp -s "$CADDY_FILE" "$DISABLE_BACKUP/Caddyfile"; then
      DISABLE_CADDY_CHANGED=1
      caddy validate --config "$CADDY_FILE" >/dev/null
      systemctl_do reload caddy || systemctl_do restart caddy
    else
      DISABLE_CADDY_CHANGED=0
    fi
  fi
  DISABLE_ENV_CHANGED=1
  python3 -I "$SCRIPT_DIR/edge_env.py" "$CODEX_HOME" "$ENV_FILE" set ""
  remaining_auth_refs="$(python3 -I "$SCRIPT_DIR/lifecycle.py" auth-in-use "$CADDY_FILE" "$AUTHELIA_ADDR")"
  # Only dedicated instance authentication units can be stopped automatically.
  # Shared/default Authelia may also serve Nginx or other proxies not in this file.
  if [ "$AUTHELIA_UNIT" = "codex-harness-auth-$GATEWAY_UNIT" ] && [ -z "$remaining_auth_refs" ] \
     && grep -q '^Description=Authelia authentication for codex-harness$' "/etc/systemd/system/${AUTHELIA_UNIT}.service" 2>/dev/null; then
    DISABLE_AUTH_CHANGED=1
    systemctl_do disable --now "$AUTHELIA_UNIT"
  fi
  if [ "${EDGE_GATEWAY_STOPPED:-0}" != 1 ] && [ -f "/etc/systemd/system/${GATEWAY_UNIT}.service" ]; then systemctl_do restart "$GATEWAY_UNIT"; fi
  if [ "$DISABLE_TLS_PRESENT" = 1 ]; then
    DISABLE_TLS_CHANGED=1
    python3 -I "$SCRIPT_DIR/edge_tls.py" remove "$GATEWAY_UNIT" "$CADDY_USER"
  fi
  # The state file selects custom Caddy/Authelia resources on the next run.
  # Remove it only after every public/runtime change succeeds, and restore it
  # from the private snapshot if this transaction later fails.
  if [ -f "$EDGE_STATE" ]; then
    DISABLE_EDGE_STATE_CHANGED=1
    rm -f -- "$EDGE_STATE"
  fi
  log "本实例远程站点已移除；共享认证服务及其它实例保持原状态"
  exit 0
fi

random_hex() {
  local bytes="${1:-32}"
  head -c "$bytes" /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# find_cert <dir> <domain> cert|key — locate a cert/key pair under common names.
find_cert() {
  local dir="$1" domain="$2" kind="$3"
  local pairs=(
    "cert.pem:key.pem" "fullchain.pem:privkey.pem" "tls.crt:tls.key"
    "${domain}.crt:${domain}.key" "${domain}-fullchain.pem:${domain}-privkey.pem"
  )
  for pair in "${pairs[@]}"; do
    local c="${pair%%:*}" k="${pair##*:}"
    if [ -f "$dir/$c" ] && [ -f "$dir/$k" ]; then
      if [ "$kind" = "cert" ]; then echo "$dir/$c"; else echo "$dir/$k"; fi
      return 0
    fi
  done
  return 1
}

migrate_legacy_auth_state() {
  local migrate_database=0 migrate_notification=0
  if [ -f "$AUTHELIA_DIR/db.sqlite3" ] \
     && grep -qF "path: ${AUTHELIA_DIR}/db.sqlite3" "$AUTHELIA_DIR/configuration.yml"; then
    migrate_database=1
  fi
  if [ -f "$AUTHELIA_DIR/notification.txt" ] \
     && grep -qF "filename: ${AUTHELIA_DIR}/notification.txt" "$AUTHELIA_DIR/configuration.yml"; then
    migrate_notification=1
  fi
  if [ "$migrate_database" = 0 ] && [ "$migrate_notification" = 0 ]; then
    return 0
  fi

  # Stop an active legacy unit once before either state file moves. In
  # particular, notification-only migrations must not race a live writer.
  if [ "$RB_AUTH_WAS_ACTIVE" = "1" ]; then
    AUTH_RUNTIME_TOUCHED=1
    systemctl_do stop "$AUTHELIA_UNIT" || rollback
  fi
  if [ "$migrate_database" = 1 ]; then
    if ! python3 -I "$SCRIPT_DIR/edge_state.py" database "$AUTHELIA_DIR/db.sqlite3" "$AUTHELIA_STATE_DIR/db.sqlite3"; then
      log "Authelia 数据库迁移失败"
      rollback
    fi
  fi
  if [ "$migrate_notification" = 1 ]; then
    if ! python3 -I "$SCRIPT_DIR/edge_state.py" notification "$AUTHELIA_DIR/notification.txt" "$AUTHELIA_STATE_DIR/notification.txt"; then
      log "Authelia 通知状态迁移失败"
      rollback
    fi
  fi
  sed -i "s|path: ${AUTHELIA_DIR}/db.sqlite3|path: ${AUTHELIA_STATE_DIR}/db.sqlite3|; s|filename: ${AUTHELIA_DIR}/notification.txt|filename: ${AUTHELIA_STATE_DIR}/notification.txt|" "$AUTHELIA_DIR/configuration.yml"
  if ! "$AUTHELIA_BIN" validate-config --config "$AUTHELIA_DIR/configuration.yml" >/dev/null 2>&1; then
    log "迁移后的 Authelia 配置校验失败"
    rollback
  fi
}

# --- 1. choose mode ----------------------------------------------------------
if [ -z "$EDGE" ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    echo
    echo "远程访问方式："
    echo "  1) 仅本机 / SSH 隧道 —— 不对外开端口，不需要身份认证"
    echo "     用法: ssh -L ${GATEWAY_PORT}:127.0.0.1:${GATEWAY_PORT} <服务器>"
    echo "  2) Caddy + Authelia —— HTTPS 对外 + 登录鉴权"
    local_choice=""
    read -r -p "请选择 [1/2]（默认 1）: " local_choice || true
    case "$local_choice" in
      2) EDGE=caddy-authelia ;;
      *) EDGE=none ;;
    esac
  else
    log "非交互环境且未指定 EDGE —— 默认仅本机/SSH 隧道（重跑 setup-edge.sh 可再配置）"
    EDGE=none
  fi
fi

if [ "$EDGE" = "none" ]; then
  # Selecting local-only on an already configured host means actually
  # deactivating this project's edge, not merely printing SSH instructions.
  EDGE_HOSTS="$(python3 -I "$SCRIPT_DIR/lifecycle.py" hosts "$CADDY_FILE" "$GATEWAY_UNIT" "$GATEWAY_PORT")" \
    || die "无法检查现有 Caddy 站点；拒绝假定本实例已处于仅本机模式"
  # A plain `test -e`/grep pair cannot distinguish a missing file from an
  # inaccessible ancestor. Inspect a bounded regular-file descriptor so every
  # permission, type, encoding or contradictory-value error fails closed.
  EDGE_ENV_STATE="$(python3 -I - "$ENV_FILE" <<'PY'
import os, pwd, stat, sys
path = sys.argv[1]
try:
    before = os.lstat(path)
except FileNotFoundError:
    # Confirm absence on both the pathname and an attempted no-follow open.
    # A dangling link, inaccessible ancestor or concurrently appearing leaf is
    # corruption, not an absent optional environment file.
    try:
        appeared = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except FileNotFoundError:
        try:
            os.lstat(path)
        except FileNotFoundError:
            print("missing")
            raise SystemExit
        raise RuntimeError("gateway environment appeared during inspection")
    else:
        os.close(appeared)
        raise RuntimeError("gateway environment appeared during inspection")

run_user = os.environ.get("RUN_USER", "")
if run_user:
    account = pwd.getpwnam(run_user)
    expected_uid, expected_gid = account.pw_uid, account.pw_gid
else:
    expected_uid, expected_gid = os.geteuid(), os.getegid()

def validate(info):
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("gateway environment must be a singly linked regular file")
    if stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError("gateway environment must have mode 0600")
    if (info.st_uid, info.st_gid) != (expected_uid, expected_gid):
        raise ValueError("gateway environment must belong to the configured gateway identity")
    if info.st_size > 1024 * 1024:
        raise ValueError("gateway environment exceeds inspection limit")

def identity(info):
    return info.st_dev, info.st_ino

def stable_metadata(info):
    return (info.st_mode, info.st_uid, info.st_gid, info.st_nlink, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)

validate(before)
flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
descriptor = os.open(path, flags)
try:
    opened = os.fstat(descriptor)
    current = os.lstat(path)
    validate(opened)
    validate(current)
    if not identity(before) == identity(opened) == identity(current):
        raise RuntimeError("gateway environment changed while opening")
    if not stable_metadata(before) == stable_metadata(opened) == stable_metadata(current):
        raise RuntimeError("gateway environment metadata changed while opening")

    chunks = []
    remaining = 1024 * 1024 + 1
    while remaining:
        chunk = os.read(descriptor, min(64 * 1024, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    raw = b"".join(chunks)

    opened_after = os.fstat(descriptor)
    current_after = os.lstat(path)
    validate(opened_after)
    validate(current_after)
    if not identity(before) == identity(opened_after) == identity(current_after):
        raise RuntimeError("gateway environment was replaced while reading")
    if not stable_metadata(before) == stable_metadata(opened_after) == stable_metadata(current_after):
        raise RuntimeError("gateway environment changed while reading")
finally:
    os.close(descriptor)
if len(raw) > 1024 * 1024:
    raise ValueError("gateway environment exceeds inspection limit")
if len(raw) != before.st_size:
    raise RuntimeError("gateway environment read was incomplete")
values = [line.removeprefix("GATEWAY_HTTPS=") for line in raw.decode("utf-8").splitlines()
          if line.startswith("GATEWAY_HTTPS=")]
if not values or values == ["false"]:
    print("disabled")
elif values == ["true"]:
    print("enabled")
else:
    raise ValueError("gateway environment has an invalid or duplicate GATEWAY_HTTPS value")
PY
  )" || die "无法检查现有网关 edge 环境；拒绝假定本实例已处于仅本机模式"
  EDGE_HTTPS_ENABLED=0
  case "$EDGE_ENV_STATE" in
    enabled) EDGE_HTTPS_ENABLED=1 ;;
    disabled|missing) ;;
    *) die "网关 edge 环境检查返回未知状态；拒绝假定本实例已处于仅本机模式" ;;
  esac
  if [ -n "$EDGE_HOSTS" ] || [ "$EDGE_HTTPS_ENABLED" = 1 ] \
     || [ -e "$EDGE_STATE" ] || [ -L "$EDGE_STATE" ]; then
    [ "$(id -u)" -eq 0 ] || die "已有远程站点；请用 sudo 重新运行以切回仅本机模式"
    EDGE_ACTION=disable bash "$0"
    exit $?
  fi
  cat <<EOF

已选择仅本机 / SSH 隧道模式（网关只监听 127.0.0.1:${GATEWAY_PORT}，无暴露面）。
  ▸ 立即使用: ssh -L ${GATEWAY_PORT}:127.0.0.1:${GATEWAY_PORT} <服务器> 后浏览器打开 http://127.0.0.1:${GATEWAY_PORT}
  ▸ 以后想开 HTTPS + 登录: bash ${SCRIPT_DIR}/setup-edge.sh
EOF
  exit 0
fi

[ "$EDGE" = "caddy-authelia" ] || die "EDGE 必须是 none 或 caddy-authelia"
need_root
lock_edge
load_saved_edge_state
validate_edge_values
check_edge_paths

# --- 2. gather parameters (interactive prompts with env/unattended overrides) --
if [ -z "$DOMAIN" ] && [ -t 0 ]; then read -r -p "对外访问域名（如 codex.example.com）: " DOMAIN; fi
[ -n "$DOMAIN" ] || die "缺少域名：设置 EDGE_DOMAIN 或交互输入"
# Hostnames land in the Caddyfile and Authelia URLs. Validate every label,
# total length, and edge hyphens rather than relying on a broad character set.
DOMAIN="$DOMAIN" python3 -I -c 'import os,re; d=os.environ["DOMAIN"]; ok=len(d)<=253 and all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", x) for x in d.split(".")); raise SystemExit(0 if ok else 1)' \
  || die "域名不是有效的 ASCII DNS 主机名: $DOMAIN"
DOMAIN="${DOMAIN,,}"

if [ -z "$LISTEN_PORT_EXPLICIT" ] && [ -t 0 ]; then
  read -r -p "对外 HTTPS 端口 [443]: " lp || true
  [ -n "$lp" ] && LISTEN_PORT="$lp" && LISTEN_PORT_EXPLICIT=1
fi
case "$LISTEN_PORT" in
  ''|*[!0-9]*) die "端口必须是数字: $LISTEN_PORT" ;;
esac
[ "$LISTEN_PORT" -ge 1 ] && [ "$LISTEN_PORT" -le 65535 ] || die "端口必须在 1..65535: $LISTEN_PORT"

if [ -z "$TLS_MODE" ] && [ -t 0 ]; then
  echo "证书方式："
  echo "  1) Caddy 自动 ACME 证书（域名可公网解析时推荐）"
  echo "  2) 自签名证书（仅内网测试，浏览器需手动信任）"
  echo "  3) 使用自己的证书（提供证书目录）"
  read -r -p "请选择 [1/2/3]（默认 1）: " tls_choice || true
  case "$tls_choice" in
    2) TLS_MODE=selfsigned ;;
    3) TLS_MODE=own ;;
    *) TLS_MODE=auto ;;
  esac
fi
[ -n "$TLS_MODE" ] || TLS_MODE=auto
[ "$TLS_MODE" = "auto" ] || [ "$TLS_MODE" = "selfsigned" ] || [ "$TLS_MODE" = "own" ] || die "EDGE_TLS 必须是 auto、selfsigned 或 own"

CERT_LINE=""
CERT_SOURCE=""
KEY_SOURCE=""
if [ "$TLS_MODE" = "own" ]; then
  if [ -z "$CERT_DIR" ] && [ -t 0 ]; then read -r -p "证书目录（含证书+私钥）: " CERT_DIR; fi
  [ -n "$CERT_DIR" ] || die "自有证书需要 EDGE_CERT_DIR（目录内放 cert.pem+key.pem 或 fullchain.pem+privkey.pem 或 <域名>.crt+<域名>.key）"
  validate_path EDGE_CERT_DIR "$CERT_DIR"
  [ -d "$CERT_DIR" ] || die "目录不存在: $CERT_DIR"
  CERT_SOURCE="$(find_cert "$CERT_DIR" "$DOMAIN" cert || true)"
  KEY_SOURCE="$(find_cert "$CERT_DIR" "$DOMAIN" key || true)"
  if [ -z "$CERT_SOURCE" ] || [ -z "$KEY_SOURCE" ]; then
    die "在 $CERT_DIR 未找到证书对（cert.pem/key.pem、fullchain.pem/privkey.pem 或 ${DOMAIN}.crt/${DOMAIN}.key）"
  fi
  log "已定位自有证书；验证后将复制到 root 管理的实例目录"
elif [ "$TLS_MODE" = "selfsigned" ]; then
  CERT_LINE="tls internal"
  log "使用 Caddy 内置 CA 自签（浏览器首次访问会有告警，可信任其根证书消除）"
else
  log "使用 Caddy 自动 ACME 证书"
fi

if [ -z "${AUTH_USER_EXPLICIT}" ] && [ -t 0 ]; then
  read -r -p "Authelia 登录用户名 [admin]: " au || true
  [ -n "$au" ] && AUTH_USER="$au" && AUTH_USER_EXPLICIT=1
fi
# Usernames land in users_database.yml — keep them plain.
case "$AUTH_USER" in
  *[!A-Za-z0-9._-]*|"") die "用户名只能包含字母/数字/点/下划线/连字符: $AUTH_USER" ;;
esac

# 摘要确认（TTY 时）
if [ -t 0 ]; then
  echo
  echo "── 远程访问配置摘要 ──"
  echo "  域名:   ${DOMAIN}"
  echo "  端口:   ${LISTEN_PORT} (HTTPS)"
  echo "  证书:   ${TLS_MODE}$([ "$TLS_MODE" = own ] && echo " ($CERT_DIR)")"
  echo "  网关:   127.0.0.1:${GATEWAY_PORT}"
  echo "  用户:   ${AUTH_USER}（如为新部署将提示设置密码）"
  read -r -p "确认应用以上配置? [Y/n]: " go || true
  case "$go" in
    n*|N*) die "已取消" ;;
  esac
fi

# --- 3. Caddy ----------------------------------------------------------------
# Snapshot files we may modify, so validate failures can roll back cleanly.
# Also track which files are NEW (didn't exist before) so rollback deletes
# them rather than trying to restore a non-existent "original".
RB_DIR="$(mktemp -d /tmp/codex-harness-edge-rollback.XXXXXX)"
TMPD="" # Never clean up an inherited caller-supplied directory.
trap 'rm -rf -- "$RB_DIR"' EXIT
RB_NEW_CADDY=0; RB_NEW_AUTH_CONF=0; RB_NEW_AUTH_USERS=0; RB_NEW_AUTH_UNIT=0; RB_NEW_AUTH_DROPIN=0
RB_NEW_AUTH_INITIAL=0; RB_NEW_EDGE_STATE=0; AUTH_UNIT_CREATED=0
AUTH_RUNTIME_TOUCHED=0; GATEWAY_RUNTIME_TOUCHED=0; RB_AUTH_WAS_ACTIVE=0; RB_AUTH_WAS_ENABLED=0
RB_TLS_EXISTED=0; RB_TLS_PRESENT=0; TLS_STATE_TOUCHED=0
AUTH_DROPIN="/etc/systemd/system/${AUTHELIA_UNIT}.service.d/codex-harness-hardening.conf"
AUTH_INITIAL="${AUTHELIA_DIR}/initial-password"
if [ -f "$CADDY_FILE" ]; then cp --preserve=mode,ownership,timestamps "$CADDY_FILE" "$RB_DIR/Caddyfile"; else RB_NEW_CADDY=1; fi
if [ -f "$AUTHELIA_DIR/configuration.yml" ]; then cp --preserve=mode,ownership,timestamps "$AUTHELIA_DIR/configuration.yml" "$RB_DIR/configuration.yml"; else RB_NEW_AUTH_CONF=1; fi
if [ -f "$AUTHELIA_DIR/users_database.yml" ]; then cp --preserve=mode,ownership,timestamps "$AUTHELIA_DIR/users_database.yml" "$RB_DIR/users_database.yml"; else RB_NEW_AUTH_USERS=1; fi
if [ -f "/etc/systemd/system/${AUTHELIA_UNIT}.service" ]; then cp --preserve=mode,ownership,timestamps "/etc/systemd/system/${AUTHELIA_UNIT}.service" "$RB_DIR/authelia.service"; else RB_NEW_AUTH_UNIT=1; fi
if [ -f "$AUTH_DROPIN" ]; then cp --preserve=mode,ownership,timestamps "$AUTH_DROPIN" "$RB_DIR/authelia-hardening.conf"; else RB_NEW_AUTH_DROPIN=1; fi
if [ -f "$AUTH_INITIAL" ]; then cp --preserve=mode,ownership,timestamps "$AUTH_INITIAL" "$RB_DIR/initial-password"; else RB_NEW_AUTH_INITIAL=1; fi
python3 -I "$SCRIPT_DIR/edge_env.py" "$CODEX_HOME" "$ENV_FILE" snapshot "$RB_DIR/edge-env.json"
if [ -f "$EDGE_STATE" ]; then cp --preserve=mode,ownership,timestamps "$EDGE_STATE" "$RB_DIR/edge-state.json"; else RB_NEW_EDGE_STATE=1; fi
if [ -e "$MANAGED_TLS_DIR" ] || [ -L "$MANAGED_TLS_DIR" ]; then
  RB_TLS_PRESENT=1
  if python3 -I "$SCRIPT_DIR/edge_tls.py" snapshot "$GATEWAY_UNIT" "$RB_DIR/tls" "$CADDY_USER"; then
    RB_TLS_EXISTED=1
  else
    tls_snapshot_status=$?
    [ "$tls_snapshot_status" = 3 ] \
      || die "现有实例 TLS 目录不可信；拒绝覆盖"
    log "检测到可信但不完整的实例 TLS 残留；本次事务将修复或清理"
  fi
fi
if [ "$SERVICE_MGR" = "systemd" ] && systemctl is-active --quiet "$AUTHELIA_UNIT" 2>/dev/null; then
  RB_AUTH_WAS_ACTIVE=1
fi
if [ "$SERVICE_MGR" = "systemd" ] && systemctl is-enabled --quiet "$AUTHELIA_UNIT" 2>/dev/null; then RB_AUTH_WAS_ENABLED=1; fi

rollback() {
  local status="${1:-1}"
  local rollback_failed=0
  [ "$status" -ne 0 ] || status=1
  trap - EXIT
  set +e
  log "配置失败——回滚所有已修改的文件与服务状态"
  if [ "$RB_NEW_CADDY" = "1" ]; then
    rm -f "$CADDY_FILE" || rollback_failed=1
  else
    cp --remove-destination --preserve=mode,ownership,timestamps "$RB_DIR/Caddyfile" "$CADDY_FILE" || rollback_failed=1
  fi
  if [ "$RB_NEW_AUTH_CONF" = "1" ]; then
    rm -f "$AUTHELIA_DIR/configuration.yml" || rollback_failed=1
  else
    cp --remove-destination --preserve=mode,ownership,timestamps "$RB_DIR/configuration.yml" "$AUTHELIA_DIR/configuration.yml" || rollback_failed=1
  fi
  if [ "$RB_NEW_AUTH_USERS" = "1" ]; then
    rm -f "$AUTHELIA_DIR/users_database.yml" || rollback_failed=1
  else
    cp --remove-destination --preserve=mode,ownership,timestamps "$RB_DIR/users_database.yml" "$AUTHELIA_DIR/users_database.yml" || rollback_failed=1
  fi
  if [ "$AUTH_UNIT_CREATED" = "1" ] && [ "$RB_NEW_AUTH_UNIT" = "1" ]; then
    if [ "$AUTH_RUNTIME_TOUCHED" = "1" ]; then systemctl_do disable --now "$AUTHELIA_UNIT" || rollback_failed=1; fi
    rm -f "/etc/systemd/system/${AUTHELIA_UNIT}.service" || rollback_failed=1
  elif [ -f "$RB_DIR/authelia.service" ]; then
    cp --remove-destination --preserve=mode,ownership,timestamps "$RB_DIR/authelia.service" "/etc/systemd/system/${AUTHELIA_UNIT}.service" || rollback_failed=1
  fi
  if [ "$RB_NEW_AUTH_DROPIN" = "1" ]; then
    rm -f "$AUTH_DROPIN" || rollback_failed=1
    rmdir "${AUTH_DROPIN%/*}" 2>/dev/null || true
  elif [ -f "$RB_DIR/authelia-hardening.conf" ]; then
    install -d -m 755 "${AUTH_DROPIN%/*}" || rollback_failed=1
    cp --remove-destination --preserve=mode,ownership,timestamps "$RB_DIR/authelia-hardening.conf" "$AUTH_DROPIN" || rollback_failed=1
  fi
  if [ "$RB_NEW_AUTH_INITIAL" = "1" ]; then
    rm -f "$AUTH_INITIAL" || rollback_failed=1
  else
    cp --remove-destination --preserve=mode,ownership,timestamps "$RB_DIR/initial-password" "$AUTH_INITIAL" || rollback_failed=1
  fi
  python3 -I "$SCRIPT_DIR/edge_env.py" "$CODEX_HOME" "$ENV_FILE" restore "$RB_DIR/edge-env.json" || rollback_failed=1
  if [ "$RB_NEW_EDGE_STATE" = "1" ]; then rm -f "$EDGE_STATE" || rollback_failed=1; else cp --remove-destination --preserve=mode,ownership,timestamps "$RB_DIR/edge-state.json" "$EDGE_STATE" || rollback_failed=1; fi
  if [ "${TLS_STATE_TOUCHED:-0}" = "1" ]; then
    if [ "${RB_TLS_EXISTED:-0}" = "1" ]; then
      python3 -I "$SCRIPT_DIR/edge_tls.py" restore "$GATEWAY_UNIT" "$RB_DIR/tls" "$CADDY_USER" || rollback_failed=1
    else
      python3 -I "$SCRIPT_DIR/edge_tls.py" remove "$GATEWAY_UNIT" "$CADDY_USER" || rollback_failed=1
    fi
  fi
  systemctl_do daemon-reload || rollback_failed=1
  if [ "$AUTH_RUNTIME_TOUCHED" = "1" ] && [ "$AUTH_UNIT_CREATED" != "1" ]; then
    if [ "$RB_AUTH_WAS_ENABLED" = "1" ]; then systemctl_do enable "$AUTHELIA_UNIT" || rollback_failed=1; else systemctl_do disable "$AUTHELIA_UNIT" || rollback_failed=1; fi
    if [ "$RB_AUTH_WAS_ACTIVE" = "1" ]; then
      systemctl_do reset-failed "$AUTHELIA_UNIT" || rollback_failed=1
      systemctl_do restart "$AUTHELIA_UNIT" || rollback_failed=1
      wait_authelia || rollback_failed=1
    else
      systemctl_do stop "$AUTHELIA_UNIT" || rollback_failed=1
    fi
  fi
  systemctl_do reload caddy || rollback_failed=1
  if [ "$GATEWAY_RUNTIME_TOUCHED" = "1" ]; then
    systemctl_do restart "$GATEWAY_UNIT" || rollback_failed=1
  fi
  if [ "$rollback_failed" = 1 ]; then
    log "自动恢复未完成；私有恢复副本保留在 $RB_DIR，请人工恢复后再清理"
  else
    rm -rf -- "$RB_DIR"
  fi
  [ -z "${TMPD:-}" ] || rm -rf -- "$TMPD"
  exit "$status"
}
cleanup_edge_transaction() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    rollback "$status"
  fi
  trap - EXIT
  rm -rf "$RB_DIR" "${TMPD:-}"
}
trap cleanup_edge_transaction EXIT

install_caddy() {
  log "安装 Caddy（官方 apt 源）..."
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
  local caddy_key caddy_keyring caddy_repo
  caddy_key="$(mktemp)"
  caddy_keyring="$(mktemp)"
  caddy_repo="$(mktemp)"
  if ! download_https 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' "$caddy_key" 1048576; then
    rm -f "$caddy_key" "$caddy_keyring" "$caddy_repo"
    die "下载 Caddy 仓库签名密钥失败"
  fi
  if ! download_https 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' "$caddy_repo" 262144; then
    rm -f "$caddy_key" "$caddy_keyring" "$caddy_repo"
    die "下载 Caddy 仓库配置失败"
  fi
  if ! gpg --dearmor --yes -o "$caddy_keyring" "$caddy_key"; then
    rm -f "$caddy_key" "$caddy_keyring" "$caddy_repo"
    die "解析 Caddy 仓库签名密钥失败"
  fi
  rm -f "$caddy_key"
  install -o root -g root -m 0644 "$caddy_keyring" /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  install -o root -g root -m 0644 "$caddy_repo" /etc/apt/sources.list.d/caddy-stable.list
  rm -f "$caddy_keyring" "$caddy_repo"
  # apt may drop privileges to _apt while reading repository metadata.
  chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y caddy
}

command -v caddy >/dev/null 2>&1 || install_caddy
log "caddy: $(caddy version)"

if [ "$TLS_MODE" = "own" ]; then
  TLS_STATE_TOUCHED=1
  if ! python3 -I "$SCRIPT_DIR/edge_tls.py" install "$GATEWAY_UNIT" "$CERT_SOURCE" "$KEY_SOURCE" "$CADDY_USER" >/dev/null; then
    log "自有证书未通过有界常规文件、链接数、权限或稳定性检查"
    rollback
  fi
  CERT_LINE="tls ${MANAGED_TLS_DIR}/cert.pem ${MANAGED_TLS_DIR}/key.pem"
  log "自有证书已复制到实例专属的 root 管理目录"
fi

# --- 4. Authelia -------------------------------------------------------------
AUTHELIA_BIN="$(command -v authelia || true)"
FRESH_AUTHELIA=0
if [ ! -f "$AUTHELIA_DIR/configuration.yml" ]; then
  FRESH_AUTHELIA=1
  if [ -z "$AUTHELIA_BIN" ]; then
    ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m | sed 's/aarch64/arm64/;s/x86_64/amd64/')"
    log "安装 Authelia ${AUTHELIA_VERSION} (${ARCH})..."
    TMPD="$(mktemp -d)"
    ARCHIVE="authelia-v${AUTHELIA_VERSION}-linux-${ARCH}.tar.gz"
    RELEASE_URL="https://github.com/authelia/authelia/releases/download/v${AUTHELIA_VERSION}"
    download_https "$RELEASE_URL/$ARCHIVE" "$TMPD/$ARCHIVE" 268435456 \
      || die "下载 Authelia 归档失败"
    download_https "$RELEASE_URL/$ARCHIVE.sha256" "$TMPD/$ARCHIVE.sha256" 65536 \
      || die "下载 Authelia 校验和失败"
    EXPECTED_SHA="$(awk 'NR==1 { print $1 }' "$TMPD/$ARCHIVE.sha256")"
    case "$EXPECTED_SHA" in ''|*[!0-9a-fA-F]* ) die "Authelia 校验和文件格式无效" ;; esac
    [ "${#EXPECTED_SHA}" -eq 64 ] || die "Authelia 校验和长度无效"
    printf '%s  %s\n' "$EXPECTED_SHA" "$TMPD/$ARCHIVE" | sha256sum -c - >/dev/null \
      || die "Authelia 下载校验和不匹配"
    tar -xzf "$TMPD/$ARCHIVE" -C "$TMPD" --no-same-owner --no-same-permissions -- "authelia-linux-${ARCH}"
    install -m 755 "$TMPD/authelia-linux-${ARCH}" /usr/local/bin/authelia
    rm -rf "$TMPD"
    TMPD=""
    AUTHELIA_BIN=/usr/local/bin/authelia
  fi
fi
log "authelia: ${AUTHELIA_BIN:-复用已有部署（$AUTHELIA_DIR）}"

if [ "$FRESH_AUTHELIA" = "1" ]; then
  mkdir -p "$AUTHELIA_DIR"
  # first user
  if [ -z "$AUTH_PASS" ] && [ -t 0 ]; then
    while true; do
      read -r -s -p "Authelia 用户 [$AUTH_USER] 的密码: " AUTH_PASS; echo
      read -r -s -p "确认密码: " pass2; echo
      [ "$AUTH_PASS" = "$pass2" ] && [ -n "$AUTH_PASS" ] && break
      echo "两次输入不一致或为空，请重试"
    done
  fi
  if [ -z "$AUTH_PASS" ]; then
    AUTH_PASS="$(random_hex 16)"
    GENERATED_PASS=1
  fi
  # Wait for the CLI to disable terminal echo before sending the password:
  # pre-fed `printf | script` input can be discarded by terminal setup.
  HASH="$(printf '%s\n' "$AUTH_PASS" | python3 -I "$SCRIPT_DIR/authelia_hash.py" "$AUTHELIA_BIN")"
  [ -n "$HASH" ] || die "生成 argon2 哈希失败"
  if [ "${GENERATED_PASS:-0}" = "1" ]; then
    printf '%s\n' "$AUTH_PASS" > "$AUTHELIA_DIR/initial-password"
    chmod 600 "$AUTHELIA_DIR/initial-password"
  fi

  cat > "$AUTHELIA_DIR/users_database.yml" <<EOF
users:
  ${AUTH_USER}:
    displayname: '${AUTH_USER}'
    password: '${HASH}'
    email: ${AUTH_USER}@example.com
    groups:
      - admins
EOF
  chmod 600 "$AUTHELIA_DIR/users_database.yml"

  SESSION_SECRET="$(random_hex)"
  JWT_SECRET="$(random_hex)"
  STORAGE_KEY="$(random_hex)"
  # Scope the session cookie to the exact app host. Parent-domain cookies
  # unnecessarily expose it to sibling applications.
  COOKIE_DOMAIN="$DOMAIN"
  cat > "$AUTHELIA_DIR/configuration.yml" <<EOF
# Authelia mounted under the /authelia path (server.address suffix) so a
# single domain serves both the app and the login portal.
server:
  address: tcp://${AUTHELIA_ADDR}/authelia
  endpoints:
    authz:
      forward-auth:
        implementation: ForwardAuth

authentication_backend:
  file:
    path: ${AUTHELIA_DIR}/users_database.yml

session:
  secret: ${SESSION_SECRET}
  cookies:
    - domain: ${COOKIE_DOMAIN}
      authelia_url: https://${DOMAIN}:${LISTEN_PORT}/authelia/

storage:
  encryption_key: ${STORAGE_KEY}
  local:
    path: ${AUTHELIA_DIR}/db.sqlite3

access_control:
  default_policy: one_factor

identity_validation:
  reset_password:
    jwt_secret: ${JWT_SECRET}

notifier:
  filesystem:
    filename: ${AUTHELIA_DIR}/notification.txt
EOF
  chmod 600 "$AUTHELIA_DIR/configuration.yml"
  "$AUTHELIA_BIN" validate-config --config "$AUTHELIA_DIR/configuration.yml" >/dev/null 2>&1 \
    || { log "Authelia 配置校验失败"; rollback; }

  if [ "$SERVICE_MGR" = "systemd" ]; then
    id authelia >/dev/null 2>&1 || useradd --system --home-dir /var/lib/authelia --create-home --shell /usr/sbin/nologin authelia
    python3 -I "$SCRIPT_DIR/service_directory.py" authelia "$AUTHELIA_STATE_DIR" --private
    sed -i "s|path: ${AUTHELIA_DIR}/db.sqlite3|path: ${AUTHELIA_STATE_DIR}/db.sqlite3|; s|filename: ${AUTHELIA_DIR}/notification.txt|filename: ${AUTHELIA_STATE_DIR}/notification.txt|" "$AUTHELIA_DIR/configuration.yml"
    "$AUTHELIA_BIN" validate-config --config "$AUTHELIA_DIR/configuration.yml" >/dev/null 2>&1 \
      || { log "Authelia 状态目录迁移后的配置校验失败"; rollback; }
    chown root:authelia "$AUTHELIA_DIR" "$AUTHELIA_DIR/configuration.yml" "$AUTHELIA_DIR/users_database.yml"
    chmod 750 "$AUTHELIA_DIR"
    chmod 640 "$AUTHELIA_DIR/configuration.yml" "$AUTHELIA_DIR/users_database.yml"
    # A unit can exist under /usr/lib or /lib even with no /etc override.
    # Never create our unit on top of an unrelated systemd service.
    AUTH_FRAGMENT="$(systemctl show -p FragmentPath --value "$AUTHELIA_UNIT" 2>/dev/null)" \
      || die "无法确定现有 Authelia unit 的来源，未创建新 unit"
    if [ -e "/etc/systemd/system/${AUTHELIA_UNIT}.service" ] || [ -n "$AUTH_FRAGMENT" ]; then
      die "已有 Authelia unit，但未找到对应配置；请指定独立 AUTHELIA_UNIT 或现有 AUTHELIA_DIR"
    fi
    AUTH_UNIT_CREATED=1
    cat > "/etc/systemd/system/${AUTHELIA_UNIT}.service" <<EOF
[Unit]
Description=Authelia authentication for codex-harness
After=network-online.target

[Service]
Type=simple
User=authelia
Group=authelia
ExecStart=${AUTHELIA_BIN} --config ${AUTHELIA_DIR}/configuration.yml
Restart=always
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${AUTHELIA_STATE_DIR}
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
    chmod 0644 "/etc/systemd/system/${AUTHELIA_UNIT}.service"
    systemctl_do daemon-reload
    # Validate the complete candidate before starting it once below.
  fi
else
  log "检测到已有 Authelia —— 复用现有用户库与配置"
  log "  · 加用户: authelia crypto hash generate argon2 后写入 users_database.yml"
  log "  · 若现有 Authelia 用白名单策略（default_policy: deny），请把 ${DOMAIN} 加入其 access_control 规则"
fi

# Upgrade hardening for units created by earlier codex-harness releases. A
# drop-in avoids rewriting unrelated vendor units and is applied only when
# the base unit carries our exact description marker.
if [ "$SERVICE_MGR" = "systemd" ] \
   && grep -q '^Description=Authelia authentication for codex-harness$' "/etc/systemd/system/${AUTHELIA_UNIT}.service" 2>/dev/null; then
  id authelia >/dev/null 2>&1 || useradd --system --home-dir /var/lib/authelia --create-home --shell /usr/sbin/nologin authelia
  python3 -I "$SCRIPT_DIR/service_directory.py" authelia "$AUTHELIA_STATE_DIR" --private
  chown root:authelia "$AUTHELIA_DIR" "$AUTHELIA_DIR/configuration.yml" "$AUTHELIA_DIR/users_database.yml"
  chmod 750 "$AUTHELIA_DIR"
  chmod 640 "$AUTHELIA_DIR/configuration.yml" "$AUTHELIA_DIR/users_database.yml"
  if [ -f "$AUTHELIA_DIR/configuration.yml" ]; then
    # Earlier project units stored mutable state under /etc/authelia. Preserve
    # it before applying ProtectSystem=strict and switching to /var/lib.
    migrate_legacy_auth_state
  fi
  install -d -o root -g root -m 755 "/etc/systemd/system/${AUTHELIA_UNIT}.service.d"
  cat > "/etc/systemd/system/${AUTHELIA_UNIT}.service.d/codex-harness-hardening.conf" <<EOF
[Service]
User=authelia
Group=authelia
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${AUTHELIA_STATE_DIR}
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
EOF
  systemctl_do daemon-reload
  # Defer the one restart until cookies and the candidate config are valid.
fi

# --- 5. Caddy site block (idempotent, marker-wrapped) ------------------------
# Same-domain pattern (proven against Authelia 4.38/4.39): authelia is mounted
# under /authelia (server.address path suffix), portal requests keep the
# prefix, everything else goes through forward-auth to the gateway.
site_block() {
  cat <<EOF
# codex-harness:begin ${GATEWAY_UNIT} ${DOMAIN}:${LISTEN_PORT}
https://${DOMAIN}:${LISTEN_PORT} {
    ${CERT_LINE}

    encode zstd gzip

    route /authelia* {
        reverse_proxy ${AUTHELIA_ADDR}
    }

    route {
        forward_auth ${AUTHELIA_ADDR} {
            uri /authelia/api/authz/forward-auth
            copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
        }
        # Scope the app CSP to the app response. Applying it at site level also
        # constrains Authelia's own portal and can break its login JavaScript.
        header {
            X-Content-Type-Options "nosniff"
            X-Frame-Options "DENY"
            Referrer-Policy "no-referrer"
            Permissions-Policy "camera=(), microphone=(), geolocation=()"
            Content-Security-Policy "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' wss://{http.request.host}"
            -Server
        }
        reverse_proxy 127.0.0.1:${GATEWAY_PORT} {
            flush_interval -1
        }
    }
}
# codex-harness:end ${GATEWAY_UNIT} ${DOMAIN}:${LISTEN_PORT}
EOF
}

BLOCK_TMP="$(mktemp)"
site_block > "$BLOCK_TMP"
if ! python3 -I "$SCRIPT_DIR/lifecycle.py" upsert "$CADDY_FILE" "$GATEWAY_UNIT" "$GATEWAY_PORT" "${DOMAIN}:${LISTEN_PORT}" "$BLOCK_TMP"
then
  rm -f "$BLOCK_TMP"
  rollback
fi
rm -f "$BLOCK_TMP"
log "站点块已原子写入 $CADDY_FILE"

# Register every marked domain using this authentication service. A reused
# external config must already cover the domain; it is never rewritten.
COOKIE_OWNER=external
if grep -q '^Description=Authelia authentication for codex-harness$' "/etc/systemd/system/${AUTHELIA_UNIT}.service" 2>/dev/null; then COOKIE_OWNER=owned; fi
AUTH_HOST_TEXT="$(python3 -I "$SCRIPT_DIR/lifecycle.py" auth-hosts "$CADDY_FILE" "$AUTHELIA_ADDR")"
mapfile -t AUTH_HOSTS <<< "$AUTH_HOST_TEXT"
# An unmarked shared portal is an explicit integration choice. Check its
# public health endpoint before letting it satisfy canonical-URL validation.
AUTHELIA_VERIFIED_CANONICAL_URL=""
if [ -n "${AUTHELIA_CANONICAL_URL:-}" ]; then
  python3 -I -c 'import os,sys; sys.path.insert(0,sys.argv[1]); from lifecycle import auth_origin; auth_origin(os.environ["AUTHELIA_CANONICAL_URL"])' "$SCRIPT_DIR"
  curl -fsS --proto '=https' --max-time 10 "${AUTHELIA_CANONICAL_URL}api/health" \
    | python3 -I -c 'import json,sys; assert json.load(sys.stdin).get("status") == "UP"' \
    || die "共享 Authelia 规范入口健康检查失败，请检查 AUTHELIA_CANONICAL_URL"
  AUTHELIA_VERIFIED_CANONICAL_URL="$AUTHELIA_CANONICAL_URL"
fi
export AUTHELIA_VERIFIED_CANONICAL_URL
python3 -I "$SCRIPT_DIR/lifecycle.py" cookies "$AUTHELIA_DIR/configuration.yml" "$COOKIE_OWNER" "${AUTH_HOSTS[@]}"
caddy validate --config "$CADDY_FILE" >/dev/null 2>&1 || { log "Caddyfile 校验失败"; rollback; }
log "Caddyfile 校验通过"
if [ "$COOKIE_OWNER" = owned ]; then
  "$AUTHELIA_BIN" validate-config --config "$AUTHELIA_DIR/configuration.yml" >/dev/null 2>&1 \
    || { log "域名迁移后的 Authelia 配置校验失败"; rollback; }
  AUTH_RUNTIME_TOUCHED=1
  systemctl_do enable "$AUTHELIA_UNIT"
  systemctl_do reset-failed "$AUTHELIA_UNIT"
  systemctl_do restart "$AUTHELIA_UNIT"
  wait_authelia || { log "Authelia 未通过启动健康检查"; rollback; }
else
  [ -n "$AUTHELIA_BIN" ] && [ -x "$AUTHELIA_BIN" ] \
    || { log "外部 Authelia 需要本机可执行文件以校验配置，请先安装匹配版本"; rollback; }
  "$AUTHELIA_BIN" validate-config --config "$AUTHELIA_DIR/configuration.yml" >/dev/null 2>&1 \
    || { log "外部 Authelia 配置校验失败"; rollback; }
  python3 -I "$SCRIPT_DIR/edge_auth.py" "$AUTHELIA_DIR/configuration.yml" \
    || { log "请审阅 access_control：目标域名必须要求认证并允许预期用户；复杂规则需 AUTHELIA_POLICY_REVIEWED=1。该确认不替代浏览器验收"; rollback; }
  wait_authelia external || { log "外部 Authelia 未通过实时健康检查，未发布 Caddy 配置"; rollback; }
fi

# --- 6. validate + reload ------------------------------------------------------
if [ "$FRESH_AUTHELIA" = "1" ]; then
  "$AUTHELIA_BIN" validate-config --config "$AUTHELIA_DIR/configuration.yml" >/dev/null 2>&1 || { log "Authelia 配置校验失败"; rollback; }
  log "Authelia 配置校验通过"
fi
systemctl_do reload caddy || systemctl_do restart caddy
if [ "$TLS_MODE" != "own" ] && [ "$RB_TLS_PRESENT" = "1" ]; then
  # The live Caddy configuration no longer references the old managed pair.
  # Remove it only now; a later failure restores both it and the old Caddyfile.
  TLS_STATE_TOUCHED=1
  python3 -I "$SCRIPT_DIR/edge_tls.py" remove "$GATEWAY_UNIT" "$CADDY_USER" || rollback
fi

# --- 6.5 register the public host with the gateway ----------------------------
# The gateway only sets its auth cookie and accepts WebSockets for trusted
# Host headers (DNS-rebinding defense). The proxied browser traffic arrives
# with Host = domain[:port] (browsers omit the port when it is 443), so the
# edge URL must be registered in the gateway's environment — otherwise the
# page loads but every WebSocket is closed with 4003 ("gateway 未连接").
if [ "$LISTEN_PORT" = "443" ]; then
  PROXY_HOST="$DOMAIN"
else
  PROXY_HOST="${DOMAIN}:${LISTEN_PORT}"
fi
# Rebuild the whole list from the codex-harness site blocks in the Caddyfile
# (supports multiple proxies/domains — one marker per block), so re-running
# with a new domain neither drops the others nor keeps stale ones.
TH_ALL=""
if [ -f "$CADDY_FILE" ]; then
  while IFS= read -r marker; do
    [ -n "$marker" ] || continue
    m_domain="${marker%%:*}"
    m_port="${marker##*:}"
    case "$m_port" in
      ''|*[!0-9]*) m_port="443" ;;
    esac
    if [ "$m_port" = "443" ]; then
      entry="$m_domain"
    else
      entry="${m_domain}:${m_port}"
    fi
    case ",$TH_ALL," in
      *",$entry,"*) ;; # dedupe
      *) TH_ALL="${TH_ALL:+$TH_ALL,}$entry" ;;
    esac
  done < <(python3 -I "$SCRIPT_DIR/lifecycle.py" hosts "$CADDY_FILE" "$GATEWAY_UNIT" "$GATEWAY_PORT" | sort -u)
fi
# The just-written block is in the Caddyfile already, but keep PROXY_HOST as a
# fallback for marker-less setups.
case ",$TH_ALL," in
  *",$PROXY_HOST,"*) ;;
  *) TH_ALL="${TH_ALL:+$TH_ALL,}$PROXY_HOST" ;;
esac
python3 -I "$SCRIPT_DIR/edge_env.py" "$CODEX_HOME" "$ENV_FILE" set "$TH_ALL"
log "已注册对外地址到网关信任列表（TRUSTED_HOSTS=${TH_ALL}）"
# Do not use grep -q here: with pipefail, an early reader exit can turn a
# successful match in a long systemctl listing into an upstream SIGPIPE.
if command -v systemctl >/dev/null 2>&1 \
   && systemctl list-unit-files 2>/dev/null | grep "^${GATEWAY_UNIT}\.service[[:space:]]" >/dev/null; then
  GATEWAY_RUNTIME_TOUCHED=1
  systemctl_do restart "$GATEWAY_UNIT"
  log "网关已重启以加载新环境"
fi

# Save only non-secret resource identity, after the entire configuration succeeds.
install -d -o root -g root -m 755 /etc/codex-harness
CADDY_FILE="$CADDY_FILE" AUTHELIA_DIR="$AUTHELIA_DIR" AUTHELIA_UNIT="$AUTHELIA_UNIT" AUTHELIA_ADDR="$AUTHELIA_ADDR" \
  python3 -I - "$EDGE_STATE" "$SCRIPT_DIR" <<'PY'
import json, os, sys
sys.path.insert(0, sys.argv[2])
from lifecycle import atomic_text
data = {key: os.environ[key] for key in ("CADDY_FILE", "AUTHELIA_DIR", "AUTHELIA_UNIT", "AUTHELIA_ADDR")}
atomic_text(sys.argv[1], json.dumps(data, indent=2) + "\n")
os.chmod(sys.argv[1], 0o600)
PY

# --- 7. summary ----------------------------------------------------------------
cat <<EOF

远程访问配置完成。
  ▸ 地址: https://${DOMAIN}:${LISTEN_PORT}
EOF
if [ "${GENERATED_PASS:-0}" = "1" ]; then
  echo "  ▸ 首个用户: ${AUTH_USER}；初始密码仅保存在 ${AUTHELIA_DIR}/initial-password（root 600），不会打印到终端"
else
  echo "  ▸ 用户: ${AUTH_USER}"
fi
[ "$TLS_MODE" = "selfsigned" ] && echo "  ▸ 自签证书：浏览器首次访问会告警，可信任 Caddy 根证书（journalctl -u caddy 可找到路径）"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "  ▸ 提示: ufw 防火墙处于启用状态，如需外网访问请放行端口: ufw allow ${LISTEN_PORT}/tcp"
fi
echo "  ▸ 验证: EDGE_URL=https://${DOMAIN}:${LISTEN_PORT} bash ${SCRIPT_DIR}/verify-login.sh"
echo "  ▸ 管理员仍须用浏览器验收：未登录被拦截、允许账号可访问、禁止账号被拒绝；配置/健康检查不能证明这些访问策略"
[ "$SERVICE_MGR" != none ] || echo "  ▸ SERVICE_MGR=none：未启动服务，未执行实时健康验收"
