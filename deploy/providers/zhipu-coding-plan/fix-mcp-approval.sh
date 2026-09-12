#!/usr/bin/env bash
# Auto-approve only the four bundled Zhipu servers, so they work when the session
# approval policy is "never" (WebUI composer "never ask").
# Official key: mcp_servers.<id>.default_tools_approval_mode = "approve".
# Idempotent against any block layout: scans the WHOLE block (until the next
# table header) before inserting.
set -eu
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="$SCRIPT_DIR/..${PYTHONPATH:+:$PYTHONPATH}"
CONFIG="${CONFIG:-${CODEX_HOME:-$HOME/.codex}/config.toml}"
python3 - "$CONFIG" <<'PY'
import sys
from toml_config import load_config, save_config, table
config = sys.argv[1]
data = load_config(config)
allowed = {"web-search-prime", "web-reader", "zread", "zai-mcp-server"}
inserted = 0
for name, server in table(data, "mcp_servers").items():
    if name in allowed and isinstance(server, dict) and "default_tools_approval_mode" not in server:
        server["default_tools_approval_mode"] = "approve"
        inserted += 1
save_config(config, data)
print(f"bundled-server approval flags inserted: {inserted}; third-party servers unchanged")
PY
