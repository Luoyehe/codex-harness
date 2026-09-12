#!/usr/bin/env bash
# Codex Harness WebUI — one-shot bare-metal installer.
#
# Simplest path:
#   curl -fsSL https://raw.githubusercontent.com/Luoyehe/codex-harness/main/deploy/install.sh | bash
# The script clones the repository itself, then runs the wizard.
#
# From a checkout:
#   ./deploy/install.sh
#
# Interactive wizard asks for the model provider; fully unattended with:
#   PROVIDER=zhipu ZHIPU_KEY=xxx ./deploy/install.sh
#   PROVIDER=openai ./deploy/install.sh        (then codex login yourself)
#   PROVIDER=skip ./deploy/install.sh          (configure later)
#
# Environment overrides:
#   INSTALL_DIR     default: repo root (in-place)
#   CODEX_HOME      default: ~/.codex
#   CODEX_WORKSPACE default: ~/codex-workspace (created if missing)
#   PORT            default: 8080 (gateway listens on 127.0.0.1)
#   SERVICE_NAME    default: codex-harness
#   NPM_REGISTRY    default: https://registry.npmmirror.com
#   ENV_FILE        default: /etc/codex-harness.env
#   REPO_URL        default: https://github.com/Luoyehe/codex-harness
set -euo pipefail

# --- self-clone: support `curl ... | bash` without a checkout ---------------
if [ ! -d "$(dirname "${BASH_SOURCE[0]}")/providers" ]; then
  command -v git >/dev/null 2>&1 || { echo "[install] git required"; exit 1; }
  REPO_URL="${REPO_URL:-https://github.com/Luoyehe/codex-harness}"
  CLONE_DIR="${CLONE_DIR:-$(pwd)/codex-harness}"
  echo "[install] not run from a checkout — cloning $REPO_URL to $CLONE_DIR"
  git clone --depth 1 "$REPO_URL" "$CLONE_DIR"
  cd "$CLONE_DIR"
  exec bash deploy/install.sh "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

INSTALL_DIR="${INSTALL_DIR:-$REPO_ROOT}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CODEX_WORKSPACE="${CODEX_WORKSPACE:-}"
PORT="${PORT:-}"

# --- 0. interactive base setup (TTY only; env vars / defaults win otherwise) ---
if [ -t 0 ] && [ -t 1 ]; then
  echo
  echo "基础设置（回车使用默认值；可用环境变量预先指定跳过提问）："
  if [ -z "$PORT" ]; then
    read -r -p "  网关端口（仅监听本机） [8080]: " p || true
    [ -n "$p" ] && PORT="$p"
  fi
  if [ -z "$CODEX_WORKSPACE" ]; then
    read -r -p "  新会话默认工作区 [~/codex-workspace]: " w || true
    [ -n "$w" ] && CODEX_WORKSPACE="$w"
  fi
fi

CODEX_WORKSPACE="${CODEX_WORKSPACE:-$HOME/codex-workspace}"
PORT="${PORT:-8080}"
SERVICE_NAME="${SERVICE_NAME:-codex-harness}"
# Export for child scripts (verify-server.sh, provider setups): without this,
# a custom CODEX_HOME/PORT deployment falls back to the defaults in children.
export CODEX_HOME PORT
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
ENV_FILE="${ENV_FILE:-/etc/codex-harness.env}"
RUN_USER="${RUN_USER:-$(id -un)}"

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

log() { echo "[install] $*"; }

# --- 1. Node.js >= 22 -------------------------------------------------------
install_node() {
  log "installing Node.js 22 via NodeSource..."
  $SUDO curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
  $SUDO apt-get install -y nodejs
}

if ! command -v node >/dev/null 2>&1; then
  install_node
elif [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  log "Node $(node --version) found, need >= 22"
  install_node
fi
log "Node.js: $(node --version)"

# --- 2. pnpm + codex CLI + both provider presets -----------------------------
# Universal install: dependencies for BOTH provider modes are deployed up
# front (OpenAI needs nothing extra; the Zhipu preset needs @z_ai/mcp-server).
# Only the config the user picks is ever ACTIVATED — the two modes stay
# exclusive in ~/.codex and can be switched later via providers/*/setup.sh.
corepack enable 2>/dev/null || $SUDO corepack enable
corepack prepare pnpm@11.22.0 --activate
log "pnpm: $(pnpm --version)"

npm config set registry "$NPM_REGISTRY"
CODEX_VERSION="0.149.0"   # protocol/ generated from this version; bump both.
ZAI_MCP_VERSION="0.1.4"   # pinned — floating latest may break tool names/protocol.
                           # (verified against npm's published 0.1.x line; the
                           # vision MCP tests in deploy/ pass on this version)

if ! command -v codex >/dev/null 2>&1; then
  log "installing @openai/codex CLI..."
  $SUDO npm install -g "@openai/codex@$CODEX_VERSION"
elif ! codex --version 2>/dev/null | grep -q "$CODEX_VERSION"; then
  log "WARN: codex $(codex --version 2>/dev/null | head -1) found, but this repo targets $CODEX_VERSION."
  log "      protocol/ types and MCP compatibility are tied to this version."
  log "      To upgrade: edit CODEX_VERSION in deploy/install.sh, regenerate protocol/, and re-run tests."
fi
log "codex: $(codex --version)"

if ! command -v zai-mcp-server >/dev/null 2>&1; then
  log "installing @z_ai/mcp-server@$ZAI_MCP_VERSION (Zhipu preset)..."
  $SUDO npm install -g "@z_ai/mcp-server@$ZAI_MCP_VERSION"
else
  # `zai-mcp-server --version` does not print a version (it starts the server
  # and errors on the missing API key) — ask npm what is actually installed.
  ZAI_CURRENT="$(npm ls -g @z_ai/mcp-server --depth=0 2>/dev/null | grep -oP '(?<=@z_ai/mcp-server@)[0-9][0-9A-Za-z.-]*' | head -1 || true)"
  if [ "$ZAI_CURRENT" != "$ZAI_MCP_VERSION" ]; then
    log "WARN: zai-mcp-server ${ZAI_CURRENT:-unknown} found, pinned version is $ZAI_MCP_VERSION. Reinstalling..."
    $SUDO npm install -g "@z_ai/mcp-server@$ZAI_MCP_VERSION"
  fi
fi

# --- 3. build ----------------------------------------------------------------
log "building gateway + web ($INSTALL_DIR)..."
cd "$INSTALL_DIR"
pnpm install --frozen-lockfile
pnpm build

# --- 4. workspace + codex home + service env --------------------------------
case "$CODEX_HOME" in
  /tmp|/tmp/*|/var/tmp/*)
    log "WARNING: CODEX_HOME=$CODEX_HOME 位于临时目录——codex 拒绝在 /tmp 下创建"
    log "         helper binaries（网页终端/沙箱将不可用）。请使用持久化目录。"
    ;;
esac
mkdir -p "$CODEX_WORKSPACE" "$CODEX_HOME"
log "workspace: $CODEX_WORKSPACE"
log "codex home: $CODEX_HOME"

if [ ! -f "$ENV_FILE" ]; then
  log "creating $ENV_FILE (provider setup scripts add their keys here)"
  $SUDO tee "$ENV_FILE" >/dev/null <<EOF
# Extra environment for the codex-harness service.
# The provider preset you choose appends its own keys to this file.
EOF
  # The service (User=$RUN_USER) must be able to read this file — when the
  # installer runs via sudo for a non-root service user, root-owned 600
  # would make EnvironmentFile unreadable.
  $SUDO chown "$RUN_USER:$(id -gn "$RUN_USER")" "$ENV_FILE" 2>/dev/null || true
  $SUDO chmod 600 "$ENV_FILE"
fi

# --- 5. systemd unit ---------------------------------------------------------
# Guard 1: refuse to clobber an existing deployment that lives elsewhere.
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
if [ -f "$UNIT_FILE" ] && ! grep -q "WorkingDirectory=${INSTALL_DIR}/apps/gateway" "$UNIT_FILE" 2>/dev/null; then
  log "ERROR: $UNIT_FILE already serves a different install directory."
  log "Set SERVICE_NAME=<new-name> (and PORT) to deploy another instance,"
  log "or point INSTALL_DIR at the existing checkout to upgrade in place."
  exit 1
fi
# Guard 2: the port must be free — a collision would crash-loop the gateway.
# The one allowed holder is THIS service's own old instance (in-place upgrade).
if [ "${FORCE:-0}" != "1" ] && command -v ss >/dev/null 2>&1; then
  OCC_PID="$(ss -tlnp 2>/dev/null | grep -E ":${PORT}\b" | grep -oP '(?<=pid=)[0-9]+' | head -1 || true)"
  if [ -n "$OCC_PID" ]; then
    # cgroup v2 path looks like /system.slice/<unit>.service
    OCC_UNIT="$(grep -ao '/[a-zA-Z0-9_.@-]*\.service' "/proc/${OCC_PID}/cgroup" 2>/dev/null | head -1 | sed -e 's|^/||' -e 's|\.service$||')"
    if [ "$OCC_UNIT" != "$SERVICE_NAME" ]; then
      log "ERROR: 端口 ${PORT} 已被占用（pid=${OCC_PID}${OCC_UNIT:+, 服务=${OCC_UNIT}}）。"
      log "换一个端口（PORT=xxx）部署新实例，或 FORCE=1 跳过此检查。"
      exit 1
    fi
  fi
fi
log "writing $UNIT_FILE (user=$RUN_USER, env file=$ENV_FILE)..."
cat > /tmp/${SERVICE_NAME}.unit <<EOF
[Unit]
Description=Codex Harness WebUI gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=$(id -gn "$RUN_USER")
WorkingDirectory=${INSTALL_DIR}/apps/gateway
Environment=HOST=127.0.0.1
Environment=PORT=${PORT}
Environment=CODEX_HOME=${CODEX_HOME}
Environment=CODEX_WORKSPACE=${CODEX_WORKSPACE}
EnvironmentFile=-${ENV_FILE}
ExecStart=$(which node) ${INSTALL_DIR}/apps/gateway/dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
$SUDO install -m 644 /tmp/${SERVICE_NAME}.unit "$UNIT_FILE"
rm -f /tmp/${SERVICE_NAME}.unit

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now "$SERVICE_NAME"

# --- 5.5 register the `codex-harness` management command ---------------------
# A thin wrapper in PATH so users can run `codex-harness` from anywhere
# (removed again by `manage.sh uninstall`). The wrapper points at the real
# script in the install dir, so code updates never need re-registration.
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
COMMAND_PATH="$BIN_DIR/codex-harness"
log "registering management command: $COMMAND_PATH"
$SUDO tee "$COMMAND_PATH" >/dev/null <<EOF
#!/usr/bin/env bash
# Registered by codex-harness install.sh — removed by manage.sh uninstall.
exec bash "${INSTALL_DIR}/deploy/manage.sh" "\$@"
EOF
$SUDO chmod 755 "$COMMAND_PATH"

# --- 6. model provider -------------------------------------------------------
# Unattended: PROVIDER=openai|zhipu|skip. Interactive TTY: ask. curl|bash
# (non-TTY, no PROVIDER): skip with instructions.
configure_provider() {
  local provider="${PROVIDER:-}"
  if [ -z "$provider" ]; then
    if [ -t 0 ] && [ -t 1 ]; then
      echo
      echo "选择要激活的模型源（几套方案均已部署，随时可运行 providers/*/setup.sh 切换）："
      echo "  1) OpenAI / ChatGPT 账号 —— Codex 原生，设备码登录"
      echo "  2) 智谱个人版 Coding Plan —— GLM 模型 + 四个官方 MCP（推荐国内用户）"
      echo "  3) 自定义 OpenAI 兼容 API —— 本地 vLLM / Ollama / 中转站等"
      echo "  4) 稍后自己选择"
      local choice
      read -r -p "请选择 [1/2/3/4]（默认 1）: " choice || choice=4
      case "$choice" in
        2) provider=zhipu ;;
        3) provider=custom ;;
        4) provider=skip ;;
        *) provider=openai ;;
      esac
    else
      log "非交互环境且未指定 PROVIDER —— 跳过模型源配置（详见 deploy/README.md 第二节）"
      provider=skip
    fi
  fi

  case "$provider" in
    zhipu)
      local key="${ZHIPU_KEY:-}"
      if [ -z "$key" ] && grep -q '^Z_AI_API_KEY=.\+' "$ENV_FILE" 2>/dev/null; then
        key="$(grep -oP '(?<=^Z_AI_API_KEY=).*' "$ENV_FILE")"
        log "使用 $ENV_FILE 中已有的 Z_AI_API_KEY"
      fi
      if [ -z "$key" ] && [ -t 0 ]; then
        read -r -p "粘贴你的智谱 Coding Plan API Key: " key
      fi
      if [ -z "$key" ]; then
        log "未提供 Key —— 请稍后把 Z_AI_API_KEY 填入 $ENV_FILE 并运行 deploy/providers/zhipu-coding-plan/setup.sh"
      else
        if ! grep -q '^Z_AI_API_KEY=.\+' "$ENV_FILE" 2>/dev/null; then
          $SUDO sh -c "printf 'Z_AI_API_KEY=%s\n' '$key' >> '$ENV_FILE'"
          $SUDO chown "$RUN_USER:$(id -gn "$RUN_USER")" "$ENV_FILE" 2>/dev/null || true
          $SUDO chmod 600 "$ENV_FILE"
        fi
        ENV_FILE="$ENV_FILE" CODEX_HOME="$CODEX_HOME" bash "$INSTALL_DIR/deploy/providers/zhipu-coding-plan/setup.sh"
      fi
      ;;
    openai)
      log "OpenAI/ChatGPT 原生模式：移除激活配置软链（回到零配置；其它模式配置集与密钥保留不动）"
      bash "$INSTALL_DIR/deploy/providers/openai/setup.sh"
      if [ -t 0 ]; then
        local login_now
        read -r -p "现在进行设备码登录 codex login --device-auth？[y/N] " login_now || true
        if [[ "$login_now" == y* || "$login_now" == Y* ]]; then
          $SUDO systemctl stop "$SERVICE_NAME" || true
          codex login --device-auth
          $SUDO systemctl start "$SERVICE_NAME"
        fi
      else
        log "登录命令：codex login --device-auth（或打开 WebUI 点右上角登录）"
      fi
      ;;
    custom)
      local cu_base="${CUSTOM_BASE_URL:-}"
      local cu_model="${CUSTOM_MODEL:-}"
      if { [ -z "$cu_base" ] || [ -z "$cu_model" ]; } && [ -t 0 ]; then
        log "自定义 OpenAI 兼容 API（本地 vLLM/中转站，需提供 Responses API 端点）"
      fi
      if ! CUSTOM_BASE_URL="$cu_base" CUSTOM_MODEL="$cu_model" \
           CUSTOM_API_KEY="${CUSTOM_API_KEY:-}" CUSTOM_CTX="${CUSTOM_CTX:-}" \
           CODEX_HOME="$CODEX_HOME" \
           bash "$INSTALL_DIR/deploy/providers/custom-openai/setup.sh"; then
        log "custom 供应商配置未完成（非交互环境需 CUSTOM_BASE_URL + CUSTOM_MODEL）"
        log "稍后补齐：bash $INSTALL_DIR/deploy/providers/custom-openai/setup.sh"
      fi
      ;;
    skip|""|none)
      log "跳过模型源配置。后续参见 deploy/README.md 第二节。"
      ;;
    *)
      log "未知 PROVIDER=$provider（可选 openai/zhipu/custom/skip），跳过"
      ;;
  esac
}

configure_provider

# --- 7. restart + health check ------------------------------------------------
$SUDO systemctl restart "$SERVICE_NAME"
sleep 2

if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null; then
  log "OK — gateway is healthy on http://127.0.0.1:${PORT}"
else
  log "gateway not healthy yet; check: journalctl -u ${SERVICE_NAME} -e"
  exit 1
fi
bash "$INSTALL_DIR/deploy/verify-server.sh" || log "(verify-server 有失败项，见上方输出)"

# --- 8. remote access wizard ---------------------------------------------------
# ① local-only / SSH tunnel (default) or ③ Caddy(TLS) + Authelia(login);
# see deploy/setup-edge.sh for the unattended EDGE= variables.
GATEWAY_PORT="$PORT" GATEWAY_UNIT="$SERVICE_NAME" ENV_FILE="$ENV_FILE" \
  bash "$INSTALL_DIR/deploy/setup-edge.sh" \
  || log "(远程访问配置未完成，可稍后运行: bash $INSTALL_DIR/deploy/setup-edge.sh)"

cat <<EOF

安装完成。
  ▸ 立即使用:  http://127.0.0.1:${PORT}
  ▸ 管理命令:  codex-harness（任意目录直接运行；也可 bash ${INSTALL_DIR}/deploy/manage.sh）
  ▸ 远程访问:  见上方远程访问向导输出（变更: codex-harness edge 或 网页设置 → 服务器管理）
               ——网关仅监听回环地址且启用 token 认证（~/.codex/gateway-token），
                 远程访问仍须走 TLS 反代 + 登录鉴权，绝不可直接暴露端口
  ▸ 日常维护:  优先在网页「设置 → 服务器管理」完成（切模型源 / 一键同步 / 重启 / 日志）
  ▸ 服务管理:  systemctl {status|restart} ${SERVICE_NAME}；日志: journalctl -u ${SERVICE_NAME} -f
  ▸ 升级:      codex-harness update（git 安装方式下可一键拉取并重建）
EOF
