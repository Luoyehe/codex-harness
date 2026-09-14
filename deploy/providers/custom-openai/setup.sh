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
# Config-set layout: this mode owns providers/custom/ inside a private candidate.
# The outer transaction publishes its config/catalog/credentials together;
# no write below edits the currently published generation.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="$SCRIPT_DIR/..${PYTHONPATH:+:$PYTHONPATH}"
if [ "${HARNESS_PROVIDER_TRANSACTION:-0}" != "1" ]; then
  exec python3 "$SCRIPT_DIR/../provider_transaction.py" custom "$0" "$@"
fi
CH="${CODEX_HOME:-$HOME/.codex}"
SET_DIR="$CH/providers/custom"
CONFIG="$SET_DIR/config.toml"
LIVE="$CH/config.toml"
ENV_FILE="${ENV_FILE:-${CODEX_HOME:-$HOME/.codex}/secrets.env}"
BASE_URL="${CUSTOM_BASE_URL:-}"
MODEL="${CUSTOM_MODEL:-}"
API_KEY=""
CTX="${CUSTOM_CTX:-131072}"
VISION="${CUSTOM_VISION:-}"
# Reasoning effort codex sends on every request. Vocabularies differ per
# endpoint (docs: DeepSeek none/low/high/max, Qwen3 vLLM low/medium/xhigh,
# OpenAI minimal..max) — pick the value your endpoint documents; "medium" is
# the common denominator we tested against both.
EFFORT="${CUSTOM_EFFORT:-medium}"

log() { echo "[custom-setup] $*"; }
die() { echo "[custom-setup] ERROR: $*" >&2; exit 1; }

if [ "${CUSTOM_SYNC_CATALOG:-0}" = "1" ]; then
  # A refresh is not a settings change. Read the locked candidate snapshot,
  # never substitute setup defaults for existing user choices.
  EFFORT="$(python3 - "$CONFIG" <<'PY'
import sys
from toml_config import load_config
data = load_config(sys.argv[1])
value = data.get("model_reasoning_effort")
if not isinstance(value, str):
    raise SystemExit("当前配置缺少默认 effort；请先完成供应商配置")
print(value)
PY
)"
  PROBE_REASONING=0
fi

# A supplied replacement key is written atomically to the canonical service
# EnvironmentFile. It is never placed in TOML or passed to Python in argv.
persist_key() {
  local incoming="$1"
  CUSTOM_API_KEY="$incoming" ENV_FILE="$ENV_FILE" python3 - <<'PY'
import os
from atomic_write import atomic_write
path = os.environ["ENV_FILE"]
key = os.environ["CUSTOM_API_KEY"]
if len(key) > 16384 or any(ord(c) < 32 or ord(c) == 127 for c in key):
    raise SystemExit("invalid CUSTOM_API_KEY")
os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
try:
    with open(path, encoding="utf-8") as f: lines = f.read().splitlines()
except FileNotFoundError:
    lines = []
lines = [line for line in lines if not line.startswith("CUSTOM_OPENAI_API_KEY=")]
quoted = '"' + key.replace('\\', '\\\\').replace('"', '\\"') + '"'
lines.append("CUSTOM_OPENAI_API_KEY=" + quoted)
atomic_write(path, "\n".join(lines) + "\n")
PY
}

# One-time migration from releases that embedded the token in config.toml.
# Do it before rewriting/sanitizing the provider block so CLI and WebUI paths
# preserve authentication without requiring the gateway to read the secret.
if [ -z "${CUSTOM_API_KEY:-}" ] && ! grep -q '^CUSTOM_OPENAI_API_KEY=' "$ENV_FILE" 2>/dev/null; then
  LEGACY_SOURCE=""
  if [ -f "$CONFIG" ]; then
    LEGACY_SOURCE="$CONFIG"
  elif [ -f "$LIVE" ] && [ ! -L "$LIVE" ]; then
    LEGACY_SOURCE="$LIVE"
  fi
  if [ -n "$LEGACY_SOURCE" ]; then
    LEGACY_KEY="$(python3 - "$LEGACY_SOURCE" <<'PY'
import sys
from toml_config import load_config
data = load_config(sys.argv[1])
value = data.get("model_providers", {}).get("custom", {}).get("experimental_bearer_token")
if isinstance(value, str) and value:
    print(value)
PY
)"
    if [ -n "$LEGACY_KEY" ]; then
      persist_key "$LEGACY_KEY"
      unset LEGACY_KEY
      log "已把旧配置中的 bearer token 迁移到统一密钥文件"
    fi
  fi
fi
API_KEY="$(python3 - "$ENV_FILE" <<'PY'
import shlex, sys
try: lines = open(sys.argv[1], encoding="utf-8")
except FileNotFoundError: raise SystemExit(0)
for line in lines:
    if line.startswith("CUSTOM_OPENAI_API_KEY="):
        values = shlex.split(line.split("=", 1)[1].strip(), posix=True)
        if len(values) == 1: print(values[0])
PY
)"
[ -n "$API_KEY" ] || API_KEY="EMPTY"
if [ -n "${CUSTOM_API_KEY:-}" ]; then API_KEY="${CUSTOM_API_KEY}"; fi
# A blank key on a new/reconfigured endpoint means no authentication. Reuse
# of the stored key is reserved for catalog sync of the existing endpoint;
# otherwise changing the URL could silently send the old provider's secret.
if [ -z "${CUSTOM_API_KEY:-}" ] && [ "${CUSTOM_REUSE_API_KEY:-0}" != "1" ]; then
  API_KEY="EMPTY"
fi

normalize_url() {
  BASE_URL="$(BASE_URL="$BASE_URL" python3 - <<'PY'
import os, urllib.parse
value = os.environ["BASE_URL"].strip().rstrip("/")
if len(value) > 2048 or any(ord(c) < 32 or ord(c) == 127 for c in value):
    raise SystemExit(1)
try:
    parsed = urllib.parse.urlsplit(value)
    port = parsed.port
except ValueError:
    raise SystemExit(1)
if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.fragment or parsed.query:
    raise SystemExit(1)
if port is not None and not 1 <= port <= 65535:
    raise SystemExit(1)
print(value)
PY
)" || die "base_url 必须是无内嵌凭据、查询参数或片段的绝对 http(s) URL"
}

# Supply bearer headers over stdin so API keys never appear in curl argv or
# process listings. These requests do not otherwise consume stdin.
custom_curl() {
  API_KEY="$API_KEY" python3 -c 'import os; v=os.environ["API_KEY"]; raise SystemExit(0 if len(v) <= 16384 and not any(ord(c)<32 or ord(c)==127 for c in v) else 1)' \
    || die "API Key 过长或含控制字符"
  if [ "$API_KEY" != "EMPTY" ]; then
    printf 'Authorization: Bearer %s\n' "$API_KEY" | curl -H @- "$@"
  else
    curl "$@"
  fi
}

# GET <base_url>/models — the endpoint's live model list.
fetch_models() {
  custom_curl -sf --max-time 20 "$BASE_URL/models" 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    ids = [m["id"] for m in d.get("data", []) if isinstance(m, dict) and isinstance(m.get("id"), str)]
    if not ids or any(not 0 < len(v) <= 256 or any(ord(c)<32 or ord(c)==127 for c in v) for v in ids):
        raise ValueError("invalid model list")
    print("\n".join(ids))
except Exception:
    raise SystemExit(1)
'
}

if [ -t 0 ]; then
  # 1) URL first
  [ -z "$BASE_URL" ] && read -r -p "API base_url（如 http://127.0.0.1:8000/v1，需提供 /responses 端点）: " BASE_URL
  normalize_url
  # 2) key BEFORE fetching models (authed endpoints reject the list otherwise)
  if [ "${CUSTOM_API_KEY:-}" = "" ]; then
    read -r -s -p "API Key（本地无鉴权服务直接回车）: " k || true; echo
    [ -n "$k" ] && API_KEY="$k"
  fi
  # 3) auto-fetch the model list and let the user pick
  if [ -z "$MODEL" ]; then
    echo "正在获取模型列表..."
    MODELS_LIST="$(fetch_models || true)"
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
normalize_url
[ -n "$MODEL" ] || die "缺少模型 id：设置 CUSTOM_MODEL 或交互输入"
if [ "${CUSTOM_SYNC_CATALOG:-0}" = "1" ]; then
  CUSTOM_MODEL_IDS="$(fetch_models)" || die "无法获取有效模型目录；当前配置保持不变"
  export CUSTOM_MODEL_IDS
fi
MODEL="$MODEL" python3 -c 'import os; v=os.environ["MODEL"]; raise SystemExit(0 if 0 < len(v) <= 256 and not any(ord(c)<32 or ord(c)==127 for c in v) else 1)' \
  || die "模型 id 为空、过长或含控制字符"
case "$CTX" in ''|*[!0-9]*) die "CUSTOM_CTX 必须是数字" ;; esac
[ "$CTX" -ge 1024 ] && [ "$CTX" -le 16777216 ] || die "CUSTOM_CTX 必须在 1024..16777216 之间"
API_KEY="$API_KEY" python3 -c 'import os; v=os.environ["API_KEY"]; raise SystemExit(0 if len(v) <= 16384 and not any(ord(c)<32 or ord(c)==127 for c in v) else 1)' \
  || die "API Key 过长或含控制字符"

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
  for E in none minimal low medium high xhigh max; do
    local payload
    payload="$(python3 -c 'import json,sys; print(json.dumps({"model":sys.argv[1],"input":"ping","reasoning":{"effort":sys.argv[2]},"max_output_tokens":16}))' "$MODEL" "$E")"
    code="$(custom_curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$url" \
      -H 'Content-Type: application/json' \
      -d "$payload" 2>/dev/null || echo 000)"
    if [ "$code" = "200" ]; then
      detected="$detected $E"
    fi
  done
  # shellcheck disable=SC2086
  echo $detected
}

EFFORT="$EFFORT" python3 -c 'import os,re; raise SystemExit(0 if re.fullmatch(r"[a-z][a-z0-9-]{0,31}",os.environ["EFFORT"]) else 1)' \
  || die "CUSTOM_EFFORT 必须是有界的档位标识；具体支持情况由该模型的配置/探测结果决定"

if [ "${PROBE_REASONING:-0}" = "1" ]; then
  log "将发送 7 个真实 API 探测请求（可能计费，模型 $MODEL）..."
  EFFORTS_DETECTED="$(detect_efforts)"
else
  EFFORTS_DETECTED=""
  log "跳过付费思考档位探测（设置 PROBE_REASONING=1 可显式启用）"
fi
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
elif [ "${PROBE_REASONING:-0}" = "1" ]; then
  log "探测失败或端点拒绝全部档位——跳过档位列表（仍使用默认 $EFFORT）"
fi

# Persist the selected authentication state, including an explicit blank.
# Leaving an old key in the canonical store after an unauthenticated URL
# switch would let a later catalog sync silently restore it on the new URL.
if [ "$API_KEY" = "EMPTY" ]; then persist_key ""; else persist_key "$API_KEY"; fi

python3 - "$CONFIG" "$BASE_URL" "$MODEL" "$CTX" "$VISION" "$EFFORT" "$EFFORTS_DETECTED" "$([ "$API_KEY" != "EMPTY" ] && echo 1 || echo 0)" <<'PY'
import json, os, sys
from atomic_write import atomic_write

config, base_url, model, ctx, vision, effort, detected, has_key = sys.argv[1:9]
from toml_config import load_config, save_config, table
catalog_path = os.path.join(os.path.dirname(os.path.abspath(config)), "models.json")
data = load_config(config)
try:
    previous_catalog = json.load(open(catalog_path, encoding="utf-8"))
except FileNotFoundError:
    previous_catalog = {"models": []}
previous_provider = data.get("model_providers", {}).get("custom", {})
same_endpoint = previous_provider.get("base_url") == base_url
previous_entries = {
    entry["slug"]: entry for entry in previous_catalog.get("models", [])
    if isinstance(entry, dict) and isinstance(entry.get("slug"), str)
} if same_endpoint else {}
data.update(model_provider="custom", model=model,
            model_reasoning_effort=effort, model_catalog_json=catalog_path)
data["model_providers"] = {"custom": {
    "name": "Custom OpenAI-compatible API", "base_url": base_url,
    "wire_api": "responses",
}}
if has_key == "1":
    data["model_providers"]["custom"]["env_key"] = "CUSTOM_OPENAI_API_KEY"
features = table(data, "features")
features.pop("mcp_2026_07_28", None)
servers = table(data, "mcp_servers")
for name in ("web-search-prime", "web-reader", "zread", "zai-mcp-server"):
    servers.pop(name, None)
save_config(config, data)
print("[custom-setup] 模型配置已在候选配置集中生成，保留其它用户配置")

# Single-model catalog so model/list (and the WebUI model selector) show the
# real model instead of the built-in gpt list.
EFFORT_DESC = {
    "none": "禁用思考", "minimal": "极少思考", "low": "轻量思考",
    "medium": "中等思考", "high": "深度思考", "xhigh": "超深度思考", "max": "最大思考",
}
levels = [{"effort": e, "description": EFFORT_DESC.get(e, e)} for e in detected.split()]
if not detected:
    levels = previous_entries.get(model, {}).get("supported_reasoning_levels", [])
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
if os.environ.get("CUSTOM_SYNC_CATALOG") == "1":
    ids = os.environ.get("CUSTOM_MODEL_IDS", "").splitlines()
    if not ids or model not in ids:
        raise SystemExit("同步目录未包含当前模型；保持当前配置，请先选择端点中存在的模型")
    entries = []
    unconfigured = []
    for slug in dict.fromkeys(ids):
        if not 0 < len(slug) <= 256 or any(ord(c) < 32 or ord(c) == 127 for c in slug):
            raise SystemExit("模型目录包含非法模型 id")
        if slug not in previous_entries:
            # /models declares identifiers, not context length, modalities,
            # reasoning or tools. Codex's catalog requires concrete values;
            # inventing them would silently send unsupported requests. Keep
            # discoveries separate until this model is explicitly configured.
            unconfigured.append({"id": slug, "capabilities": "unknown"})
            continue
        entries.append(dict(previous_entries[slug]))
    models["models"] = entries
    models["unconfigured_models"] = unconfigured
    if unconfigured:
        print("[custom-setup] %d 个新模型能力未知，已登记但未启用；请按模型单独配置上下文、图片与 effort" % len(unconfigured))
elif same_endpoint:
    # Explicitly configuring another model at this same endpoint should add
    # its own capabilities, not discard previously configured models. Never
    # carry these declarations across an endpoint URL change.
    models["models"].extend(entry for slug, entry in previous_entries.items() if slug != model)
    discoveries = previous_catalog.get("unconfigured_models", [])
    models["unconfigured_models"] = [entry for entry in discoveries
        if isinstance(entry, dict) and isinstance(entry.get("id"), str)
        and entry["id"] != model and entry["id"] not in previous_entries]
atomic_write(catalog_path, json.dumps(models, indent=2, ensure_ascii=False) + "\n")
effort_list = " ".join(l["effort"] for l in levels) if levels else "(仅默认 %s)" % effort
print("[custom-setup] models.json 目录已生成（窗口 %s tokens，effort 档位: %s）" % (ctx, effort_list))
PY

# Provider config and catalog remain owner-only even though credentials now
# live solely in the EnvironmentFile.
chmod 600 "$CONFIG" "$SET_DIR/models.json" 2>/dev/null || true

SCRIPT_PARENT="$(cd "$SCRIPT_DIR/.." && pwd)"
bash "$SCRIPT_PARENT/activate-config.sh" custom
echo "[custom-setup] 完成。重启服务生效：sudo systemctl restart codex-harness"
