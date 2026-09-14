/** Shared bounded streamable-HTTP transport for the stdio bridge and gateway.
 * A callback returns true only for the matching terminal JSON-RPC response.
 * Returning then cancels the response reader; SSE does not have to reach EOF.
 */
export class RemoteHttpError extends Error {
  constructor(status) { super(`remote HTTP ${status}`); this.status = status; }
}
export class ResponseTooLargeError extends Error {}
export function isSupportedProtocolVersion(version) {
  return ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(version);
}

export function isResponseFor(message, id) {
  return !!message && typeof message === "object" && !Array.isArray(message)
    && !Object.hasOwn(message, "method") && message.id === id
    && Object.hasOwn(message, "result") !== Object.hasOwn(message, "error");
}

export async function postMcp(endpoint, body, options) {
  const { token, session, onMessage, maxResponseBytes = 10 * 1024 * 1024, timeoutMs = 110_000, signal } = options;
  const response = await fetch(endpoint, {
    method: "POST", redirect: "error",
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "MCP-Protocol-Version": session.version,
      ...(session.id ? { "Mcp-Session-Id": session.id } : {}),
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new RemoteHttpError(response.status);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(`MCP response exceeded ${maxResponseBytes} bytes`);
  }
  const sessionId = response.headers.get("mcp-session-id") ?? "";
  if (!response.body) return sessionId;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = "";
  let skipLeadingLf = false;
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const isSse = type.includes("text/event-stream");
  let data = [];
  const line = async (value) => {
    if (value !== "") {
      if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
      return false;
    }
    const event = data.join("\n");
    data = [];
    if (!event || event === "[DONE]") return false;
    return await onMessage(JSON.parse(event));
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) throw new ResponseTooLargeError(`MCP response exceeded ${maxResponseBytes} bytes`);
      let decoded = decoder.decode(value, { stream: true });
      if (skipLeadingLf && decoded) {
        if (decoded.startsWith("\n")) decoded = decoded.slice(1);
        skipLeadingLf = false;
      }
      buffer += decoded;
      if (!isSse) continue;
      let match;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        // CR is itself a complete SSE line terminator. Process it now, then
        // ignore an optional LF in the next chunk; waiting for that LF would
        // hang a valid CR-only terminal event on an open stream.
        if (match[0] === "\r" && match.index === buffer.length - 1) skipLeadingLf = true;
        const value = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (await line(value)) return sessionId;
      }
    }
    buffer += decoder.decode();
    if (isSse) {
      if (buffer && await line(buffer.replace(/\r$/, ""))) return sessionId;
      await line("");
    } else if (buffer.trim()) {
      if (!type.includes("application/json") && !type.includes("+json")) throw new Error("unexpected response content type");
      await onMessage(JSON.parse(buffer));
    }
    return sessionId;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
