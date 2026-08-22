#!/usr/bin/env bash
# One-shot Zhipu Coding Plan setup: model-source config + all four MCP servers
# (web-search-prime / web-reader / zread via the streamable-http bridge, plus
# the zai vision server), each with the compatibility fixes this repo needed.
#
# Guided flow: fetches the live model catalog from the Coding Plan endpoint,
# lets you pick a model (interactive), verifies the model's declared thinking
# levels against the endpoint, and writes config + catalog accordingly.
#
# Prereq: your Coding Plan key in $ENV_FILE (default /etc/codex-harness.env):
#   Z_AI_API_KEY=xxxxx
# Unattended overrides: ZHIPU_MODEL=<slug> (default glm-5.3 when present).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-/etc/codex-harness.env}"
CH="${CODEX_HOME:-$HOME/.codex}"
# Config-set layout: this mode OWNS providers/zhipu/ as a fully self-contained
# set; ~/.codex/config.toml is a symlink to it (../activate-config.sh). Every
# write below targets the SET file, never the live link — switching modes
# never edits this set.
SET_DIR="$CH/providers/zhipu"
CONFIG="$SET_DIR/config.toml"
LIVE="$CH/config.toml"
CATALOG_URL="https://open.bigmodel.cn/api/v1/models"
RESPONSES_URL="https://open.bigmodel.cn/api/v1/responses"

log() { echo "[zhipu-setup] $*"; }

if [ ! -f "$ENV_FILE" ] || ! grep -q '^Z_AI_API_KEY=.\+' "$ENV_FILE"; then
  cat >&2 <<EOF
请先在 $ENV_FILE 里填入智谱 Coding Plan Key：
  Z_AI_API_KEY=你的Key
EOF
  exit 1
fi

mkdir -p "$SET_DIR"
KEY="$(grep -oP '(?<=^Z_AI_API_KEY=).*' "$ENV_FILE")"
# Key lands in TOML strings — reject injection-capable characters (same as
# custom-openai: die, not warn, because sed/TOML corruption is silent).
case "$KEY" in
  *[!A-Za-z0-9._\-]*) echo "[zhipu-setup] ERROR: Z_AI_API_KEY 含非法字符（仅允许字母/数字/点/下划线/连字符）" >&2; exit 1 ;;
esac
# Migration: a pre-set-switching single config.toml seeds this set once
# (activate-config.sh backs the original up when repointing the link).
if [ ! -f "$CONFIG" ] && [ -f "$LIVE" ] && [ ! -L "$LIVE" ]; then
  cp "$LIVE" "$CONFIG"
  log "检测到旧式单文件配置，已吸收为本模式配置集的基础"
fi

# --- 1) live model catalog ----------------------------------------------------
log "获取模型列表..."
CATALOG_TMP="$(mktemp /tmp/codex-harness-catalog.XXXXXX.json)"
trap 'rm -f "$CATALOG_TMP"' EXIT
if curl -sf --max-time 20 "$CATALOG_URL" -H "Authorization: Bearer $KEY" -o "$CATALOG_TMP" 2>/dev/null \
   && python3 -c 'import json,sys;json.load(open(sys.argv[1]))["models"]' "$CATALOG_TMP" 2>/dev/null; then
  CATALOG_SRC="$CATALOG_TMP"
  log "已获取在线模型目录"
else
  CATALOG_SRC="$SCRIPT_DIR/models.json"
  log "在线目录获取失败——使用内置目录"
fi

# --- 2) pick a model ----------------------------------------------------------
MODEL="${ZHIPU_MODEL:-}"
MODEL_EFFORT="max"
MODEL_LEVELS=""
pick_model() {
  python3 - "$CATALOG_SRC" "$MODEL" <<'PY'
import json, sys

catalog, model = sys.argv[1], sys.argv[2]
ms = json.load(open(catalog))["models"]
if not model:
    model = "glm-5.3" if any(m.get("slug") == "glm-5.3" for m in ms) else ms[0]["slug"]
entry = next((m for m in ms if m.get("slug") == model), None)
if entry is None:
    sys.stderr.write(f"模型 {model} 不在目录里；可用: {', '.join(m.get('slug','?') for m in ms)}\n")
    sys.exit(1)
levels = [l["effort"] for l in entry.get("supported_reasoning_levels", []) if isinstance(l, dict) and l.get("effort")]
print(entry.get("default_reasoning_level", "max"))
print(" ".join(levels))
print(model)
PY
}
if [ -t 0 ] && python3 -c 'import json,sys;ms=json.load(open(sys.argv[1]))["models"];exit(0 if ms else 1)' "$CATALOG_SRC"; then
  # show the list, let the user pick by number
  mapfile -t SLUGS < <(python3 -c 'import json,sys;print("\n".join(m.get("slug","?") for m in json.load(open(sys.argv[1]))["models"]))' "$CATALOG_SRC")
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
else
  die() { echo "[zhipu-setup] ERROR: $*" >&2; exit 1; }
  die "$PICK_OUT"
fi

# --- 3) verify the model's declared thinking levels against the endpoint ------
if [ -n "$MODEL_LEVELS" ]; then
  VERIFIED=""
  for E in $MODEL_LEVELS; do
    CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$RESPONSES_URL" \
      -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
      -d "{\"model\":\"$MODEL\",\"input\":\"ping\",\"reasoning\":{\"effort\":\"$E\"},\"max_output_tokens\":16}" 2>/dev/null || echo 000)"
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
else
  log "该模型未声明思考档位（无 reasoning levels）"
fi

# --- 4) write config + catalog -------------------------------------------------
# fresh: from template; existing: force-write this mode's model keys (switching
# from other providers keeps the rest of the user's config).
if [ ! -f "$CONFIG" ]; then
  sed -e "s|<你的智谱 Coding Plan API Key>|$KEY|" \
      -e "s|^model = .*|model = \"$MODEL\"|" \
      -e "s|^model_reasoning_effort = .*|model_reasoning_effort = \"$MODEL_EFFORT\"|" \
      -e "s|model_catalog_json = .*|model_catalog_json = \"$(dirname "$CONFIG")/models.json\"|" \
    "$SCRIPT_DIR/config.toml.example" > "$CONFIG"
  log "config.toml 已从模板生成（模型: $MODEL，默认思考: $MODEL_EFFORT）"
else
  python3 - "$CONFIG" "$SCRIPT_DIR" "$KEY" "$MODEL" "$MODEL_EFFORT" <<'PY'
import os, re, sys

config, script_dir, key, model, effort = sys.argv[1:6]

model_keys = {
    "model_provider": '"ZAI"',
    "model": f'"{model}"',
    "model_reasoning_effort": f'"{effort}"',
    # Absolute path: "~" would expand to $HOME, not CODEX_HOME, breaking
    # isolated deployments (SERVICE_NAME/CODEX_HOME overrides).
    "model_catalog_json": '"' + os.path.join(os.path.dirname(os.path.abspath(config)), "models.json") + '"',
}
zai_block = f'''[model_providers.ZAI]
name = "ZAI"
base_url = "https://open.bigmodel.cn/api/v1"
experimental_bearer_token = "{key}"
wire_api = "responses"'''

lines = open(config).read().split("\n")

def is_header(line):
    return re.match(r"^\[[a-zA-Z_]", line) is not None

# Drop existing top-level model keys and any [model_providers.*] blocks
# (they belong to whichever provider was active before).
out, i = [], 0
while i < len(lines):
    line = lines[i]
    s = line.strip()
    if any(re.match(rf"^{k}\s*=", s) for k in model_keys):
        i += 1
        continue
    if re.match(r"^\[model_providers\.[^\]]+\]$", s) or s == "[model_providers]":
        i += 1
        while i < len(lines) and not is_header(lines[i]):
            i += 1
        continue
    out.append(line)
    i += 1

# Prepend fresh model-source keys at the top of the file.
fresh = "\n".join(f"{k} = {v}" for k, v in model_keys.items()) + f"\n\n{zai_block}\n"
open(config, "w").write(fresh + "\n".join(out).lstrip("\n"))
print("[zhipu-setup] 模型源键已写入（覆盖先前供应商设置）")
PY
  log "已存在的 $CONFIG 保留其余内容，模型源已切换为智谱（$MODEL）"
fi
cp "$CATALOG_SRC" "$(dirname "$CONFIG")/models.json"

# feature 开关（幂等）：[features] mcp_2026_07_28 = true
python3 - "$CONFIG" <<'PY'
import re, sys
config = sys.argv[1]
text = open(config).read()
if "mcp_2026_07_28" not in text:
    if re.search(r"^\[features\]", text, re.M):
        text = re.sub(r"^(\[features\])", r"\1\nmcp_2026_07_28 = true", text, count=1, flags=re.M)
    else:
        text = text.rstrip("\n") + "\n\n[features]\nmcp_2026_07_28 = true\n"
    open(config, "w").write(text)
    print("[zhipu-setup] feature mcp_2026_07_28 已开启")
else:
    print("[zhipu-setup] feature mcp_2026_07_28 已存在")
PY

# --- 5) MCP 服务器（写入本模式配置集）-------------------------------------------
CONFIG="$CONFIG" bash "$SCRIPT_DIR/setup-http-mcp.sh"
set -a; . "$ENV_FILE"; set +a
CONFIG="$CONFIG" bash "$SCRIPT_DIR/setup-zai-mcp.sh"

# 注：fix-mcp-approval.sh 用于给"其它来源"已存在的 MCP 服务器补审批白名单
# （如 chelper 写入的块）；本仓库 setup 脚本生成的块已含该行，无需再跑。

chmod 600 "$CONFIG" "$(dirname "$CONFIG")/models.json" 2>/dev/null || true

bash "$SCRIPT_DIR/../activate-config.sh" zhipu
log "完成。重启服务生效：sudo systemctl restart codex-harness"
log "验证：node $SCRIPT_DIR/../../verify-mcp-tools.mjs"
