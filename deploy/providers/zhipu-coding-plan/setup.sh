#!/usr/bin/env bash
# One-shot Zhipu Coding Plan setup: model-source config + all four MCP servers
# (web-search-prime / web-reader / zread via the streamable-http bridge, plus
# the zai vision server), each with the compatibility fixes this repo needed.
#
# Guided flow: fetches the live model catalog from the Coding Plan endpoint,
# lets you pick a model (interactive), and stages config + catalog. Checking
# declared thinking levels with paid requests requires PROBE_REASONING=1.
#
# Prereq: your Coding Plan key in $ENV_FILE (default $CODEX_HOME/secrets.env):
#   Z_AI_API_KEY=xxxxx
# Unattended overrides: ZHIPU_MODEL=<slug> (default glm-5.3 when present).
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CATALOG_LIMITS="$SCRIPT_DIR/../catalog_limits.py"
unset PYTHONHOME
export PYTHONPATH="$SCRIPT_DIR/.." PYTHONSAFEPATH=1 PYTHONNOUSERSITE=1
if [ "${HARNESS_PROVIDER_TRANSACTION:-0}" != "1" ]; then
  exec python3 -I "$SCRIPT_DIR/../provider_transaction.py" zhipu "$0" "$@"
fi
ENV_FILE="${ENV_FILE:-${CODEX_HOME:-$HOME/.codex}/secrets.env}"
CH="${CODEX_HOME:-$HOME/.codex}"
# This script runs inside a private candidate generation. All writes below
# target the candidate set; the outer transaction publishes one active pointer
# only after every configuration step succeeds and the whole set validates.
SET_DIR="$CH/providers/zhipu"
CONFIG="$SET_DIR/config.toml"
LIVE="$CH/config.toml"
CATALOG_URL="https://open.bigmodel.cn/api/v1/models"
RESPONSES_URL="https://open.bigmodel.cn/api/v1/responses"

log() { echo "[zhipu-setup] $*"; }
die() { echo "[zhipu-setup] ERROR: $*" >&2; exit 1; }

# WebUI/CLI may supply a replacement key. Persist it atomically in the one
# canonical secret store; never pass it as argv or print it.
if [ -n "${ZHIPU_KEY:-}" ]; then
  ZHIPU_KEY="$ZHIPU_KEY" ENV_FILE="$ENV_FILE" python3 - <<'PY'
import os, tempfile
path = os.environ["ENV_FILE"]
key = os.environ["ZHIPU_KEY"]
if not key or len(key) > 16384 or any(ord(c) < 32 or ord(c) == 127 for c in key):
    raise SystemExit("invalid ZHIPU_KEY")
os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
old = []
try:
    old_stat = os.stat(path)
    with open(path, encoding="utf-8") as f: old = f.read().splitlines()
except FileNotFoundError:
    old_stat = None
    pass
lines = [line for line in old if not line.startswith("Z_AI_API_KEY=")]
quoted = '"' + key.replace('\\', '\\\\').replace('"', '\\"') + '"'
lines.append("Z_AI_API_KEY=" + quoted)
fd, tmp = tempfile.mkstemp(prefix=".codex-harness-env-", dir=os.path.dirname(path) or ".", text=True)
try:
    os.fchmod(fd, 0o600)
    if old_stat is not None: os.fchown(fd, old_stat.st_uid, old_stat.st_gid)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n"); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, path)
finally:
    try: os.unlink(tmp)
    except FileNotFoundError: pass
PY
fi

if [ ! -f "$ENV_FILE" ] || ! grep -q '^Z_AI_API_KEY=.\+' "$ENV_FILE"; then
  cat >&2 <<EOF
请先在 $ENV_FILE 里填入智谱 Coding Plan Key：
  Z_AI_API_KEY=你的Key
EOF
  exit 1
fi

mkdir -p "$SET_DIR"
KEY="$(python3 - "$ENV_FILE" <<'PY'
import shlex, sys
for line in open(sys.argv[1], encoding="utf-8"):
    if line.startswith("Z_AI_API_KEY="):
        raw = line.split("=", 1)[1].strip()
        values = shlex.split(raw, posix=True)
        if len(values) == 1: print(values[0])
PY
)"
case "$KEY" in *$'\n'*|*$'\r'*) echo "[zhipu-setup] ERROR: Z_AI_API_KEY 含控制字符" >&2; exit 1 ;; esac
KEY="$KEY" python3 -c 'import os; v=os.environ["KEY"]; raise SystemExit(0 if 0 < len(v) <= 16384 and not any(ord(c)<32 or ord(c)==127 for c in v) else 1)' \
  || { echo "[zhipu-setup] ERROR: Z_AI_API_KEY 为空、过长或含控制字符" >&2; exit 1; }

# curl accepts a header file on stdin. Keep the bearer value out of
# /proc/<pid>/cmdline while retaining normal curl exit/status behavior.
zhipu_curl() {
  printf 'Authorization: Bearer %s\n' "$KEY" | curl -H @- "$@"
}
# Migration: a pre-set-switching single config.toml seeds this set once
# (activate-config.sh backs the original up when repointing the link).
if [ ! -f "$CONFIG" ] && [ -f "$LIVE" ] && [ ! -L "$LIVE" ]; then
  cp "$LIVE" "$CONFIG"
  log "检测到旧式单文件配置，已吸收为本模式配置集的基础"
fi

# --- 1) live model catalog ----------------------------------------------------
log "获取模型列表..."
CATALOG_DOWNLOAD="$(mktemp /tmp/codex-harness-catalog-download.XXXXXX.json)"
CATALOG_TMP="$(mktemp /tmp/codex-harness-catalog.XXXXXX.json)"
trap 'rm -f "$CATALOG_DOWNLOAD" "$CATALOG_TMP"' EXIT
if zhipu_curl -sf --max-time 20 --max-filesize 1048576 "$CATALOG_URL" -o "$CATALOG_DOWNLOAD" 2>/dev/null \
   && python3 "$CATALOG_LIMITS" normalize-zhipu "$CATALOG_DOWNLOAD" "$CATALOG_TMP" 2>/dev/null; then
  log "已获取在线模型目录"
else
  if [ "${ZHIPU_SYNC_CATALOG:-0}" = "1" ]; then
    log "在线目录刷新失败；当前活动目录、配置和密钥均保持不变，未请求重启"
    exit 1
  fi
  python3 "$CATALOG_LIMITS" normalize-zhipu "$SCRIPT_DIR/models.json" "$CATALOG_TMP" \
    || die "内置离线模型目录无效或超过安全上限"
  log "首次配置无法获取在线目录——使用内置离线目录（不是成功刷新）"
fi
CATALOG_SRC="$CATALOG_TMP"

# --- 2) pick a model ----------------------------------------------------------
MODEL="${ZHIPU_MODEL:-}"
MODEL_EFFORT="max"
MODEL_LEVELS=""
pick_model() {
  python3 - "$CATALOG_SRC" "$MODEL" <<'PY'
import re, sys
from catalog_limits import load_json_path, validate_models_catalog

catalog, model = sys.argv[1], sys.argv[2]
ms = validate_models_catalog(load_json_path(catalog))["models"]
if not model:
    model = "glm-5.3" if any(m.get("slug") == "glm-5.3" for m in ms) else ms[0]["slug"]
entry = next((m for m in ms if m.get("slug") == model), None)
if entry is None:
    sys.stderr.write(f"模型 {model} 不在目录里；可用: {', '.join(m.get('slug','?') for m in ms)}\n")
    sys.exit(1)
levels = [l["effort"] for l in entry.get("supported_reasoning_levels", []) if isinstance(l, dict) and l.get("effort")]
effort = entry.get("default_reasoning_level", "max")
if not isinstance(model, str) or not 0 < len(model) <= 256 or any(ord(c) < 32 or ord(c) == 127 for c in model):
    raise SystemExit("invalid model id in catalog")
if not isinstance(effort, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", effort):
    raise SystemExit("invalid default reasoning level in catalog")
levels = [level for level in levels if isinstance(level, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,31}", level)]
print(effort)
print(" ".join(levels))
print(model)
PY
}
if [ "${ZHIPU_SYNC_CATALOG:-0}" != "1" ] && [ -t 0 ] && python3 -c 'import sys;from catalog_limits import load_json_path,validate_models_catalog;ms=validate_models_catalog(load_json_path(sys.argv[1]))["models"];exit(0 if ms else 1)' "$CATALOG_SRC"; then
  # show the list, let the user pick by number
  mapfile -t SLUGS < <(python3 -c 'import sys;from catalog_limits import load_json_path,validate_models_catalog;print("\n".join(m["slug"] for m in validate_models_catalog(load_json_path(sys.argv[1]))["models"]))' "$CATALOG_SRC")
  echo "Coding Plan 提供以下模型："
  for i in "${!SLUGS[@]}"; do echo "  $((i+1))  ${SLUGS[$i]}"; done
  DEFAULT_IDX=1
  for i in "${!SLUGS[@]}"; do [ "${SLUGS[$i]}" = "glm-5.3" ] && DEFAULT_IDX=$((i+1)); done
  read -r -p "选择模型（输入序号，或直接输入模型 id） [$DEFAULT_IDX]: " pick || true
  if [ -n "$pick" ] && [ "$pick" -ge 1 ] 2>/dev/null && [ "$pick" -le "${#SLUGS[@]}" ] 2>/dev/null; then
    MODEL="${SLUGS[$((pick-1))]}"
  elif [ -n "$pick" ]; then
    MODEL="$pick"
  else
    MODEL="${SLUGS[$((DEFAULT_IDX-1))]}"
  fi
  log "已选: $MODEL"
fi
if PICK_OUT="$(pick_model)"; then
  MODEL_EFFORT="$(echo "$PICK_OUT" | sed -n 1p)"
  MODEL_LEVELS="$(echo "$PICK_OUT" | sed -n 2p)"
  MODEL="$(echo "$PICK_OUT" | sed -n 3p)"
  if [ "${ZHIPU_SYNC_CATALOG:-0}" = "1" ]; then
    case " $MODEL_LEVELS " in
      *" ${ZHIPU_EFFORT:-} "*) MODEL_EFFORT="$ZHIPU_EFFORT" ;;
      *) log "当前思考档位不在刷新目录中，未提交任何更改"; exit 1 ;;
    esac
  fi
else
  die "$PICK_OUT"
fi

# --- 3) verify the model's declared thinking levels against the endpoint ------
if [ -n "$MODEL_LEVELS" ] && [ "${PROBE_REASONING:-0}" = "1" ]; then
  log "将发送思考档位的真实 API 探测请求（可能计费）"
  VERIFIED=""
  for E in $MODEL_LEVELS; do
    PAYLOAD="$(python3 -c 'import json,sys; print(json.dumps({"model":sys.argv[1],"input":"ping","reasoning":{"effort":sys.argv[2]},"max_output_tokens":16}))' "$MODEL" "$E")"
    CODE="$(zhipu_curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$RESPONSES_URL" \
      -H 'Content-Type: application/json' \
      -d "$PAYLOAD" 2>/dev/null || echo 000)"
    if [ "$CODE" = "200" ]; then VERIFIED="$VERIFIED $E"; fi
  done
  # shellcheck disable=SC2086
  VERIFIED=$(echo $VERIFIED)
  if [ -n "$VERIFIED" ]; then
    log "思考档位探测（$MODEL）: $VERIFIED"
    case " $VERIFIED " in
      *" $MODEL_EFFORT "*) ;;
      *) MODEL_EFFORT="$(printf '%s' "$VERIFIED" | awk '{print $1}')"; log "默认档不在探测结果内，改用 $MODEL_EFFORT" ;;
    esac
  else
    log "探测失败——沿用目录声明的档位（$MODEL_LEVELS）"
  fi
elif [ -z "$MODEL_LEVELS" ]; then
  log "该模型未声明思考档位（无 reasoning levels）"
else
  log "跳过付费思考档位探测；使用目录声明（设置 PROBE_REASONING=1 可显式探测）"
fi

# --- 4) write config + catalog -------------------------------------------------
# fresh: from template; existing: force-write this mode's model keys (switching
# from other providers keeps the rest of the user's config).
python3 - "$CONFIG" "$SCRIPT_DIR" "$MODEL" "$MODEL_EFFORT" <<'PY'
import os, sys

config, script_dir, model, effort = sys.argv[1:5]
from toml_config import load_config, save_config
source = config if os.path.exists(config) else os.path.join(script_dir, "config.toml.example")
data = load_config(source)
data.update({
    "model": model,
    "model_provider": "ZAI",
    "model_reasoning_effort": effort,
    "model_catalog_json": os.path.join(os.path.dirname(os.path.abspath(config)), "models.json"),
})
data["model_providers"] = {
    "ZAI": {
        "name": "Zhipu Coding Plan",
        "base_url": "https://open.bigmodel.cn/api/v1",
        "env_key": "Z_AI_API_KEY",
        "wire_api": "responses",
    }
}
save_config(config, data)
print("[zhipu-setup] 模型源键已写入候选配置集")
PY
log "模型源已切换为智谱（$MODEL），其它用户配置保留"
VERIFIED="${VERIFIED:-}" python3 - "$CATALOG_SRC" "$(dirname "$CONFIG")/models.json" "$MODEL" "$MODEL_EFFORT" <<'PY'
import os, sys
from atomic_write import atomic_write
from catalog_limits import dump_json_limited, load_json_path, validate_models_catalog
catalog = validate_models_catalog(load_json_path(sys.argv[1]))
verified = os.environ.get("VERIFIED", "").split()
for entry in catalog["models"]:
    if entry.get("slug") == sys.argv[3]:
        entry["default_reasoning_level"] = sys.argv[4]
        if verified:
            entry["supported_reasoning_levels"] = [
                level for level in entry.get("supported_reasoning_levels", [])
                if isinstance(level, dict) and level.get("effort") in verified
            ]
validate_models_catalog(catalog)
atomic_write(sys.argv[2], dump_json_limited(catalog, indent=2))
PY

# feature 开关（幂等）：[features] mcp_2026_07_28 = true
python3 - "$CONFIG" <<'PY'
import sys
config = sys.argv[1]
# Ensure the feature in its actual table, including inline/dotted forms.
from toml_config import load_config, save_config, table
data = load_config(config)
table(data, "features")["mcp_2026_07_28"] = True
save_config(config, data)
print("[zhipu-setup] feature mcp_2026_07_28 已开启")
PY

# --- 5) MCP 服务器（写入本模式配置集）-------------------------------------------
CONFIG="$CONFIG" bash "$SCRIPT_DIR/setup-http-mcp.sh"
CONFIG="$CONFIG" bash "$SCRIPT_DIR/setup-zai-mcp.sh"

chmod 600 "$CONFIG" "$(dirname "$CONFIG")/models.json" 2>/dev/null || true

bash "$SCRIPT_DIR/../activate-config.sh" zhipu
log "完成。重启服务生效：sudo systemctl restart codex-harness"
log "付费验收（仅显式启用）：HARNESS_ALLOW_PAID_TESTS=1 node $SCRIPT_DIR/../../verify-mcp-tools.mjs"
