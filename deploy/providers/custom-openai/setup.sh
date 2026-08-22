#!/usr/bin/env bash
# Custom OpenAI-compatible API provider preset — for local vLLM / relays and
# anything speaking the OpenAI Responses wire format.
#
#   bash deploy/providers/custom-openai/setup.sh        # interactive
# Unattended:
#   CUSTOM_BASE_URL=http://127.0.0.1:8000/v1 CUSTOM_MODEL=my-model \
#   [CUSTOM_API_KEY=...] [CUSTOM_CTX=131072] \
#   bash deploy/providers/custom-openai/setup.sh
#
# NOTE: codex 0.149 dropped `wire_api = "chat"` — only the Responses API is
# supported, so the endpoint must expose POST <base_url>/responses (recent
# vLLM builds do). Chat-only servers cannot be used as a codex provider.
#
# Config-set layout: this mode OWNS providers/custom/ as a self-contained set;
# ~/.codex/config.toml becomes a symlink to it (../activate-config.sh), so
# switching modes never edits this set.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CH="${CODEX_HOME:-$HOME/.codex}"
SET_DIR="$CH/providers/custom"
CONFIG="$SET_DIR/config.toml"
LIVE="$CH/config.toml"
BASE_URL="${CUSTOM_BASE_URL:-}"
MODEL="${CUSTOM_MODEL:-}"
API_KEY="${CUSTOM_API_KEY:-EMPTY}"
CTX="${CUSTOM_CTX:-131072}"
VISION="${CUSTOM_VISION:-}"
# Reasoning effort codex sends on every request. Vocabularies differ per
# endpoint (docs: DeepSeek none/low/high/max, Qwen3 vLLM low/medium/xhigh,
# OpenAI minimal..max) — pick the value your endpoint documents; "medium" is
# the common denominator we tested against both.
EFFORT="${CUSTOM_EFFORT:-medium}"

log() { echo "[custom-setup] $*"; }
die() { echo "[custom-setup] ERROR: $*" >&2; exit 1; }

# GET <base_url>/models — the endpoint's live model list.
fetch_models() {
  local auth=()
  if [ -n "$API_KEY" ] && [ "$API_KEY" != "EMPTY" ]; then
    auth=(-H "Authorization: Bearer $API_KEY")
  fi
  curl -s --max-time 20 "$BASE_URL/models" "${auth[@]}" 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    ids = [m["id"] for m in d.get("data", []) if isinstance(m, dict) and m.get("id")]
    print("\n".join(ids))
except Exception:
    pass
'
}

auth_header_args() {
  if [ -n "$API_KEY" ] && [ "$API_KEY" != "EMPTY" ]; then
    printf '%s' "-H Authorization: Bearer $API_KEY"
  fi
}

if [ -t 0 ]; then
  # 1) URL first
  [ -z "$BASE_URL" ] && read -r -p "API base_url（如 http://127.0.0.1:8000/v1，需提供 /responses 端点）: " BASE_URL
  case "$BASE_URL" in
    http://*|https://*) ;;
    *) die "base_url 必须以 http:// 或 https:// 开头: $BASE_URL" ;;
  esac
  # 2) key BEFORE fetching models (authed endpoints reject the list otherwise)
  if [ "${CUSTOM_API_KEY:-}" = "" ]; then
    read -r -p "API Key（本地无鉴权服务直接回车）: " k || true
    [ -n "$k" ] && API_KEY="$k"
  fi
  # 3) auto-fetch the model list and let the user pick
  if [ -z "$MODEL" ]; then
    echo "正在获取模型列表..."
    MODELS_LIST="$(fetch_models)"
    if [ -n "$MODELS_LIST" ]; then
      echo "端点提供以下模型："
      echo "$MODELS_LIST" | nl -ba | sed 's/^/  /'
      local_total="$(echo "$MODELS_LIST" | wc -l)"
      read -r -p "选择模型（输入序号，或直接输入模型 id）: " pick || true
      if [ -n "$pick" ] && [ "$pick" -ge 1 ] 2>/dev/null && [ "$pick" -le "$local_total" ] 2>/dev/null; then
        MODEL="$(echo "$MODELS_LIST" | sed -n "${pick}p")"
        log "已选: $MODEL"
      elif [ -n "$pick" ]; then
        MODEL="$pick"
      fi
    else
      log "获取模型列表失败——手动输入模型 id"
    fi
    while [ -z "$MODEL" ]; do
      read -r -p "模型 id: " MODEL || true
    done
  fi
  # 4) vision
  if [ -z "$VISION" ]; then
    read -r -p "端点支持图片输入吗（vLLM 带 --limit-mm-per-prompt.image 时选 y）? [y/N]: " v || true
    case "$v" in y*|Y*) VISION=1 ;; *) VISION=0 ;; esac
  fi
fi
case "$VISION" in 1|true|yes) VISION=1 ;; *) VISION=0 ;; esac

[ -n "$BASE_URL" ] || die "缺少 base_url：设置 CUSTOM_BASE_URL 或交互输入"
case "$BASE_URL" in
  *[!A-Za-z0-9:/._-]*) die "base_url 含非法字符（仅允许字母/数字/点/斜杠/冒号/连字符/下划线）: $BASE_URL" ;;
esac
[ -n "$MODEL" ] || die "缺少模型 id：设置 CUSTOM_MODEL 或交互输入"
case "$MODEL" in *[!A-Za-z0-9._/\-]*) die "模型 id 含非法字符: $MODEL" ;; esac
case "$CTX" in ''|*[!0-9]*) die "CUSTOM_CTX 必须是数字" ;; esac
# API keys land in TOML strings and curl bodies — reject anything that could
# escape the quoting (injection guard; keys are typically [A-Za-z0-9._\-]).
case "$API_KEY" in
  *[!A-Za-z0-9._\-]*) die "API Key 含非法字符（仅允许字母/数字/点/下划线/连字符）: $API_KEY" ;;
esac

mkdir -p "$SET_DIR"
# Migration: a pre-set-switching single config.toml seeds this set once (the
# strip below then removes any foreign keys it carried along).
if [ ! -f "$CONFIG" ] && [ -f "$LIVE" ] && [ ! -L "$LIVE" ]; then
  cp "$LIVE" "$CONFIG"
  log "检测到旧式单文件配置，已吸收为本模式配置集的基础"
fi

# --- auto-detect the endpoint's reasoning-effort vocabulary -------------------
# One tiny /responses request per candidate; 200 = accepted. The detected set
# populates the catalog (and thus the WebUI effort selector). Offline or
# probing errors fall back to the single configured default.
detect_efforts() {
  local url="$BASE_URL/responses" code detected=""
  local auth=()
  if [ -n "$API_KEY" ] && [ "$API_KEY" != "EMPTY" ]; then
    auth=(-H "Authorization: Bearer $API_KEY")
  fi
  for E in none minimal low medium high xhigh max; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$url" "${auth[@]}" \
      -H 'Content-Type: application/json' \
      -d "{\"model\":\"$MODEL\",\"input\":\"ping\",\"reasoning\":{\"effort\":\"$E\"},\"max_output_tokens\":16}" 2>/dev/null || echo 000)"
    if [ "$code" = "200" ]; then
      detected="$detected $E"
    fi
  done
  # shellcheck disable=SC2086
  echo $detected
}

case "$EFFORT" in
  none|minimal|low|medium|high|xhigh|max) ;;
  *) die "CUSTOM_EFFORT 必须是 none/minimal/low/medium/high/xhigh/max 之一: $EFFORT" ;;
esac

log "探测端点支持的思考档位（使用所选模型 $MODEL）..."
EFFORTS_DETECTED="$(detect_efforts)"
if [ -n "$EFFORTS_DETECTED" ]; then
  log "端点接受: ${EFFORTS_DETECTED}"
  if [ -t 0 ] && [ -z "${CUSTOM_EFFORT:-}" ]; then
    # default suggestion: medium when accepted, else the first accepted value
    DEFAULT_SUGGEST="medium"
    case " $EFFORTS_DETECTED " in
      *" medium "*) ;;
      *) DEFAULT_SUGGEST="$(printf '%s' "$EFFORTS_DETECTED" | awk '{print $1}')" ;;
    esac
    read -r -p "默认思考档位（$EFFORTS_DETECTED） [$DEFAULT_SUGGEST]: " ef || true
    [ -n "$ef" ] && EFFORT="$ef"
    case " $EFFORTS_DETECTED " in
      *" $EFFORT "*) ;;
      *) die "所选档位 $EFFORT 不在端点支持列表里（支持: $EFFORTS_DETECTED）" ;;
    esac
  else
    case " $EFFORTS_DETECTED " in
      *" $EFFORT "*) ;;
      *) die "CUSTOM_EFFORT=$EFFORT 不在端点支持列表里（支持: $EFFORTS_DETECTED）" ;;
    esac
  fi
else
  log "探测失败或端点拒绝全部档位——跳过档位列表（仍使用默认 $EFFORT）"
fi

python3 - "$CONFIG" "$BASE_URL" "$MODEL" "$API_KEY" "$CTX" "$VISION" "$EFFORT" "$EFFORTS_DETECTED" <<'PY'
import json, os, re, shutil, sys, time

config, base_url, model, api_key, ctx, vision, effort, detected = sys.argv[1:9]
catalog_path = os.path.join(os.path.dirname(os.path.abspath(config)), "models.json")

TOP_KEYS = ("model_provider", "model", "model_reasoning_effort", "model_catalog_json")
FEATURE_KEYS = ("mcp_2026_07_28",)

def is_header(line):
    return re.match(r"^\[[a-zA-Z_]", line) is not None

lines = open(config).read().split("\n") if os.path.exists(config) else []
out, i, removed = [], 0, []
while i < len(lines):
    line = lines[i]
    s = line.strip()
    # Third-party blocks (incl. subtables) run until the next table header.
    if re.match(r"^\[(model_providers|mcp_servers)\.[^\]]+\]", s) or s in ("[model_providers]", "[mcp_servers]"):
        name = s
        i += 1
        while i < len(lines) and not is_header(lines[i]):
            i += 1
        removed.append(name)
        continue
    if is_header(line):
        if s == "[features]":
            out.append(line)
            i += 1
            kept_any = False
            while i < len(lines) and not is_header(lines[i]):
                if not any(lines[i].strip().startswith(k + " ") or lines[i].strip().startswith(k + "=") for k in FEATURE_KEYS):
                    out.append(lines[i])
                    kept_any = kept_any or lines[i].strip() != ""
                else:
                    removed.append(lines[i].strip())
                i += 1
            if not kept_any:
                while out and out[-1].strip() == "":
                    out.pop()
                if out and out[-1].strip() == "[features]":
                    out.pop()
            continue
        out.append(line)
        i += 1
        continue
    if any(re.match(rf"^{k}\s*=", s) for k in TOP_KEYS):
        removed.append(s)
        i += 1
        continue
    out.append(line)
    i += 1

fresh = f'''model_provider = "custom"
model = "{model}"
model_reasoning_effort = "{effort}"
model_catalog_json = "{catalog_path}"

[model_providers.custom]
name = "Custom OpenAI-compatible API"
base_url = "{base_url}"
experimental_bearer_token = "{api_key}"
wire_api = "responses"
'''

if removed:
    bak = f"{config}.bak-{int(time.time())}"
    shutil.copyfile(config, bak)
    # copyfile doesn't preserve permissions — the backup contains the API
    # key so tighten it to match the main config.
    import os as _os
    _os.chmod(bak, 0o600)
text = fresh + "\n" + "\n".join(out).lstrip("\n")
text = re.sub(r"\n{3,}", "\n\n", text)
open(config, "w").write(text)
print(f"[custom-setup] 配置已写入（剥离其它供应商/MCP {len(removed)} 项{'，已备份' if removed else ''}）")

# Single-model catalog so model/list (and the WebUI model selector) show the
# real model instead of the built-in gpt list.
EFFORT_DESC = {
    "none": "禁用思考", "minimal": "极少思考", "low": "轻量思考",
    "medium": "中等思考", "high": "深度思考", "xhigh": "超深度思考", "max": "最大思考",
}
levels = [{"effort": e, "description": EFFORT_DESC.get(e, e)} for e in detected.split()]
models = {
    "models": [
        {
            "slug": model,
            "display_name": model,
            "description": "Custom OpenAI-compatible endpoint",
            # Field set mirrors the working glm catalog entries; codex rejects
            # catalog entries that miss these (missing-field JSON error).
            # supported levels come from live probing of the endpoint, so the
            # WebUI effort selector only ever offers values it accepts; when
            # probing failed we stay with an empty list (codex then just sends
            # the default on every request).
            "default_reasoning_level": effort,
            "supported_reasoning_levels": levels,
            "shell_type": "shell_command",
            "visibility": "list",
            "supported_in_api": True,
            "priority": 0,
            "base_instructions": "",
            "supports_reasoning_summaries": True,
            "default_reasoning_summary": "none",
            "support_verbosity": False,
            "apply_patch_tool_type": "freeform",
            "truncation_policy": {"mode": "bytes", "limit": 10000},
            "context_window": int(ctx),
            "max_context_window": int(ctx),
            "effective_context_window_percent": 95,
            "supports_parallel_tool_calls": True,
            "experimental_supported_tools": [],
            # Declaring image support lets codex send localImage attachments
            # natively (endpoint must accept them, e.g. vLLM --limit-mm-per-prompt.image).
            "input_modalities": ["text", "image"] if vision == "1" else ["text"],
        }
    ]
}
with open(catalog_path, "w") as f:
    json.dump(models, f, indent=2, ensure_ascii=False)
effort_list = " ".join(l["effort"] for l in levels) if levels else "(仅默认 %s)" % effort
print("[custom-setup] models.json 目录已生成（窗口 %s tokens，effort 档位: %s）" % (ctx, effort_list))
PY

# The set contains the API key — keep it owner-only.
chmod 600 "$CONFIG" "$SET_DIR/models.json" 2>/dev/null || true

SCRIPT_PARENT="$(cd "$SCRIPT_DIR/.." && pwd)"
bash "$SCRIPT_PARENT/activate-config.sh" custom
echo "[custom-setup] 完成。重启服务生效：sudo systemctl restart codex-harness"
