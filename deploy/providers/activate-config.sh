#!/usr/bin/env bash
# Config-set switcher: each provider mode owns a fully self-contained set at
#   <CODEX_HOME>/providers/<mode>/{config.toml,models.json}
# and ~/.codex/config.toml is a SYMLINK to the active set. Switching modes =
# repointing the link — no in-place edits, no per-pair strip logic, adding a
# provider later costs one directory and nothing else.
#
#   activate-config.sh <mode>            # activate <mode>'s set (must exist)
#   activate-config.sh openai            # native mode: remove the link
#   activate-config.sh absorb-and-link <mode> <file>
#                                       # migration: seed <mode>'s set from a
#                                       # legacy config.toml, then activate
set -euo pipefail
CH="${CODEX_HOME:-$HOME/.codex}"
LIVE="$CH/config.toml"
PROV_DIR="$CH/providers"
log() { echo "[activate] $*"; }

MODE="${1:-}"
case "$MODE" in
  openai)
    if [ -L "$LIVE" ]; then
      rm "$LIVE"
      log "已切回 OpenAI 原生模式（移除配置软链，零配置文件）"
    elif [ -f "$LIVE" ]; then
      mkdir -p "$PROV_DIR/_pre-switching"
      BAK="$PROV_DIR/_pre-switching/config.$(date +%s).toml"
      mv "$LIVE" "$BAK"
      log "原有 config.toml 已备份到 $BAK；OpenAI 原生模式为零配置文件"
    else
      log "已是 OpenAI 原生模式（无 config.toml）"
    fi
    ;;
  absorb-and-link)
    MODE2="${2:?mode required}"
    SRC="${3:?legacy config file required}"
    SET_DIR="$PROV_DIR/$MODE2"
    mkdir -p "$SET_DIR"
    if [ ! -f "$SET_DIR/config.toml" ] && [ -f "$SRC" ]; then
      cp "$SRC" "$SET_DIR/config.toml"
      log "legacy 配置已吸收为 $MODE2 配置集基础"
    fi
    exec bash "$0" "$MODE2"
    ;;
  *)
    SET_FILE="$PROV_DIR/$MODE/config.toml"
    [ -f "$SET_FILE" ] || { echo "[activate] ERROR: 配置集不存在: $SET_FILE（先运行该模式的 setup.sh）" >&2; exit 1; }
    mkdir -p "$PROV_DIR"
    if [ -f "$LIVE" ] && [ ! -L "$LIVE" ]; then
      # Pre-set-switching era config: back it up, never silently destroy.
      mkdir -p "$PROV_DIR/_pre-switching"
      mv "$LIVE" "$PROV_DIR/_pre-switching/config.$(date +%s).toml"
      log "检测到非软链的存量 config.toml，已备份到 providers/_pre-switching/"
    fi
    if [ -L "$LIVE" ] || [ -e "$LIVE" ]; then rm -f "$LIVE"; fi
    if ln -s "$SET_FILE" "$LIVE" 2>/dev/null; then
      log "已激活 $MODE 配置集（软链 → $SET_FILE）"
    else
      # Filesystem without symlinks: fall back to a copy (edits to the live
      # file then won't persist into the set — re-run setup to refresh).
      cp "$SET_FILE" "$LIVE"
      log "已激活 $MODE 配置集（复制方式，文件系统不支持软链）"
    fi
    ;;
esac
