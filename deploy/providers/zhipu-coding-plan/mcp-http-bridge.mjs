#!/usr/bin/env node
/**
 * Minimal stdio <-> streamable-HTTP MCP bridge for servers that need a plain
 * Bearer token (e.g. Zhipu's open.bigmodel.cn endpoints).
 *
 *   mcp-http-bridge.mjs <https-url> [--key-file <path>] [token]
 *
 * Reads newline-delimited JSON-RPC on stdin, POSTs to the remote endpoint,
 * writes id-bearing responses back on stdout. The token comes from (in order)
 * --key-file, argv, or $Z_AI_API_KEY. The key-FILE form is what our setup
 * script generates: argv is visible to other local users via
 * /proc/<pid>/cmdline, a 600-permission file is not.
 * Replaces mcp-remote for this project: that bridge hangs on tools/call
 * against these endpoints.
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const url = argv[0];
if (!url) {
  console.error("usage: mcp-http-bridge.mjs <url> [--key-file <path>] [token]");
  process.exit(1);
}
let token = "";
const keyFileIdx = argv.indexOf("--key-file");
if (keyFileIdx !== -1 && argv[keyFileIdx + 1]) {
  try {
    token = readFileSync(argv[keyFileIdx + 1], "utf8").trim();
  } catch (err) {
    console.error(`[mcp-http-bridge] cannot read key file: ${err.message}`);
    process.exit(1);
  }
} else {
  token = argv[1] || process.env.Z_AI_API_KEY || "";
}
let protocolVersion = "2025-03-26";
// Streamable-HTTP servers hand out a session id at initialize and require it
// on every later call (Zhipu's search endpoint answers 401 without it).
let sessionId = "";

const LOG_PREFIX = `[bridge ${url.split("/").pop()}]`;
// Privacy: MCP payloads carry user prompts, search queries and fetched page
// content — never write them to the journal. Log method names and statuses
// only. Set MCP_BRIDGE_DEBUG=1 to restore full payload logging while debugging.
const DEBUG = process.env.MCP_BRIDGE_DEBUG === "1";
function summarize(obj) {
  if (!obj || typeof obj !== "object") return String(obj).slice(0, 80);
  const parts = [];
  if (obj.method) parts.push(obj.method);
  if (obj.id !== undefined) parts.push(`id=${obj.id}`);
  if (obj.error) parts.push(`error=${JSON.stringify(obj.error).slice(0, 120)}`);
  if (obj.result) parts.push(`result-keys=${Object.keys(obj.result).join(",")}`);
  return parts.join(" ") || "msg";
}
function blog(dir, data) {
  const text = DEBUG ? JSON.stringify(data).slice(0, 300) : summarize(data);
  process.stderr.write(`${LOG_PREFIX} ${dir} ${text}\n`);
}

function send(obj) {
  blog("->", JSON.stringify(obj));
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function post(body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "MCP-Protocol-Version": protocolVersion,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(body),
    // Don't hang forever — codex's startup_timeout_sec (120s) bounds this
    // anyway, failing earlier gives a clearer error.
    signal: AbortSignal.timeout(110_000),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const ctype = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ctype.includes("text/event-stream")) {
    // Parse SSE: collect data: lines per event, yield each JSON message.
    const messages = [];
    for (const block of text.split(/\n\s*\n/)) {
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        /* keepalive or non-JSON event */
      }
    }
    return messages;
  }
  if (!text.trim()) return []; // 202-style empty body (notifications)
  try {
    return [JSON.parse(text)];
  } catch {
    return [];
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (DEBUG) console.error("[bridge] non-json stdin:", line.slice(0, 120));
      continue;
    }
    if (DEBUG) console.error("[bridge] <-", JSON.stringify(msg).slice(0, 160));
    blog("<-", JSON.stringify(msg));
    void handle(msg);
  }
});

async function handle(msg) {
  // Notifications (no id) get no response body; still forward fire-and-forget.
  const isNotification = msg.id === undefined || msg.id === null;
  try {
    const responses = await post(msg);
    if (msg.method === "initialize") {
      for (const r of responses) {
        if (r?.result?.protocolVersion) protocolVersion = r.result.protocolVersion;
      }
    }
    for (const r of responses) {
      // Forward id-bearing responses; drop server-initiated requests we
      // cannot meaningfully answer (elicitation etc.).
      if (r && (r.id !== undefined || r.method === undefined)) send(r);
    }
  } catch (err) {
    if (!isNotification) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(err?.message ?? err) } });
    }
  }
}

process.stdin.on("end", () => process.exit(0));
// Fail fast if the token is missing on authed endpoints (empty string header omitted above).
if (!token) {
  console.error("[mcp-http-bridge] warning: no token (pass as argv[2] or $Z_AI_API_KEY)");
}
