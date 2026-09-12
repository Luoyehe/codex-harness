#!/usr/bin/env bash
# Config-set switcher: each provider mode owns a fully self-contained set at
#   <CODEX_HOME>/providers/<mode>/{config.toml,models.json}
# Public config, provider sets and EnvironmentFile traverse one .active link.
# This script edits only a private candidate; provider_transaction.py validates
# and publishes its complete generation after this script succeeds.
#
#   activate-config.sh <mode>            # activate <mode>'s set (must exist)
#   activate-config.sh openai            # native defaults: empty managed config
#   activate-config.sh absorb-and-link <mode> <file>
#                                       # migration: seed <mode>'s set from a
#                                       # legacy config.toml, then activate
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="$SCRIPT_DIR${PYTHONPATH:+:$PYTHONPATH}"
CH="${CODEX_HOME:-$HOME/.codex}"
LIVE="$CH/config.toml"
PROV_DIR="$CH/providers"
log() { echo "[activate] $*"; }

archive_legacy() {
  local source="$1" destination="$2" remove_source="${3:-1}"
  python3 - "$source" "$destination" "$remove_source" <<'PY'
import os, sys
from toml_config import archive_config
source, destination = sys.argv[1:3]
archive_config(source, destination)
if sys.argv[3] == "1": os.unlink(source)
PY
}

MODE="${1:-}"
case "$MODE" in openai|custom|zhipu|absorb-and-link) ;; *) echo "[activate] ERROR: invalid provider mode" >&2; exit 1 ;; esac
if [ "${HARNESS_PROVIDER_TRANSACTION:-0}" != "1" ]; then
  TRANSACTION_MODE="$MODE"
  if [ "$MODE" = "absorb-and-link" ]; then TRANSACTION_MODE="${2:?mode required}"; fi
  exec python3 "$SCRIPT_DIR/provider_transaction.py" "$TRANSACTION_MODE" "$0" "$@"
fi
case "$MODE" in
  openai)
    if [ -L "$LIVE" ]; then
      rm "$LIVE"
      log "候选配置已恢复 OpenAI 原生默认值（事务提交时保留公共软链）"
    elif [ -f "$LIVE" ]; then
      mkdir -p "$PROV_DIR/_pre-switching"
      BAK="$PROV_DIR/_pre-switching/config.$(date +%s).toml"
      archive_legacy "$LIVE" "$BAK"
      log "原有 config.toml 已脱敏备份到 $BAK；候选配置已恢复 OpenAI 原生默认值"
    else
      log "候选配置已是 OpenAI 原生默认值"
    fi
    ;;
  absorb-and-link)
    MODE2="${2:?mode required}"
    case "$MODE2" in custom|zhipu) ;; *) echo "[activate] ERROR: invalid provider mode" >&2; exit 1 ;; esac
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
      archive_legacy "$LIVE" "$PROV_DIR/_pre-switching/config.$(date +%s).toml" 0
      log "检测到非软链的存量 config.toml，已脱敏备份到 providers/_pre-switching/"
    fi
    python3 - "$SET_FILE" "$LIVE" <<'PY'
import os, sys, tempfile
source, live = sys.argv[1:3]
fd, temporary = tempfile.mkstemp(prefix=".provider-link-", dir=os.path.dirname(live))
os.close(fd)
try:
    os.unlink(temporary)
    os.symlink(os.path.abspath(source), temporary)
    os.replace(temporary, live)
finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
PY
    log "已原子激活 $MODE 配置集（软链 → $SET_FILE）"
    ;;
esac
