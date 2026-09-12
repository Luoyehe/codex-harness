#!/usr/bin/env bash
# Configure the three Zhipu streamable-http MCP servers on our minimal bridge.
# Codex explicitly forwards only the named environment variable. The bearer
# value therefore remains in the service's owner-only EnvironmentFile and is
# never duplicated into config.toml, a command line, or another key file.
set -eu
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="$SCRIPT_DIR/..${PYTHONPATH:+:$PYTHONPATH}"
BRIDGE="$SCRIPT_DIR/mcp-http-bridge.mjs"
# CONFIG may be redirected to a provider config-set file (zhipu setup.sh);
# default remains the live ~/.codex/config.toml.
CONFIG="${CONFIG:-${CODEX_HOME:-$HOME/.codex}/config.toml}"
log() { echo "[zhipu-setup] $*"; }

python3 - "$CONFIG" "$BRIDGE" <<'PY'
import sys
from toml_config import load_config, save_config, table
config, bridge = sys.argv[1:3]
data = load_config(config)
servers = table(data, "mcp_servers")
for name, url in {
    "web-search-prime": "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
    "web-reader": "https://open.bigmodel.cn/api/mcp/web_reader/mcp",
    "zread": "https://open.bigmodel.cn/api/mcp/zread/mcp",
}.items():
    servers[name] = {
        "type": "local", "startup_timeout_sec": 120,
        "default_tools_approval_mode": "approve", "command": "node",
        "env_vars": ["Z_AI_API_KEY"], "args": [bridge, url],
    }
save_config(config, data)
print("bridged MCP entries written (key inherited by name)")
PY
