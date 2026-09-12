#!/usr/bin/env bash
# Codex Harness WebUI — one-shot bare-metal installer.
#
# Simplest path:
#   bash <(curl -fsSL https://raw.githubusercontent.com/Luoyehe/codex-harness/main/deploy/install.sh)
# The script clones the repository itself, then runs the wizard.
#
# From a checkout:
#   ./deploy/install.sh
#
# Interactive wizard asks for the model provider; fully unattended with:
#   PROVIDER=zhipu ZHIPU_KEY=xxx ./deploy/install.sh
#   PROVIDER=openai ./deploy/install.sh        (then log in through the WebUI)
#   PROVIDER=skip ./deploy/install.sh          (configure later)
#
# Environment overrides:
#   INSTALL_DIR     default: repo root (in-place)
#   CODEX_HOME      default: ~/.codex
#   CODEX_WORKSPACE default: ~/codex-workspace (created if missing)
#   PORT            default: 8080 (gateway listens on 127.0.0.1)
#   SERVICE_NAME    default: codex-harness
#   NPM_REGISTRY    optional npm registry override (official registry by default)
#   ENV_FILE        default: <CODEX_HOME>/secrets.env
#   TOOLS_BIN_DIR   default: validated `npm prefix -g`/bin; root-owned tools only
#   REPO_URL        default: https://github.com/Luoyehe/codex-harness
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
# Build artefacts, cloned source, apt metadata and systemd units must remain
# readable by the unprivileged service account. Secret files are created with
# explicit 0600 modes below rather than making the entire installer umask 077.
umask 022

# --- self-clone: support process-substitution installation without checkout --
if [ ! -d "$(dirname "${BASH_SOURCE[0]}")/providers" ]; then
  command -v git >/dev/null 2>&1 || { echo "[install] git required"; exit 1; }
  REPO_URL="${REPO_URL:-https://github.com/Luoyehe/codex-harness}"
  if [ "$(id -u)" -eq 0 ]; then
    CLONE_DIR="${CLONE_DIR:-/opt/codex-harness}"
  else
    CLONE_DIR="${CLONE_DIR:-$(pwd)/codex-harness}"
  fi
  echo "[install] not run from a checkout — cloning $REPO_URL to $CLONE_DIR"
  git clone --depth 1 -- "$REPO_URL" "$CLONE_DIR"
  cd "$CLONE_DIR"
  exec bash deploy/install.sh "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

INSTALL_DIR="${INSTALL_DIR:-$REPO_ROOT}"
SERVICE_NAME="${SERVICE_NAME:-codex-harness}"
case "$SERVICE_NAME" in
  ''|[-_]*|*[!A-Za-z0-9_-]*)
    echo "[install] invalid SERVICE_NAME: use a letter/digit first and only A-Z a-z 0-9 _ -" >&2
    exit 1
    ;;
esac
[ "${#SERVICE_NAME}" -le 128 ] || { echo "[install] SERVICE_NAME is too long" >&2; exit 1; }
EXISTING_UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
LEGACY_ADMIN_FOR_THIS=0
if grep -qxF 'Environment=CODEX_HARNESS_ADMIN_HELPER=/usr/local/libexec/codex-harness-admin' "$EXISTING_UNIT" 2>/dev/null; then
  LEGACY_ADMIN_FOR_THIS=1
fi
if [ -z "${RUN_USER:-}" ]; then
  if [ -f "$EXISTING_UNIT" ]; then
    RUN_USER="$(sed -n 's/^User=//p' "$EXISTING_UNIT" | head -1)"
    RUN_USER="${RUN_USER:-root}"
  elif [ "$(id -u)" -eq 0 ]; then
    RUN_USER="codex-harness"
    if ! id "$RUN_USER" >/dev/null 2>&1; then
      useradd --system --create-home --home-dir /var/lib/codex-harness --shell /usr/sbin/nologin "$RUN_USER"
    fi
  else
    RUN_USER="$(id -un)"
  fi
fi
id "$RUN_USER" >/dev/null 2>&1 || { echo "[install] unknown RUN_USER: $RUN_USER" >&2; exit 1; }
case "$RUN_USER" in ''|[-.]*|*[!A-Za-z0-9_.-]*) echo "[install] unsafe RUN_USER for sudoers: $RUN_USER" >&2; exit 1 ;; esac
if [ "$(id -u "$RUN_USER")" -eq 0 ]; then
  echo "[install] ERROR: refusing to run the gateway and browser terminal as root." >&2
  echo "[install] Create a dedicated unprivileged account, migrate CODEX_HOME, ENV_FILE and" >&2
  echo "[install] CODEX_WORKSPACE deliberately, then rerun with RUN_USER=<account>." >&2
  echo "[install] Existing data is never recursively chowned by this installer." >&2
  echo "[install] ALLOW_ROOT_SERVICE=1 no longer bypasses this requirement." >&2
  exit 1
fi
RUN_GROUP="$(id -gn "$RUN_USER")"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
[ -n "$RUN_HOME" ] || { echo "[install] cannot determine home for $RUN_USER" >&2; exit 1; }
INSTANCE_HOME="$RUN_HOME"
[ "$SERVICE_NAME" = codex-harness ] || INSTANCE_HOME="$RUN_HOME/instances/$SERVICE_NAME"
if [ -z "${CODEX_HOME:-}" ] && [ -f "$EXISTING_UNIT" ]; then
  CODEX_HOME="$(sed -n 's/^Environment=CODEX_HOME=//p' "$EXISTING_UNIT" | head -1)"
fi
CODEX_HOME="${CODEX_HOME:-$INSTANCE_HOME/.codex}"
if [ -z "${CODEX_WORKSPACE:-}" ] && [ -f "$EXISTING_UNIT" ]; then
  CODEX_WORKSPACE="$(sed -n 's/^Environment=CODEX_WORKSPACE=//p' "$EXISTING_UNIT" | head -1)"
fi
CODEX_WORKSPACE="${CODEX_WORKSPACE:-}"
if [ -z "${PORT:-}" ] && [ -f "$EXISTING_UNIT" ]; then
  PORT="$(sed -n 's/^Environment=PORT=//p' "$EXISTING_UNIT" | head -1)"
fi
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

CODEX_WORKSPACE="${CODEX_WORKSPACE:-$INSTANCE_HOME/codex-workspace}"
PORT="${PORT:-8080}"
case "$PORT" in ''|*[!0-9]*) echo "[install] PORT must be an integer" >&2; exit 1 ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || { echo "[install] PORT must be between 1 and 65535" >&2; exit 1; }
# Export for child scripts (verify-server.sh, provider setups): without this,
# a custom CODEX_HOME/PORT deployment falls back to the defaults in children.
export CODEX_HOME PORT
NPM_REGISTRY="${NPM_REGISTRY:-}"
if [ -z "${ENV_FILE:-}" ] && [ -f "$EXISTING_UNIT" ]; then
  ENV_FILE="$(sed -n 's/^Environment=ENV_FILE=//p' "$EXISTING_UNIT" | head -1)"
fi
ENV_FILE="${ENV_FILE:-$CODEX_HOME/secrets.env}"

# These values are emitted into systemd directives without a shell. Reject
# control characters, specifiers and whitespace instead of producing a unit
# whose parsed value differs from the operator's requested path.
validate_unit_path() {
  local name="$1" value="$2"
  case "$value" in
    /*) ;;
    *) echo "[install] $name must be an absolute path: $value" >&2; exit 1 ;;
  esac
  case "$value" in
    *[!A-Za-z0-9_./@+-]*) echo "[install] $name contains characters unsafe for a systemd unit: $value" >&2; exit 1 ;;
  esac
}
validate_unit_path INSTALL_DIR "$INSTALL_DIR"
validate_unit_path CODEX_HOME "$CODEX_HOME"
validate_unit_path CODEX_WORKSPACE "$CODEX_WORKSPACE"
validate_unit_path ENV_FILE "$ENV_FILE"

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

# Fail before package installs, builds or secret-file changes if this name belongs
# to another checkout. Python 3.11 is also needed by the provider configuration.
if [ -f "$EXISTING_UNIT" ] && ! grep -qxF "WorkingDirectory=${INSTALL_DIR}/apps/gateway" "$EXISTING_UNIT"; then
  echo "[install] service belongs to another checkout; choose a different SERVICE_NAME" >&2
  exit 1
fi
if ! python3 -c 'import sys,tomllib; assert sys.version_info >= (3,11)' >/dev/null 2>&1; then
  $SUDO apt-get update
  $SUDO apt-get install -y python3
  python3 -c 'import sys,tomllib; assert sys.version_info >= (3,11)' \
    || { echo "[install] Python 3.11+ required (Ubuntu 24.04+ or Debian 12+)" >&2; exit 1; }
fi

log() { echo "[install] $*"; }

run_as_service() {
  if [ "$(id -un)" = "$RUN_USER" ]; then
    env HOME="$RUN_HOME" CODEX_HOME="$CODEX_HOME" PATH="$PATH" "$@"
  elif [ "$(id -u)" -eq 0 ]; then
    runuser -u "$RUN_USER" -- env HOME="$RUN_HOME" CODEX_HOME="$CODEX_HOME" PATH="$PATH" "$@"
  else
    sudo -u "$RUN_USER" env HOME="$RUN_HOME" CODEX_HOME="$CODEX_HOME" PATH="$PATH" "$@"
  fi
}

# --- 1. Node.js >= 22 -------------------------------------------------------
if [ -z "${NODE_BIN:-}" ] && [ -f "$EXISTING_UNIT" ]; then
  NODE_BIN="$(sed -n 's/^Environment=NODE_BIN=//p' "$EXISTING_UNIT" | head -1)"
fi
if [ -n "${NODE_BIN:-}" ]; then
  validate_unit_path NODE_BIN "$NODE_BIN"
  [ -x "$NODE_BIN" ] || { log "ERROR: configured NODE_BIN is not executable"; exit 1; }
  export PATH="${NODE_BIN%/*}:$PATH"
fi
install_node() {
  log "installing Node.js 22 from the signed NodeSource apt repository..."
  $SUDO apt-get update
  $SUDO apt-get install -y ca-certificates curl gnupg
  $SUDO install -d -m 0755 /etc/apt/keyrings
  local key_tmp
  key_tmp="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$key_tmp"
  $SUDO gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg "$key_tmp"
  $SUDO chmod 0644 /etc/apt/keyrings/nodesource.gpg
  rm -f "$key_tmp"
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    | $SUDO tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  $SUDO chmod 0644 /etc/apt/sources.list.d/nodesource.list
  $SUDO apt-get update
  $SUDO apt-get install -y nodejs
}

if ! command -v node >/dev/null 2>&1; then
  install_node
elif [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  log "Node $(node --version) found, need >= 22"
  install_node
fi
log "Node.js: $(node --version)"
NODE_BIN="$(command -v node)"
if [ -z "${TOOLS_BIN_DIR:-}" ] && [ -f "$EXISTING_UNIT" ]; then
  TOOLS_BIN_DIR="$(sed -n 's/^Environment=TOOLS_BIN_DIR=//p' "$EXISTING_UNIT" | head -1)"
fi
TOOLS_BIN_DIR="$(python3 "$SCRIPT_DIR/runtime_paths.py" "${TOOLS_BIN_DIR:-}" --allow-missing)"
TOOLS_PREFIX="${TOOLS_BIN_DIR%/bin}"
NPM_BIN="$(command -v npm)"
export NODE_BIN TOOLS_BIN_DIR
# Only persist these known directories, not an installer's ambient PATH.
export PATH="${NODE_BIN%/*}:$TOOLS_BIN_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# --- 2. pnpm + codex CLI + both provider presets -----------------------------
# Universal install: dependencies for BOTH provider modes are deployed up
# front (OpenAI needs nothing extra; the Zhipu preset needs @z_ai/mcp-server).
# Only the config the user picks is ever ACTIVATED — the two modes stay
# exclusive in ~/.codex and can be switched later via providers/*/setup.sh.
corepack enable 2>/dev/null || $SUDO corepack enable
corepack prepare pnpm@11.22.0 --activate
log "pnpm: $(pnpm --version)"

[ -z "$NPM_REGISTRY" ] || export npm_config_registry="$NPM_REGISTRY"
CODEX_VERSION="0.149.0"   # protocol/ generated from this version; bump both.
ZAI_MCP_VERSION="0.1.4"   # pinned — floating latest may break tool names/protocol.
                           # (verified against npm's published 0.1.x line; the
                           # vision MCP tests in deploy/ pass on this version)

# The gateway uses a private versioned runtime, never another app's global CLI.
CODEX_BIN="$($SUDO env PATH="$PATH" bash "$INSTALL_DIR/deploy/install-runtime.sh" "$CODEX_VERSION")"
export CODEX_BIN
log "codex: $("$CODEX_BIN" --version)"

if [ ! -x "$TOOLS_BIN_DIR/zai-mcp-server" ]; then
  log "installing @z_ai/mcp-server@$ZAI_MCP_VERSION (Zhipu preset)..."
  $SUDO env PATH="$PATH" "$NPM_BIN" --prefix "$TOOLS_PREFIX" install -g "@z_ai/mcp-server@$ZAI_MCP_VERSION"
else
  # `zai-mcp-server --version` does not print a version (it starts the server
  # and errors on the missing API key) — ask npm what is actually installed.
  ZAI_CURRENT="$("$NPM_BIN" --prefix "$TOOLS_PREFIX" ls -g @z_ai/mcp-server --depth=0 2>/dev/null | grep -oP '(?<=@z_ai/mcp-server@)[0-9][0-9A-Za-z.-]*' | head -1 || true)"
  if [ "$ZAI_CURRENT" != "$ZAI_MCP_VERSION" ]; then
    log "WARN: zai-mcp-server ${ZAI_CURRENT:-unknown} found, pinned version is $ZAI_MCP_VERSION. Reinstalling..."
    $SUDO env PATH="$PATH" "$NPM_BIN" --prefix "$TOOLS_PREFIX" install -g "@z_ai/mcp-server@$ZAI_MCP_VERSION"
  fi
fi
TOOLS_BIN_DIR="$(python3 "$SCRIPT_DIR/runtime_paths.py" "$TOOLS_BIN_DIR")"

# --- 3. build ----------------------------------------------------------------
log "building gateway + web ($INSTALL_DIR)..."
cd "$INSTALL_DIR"
pnpm install --frozen-lockfile
pnpm build
run_as_service test -r "$INSTALL_DIR/apps/gateway/dist/index.js" \
  || { log "ERROR: build output is not readable by service user $RUN_USER"; exit 1; }

# --- 4. workspace + codex home + service env --------------------------------
case "$CODEX_HOME" in
  /tmp|/tmp/*|/var/tmp/*)
    log "WARNING: CODEX_HOME=$CODEX_HOME 位于临时目录——codex 拒绝在 /tmp 下创建"
    log "         helper binaries（网页终端/沙箱将不可用）。请使用持久化目录。"
    ;;
esac
ensure_service_directory() {
  local path="$1" label="$2"
  if [ ! -e "$path" ]; then
    $SUDO install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 0700 "$path"
  fi
  [ -d "$path" ] || { log "ERROR: $label is not a directory: $path"; exit 1; }
  if ! run_as_service test -r "$path" || ! run_as_service test -w "$path" || ! run_as_service test -x "$path"; then
    log "ERROR: $label is not readable/writable by service user $RUN_USER: $path"
    log "Adjust ownership deliberately, then rerun (the installer will not recursively chown an existing project tree)."
    exit 1
  fi
}
ensure_service_directory "$CODEX_HOME" "CODEX_HOME"
ensure_service_directory "$CODEX_WORKSPACE" "CODEX_WORKSPACE"
log "workspace: $CODEX_WORKSPACE"
log "codex home: $CODEX_HOME"

# Validate the actual non-root sandbox before registering or starting service.
$SUDO env PATH="$PATH" RUN_USER="$RUN_USER" CODEX_HOME="$CODEX_HOME" \
  CODEX_WORKSPACE="$CODEX_WORKSPACE" CODEX_BIN="$CODEX_BIN" \
  bash "$SCRIPT_DIR/install-sandbox.sh"

if [ ! -f "$ENV_FILE" ] && [ "$ENV_FILE" != "/etc/codex-harness.env" ] && [ -f /etc/codex-harness.env ]; then
  log "ERROR: legacy /etc/codex-harness.env requires deliberate migration to $ENV_FILE with ownership for $RUN_USER"
  exit 1
fi
# Service data is writable by the service account and is never a root trust
# anchor. Create/validate it with the same identity that later maintains it.
run_as_service python3 "$SCRIPT_DIR/service_env.py" "$CODEX_HOME" "$ENV_FILE"

# --- 5. systemd unit ---------------------------------------------------------
# Guard 1: refuse to clobber an existing deployment that lives elsewhere.
UNIT_FILE="$EXISTING_UNIT"
if [ -f "$UNIT_FILE" ] && ! grep -qxF "WorkingDirectory=${INSTALL_DIR}/apps/gateway" "$UNIT_FILE" 2>/dev/null; then
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
log "registering system files for $SERVICE_NAME..."
if ! command -v visudo >/dev/null 2>&1; then $SUDO apt-get install -y sudo; fi
COMMAND_PATH="$($SUDO env SERVICE_NAME="$SERVICE_NAME" RUN_USER="$RUN_USER" INSTALL_DIR="$INSTALL_DIR" \
  CODEX_HOME="$CODEX_HOME" CODEX_WORKSPACE="$CODEX_WORKSPACE" ENV_FILE="$ENV_FILE" \
  CODEX_BIN="$CODEX_BIN" NODE_BIN="$NODE_BIN" TOOLS_BIN_DIR="$TOOLS_BIN_DIR" PATH="$PATH" \
  PORT="$PORT" BIN_DIR="${BIN_DIR:-/usr/local/bin}" \
  bash "$INSTALL_DIR/deploy/register-service.sh")"
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now "$SERVICE_NAME"
if [ "$LEGACY_ADMIN_FOR_THIS" -eq 1 ]; then
  # Complete the one-time transition so the old shared sudo grant does not
  # remain usable after this instance has moved to its namespaced helper.
  if ! grep -lxF 'Environment=CODEX_HARNESS_ADMIN_HELPER=/usr/local/libexec/codex-harness-admin' \
      /etc/systemd/system/*.service >/dev/null 2>&1; then
    $SUDO rm -f /usr/local/libexec/codex-harness-admin /etc/codex-harness/admin.conf /etc/sudoers.d/codex-harness
  else
    log "legacy admin helper is still referenced by another unit; leaving its files in place"
  fi
fi

# --- 6. model provider -------------------------------------------------------
# Unattended: PROVIDER=openai|zhipu|custom|skip. Interactive TTY: ask. A pipe without
# a TTY and without PROVIDER skips safely with instructions.
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
      local stored_key=""
      if [ -z "$key" ] && grep -q '^Z_AI_API_KEY=.\+' "$ENV_FILE" 2>/dev/null; then
        stored_key=1
        log "使用 $ENV_FILE 中已有的 Z_AI_API_KEY"
      fi
      if [ -z "$key" ] && [ -z "$stored_key" ] && [ -t 0 ]; then
        read -r -s -p "粘贴你的智谱 Coding Plan API Key: " key; echo
      fi
      if [ -n "$key" ]; then
        # Pass secrets in the child environment, not as visible `env KEY=...`
        # argv entries. The provider still receives the same variables.
        ZHIPU_KEY="$key" ENV_FILE="$ENV_FILE" \
          run_as_service bash "$INSTALL_DIR/deploy/providers/zhipu-coding-plan/setup.sh"
      elif [ -n "$stored_key" ]; then
        ENV_FILE="$ENV_FILE" run_as_service bash "$INSTALL_DIR/deploy/providers/zhipu-coding-plan/setup.sh"
      else
        log "未提供 Key —— 请稍后把 Z_AI_API_KEY 填入 $ENV_FILE 并运行 deploy/providers/zhipu-coding-plan/setup.sh"
      fi
      ;;
    openai)
      log "OpenAI/ChatGPT 原生模式：发布空的受管理配置；保留其它模式配置及私有恢复代"
      ENV_FILE="$ENV_FILE" run_as_service bash "$INSTALL_DIR/deploy/providers/openai/setup.sh"
      if [ -t 0 ]; then
        local login_now
        read -r -p "现在进行设备码登录 codex login --device-auth？[y/N] " login_now || true
        if [[ "$login_now" == y* || "$login_now" == Y* ]]; then
          $SUDO systemctl stop "$SERVICE_NAME" || true
          if ! run_as_service "$CODEX_BIN" login --device-auth; then
            log "设备码登录未完成；恢复服务后可通过 WebUI 重试"
          fi
          $SUDO systemctl start "$SERVICE_NAME"
        fi
      else
        log "打开 WebUI 点右上角登录（凭据保存在该服务用户的 CODEX_HOME）"
      fi
      ;;
    custom)
      local cu_base="${CUSTOM_BASE_URL:-}"
      local cu_model="${CUSTOM_MODEL:-}"
      if { [ -z "$cu_base" ] || [ -z "$cu_model" ]; } && [ -t 0 ]; then
        log "自定义 OpenAI 兼容 API（本地 vLLM/中转站，需提供 Responses API 端点）"
      fi
      if ! CUSTOM_BASE_URL="$cu_base" CUSTOM_MODEL="$cu_model" \
           CUSTOM_API_KEY="${CUSTOM_API_KEY:-}" CUSTOM_CTX="${CUSTOM_CTX:-}" ENV_FILE="$ENV_FILE" \
           run_as_service bash "$INSTALL_DIR/deploy/providers/custom-openai/setup.sh"; then
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
$SUDO chmod 700 "$CODEX_HOME"

# --- 7. restart + health check ------------------------------------------------
$SUDO systemctl restart "$SERVICE_NAME"
sleep 2

if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null; then
  log "OK — gateway is healthy on http://127.0.0.1:${PORT}"
else
  log "gateway not healthy yet; check: journalctl -u ${SERVICE_NAME} -e"
  exit 1
fi
log "running isolated smoke verification (no production credentials or model turns)..."
run_as_service env CODEX_BIN="$CODEX_BIN" node "$INSTALL_DIR/scripts/gateway-smoke.mjs"

# --- 8. remote access wizard ---------------------------------------------------
# ① local-only / SSH tunnel (default) or ③ Caddy(TLS) + Authelia(login);
# see deploy/setup-edge.sh for the unattended EDGE= variables.
if [ "${SKIP_EDGE_SETUP:-0}" = "1" ]; then
  log "保留现有远程访问配置（修复重装不改 Caddy/Authelia）"
else
  GATEWAY_PORT="$PORT" GATEWAY_UNIT="$SERVICE_NAME" ENV_FILE="$ENV_FILE" \
    bash "$INSTALL_DIR/deploy/setup-edge.sh" \
    || log "(远程访问配置未完成，可稍后运行: bash $INSTALL_DIR/deploy/setup-edge.sh)"
fi

cat <<EOF

安装完成。
  ▸ 立即使用:  http://127.0.0.1:${PORT}
  ▸ 管理命令:  ${COMMAND_PATH}（已绑定服务 ${SERVICE_NAME}）
  ▸ 远程访问:  见上方远程访问向导输出（系统级变更: sudo codex-harness edge）
               ——网关仅监听回环地址且启用 token 认证（~/.codex/gateway-token），
                 远程访问仍须走 TLS 反代 + 登录鉴权，绝不可直接暴露端口
  ▸ 日常维护:  优先在网页「设置 → 服务器管理」完成（切模型源 / 一键同步 / 重启 / 日志）
  ▸ 服务管理:  systemctl {status|restart} ${SERVICE_NAME}；日志: journalctl -u ${SERVICE_NAME} -f
  ▸ 升级:      sudo ${COMMAND_PATH} update（Git 检出可升级应用、CLI 和系统辅助文件）
EOF
