#!/usr/bin/env bash
# Codex Harness WebUI — unified interactive management entry.
#
#   bash manage.sh                 # interactive menu
#   bash manage.sh <command>       # direct: install provider edge status
#                                 #           restart logs verify reinstall
#                                 #           uninstall update version
# Covers: first install, switching the model provider (exclusive config),
# remote access, service control, verification, reinstall (keeping or wiping
# config), and update checking (placeholder — feature lands later).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SERVICE_NAME="${SERVICE_NAME:-codex-harness}"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_FILE="${ENV_FILE:-/etc/codex-harness.env}"

# CODEX_HOME precedence: env override > installed unit > $HOME/.codex.
# Parsing the unit matters because `sudo bash manage.sh` changes $HOME to
# /root — if the unit runs as a non-root user with a custom CODEX_HOME, the
# shell var would point at the wrong directory.
if [ -z "${CODEX_HOME:-}" ] && [ -f "$UNIT_FILE" ]; then
  UNIT_CH="$(grep -oP '(?<=Environment=CODEX_HOME=).*' "$UNIT_FILE" 2>/dev/null | head -1 || true)"
  [ -n "$UNIT_CH" ] && export CODEX_HOME="$UNIT_CH"
fi

# Port precedence: explicit PORT env override > installed unit's port > 8080.
PORT="${PORT:-}"
if [ -z "$PORT" ] && [ -f "$UNIT_FILE" ]; then
  DETECTED_PORT="$(grep -oP '(?<=Environment=PORT=)[0-9]+' "$UNIT_FILE" | head -1 || true)"
  [ -n "$DETECTED_PORT" ] && PORT="$DETECTED_PORT"
fi
PORT="${PORT:-8080}"

# Preserve the original service user and workspace across reinstall —
# without this, `sudo bash manage.sh reinstall repair` would rewrite the unit
# as root even if it originally ran as a dedicated user.
if [ -z "${RUN_USER:-}" ] && [ -f "$UNIT_FILE" ]; then
  UNIT_USER="$(grep -oP '(?<=^User=).*' "$UNIT_FILE" 2>/dev/null | head -1 || true)"
  [ -n "$UNIT_USER" ] && export RUN_USER="$UNIT_USER"
fi
if [ -z "${CODEX_WORKSPACE:-}" ] && [ -f "$UNIT_FILE" ]; then
  UNIT_WS="$(grep -oP '(?<=Environment=CODEX_WORKSPACE=).*' "$UNIT_FILE" 2>/dev/null | head -1 || true)"
  [ -n "$UNIT_WS" ] && export CODEX_WORKSPACE="$UNIT_WS"
fi

log()  { echo "[manage] $*"; }
die()  { echo "[manage] ERROR: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die "该操作需要 root（sudo bash manage.sh ...）"; }

installed() { systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; }

active_provider() {
  local cfg="${CODEX_HOME:-$HOME/.codex}/config.toml"
  if [ ! -f "$cfg" ]; then echo "openai（零配置原生模式）"; return; fi
  if grep -q '^model_provider *= *"ZAI"' "$cfg"; then echo "zhipu（智谱 Coding Plan）"
  elif grep -q '^model_provider *= *"custom"' "$cfg"; then echo "custom（自定义 OpenAI 兼容 API）"
  else echo "openai（原生模式）"; fi
}

show_status() {
  echo "=========================================="
  echo " Codex Harness WebUI 状态"
  echo "=========================================="
  echo " 服务: $SERVICE_NAME ($(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo unknown))"
  echo " 网关: http://127.0.0.1:${PORT}  $(curl -sf --max-time 3 "http://127.0.0.1:${PORT}/healthz" || echo '(未响应)')"
  echo " 当前模型源: $(active_provider)"
  if [ -d "$REPO_ROOT/.git" ]; then
    echo " 代码版本: $(git -C "$REPO_ROOT" rev-parse --short HEAD) ($(git -C "$REPO_ROOT" log -1 --format=%cd --date=short 2>/dev/null))"
  fi
  echo "=========================================="
}

do_install() {
  need_root
  bash "$SCRIPT_DIR/install.sh"
}

do_provider() {
  need_root
  local target="${1:-}"
  if [ -z "$target" ]; then
    if [ -t 0 ]; then
      echo "当前模型源: $(active_provider)"
      echo "  1) OpenAI / ChatGPT 原生（Codex 默认）"
      echo "  2) 智谱个人版 Coding Plan"
      echo "  3) 自定义 OpenAI 兼容 API（本地 vLLM/中转站）"
      read -r -p "切换到 [1/2/3]: " choice || return 0
      case "$choice" in
        2) target=zhipu ;;
        3) target=custom ;;
        *) target=openai ;;
      esac
    else
      die "用法: manage.sh provider zhipu|openai|custom"
    fi
  fi
  case "$target" in
    zhipu)
      local key="${ZHIPU_KEY:-}"
      if [ -z "$key" ] && grep -q '^Z_AI_API_KEY=.\+' "$ENV_FILE" 2>/dev/null; then
        key="$(grep -oP '(?<=^Z_AI_API_KEY=).*' "$ENV_FILE")"
        log "使用 $ENV_FILE 中已有的 Z_AI_API_KEY"
      fi
      if [ -z "$key" ] && [ -t 0 ]; then
        read -r -p "粘贴你的智谱 Coding Plan API Key: " key
      fi
      [ -n "$key" ] || die "缺少 Key：设置 ZHIPU_KEY 或在 $ENV_FILE 填 Z_AI_API_KEY"
      if ! grep -q '^Z_AI_API_KEY=.\+' "$ENV_FILE" 2>/dev/null; then
        printf 'Z_AI_API_KEY=%s\n' "$key" >> "$ENV_FILE"
        # Ensure the service user can read the env file.
        if [ -n "${RUN_USER:-}" ] && [ "$RUN_USER" != "$(id -un)" ]; then
          chown "$RUN_USER:$(id -gn "$RUN_USER")" "$ENV_FILE" 2>/dev/null || true
        fi
        chmod 600 "$ENV_FILE" 2>/dev/null || true
      fi
      ENV_FILE="$ENV_FILE" bash "$SCRIPT_DIR/providers/zhipu-coding-plan/setup.sh"
      ;;
    openai)
      bash "$SCRIPT_DIR/providers/openai/setup.sh"
      log "后续登录: codex login --device-auth（或 WebUI 右上角登录）"
      ;;
    custom)
      CUSTOM_BASE_URL="${CUSTOM_BASE_URL:-}" CUSTOM_MODEL="${CUSTOM_MODEL:-}" \
      CUSTOM_API_KEY="${CUSTOM_API_KEY:-}" CUSTOM_CTX="${CUSTOM_CTX:-}" \
        bash "$SCRIPT_DIR/providers/custom-openai/setup.sh"
      ;;
    *) die "未知供应商: $target（可选 zhipu|openai|custom）" ;;
  esac
  systemctl restart "$SERVICE_NAME" && log "已重启 $SERVICE_NAME，当前模型源: $(active_provider)"
}

do_edge() {
  need_root
  GATEWAY_PORT="$PORT" GATEWAY_UNIT="$SERVICE_NAME" ENV_FILE="$ENV_FILE" \
    bash "$SCRIPT_DIR/setup-edge.sh"
}

do_restart() {
  need_root
  systemctl restart "$SERVICE_NAME" && log "已重启 $(systemctl is-active "$SERVICE_NAME")"
}

do_logs() {
  journalctl -u "$SERVICE_NAME" -f
}

do_verify() {
  if ! installed; then log "服务未运行——验证结果可能不完整"; fi
  local rc=0
  local edge_url=""
  # When an edge (reverse proxy) host is registered, probe through it too —
  # a bare loopback pass would miss TRUSTED_HOSTS breakage ("gateway 未连接").
  local th=""
  [ -f "$ENV_FILE" ] && th="$(grep -oP '(?<=^TRUSTED_HOSTS=).*' "$ENV_FILE" 2>/dev/null | head -1 || true)"
  if [ -n "$th" ]; then
    local first="${th%%,*}"
    case "$first" in
      *:443) edge_url="https://${first%:443}" ;;
      *:*)   edge_url="https://$first" ;;
      *)     edge_url="https://$first" ;;
    esac
    log "检测到边缘配置（$first），将同时探测外网链路"
  fi
  PORT="$PORT" SERVICE_NAME="$SERVICE_NAME" EDGE_URL="$edge_url" \
    bash "$SCRIPT_DIR/verify-server.sh" || rc=1
  if active_provider | grep -q zhipu; then
    echo "--- MCP 真实任务验证（智谱预设）---"
    GATEWAY_WS="ws://127.0.0.1:${PORT}/ws" node "$SCRIPT_DIR/verify-mcp-tools.mjs" || rc=1
  fi
  return $rc
}

do_reinstall() {
  need_root
  local mode="${1:-}"
  if [ -z "$mode" ]; then
    echo "重装模式："
    echo "  1) 修复重装 —— 重建构建与服务，保留全部配置/会话/附件（推荐）"
    echo "  2) 完全重置 —— 删除配置、会话与上传，重新走安装向导（危险）"
    read -r -p "选择 [1/2]（默认 1）: " choice || choice=1
    case "$choice" in
      2) mode=full ;;
      *) mode=repair ;;
    esac
  fi
  case "$mode" in
    repair)
      log "修复重装：重建构建与服务（配置与数据不动）"
      cd "$REPO_ROOT"
      pnpm install --frozen-lockfile && pnpm build || die "构建失败"
      do_install
      ;;
    full)
      echo "⚠️  完全重置将删除：${CODEX_HOME:-$HOME/.codex}（配置+会话+附件）、$ENV_FILE、服务单元"
      local confirm1 confirm2
      read -r -p "输入 yes 确认: " confirm1 || true
      [ "$confirm1" = "yes" ] || die "已取消"
      read -r -p "再次输入 yes 确认清空一切: " confirm2 || true
      [ "$confirm2" = "yes" ] || die "已取消"
      systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
      rm -f "$UNIT_FILE"
      rm -rf "${CODEX_HOME:-$HOME/.codex}"
      rm -f "$ENV_FILE"
      systemctl daemon-reload || true
      # Caddy/Authelia edge configs are intentionally left in place (they may
      # serve other things) — but deleting the env file drops TRUSTED_HOSTS,
      # so a leftover site block would 4003 every WebSocket after reinstall.
      if [ -f /etc/caddy/Caddyfile ] && grep -q '^# codex-harness:begin' /etc/caddy/Caddyfile 2>/dev/null; then
        log "注意：检测到 Caddy 中的 codex-harness 站点块（已保留）"
        log "重装完成后请运行 manage.sh edge 重新配置远程访问（会重新注册网关信任列表），"
        log "或手动删除 Caddyfile 中 codex-harness:begin/end 标记块"
      fi
      log "已清空，开始重新安装"
      do_install
      ;;
    *) die "未知重装模式: $mode（可选 repair|full）" ;;
  esac
}

do_uninstall() {
  need_root
  cat <<EOF
卸载将【移除】：
  · systemd 服务 ${SERVICE_NAME}（停止、禁用、删除单元文件）
  · 程序代码目录：${REPO_ROOT}
卸载将【保留】：
  · 运行环境：Node / pnpm / codex CLI / 智谱 MCP 组件（如需彻底清理可自行 npm -g 卸载）
  · codex 用户数据：${CODEX_HOME:-$HOME/.codex}（全部会话、各模型源配置集、API 密钥、网关 token）
  · 服务环境文件：${ENV_FILE}（含 API Key——保留它，以后重装无需重新填写）
  · 工作区与项目目录：${CODEX_WORKSPACE:-$HOME/codex-workspace}
  · Caddy / Authelia 远程访问配置（可能同时服务其它站点，不触碰）
EOF
  case "${CODEX_WORKSPACE:-}" in
    "${REPO_ROOT}"/*) echo "⚠ 警告：工作区位于安装目录内，将随代码一起被删除——请先备份！" ;;
  esac
  local confirm
  read -r -p "输入 yes 确认卸载: " confirm || true
  [ "$confirm" = "yes" ] || die "已取消"
  systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload || true
  cd /
  rm -rf "$REPO_ROOT"
  echo "[manage] 卸载完成。浏览器将无法再访问本服务；所有会话与密钥仍保留在 ${CODEX_HOME:-$HOME/.codex}。"
  echo "[manage] 以后重新部署：git clone https://github.com/Luoyehe/codex-harness && ./deploy/install.sh"
  exit 0
}

do_update() {
  need_root
  if [ ! -d "$REPO_ROOT/.git" ]; then
    log "当前部署不是 git 检出（文件拷贝方式安装），无法自动检查更新。"
    log "获取新版本后运行: bash $SCRIPT_DIR/manage.sh reinstall repair"
    return 0
  fi
  log "检查远程更新（git fetch origin）…"
  if ! git -C "$REPO_ROOT" fetch --quiet origin; then
    log "无法访问远程仓库（网络或凭据问题）——稍后重试或手动 git fetch"
    return 0
  fi
  local local_ref remote_ref
  local_ref="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  remote_ref="$(git -C "$REPO_ROOT" rev-parse '@{u}' 2>/dev/null || true)"
  if [ -z "$remote_ref" ]; then
    remote_ref="$(git -C "$REPO_ROOT" rev-parse origin/HEAD 2>/dev/null || true)"
  fi
  if [ -z "$remote_ref" ]; then
    log "无法确定远程跟踪分支（origin/HEAD）——请检查 git remote 配置"
    return 0
  fi
  if [ "$local_ref" = "$remote_ref" ]; then
    log "已是最新版本（$(git -C "$REPO_ROOT" log -1 --format='%h %cd' --date=short)）"
    return 0
  fi
  log "发现新版本，待更新提交："
  git -C "$REPO_ROOT" --no-pager log --oneline "HEAD..${remote_ref}" | head -15
  local apply="${UPDATE:-}"
  if [ -z "$apply" ] && [ -t 0 ]; then
    read -r -p "拉取并重建（自动重启服务）? [y/N]: " apply || apply=n
  fi
  case "$apply" in
    y|Y|yes|YES)
      log "拉取更新…"
      git -C "$REPO_ROOT" pull --ff-only || { log "git pull 失败（有本地改动？）——请手动处理"; return 1; }
      log "重建…"
      cd "$REPO_ROOT"
      pnpm install --frozen-lockfile && pnpm build || { log "构建失败——请检查上方输出"; return 1; }
      systemctl restart "$SERVICE_NAME" && log "已重启 $SERVICE_NAME"
      log "更新完成: $(git -C "$REPO_ROOT" log -1 --format='%h %s')"
      ;;
    *)
      log "已跳过。手动更新: cd $REPO_ROOT && git pull && pnpm install && pnpm build && sudo systemctl restart $SERVICE_NAME"
      ;;
  esac
}

menu() {
  while true; do
    echo
    echo "======== Codex Harness WebUI 管理 ========"
    show_status
    echo "  1) 安装（首次部署 / 引导向导）"
    echo "  2) 切换模型源（当前: $(active_provider)）"
    echo "  3) 配置远程访问（SSH 隧道 / Caddy+Authelia）"
    echo "  4) 重启服务"
    echo "  5) 查看日志"
    echo "  6) 运行验证"
  echo "  7) 重装（修复 / 完全重置）"
  echo "  8) 检查更新（git 对比远程，可选拉取并重建）"
  echo "  9) 卸载（移除程序与服务；保留 codex、会话、密钥、项目）"
  echo "  0) 退出"
  read -r -p "请选择: " choice || return 0
  case "$choice" in
    1) do_install ;;
    2) do_provider ;;
    3) do_edge ;;
    4) do_restart ;;
    5) do_logs ;;
    6) do_verify ;;
    7) do_reinstall ;;
    8) do_update ;;
    9) do_uninstall ;;
      0|q|quit) return 0 ;;
      *) echo "无效选择" ;;
    esac
  done
}

case "${1:-menu}" in
  install)  do_install ;;
  provider) shift; do_provider "${1:-}" ;;
  edge)     do_edge ;;
  status)   show_status ;;
  restart)  do_restart ;;
  logs)     do_logs ;;
  verify)   do_verify ;;
  reinstall) shift; do_reinstall "${1:-}" ;;
  uninstall) do_uninstall ;;
  update|version) do_update ;;
  menu|"")  menu ;;
  *) die "未知命令: $1（可用: install provider edge status restart logs verify reinstall uninstall update）" ;;
esac
