// Read-only MCP inventory. Listing does not prove a tool can execute.
import { VerificationClient, verificationTimeout } from "./verification-client.mjs";

let client;
try {
  const timeout = verificationTimeout();
  client = new VerificationClient(undefined, undefined, { openTimeoutMs: timeout });
  const cursors = new Set();
  let cursor, count = 0;
  const name = value => {
    if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid inventory name");
    return value;
  };
  let toolCount = 0, outputCharacters = 0;
  for (let page = 0; ; page++) {
    if (page >= 20) throw new Error("Too many MCP pages");
    const result = await client.rpc("mcpServerStatus/list", cursor ? { cursor } : {}, timeout);
    const servers = Array.isArray(result) ? result : result?.data ?? result?.servers ?? result?.statuses;
    if (!Array.isArray(servers)) throw new Error("Invalid MCP inventory");
    for (const server of servers) {
      if (++count > 4096) throw new Error("Too many MCP servers");
      const tools = server?.tools ?? {};
      if (!tools || typeof tools !== "object") throw new Error("Invalid tool inventory");
      const names = Array.isArray(tools) ? tools.map(tool => name(tool?.name)) : Object.keys(tools).map(name);
      toolCount += names.length;
      if (names.length > 4096 || toolCount > 16384) throw new Error("Too many MCP tools");
      const line = `${name(server?.name)} :: ${names.join(", ")}`;
      outputCharacters += line.length + 1;
      if (outputCharacters > 2 * 1024 * 1024) throw new Error("MCP inventory output too large");
      console.log(line);
    }
    cursor = result?.nextCursor;
    if (cursor == null) break;
    if (typeof cursor !== "string" || !cursor || cursor.length > 4096 || cursors.has(cursor)) throw new Error("Invalid MCP pagination");
    cursors.add(cursor);
  }
  console.log(`MCP-STATUS-PASS (${count} servers; listing only, no tool/model invocation)`);
} catch {
  console.error("MCP-STATUS-FAIL: authentication, connection, timeout or invalid inventory; no tool/model invocation.");
  process.exitCode = 1;
} finally { client?.close(); }
