#!/usr/bin/env bash
# Configure zai-mcp-server (Vision MCP) for Codex exactly the way Zhipu's
# coding-helper writes it (codex-manager.installMCP): type=local, plain env
# values (no env:VAR indirection), command via npx like upstream presets.
set -eu
KEY="${Z_AI_API_KEY:?Z_AI_API_KEY must be set}"
# CONFIG may be redirected to a provider config-set file (zhipu setup.sh);
# default remains the live ~/.codex/config.toml.
CONFIG="${CONFIG:-${CODEX_HOME:-$HOME/.codex}/config.toml}"

python3 - "$CONFIG" "$KEY" <<'PY'
import re, sys

config, key = sys.argv[1], sys.argv[2]
text = open(config).read()

# Drop any existing zai-mcp-server block including subtables (e.g. .env)
# line-wise: a section runs until the next *table header* line — args arrays
# also start with '[', so require a letter after the bracket to tell them
# apart (same approach as setup-http-mcp.sh).
lines = text.split("\n")
out = []
i = 0
while i < len(lines):
    line = lines[i]
    if re.match(r"^\[mcp_servers\.zai-mcp-server(\.[a-zA-Z0-9_-]+)?\]", line):
        i += 1
        while i < len(lines) and not re.match(r"^\[[a-zA-Z_]", lines[i]):
            i += 1
        continue
    out.append(line)
    i += 1
text = "\n".join(out)

block = f"""[mcp_servers.zai-mcp-server]
type = "local"
# Auto-approve this server's MCP tool calls so they still run when the
# turn's approval policy is "never" (codex otherwise rejects MCP calls
# client-side with "MCP tool call requires approval").
default_tools_approval_mode = "approve"
command = "npx"
args = ["-y", "@z_ai/mcp-server"]

[mcp_servers.zai-mcp-server.env]
Z_AI_MODE = "ZHIPU"
Z_AI_API_KEY = "{key}"

"""
open(config, "w").write(text.rstrip("\n") + "\n\n" + block)
print("zai-mcp-server block written (chelper-compatible form)")
PY

grep -A8 'mcp_servers.zai-mcp-server' "$CONFIG"
