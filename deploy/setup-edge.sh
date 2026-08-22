#!/usr/bin/env bash
# Remote-access edge wizard: local-only (SSH tunnel) or Caddy(TLS) +
# Authelia(login) in front of the gateway.
#
#   bash deploy/setup-edge.sh                 # interactive
#   EDGE=none bash deploy/setup-edge.sh       # local only, no prompts
# Unattended full setup:
#   EDGE=caddy-authelia EDGE_DOMAIN=codex.example.com \
#   EDGE_TLS=selfsigned|own [EDGE_CERT_DIR=...] \
#   [EDGE_USER=admin] [EDGE_PASS=...] bash deploy/setup-edge.sh
#
# Existing Caddy / Authelia are detected and reused: only the site block (and
# a first Authelia user when fresh) is added. Test/dry-run overrides:
#   SERVICE_MGR=none   skip systemctl (validate configs only)
#   CADDY_FILE/AUTHELIA_DIR/AUTHELIA_UNIT/AUTHELIA_ADDR
#   EDGE_LISTEN_PORT/GATEWAY_PORT
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
CADDY_FILE="${CADDY_FILE:-/etc/caddy/Caddyfile}"
AUTHELIA_DIR="${AUTHELIA_DIR:-/etc/authelia}"
AUTHELIA_UNIT="${AUTHELIA_UNIT:-authelia}"
# Loopback address Authelia listens on (fresh installs). Override when 9091
# is already taken by another Authelia.
AUTHELIA_ADDR="${AUTHELIA_ADDR:-127.0.0.1:9091}"
AUTHELIA_VERSION="4.38.19" # pinned; override with AUTHELIA_VERSION=
SERVICE_MGR="${SERVICE_MGR:-systemd}"

log() { echo "[edge] $*"; }
die() { echo "[edge] ERROR: $*" >&2; exit 1; }

systemctl_do() {
  if [ "$SERVICE_MGR" = "none" ]; then log "(dry-run) systemctl $*"; else
    if command -v systemctl >/dev/null 2>&1; then systemctl "$@"; else log "(no systemd) skip: systemctl $*"; fi
  fi
}

need_root() {
  [ "$(id -u)" -eq 0 ] || die "请以 root 运行（或 sudo）"
}

random_hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

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
  cat <<EOF

已选择仅本机 / SSH 隧道模式（网关只监听 127.0.0.1:${GATEWAY_PORT}，无暴露面）。
  ▸ 立即使用: ssh -L ${GATEWAY_PORT}:127.0.0.1:${GATEWAY_PORT} <服务器> 后浏览器打开 http://127.0.0.1:${GATEWAY_PORT}
  ▸ 以后想开 HTTPS + 登录: bash ${SCRIPT_DIR}/setup-edge.sh
EOF
  exit 0
fi

[ "$EDGE" = "caddy-authelia" ] || die "EDGE 必须是 none 或 caddy-authelia"
need_root

# --- 2. gather parameters (interactive prompts with env/unattended overrides) --
if [ -z "$DOMAIN" ] && [ -t 0 ]; then read -r -p "对外访问域名（如 codex.example.com）: " DOMAIN; fi
[ -n "$DOMAIN" ] || die "缺少域名：设置 EDGE_DOMAIN 或交互输入"
# Hostnames land in the Caddyfile and Authelia URLs — reject anything that
# is not a plain hostname (injection guard).
case "$DOMAIN" in
  *[!A-Za-z0-9.-]*|[.*]|*..*|""|"-"*) die "域名只能包含字母/数字/点/连字符: $DOMAIN" ;;
esac

if [ -z "$LISTEN_PORT_EXPLICIT" ] && [ -t 0 ]; then
  read -r -p "对外 HTTPS 端口 [443]: " lp || true
  [ -n "$lp" ] && LISTEN_PORT="$lp" && LISTEN_PORT_EXPLICIT=1
fi
case "$LISTEN_PORT" in
  ''|*[!0-9]*) die "端口必须是数字: $LISTEN_PORT" ;;
esac

if [ -z "$TLS_MODE" ] && [ -t 0 ]; then
  echo "证书方式："
  echo "  1) 自签名证书（Caddy 内置 CA 签发，浏览器需手动信任一次）"
  echo "  2) 使用自己的证书（提供证书目录）"
  read -r -p "请选择 [1/2]（默认 1）: " tls_choice || true
  case "$tls_choice" in
    2) TLS_MODE=own ;;
    *) TLS_MODE=selfsigned ;;
  esac
fi
[ "$TLS_MODE" = "selfsigned" ] || [ "$TLS_MODE" = "own" ] || die "EDGE_TLS 必须是 selfsigned 或 own"

CERT_LINE="tls internal"
if [ "$TLS_MODE" = "own" ]; then
  if [ -z "$CERT_DIR" ] && [ -t 0 ]; then read -r -p "证书目录（含证书+私钥）: " CERT_DIR; fi
  [ -n "$CERT_DIR" ] || die "自有证书需要 EDGE_CERT_DIR（目录内放 cert.pem+key.pem 或 fullchain.pem+privkey.pem 或 <域名>.crt+<域名>.key）"
  [ -d "$CERT_DIR" ] || die "目录不存在: $CERT_DIR"
  CERT="$(find_cert "$CERT_DIR" "$DOMAIN" cert || true)"
  KEY="$(find_cert "$CERT_DIR" "$DOMAIN" key || true)"
  [ -n "$CERT" ] && [ -n "$KEY" ] || die "在 $CERT_DIR 未找到证书对（cert.pem/key.pem、fullchain.pem/privkey.pem 或 ${DOMAIN}.crt/${DOMAIN}.key）"
  CERT_LINE="tls $CERT $KEY"
  log "使用证书: $CERT + $KEY"
else
  log "使用 Caddy 内置 CA 自签（浏览器首次访问会有告警，可信任其根证书消除）"
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
RB_NEW_CADDY=0; RB_NEW_AUTH_CONF=0; RB_NEW_AUTH_USERS=0; RB_NEW_AUTH_UNIT=0
if [ -f "$CADDY_FILE" ]; then cp "$CADDY_FILE" "$RB_DIR/Caddyfile"; else RB_NEW_CADDY=1; fi
if [ -f "$AUTHELIA_DIR/configuration.yml" ]; then cp "$AUTHELIA_DIR/configuration.yml" "$RB_DIR/configuration.yml"; else RB_NEW_AUTH_CONF=1; fi
if [ -f "$AUTHELIA_DIR/users_database.yml" ]; then cp "$AUTHELIA_DIR/users_database.yml" "$RB_DIR/users_database.yml"; else RB_NEW_AUTH_USERS=1; fi
if [ -f "/etc/systemd/system/${AUTHELIA_UNIT}.service" ]; then cp "/etc/systemd/system/${AUTHELIA_UNIT}.service" "$RB_DIR/authelia.service"; else RB_NEW_AUTH_UNIT=1; fi

rollback() {
  log "校验失败——回滚所有已修改的文件"
  if [ "$RB_NEW_CADDY" = "1" ]; then
    rm -f "$CADDY_FILE"
  else
    cp "$RB_DIR/Caddyfile" "$CADDY_FILE" 2>/dev/null || true
  fi
  if [ "$RB_NEW_AUTH_CONF" = "1" ]; then
    rm -f "$AUTHELIA_DIR/configuration.yml"
  else
    cp "$RB_DIR/configuration.yml" "$AUTHELIA_DIR/configuration.yml" 2>/dev/null || true
  fi
  if [ "$RB_NEW_AUTH_USERS" = "1" ]; then
    rm -f "$AUTHELIA_DIR/users_database.yml"
  else
    cp "$RB_DIR/users_database.yml" "$AUTHELIA_DIR/users_database.yml" 2>/dev/null || true
  fi
  if [ "$RB_NEW_AUTH_UNIT" = "1" ]; then
    systemctl_do disable --now "$AUTHELIA_UNIT" 2>/dev/null || true
    rm -f "/etc/systemd/system/${AUTHELIA_UNIT}.service"
  elif [ -f "$RB_DIR/authelia.service" ]; then
    cp "$RB_DIR/authelia.service" "/etc/systemd/system/${AUTHELIA_UNIT}.service"
  fi
  systemctl_do daemon-reload
  systemctl_do reload caddy 2>/dev/null || true
  rm -rf "$RB_DIR"
  exit 1
}
trap 'rm -rf "$RB_DIR"' EXIT

install_caddy() {
  log "安装 Caddy（官方 apt 源）..."
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y caddy
}

command -v caddy >/dev/null 2>&1 || install_caddy
log "caddy: $(caddy version)"

# --- 4. Authelia -------------------------------------------------------------
AUTHELIA_BIN="$(command -v authelia || true)"
FRESH_AUTHELIA=0
if [ -z "$AUTHELIA_BIN" ] && [ ! -f "$AUTHELIA_DIR/configuration.yml" ]; then
  FRESH_AUTHELIA=1
  ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m | sed 's/aarch64/arm64/;s/x86_64/amd64/')"
  log "安装 Authelia ${AUTHELIA_VERSION} (${ARCH})..."
  TMPD="$(mktemp -d)"
  curl -fsSL "https://github.com/authelia/authelia/releases/download/v${AUTHELIA_VERSION}/authelia-v${AUTHELIA_VERSION}-linux-${ARCH}.tar.gz" \
    | tar -xz -C "$TMPD"
  install -m 755 "$TMPD/authelia-linux-${ARCH}" /usr/local/bin/authelia
  rm -rf "$TMPD"
  AUTHELIA_BIN=/usr/local/bin/authelia
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
    AUTH_PASS="$(random_hex | head -c 16)"
    GENERATED_PASS=1
  fi
  HASH="$("$AUTHELIA_BIN" crypto hash generate argon2 --password "$AUTH_PASS" 2>/dev/null | grep -o "\$argon2id\$[A-Za-z0-9$+/=.,_-]*" | head -1)"
  [ -n "$HASH" ] || die "生成 argon2 哈希失败"

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
  # Cookie domain: parent of the site domain when it has enough label depth
  # (codex.example.com -> example.com); fall back to the full domain for
  # shallow names like edge-test.local (cookie domains must contain a dot).
  COOKIE_DOMAIN="${DOMAIN#*.}"
  case "$COOKIE_DOMAIN" in
    *.*) ;;
    *) COOKIE_DOMAIN="$DOMAIN" ;;
  esac
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

  if [ "$SERVICE_MGR" = "systemd" ]; then
    cat > "/etc/systemd/system/${AUTHELIA_UNIT}.service" <<EOF
[Unit]
Description=Authelia authentication for codex-harness
After=network-online.target

[Service]
Type=simple
ExecStart=${AUTHELIA_BIN} --config ${AUTHELIA_DIR}/configuration.yml
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    systemctl_do daemon-reload
    systemctl_do enable --now "$AUTHELIA_UNIT"
  fi
else
  log "检测到已有 Authelia —— 复用现有用户库与配置"
  log "  · 加用户: authelia crypto hash generate argon2 后写入 users_database.yml"
  log "  · 若现有 Authelia 用白名单策略（default_policy: deny），请把 ${DOMAIN} 加入其 access_control 规则"
fi

# --- 5. Caddy site block (idempotent, marker-wrapped) ------------------------
# Same-domain pattern (proven against Authelia 4.38/4.39): authelia is mounted
# under /authelia (server.address path suffix), portal requests keep the
# prefix, everything else goes through forward-auth to the gateway.
site_block() {
  cat <<EOF
# codex-harness:begin ${DOMAIN}:${LISTEN_PORT}
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
        reverse_proxy 127.0.0.1:${GATEWAY_PORT} {
            flush_interval -1
        }
    }
}
# codex-harness:end ${DOMAIN}:${LISTEN_PORT}
EOF
}

MARK_BEGIN="# codex-harness:begin ${DOMAIN}:${LISTEN_PORT}"
if [ -f "$CADDY_FILE" ] && grep -qF "$MARK_BEGIN" "$CADDY_FILE"; then
  log "站点块已存在，更新（$CADDY_FILE）"
  python3 - "$CADDY_FILE" <<PY
import sys
path, begin = sys.argv[1], "${MARK_BEGIN}"
end = "# codex-harness:end ${DOMAIN}:${LISTEN_PORT}"
new = """$(site_block)"""
lines = open(path).read().split("\n")
out, skipping = [], False
for l in lines:
    if l.strip() == begin:
        skipping = True
        out.extend(new.rstrip("\n").split("\n"))
        continue
    if skipping and l.strip() == end:
        skipping = False
        continue
    if not skipping:
        out.append(l)
open(path, "w").write("\n".join(out) + "\n")
PY
else
  touch "$CADDY_FILE"
  { echo; site_block; } >> "$CADDY_FILE"
  log "已追加站点块到 $CADDY_FILE"
fi

# --- 6. validate + reload ------------------------------------------------------
caddy validate --config "$CADDY_FILE" >/dev/null 2>&1 || { log "Caddyfile 校验失败"; rollback; }
log "Caddyfile 校验通过"
if [ "$FRESH_AUTHELIA" = "1" ]; then
  "$AUTHELIA_BIN" validate-config --config "$AUTHELIA_DIR/configuration.yml" >/dev/null 2>&1 || { log "Authelia 配置校验失败"; rollback; }
  log "Authelia 配置校验通过"
fi
systemctl_do reload caddy || systemctl_do restart caddy

# --- 6.5 register the public host with the gateway ----------------------------
# The gateway only sets its auth cookie and accepts WebSockets for trusted
# Host headers (DNS-rebinding defense). The proxied browser traffic arrives
# with Host = domain[:port] (browsers omit the port when it is 443), so the
# edge URL must be registered in the gateway's environment — otherwise the
# page loads but every WebSocket is closed with 4003 ("gateway 未连接").
ENV_FILE="${ENV_FILE:-/etc/codex-harness.env}"
GATEWAY_UNIT="${GATEWAY_UNIT:-codex-harness}"
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
  done < <(grep -oP '(?<=^# codex-harness:begin )\S+' "$CADDY_FILE" | sort -u)
fi
# The just-written block is in the Caddyfile already, but keep PROXY_HOST as a
# fallback for marker-less setups.
case ",$TH_ALL," in
  *",$PROXY_HOST,"*) ;;
  *) TH_ALL="${TH_ALL:+$TH_ALL,}$PROXY_HOST" ;;
esac
if [ -f "$ENV_FILE" ] && grep -q '^TRUSTED_HOSTS=' "$ENV_FILE"; then
  sed -i "s|^TRUSTED_HOSTS=.*|TRUSTED_HOSTS=${TH_ALL}|" "$ENV_FILE"
else
  echo "TRUSTED_HOSTS=${TH_ALL}" >> "$ENV_FILE"
fi
if [ -f "$ENV_FILE" ] && grep -q '^GATEWAY_HTTPS=' "$ENV_FILE"; then
  sed -i "s|^GATEWAY_HTTPS=.*|GATEWAY_HTTPS=true|" "$ENV_FILE"
else
  echo "GATEWAY_HTTPS=true" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE" 2>/dev/null || true
# sed -i recreates the file as root — hand ownership back to the service user
# so a non-root deployment can still read its EnvironmentFile.
UNIT_PATH="/etc/systemd/system/${GATEWAY_UNIT}.service"
UNIT_USER="$(grep -oP '(?<=^User=).*' "$UNIT_PATH" 2>/dev/null | head -1 || true)"
if [ -n "$UNIT_USER" ] && [ "$UNIT_USER" != "root" ]; then
  chown "$UNIT_USER:$(id -gn "$UNIT_USER" 2>/dev/null || echo "$UNIT_USER")" "$ENV_FILE" 2>/dev/null || true
fi
log "已注册对外地址到网关信任列表（TRUSTED_HOSTS=${TH_ALL}）"
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "^${GATEWAY_UNIT}.service"; then
  systemctl_do restart "$GATEWAY_UNIT"
  log "网关已重启以加载新环境"
fi

# --- 7. summary ----------------------------------------------------------------
cat <<EOF

远程访问配置完成。
  ▸ 地址: https://${DOMAIN}:${LISTEN_PORT}
EOF
if [ "${GENERATED_PASS:-0}" = "1" ]; then
  echo "  ▸ 首个用户: ${AUTH_USER} / ${AUTH_PASS}   （随机生成，请记录后修改）"
else
  echo "  ▸ 用户: ${AUTH_USER}"
fi
[ "$TLS_MODE" = "selfsigned" ] && echo "  ▸ 自签证书：浏览器首次访问会告警，可信任 Caddy 根证书（journalctl -u caddy 可找到路径）"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "  ▸ 提示: ufw 防火墙处于启用状态，如需外网访问请放行端口: ufw allow ${LISTEN_PORT}/tcp"
fi
echo "  ▸ 验证: EDGE_URL=https://${DOMAIN}:${LISTEN_PORT} bash ${SCRIPT_DIR}/verify-login.sh"
