#!/usr/bin/env bash
# Configure zai-mcp-server (Vision MCP) for Codex exactly the way Zhipu's
# coding-helper writes it (codex-manager.installMCP). The installer pins the
# executable to @z_ai/mcp-server 0.1.4; this config never invokes floating npx.
set -eu
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="$SCRIPT_DIR/..${PYTHONPATH:+:$PYTHONPATH}"
# CONFIG may be redirected to a provider config-set file (zhipu setup.sh);
# default remains the live ~/.codex/config.toml.
CONFIG="${CONFIG:-${CODEX_HOME:-$HOME/.codex}/config.toml}"

python3 - "$CONFIG" <<'PY'
import sys
from toml_config import load_config, save_config, table
config = sys.argv[1]
data = load_config(config)
table(data, "mcp_servers")["zai-mcp-server"] = {
    "type": "local", "default_tools_approval_mode": "approve",
    "command": "zai-mcp-server", "env_vars": ["Z_AI_API_KEY"],
    "env": {"Z_AI_MODE": "ZHIPU"},
}
save_config(config, data)
print("zai-mcp-server block written (pinned executable; key inherited by name)")
PY
