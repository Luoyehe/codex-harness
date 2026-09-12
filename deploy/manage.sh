#!/usr/bin/env bash
# Codex Harness WebUI — unified interactive management entry.
#
#   bash manage.sh                 # interactive menu
#   bash manage.sh <command>       # direct: install provider edge status
#                                 #           restart logs verify reinstall
#                                 #           uninstall update version
# Covers: first install, switching the model provider (exclusive config),
# remote access, service control, verification, reinstall (keeping or wiping
# config), and transactional update checking/application.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
# Rebuild/update commands create artefacts consumed by an unprivileged
# service. Individual secret snapshots use mktemp/explicit modes instead.
umask 022

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SERVICE_NAME="${SERVICE_NAME:-codex-harness}"
case "$SERVICE_NAME" in
  ''|[-_]*|*[!A-Za-z0-9_-]*) echo "[manage] ERROR: invalid SERVICE_NAME" >&2; exit 1 ;;
esac
[ "${#SERVICE_NAME}" -le 128 ] || { echo "[manage] ERROR: SERVICE_NAME is too long" >&2; exit 1; }
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
HAD_INSTALLED_UNIT=0
[ -f "$UNIT_FILE" ] && HAD_INSTALLED_UNIT=1
ENV_FILE="${ENV_FILE:-}"

# CODEX_HOME precedence: env override > installed unit > $HOME/.codex.
# Parsing the unit matters because `sudo bash manage.sh` changes $HOME to
# /root — if the unit runs as a non-root user with a custom CODEX_HOME, the
# shell var would point at the wrong directory.
if [ -z "${CODEX_HOME:-}" ] && [ -f "$UNIT_FILE" ]; then
  UNIT_CH="$(grep -oP '(?<=Environment=CODEX_HOME=).*' "$UNIT_FILE" 2>/dev/null | head -1 || true)"
  [ -n "$UNIT_CH" ] && export CODEX_HOME="$UNIT_CH"
fi
if [ -z "$ENV_FILE" ] && [ -f "$UNIT_FILE" ]; then
  UNIT_ENV_FILE="$(grep -oP '(?<=Environment=ENV_FILE=).*' "$UNIT_FILE" 2>/dev/null | head -1 || true)"
  [ -n "$UNIT_ENV_FILE" ] && ENV_FILE="$UNIT_ENV_FILE"
fi
ENV_FILE="${ENV_FILE:-${CODEX_HOME:-$HOME/.codex}/secrets.env}"

# Port precedence: explicit PORT env override > installed unit's port > 8080.
PORT="${PORT:-}"
if [ -z "$PORT" ] && [ -f "$UNIT_FILE" ]; then
  DETECTED_PORT="$(grep -oP '(?<=Environment=PORT=)[0-9]+' "$UNIT_FILE" | head -1 || true)"
  [ -n "$DETECTED_PORT" ] && PORT="$DETECTED_PORT"
fi
PORT="${PORT:-8080}"
case "$PORT" in ''|*[!0-9]*) echo "[manage] ERROR: PORT must be an integer" >&2; exit 1 ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || { echo "[manage] ERROR: PORT must be between 1 and 65535" >&2; exit 1; }

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

# Recover only named runtime paths, never source the unit or secret store and
# never import an arbitrary saved PATH into a root management command.
for runtime_name in NODE_BIN TOOLS_BIN_DIR; do
  if [ -z "${!runtime_name:-}" ] && [ -f "$UNIT_FILE" ]; then
    runtime_value="$(sed -n "s/^Environment=${runtime_name}=//p" "$UNIT_FILE" | head -1)"
    [ -z "$runtime_value" ] || export "$runtime_name=$runtime_value"
  fi
done
if [ -n "${NODE_BIN:-}" ]; then
  case "$NODE_BIN" in /*) ;; *) echo '[manage] NODE_BIN must be absolute' >&2; exit 1 ;; esac
  case "$NODE_BIN" in *[!A-Za-z0-9_./@+-]*) echo '[manage] unsafe NODE_BIN' >&2; exit 1 ;; esac
  export PATH="${NODE_BIN%/*}:$PATH"
fi
if [ -n "${TOOLS_BIN_DIR:-}" ] || { [ "$HAD_INSTALLED_UNIT" = 1 ] && command -v npm >/dev/null 2>&1; }; then
  TOOLS_BIN_DIR="$(python3 "$SCRIPT_DIR/runtime_paths.py" "${TOOLS_BIN_DIR:-}")"
  export TOOLS_BIN_DIR
  export PATH="${NODE_BIN:+${NODE_BIN%/*}:}$TOOLS_BIN_DIR:$PATH"
fi

log()  { echo "[manage] $*"; }
die()  { echo "[manage] ERROR: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die "该操作需要 root（sudo bash manage.sh ...）"; }
assert_instance_checkout() {
  if [ -f "$UNIT_FILE" ] && ! grep -qxF "WorkingDirectory=$REPO_ROOT/apps/gateway" "$UNIT_FILE"; then
    die "服务 $SERVICE_NAME 不属于当前程序目录 $REPO_ROOT；请使用该实例注册的管理命令"
  fi
}

SERVICE_USER="${RUN_USER:-$(id -un)}"
id "$SERVICE_USER" >/dev/null 2>&1 || die "服务用户不存在: $SERVICE_USER"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
[ -n "$SERVICE_HOME" ] || die "无法确定服务用户 $SERVICE_USER 的 home"
run_as_service() {
  local ch="${CODEX_HOME:-$SERVICE_HOME/.codex}"
  if [ "$(id -un)" = "$SERVICE_USER" ]; then
    env HOME="$SERVICE_HOME" CODEX_HOME="$ch" PATH="$PATH" "$@"
  else
    runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" CODEX_HOME="$ch" PATH="$PATH" "$@"
  fi
}

# Resolve and reject broad filesystem roots before an explicit destructive
# reset/uninstall.  The caller still asks twice for full-reset confirmation.
safe_tree_target() {
  local resolved
  resolved="$(realpath -m -- "$1")" || die "无法解析删除目标: $1"
  case "$resolved" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/usr/local|/var|/var/cache|/var/lib|/var/log|/var/spool)
      die "拒绝递归删除过宽的系统路径: $resolved" ;;
  esac
  [ "${#resolved}" -ge 6 ] || die "拒绝递归删除可疑路径: $resolved"
  printf '%s\n' "$resolved"
}

installed() { systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; }

active_provider() {
  local cfg="${CODEX_HOME:-$HOME/.codex}/config.toml"
  python3 "$SCRIPT_DIR/lifecycle.py" provider "$cfg" || { echo "配置无法解析"; return 1; }
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
  assert_instance_checkout
  if [ "$HAD_INSTALLED_UNIT" -eq 1 ]; then
    RUN_USER="$SERVICE_USER" CODEX_HOME="${CODEX_HOME:-$SERVICE_HOME/.codex}" \
      CODEX_WORKSPACE="${CODEX_WORKSPACE:-$SERVICE_HOME/codex-workspace}" \
      PORT="$PORT" SERVICE_NAME="$SERVICE_NAME" ENV_FILE="$ENV_FILE" \
      NODE_BIN="${NODE_BIN:-}" TOOLS_BIN_DIR="${TOOLS_BIN_DIR:-}" \
      PROVIDER="${PROVIDER:-}" SKIP_EDGE_SETUP="${SKIP_EDGE_SETUP:-0}" \
      bash "$SCRIPT_DIR/install.sh"
  else
    # On a genuinely fresh root install, let install.sh select its dedicated
    # codex-harness account. Explicit exported overrides still pass through.
    PORT="$PORT" SERVICE_NAME="$SERVICE_NAME" PROVIDER="${PROVIDER:-}" \
      NODE_BIN="${NODE_BIN:-}" TOOLS_BIN_DIR="${TOOLS_BIN_DIR:-}" \
      SKIP_EDGE_SETUP="${SKIP_EDGE_SETUP:-0}" \
      bash "$SCRIPT_DIR/install.sh"
  fi
}

do_provider() {
  need_root
  assert_instance_checkout
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
      local stored_key=""
      if [ -z "$key" ] && grep -q '^Z_AI_API_KEY=.\+' "$ENV_FILE" 2>/dev/null; then
        stored_key=1
        log "使用 $ENV_FILE 中已有的 Z_AI_API_KEY"
      fi
      if [ -z "$key" ] && [ -z "$stored_key" ] && [ -t 0 ]; then
        read -r -s -p "粘贴你的智谱 Coding Plan API Key: " key; echo
      fi
      if [ -n "$key" ]; then
        ZHIPU_KEY="$key" ENV_FILE="$ENV_FILE" \
          run_as_service bash "$SCRIPT_DIR/providers/zhipu-coding-plan/setup.sh"
      elif [ -n "$stored_key" ]; then
        ENV_FILE="$ENV_FILE" run_as_service bash "$SCRIPT_DIR/providers/zhipu-coding-plan/setup.sh"
      else
        die "缺少 Key：设置 ZHIPU_KEY 或在 $ENV_FILE 填 Z_AI_API_KEY"
      fi
      ;;
    openai)
      ENV_FILE="$ENV_FILE" run_as_service bash "$SCRIPT_DIR/providers/openai/setup.sh"
      log "请通过 WebUI 右上角完成该服务账号的登录"
      ;;
    custom)
      CUSTOM_BASE_URL="${CUSTOM_BASE_URL:-}" CUSTOM_MODEL="${CUSTOM_MODEL:-}" \
        CUSTOM_API_KEY="${CUSTOM_API_KEY:-}" CUSTOM_CTX="${CUSTOM_CTX:-}" ENV_FILE="$ENV_FILE" \
        run_as_service bash "$SCRIPT_DIR/providers/custom-openai/setup.sh"
      ;;
    *) die "未知供应商: $target（可选 zhipu|openai|custom）" ;;
  esac
  run_as_service test -r "${CODEX_HOME:-$SERVICE_HOME/.codex}" \
    || die "provider setup left CODEX_HOME unreadable by $SERVICE_USER"
  systemctl restart "$SERVICE_NAME" && log "已重启 $SERVICE_NAME，当前模型源: $(active_provider)"
}

do_edge() {
  need_root
  assert_instance_checkout
  local action="${1:-configure}"
  if [ "$action" = "disable" ]; then
    EDGE_ACTION=disable GATEWAY_PORT="$PORT" GATEWAY_UNIT="$SERVICE_NAME" ENV_FILE="$ENV_FILE" \
      bash "$SCRIPT_DIR/setup-edge.sh"
  else
    GATEWAY_PORT="$PORT" GATEWAY_UNIT="$SERVICE_NAME" ENV_FILE="$ENV_FILE" \
      bash "$SCRIPT_DIR/setup-edge.sh"
  fi
}

do_restart() {
  need_root
  assert_instance_checkout
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
  if [ "${HARNESS_ALLOW_PAID_TESTS:-0}" = 1 ] && active_provider | grep -q zhipu; then
    echo "--- MCP 真实任务验证（智谱预设）---"
    GATEWAY_WS="ws://127.0.0.1:${PORT}/ws" node "$SCRIPT_DIR/verify-mcp-tools.mjs" || rc=1
  fi
  return $rc
}

do_reinstall() {
  need_root
  assert_instance_checkout
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
      PROVIDER=skip SKIP_EDGE_SETUP=1 do_install
      ;;
    full)
      echo "⚠️  完全重置将删除：${CODEX_HOME:-$HOME/.codex}（配置+会话+附件）、$ENV_FILE、服务单元"
      local confirm1 confirm2
      read -r -p "输入 yes 确认: " confirm1 || true
      [ "$confirm1" = "yes" ] || die "已取消"
      read -r -p "再次输入 yes 确认清空一切: " confirm2 || true
      [ "$confirm2" = "yes" ] || die "已取消"
      local codex_tree
      codex_tree="$(safe_tree_target "${CODEX_HOME:-$HOME/.codex}")"
      if ! EDGE_ACTION=disable GATEWAY_PORT="$PORT" GATEWAY_UNIT="$SERVICE_NAME" ENV_FILE="$ENV_FILE" \
        bash "$SCRIPT_DIR/setup-edge.sh"; then
        log "警告：远程站点清理失败；继续重置前请检查 Caddy/Authelia 配置"
      fi
      systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
      rm -f "$UNIT_FILE"
      rm -rf -- "$codex_tree"
      rm -f "$ENV_FILE"
      systemctl daemon-reload || true
      log "已请求移除本项目的远程站点块；共享的 Caddy/Authelia 安装与其它站点不受影响"
      log "已清空，开始重新安装"
      do_install
      ;;
    *) die "未知重装模式: $mode（可选 repair|full）" ;;
  esac
}

do_uninstall() {
  need_root
  assert_instance_checkout
  # Registered by install.sh (BIN_DIR override supported for both sides).
  local command_name="codex-harness-$SERVICE_NAME"
  [ "$SERVICE_NAME" != codex-harness ] || command_name=codex-harness
  local command_path="${BIN_DIR:-/usr/local/bin}/$command_name"
  local repo_tree
  repo_tree="$(safe_tree_target "$REPO_ROOT")"
  python3 "$SCRIPT_DIR/lifecycle.py" guard-delete "$repo_tree" \
    "${CODEX_HOME:-$HOME/.codex}" "$ENV_FILE" "${CODEX_WORKSPACE:-$HOME/codex-workspace}" >/dev/null \
    || die "卸载目录包含承诺保留的数据；请先迁移数据并更新该实例路径"
  cat <<EOF
卸载将【移除】：
  · systemd 服务 ${SERVICE_NAME}（停止、禁用、删除单元文件）
  · 程序代码目录：${REPO_ROOT}
  · 系统管理命令：${command_path}
卸载将【保留】：
  · 运行环境：Node / pnpm / 版本化 codex CLI / 智谱 MCP 组件（可能由其他实例共享，不自动删除）
  · codex 用户数据：${CODEX_HOME:-$HOME/.codex}（全部会话、各模型源配置集、API 密钥、网关 token）
  · 服务环境文件：${ENV_FILE}（含 API Key——保留它，以后重装无需重新填写）
  · 工作区与项目目录：${CODEX_WORKSPACE:-$HOME/codex-workspace}
  · Caddy / Authelia 软件及其它站点（仅移除本项目 marker 包围的站点块）
EOF
  local confirm
  read -r -p "输入 yes 确认卸载: " confirm || true
  [ "$confirm" = "yes" ] || die "已取消"
  if ! EDGE_ACTION=disable GATEWAY_PORT="$PORT" GATEWAY_UNIT="$SERVICE_NAME" ENV_FILE="$ENV_FILE" \
    bash "$SCRIPT_DIR/setup-edge.sh"; then
    log "警告：未能自动清理远程站点，请人工检查 Caddy/Authelia 配置"
  fi
  local legacy_helper=0
  grep -qxF 'Environment=CODEX_HARNESS_ADMIN_HELPER=/usr/local/libexec/codex-harness-admin' "$UNIT_FILE" 2>/dev/null \
    && legacy_helper=1
  systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  if grep -qxF "# Managed instance: $SERVICE_NAME" "$command_path" 2>/dev/null; then
    rm -f "$command_path"
  else
    log "管理命令不属于本实例或已被修改，保留: $command_path"
  fi
  rm -f "/usr/local/libexec/codex-harness-admin-${SERVICE_NAME}" \
    "/etc/codex-harness/${SERVICE_NAME}.conf" "/etc/sudoers.d/codex-harness-${SERVICE_NAME}"
  if [ "$legacy_helper" -eq 1 ]; then
    # Old releases used one shared helper. Remove it only after this unit has
    # gone and no other service still names that exact legacy path.
    if ! grep -lxF 'Environment=CODEX_HARNESS_ADMIN_HELPER=/usr/local/libexec/codex-harness-admin' \
        /etc/systemd/system/*.service >/dev/null 2>&1; then
      rm -f /usr/local/libexec/codex-harness-admin /etc/codex-harness/admin.conf /etc/sudoers.d/codex-harness
    else
      log "旧版共享管理 helper 仍被其他服务引用，已保留"
    fi
  fi
  rmdir /etc/codex-harness 2>/dev/null || true
  systemctl daemon-reload || true
  cd /
  rm -rf -- "$repo_tree"
  echo "[manage] 卸载完成。浏览器将无法再访问本服务；所有会话与密钥仍保留在 ${CODEX_HOME:-$HOME/.codex}。"
  echo "[manage] 以后重新部署：git clone https://github.com/Luoyehe/codex-harness && ./deploy/install.sh"
  exit 0
}

health_after_update() {
  local attempt=0
  while [ "$attempt" -lt 20 ]; do
    attempt=$((attempt + 1))
    if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null \
      | node -e 'try { const v = JSON.parse(require("node:fs").readFileSync(0, "utf8")); process.exit(v.ok === true && v.codexState === "ready" ? 0 : 1); } catch { process.exit(1); }'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

do_update() {
  need_root
  assert_instance_checkout
  if [ ! -d "$REPO_ROOT/.git" ]; then
    log "当前部署不是 git 检出（文件拷贝方式安装），无法自动检查更新。"
    log "获取新版本后运行: bash $SCRIPT_DIR/manage.sh reinstall repair"
    return 0
  fi
  exec 8>"$REPO_ROOT/.git/codex-harness-update.lock"
  flock -n 8 || die "另一个更新事务正在运行"
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
  git -C "$REPO_ROOT" --no-pager log --oneline "HEAD..${remote_ref}" | sed -n '1,15p'
  local apply="${UPDATE:-}"
  if [ -z "$apply" ] && [ -t 0 ]; then
    read -r -p "拉取并重建（自动重启服务）? [y/N]: " apply || apply=n
  fi
  case "$apply" in
    y|Y|yes|YES)
      # EXIT must run before do_update's local transaction context unwinds.
      # Keeping the transaction in an inner subshell also prevents its trap
      # from leaking into the interactive management menu.
      (
      [ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] || die "工作树有本地改动；为避免覆盖，拒绝自动更新"
      git -C "$REPO_ROOT" merge-base --is-ancestor "$local_ref" "$remote_ref" \
        || die "远端不是当前版本的快进后继；拒绝自动改写历史"
      local stage_root stage
      stage_root="$(mktemp -d)"
      stage="$stage_root/worktree"
      local snapshot="$stage_root/previous"
      local applying=0 was_active=0
      local command_name="codex-harness-$SERVICE_NAME"
      [ "$SERVICE_NAME" != codex-harness ] || command_name=codex-harness
      local -a system_files=(
        "$UNIT_FILE"
        "/usr/local/libexec/codex-harness-admin-$SERVICE_NAME"
        "/etc/codex-harness/$SERVICE_NAME.conf"
        "/etc/sudoers.d/codex-harness-$SERVICE_NAME"
        "${BIN_DIR:-/usr/local/bin}/$command_name"
        "${BIN_DIR:-/usr/local/bin}/codex-harness"
        /usr/local/libexec/codex-harness-admin
        /etc/codex-harness/admin.conf
        /etc/sudoers.d/codex-harness
      )
      local -a artifacts=(node_modules apps/gateway/node_modules apps/web/node_modules apps/gateway/dist apps/web/dist)
      cleanup_update_stage() {
        local status=$?
        local rollback_failed=0
        trap - EXIT
        if [ "$applying" -eq 1 ]; then
          # An incomplete publication must never be reported as success, even
          # if a future early-exit path accidentally uses status zero.
          [ "$status" -ne 0 ] || status=1
          log "更新失败，恢复已保存的应用产物和系统文件…"
          set +e
          git -C "$REPO_ROOT" reset --hard "$local_ref" || rollback_failed=1
          local item
          for item in "${artifacts[@]}"; do
            rm -rf -- "${REPO_ROOT:?}/${item:?}" || rollback_failed=1
            if [ -e "$snapshot/artifacts/$item" ]; then
              mkdir -p "$(dirname "$REPO_ROOT/$item")" || rollback_failed=1
              cp -a "$snapshot/artifacts/$item" "$REPO_ROOT/$item" || rollback_failed=1
            fi
          done
          for item in "${system_files[@]}"; do
            if [ -e "$snapshot/system$item" ] || [ -L "$snapshot/system$item" ]; then
              cp -a --remove-destination "$snapshot/system$item" "$item" || rollback_failed=1
            else
              rm -f -- "$item" || rollback_failed=1
            fi
          done
          systemctl daemon-reload || rollback_failed=1
          if [ "$was_active" -eq 1 ]; then
            systemctl restart "$SERVICE_NAME" || rollback_failed=1
            health_after_update || rollback_failed=1
          else
            systemctl stop "$SERVICE_NAME" || rollback_failed=1
          fi
        fi
        if [ "$rollback_failed" = 1 ]; then
          log "自动恢复未完成；旧产物和系统文件保留在 $snapshot，请先人工恢复再清理"
          exit "$status"
        fi
        git -C "$REPO_ROOT" worktree remove --force "$stage" >/dev/null 2>&1 || true
        rm -rf -- "$stage_root"
        exit "$status"
      }
      trap cleanup_update_stage EXIT
      git -C "$REPO_ROOT" worktree add --detach "$stage" "$remote_ref" >/dev/null
      log "在隔离工作树中安装、测试、审计并构建候选版本…"
      (
        cd "$stage"
        pnpm install --frozen-lockfile
        pnpm typecheck
        pnpm test
        pnpm build
        node scripts/release-audit.mjs .
      )
      local candidate_version candidate_cli
      candidate_version="$(sed -n 's/^CODEX_VERSION="\([^"]*\)".*/\1/p' "$stage/deploy/install.sh")"
      [[ "$candidate_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "候选版本缺少有效 CLI 版本"
      candidate_cli="$(bash "$stage/deploy/install-runtime.sh" "$candidate_version")"
      # Smoke the candidate CLI and app together without production credentials.
      CODEX_BIN="$candidate_cli" node "$stage/scripts/gateway-smoke.mjs"
      [ "$(git -C "$REPO_ROOT" rev-parse HEAD)" = "$local_ref" ] \
        && [ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] \
        || die "验证期间工作树发生变化；未应用更新"
      mkdir -p "$snapshot/system" "$snapshot/artifacts"
      local item
      for item in "${system_files[@]}"; do
        if [ -e "$item" ] || [ -L "$item" ]; then
          mkdir -p "$snapshot/system$(dirname "$item")"
          cp -a "$item" "$snapshot/system$item"
        fi
      done
      for item in "${artifacts[@]}"; do
        if [ -e "$REPO_ROOT/$item" ]; then
          mkdir -p "$snapshot/artifacts/$(dirname "$item")"
          cp -a "$REPO_ROOT/$item" "$snapshot/artifacts/$item"
        fi
      done
      systemctl is-active --quiet "$SERVICE_NAME" && was_active=1
      applying=1
      systemctl stop "$SERVICE_NAME"
      git -C "$REPO_ROOT" merge --ff-only "$remote_ref" >/dev/null
      # Publish the exact tested dependency/build trees. Rollback restores the
      # saved trees without requiring npm access or another successful build.
      for item in "${artifacts[@]}"; do
        rm -rf -- "${REPO_ROOT:?}/${item:?}"
        if [ -e "$stage/$item" ]; then cp -a "$stage/$item" "$REPO_ROOT/$item"; fi
      done
      SERVICE_NAME="$SERVICE_NAME" RUN_USER="$SERVICE_USER" INSTALL_DIR="$REPO_ROOT" \
        CODEX_HOME="${CODEX_HOME:-$SERVICE_HOME/.codex}" CODEX_WORKSPACE="${CODEX_WORKSPACE:-$SERVICE_HOME/codex-workspace}" \
        ENV_FILE="$ENV_FILE" CODEX_BIN="$candidate_cli" PORT="$PORT" \
        NODE_BIN="${NODE_BIN:-$(command -v node)}" TOOLS_BIN_DIR="${TOOLS_BIN_DIR:-}" \
        bash "$SCRIPT_DIR/register-service.sh"
      systemctl daemon-reload
      systemctl restart "$SERVICE_NAME"
      health_after_update
      applying=0
      log "更新完成（应用、CLI 和系统辅助文件）: $(git -C "$REPO_ROOT" log -1 --format='%h %s')"
      git -C "$REPO_ROOT" worktree remove --force "$stage" >/dev/null 2>&1 || true
      rm -rf -- "$stage_root"
      trap - EXIT
      )
      ;;
    *)
      log "已跳过。稍后可再次运行: sudo codex-harness update"
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
  edge)     shift; do_edge "${1:-configure}" ;;
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
