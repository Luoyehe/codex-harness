#!/usr/bin/env bash
# Auto-approve MCP tool calls per server, so they work even when the session
# approval policy is "never" (WebUI composer "never ask").
# Official key: mcp_servers.<id>.default_tools_approval_mode = "approve".
# Idempotent against any block layout: scans the WHOLE block (until the next
# table header) before inserting.
set -eu
CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"
python3 - "$CONFIG" <<'PY'
import re, sys

config = sys.argv[1]
lines = open(config).read().split("\n")

def is_header(line):
    return re.match(r"^\[[a-zA-Z_]", line) is not None

out = []
i = 0
inserted = 0
while i < len(lines):
    line = lines[i]
    out.append(line)
    if re.match(r"^\[mcp_servers\.[a-zA-Z0-9_-]+\]$", line.strip()):
        # Collect the block first to see whether the key already exists.
        j = i + 1
        block = []
        while j < len(lines) and not is_header(lines[j]):
            block.append(lines[j])
            j += 1
        if not any("default_tools_approval_mode" in b for b in block):
            out.append('default_tools_approval_mode = "approve"')
            inserted += 1
        out.extend(block)
        i = j
        continue
    i += 1
text = "\n".join(out)
open(config, "w").write(text)
total = text.count('default_tools_approval_mode = "approve"')
print(f"approve flags: {total} (inserted {inserted})")
PY
grep -A3 'mcp_servers.web-search-prime\]' "$CONFIG" | head -4
