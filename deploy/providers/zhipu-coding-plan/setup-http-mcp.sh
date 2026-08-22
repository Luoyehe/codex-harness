#!/usr/bin/env bash
# Configure the three Zhipu streamable-http MCP servers on our minimal bridge.
# The token lives in a 600-permission key FILE next to the config set (codex
# spawns stdio MCP servers with a minimal environment, so $Z_AI_API_KEY would
# not reach the bridge; argv would expose it in /proc/<pid>/cmdline).
set -eu
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE="$SCRIPT_DIR/mcp-http-bridge.mjs"
ENV_FILE="${ENV_FILE:-/etc/codex-harness.env}"
KEY="$(grep -oP '(?<=^Z_AI_API_KEY=).*' "$ENV_FILE")"
# CONFIG may be redirected to a provider config-set file (zhipu setup.sh);
# default remains the live ~/.codex/config.toml.
CONFIG="${CONFIG:-${CODEX_HOME:-$HOME/.codex}/config.toml}"
KEY_FILE="$(dirname "$CONFIG")/.mcp-key"

# Key lands in a file read by the bridge — reject injection-capable
# characters (same guard as the other provider scripts).
case "$KEY" in
  *[!A-Za-z0-9._\-]*) echo "[zhipu-setup] ERROR: Z_AI_API_KEY 含非法字符（仅允许字母/数字/点/下划线/连字符）" >&2; exit 1 ;;
esac
umask 077
printf '%s' "$KEY" > "$KEY_FILE"
log() { echo "[zhipu-setup] $*"; }
log "token 已写入 $KEY_FILE（600，不入 config.toml/argv）"

python3 - "$CONFIG" "$BRIDGE" "$KEY_FILE" <<'PY'
import re, sys

config, bridge, keyfile = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(config).read().split("\n")

# Line-wise removal of the three MCP blocks. A section runs until the next
# *table header* line — args arrays also start with '[', so require a letter
# after the bracket (table names) to tell them apart.
def is_header(line):
    return re.match(r"^\[[a-zA-Z_]", line) is not None

out = []
i = 0
targets = ("[mcp_servers.web-search-prime", "[mcp_servers.web-reader", "[mcp_servers.zread")
while i < len(lines):
    line = lines[i]
    if any(line.startswith(t) for t in targets):
        i += 1
        while i < len(lines) and not is_header(lines[i]):
            i += 1
        continue
    out.append(line)
    i += 1

# Also drop orphaned bridge arg lines from previously broken edits (including
# the pre-key-file form that carried the raw token in argv).
out = [l for l in out if not (l.startswith('["') and "mcp-http-bridge.mjs" in l)]

def block(name, url):
    return [
        f"[mcp_servers.{name}]",
        'type = "local"',
        "startup_timeout_sec = 120",
        # Auto-approve this server's MCP tool calls so they still run when the
        # turn's approval policy is "never" (codex otherwise rejects MCP calls
        # client-side with "MCP tool call requires approval").
        'default_tools_approval_mode = "approve"',
        'command = "node"',
        # The key is read from the key FILE at runtime — argv stays secret-free
        # (other local users could otherwise read it via /proc/<pid>/cmdline).
        f'args = ["{bridge}", "{url}", "--key-file", "{keyfile}"]',
        "",
    ]

out += block("web-search-prime", "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp")
out += block("web-reader", "https://open.bigmodel.cn/api/mcp/web_reader/mcp")
out += block("zread", "https://open.bigmodel.cn/api/mcp/zread/mcp")
open(config, "w").write("\n".join(out).rstrip("\n") + "\n")
print("bridged MCP entries written (token via key file)")
PY

grep -A4 'mcp_servers.web-reader\]' "$CONFIG"
