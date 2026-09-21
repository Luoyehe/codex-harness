import { afterEach, expect, it, vi } from "vitest";
import http, { type ServerResponse } from "node:http";
import { once } from "node:events";
import { isResponseFor, isSupportedProtocolVersion, postMcp } from "../../../deploy/providers/zhipu-coding-plan/mcp-http-transport.mjs";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function fixture(tool: (request: any, response: ServerResponse, headers: http.IncomingHttpHeaders) => void) {
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    if (request.method === "initialize") {
      expect(req.headers["mcp-session-id"]).toBeUndefined();
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
      res.end(JSON.stringify({ id: request.id, result: { protocolVersion: "2025-06-18" } }));
    } else if (request.method === "notifications/initialized") res.writeHead(202).end();
    else tool(request, res, req.headers);
  });
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  // Some Windows configurations allocate ephemeral ports from fetch's
  // forbidden-port list (e.g. 6667). Select an allowed listener explicitly.
  for (;;) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as any).port;
    if (port > 10080) break;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
  const session = { id: "", version: "2025-06-18" };
  let nextId = 1;
  // Exercise the shared production transport directly. The gateway no longer
  // owns an HTTP session/proxy; native per-thread execution is covered by
  // mcp-proxy.test.ts and bridge session recovery by the real bridge suite.
  async function request(method: string, params: unknown, signal?: AbortSignal, maxResponseBytes?: number) {
    const id = nextId++;
    let terminal: any;
    const responseSession = await postMcp(url, { jsonrpc: "2.0", id, method, params }, {
      token: "fixture", session, signal, maxResponseBytes,
      onMessage(message) {
        if (!isResponseFor(message, id)) return false;
        terminal = message;
        return true;
      },
    });
    if (!terminal || Object.hasOwn(terminal, "error")) throw new Error("invalid or error response");
    return { result: terminal.result, responseSession };
  }
  const initialized = await request("initialize", { protocolVersion: session.version, capabilities: {}, clientInfo: { name: "transport-test", version: "1" } });
  expect(isSupportedProtocolVersion(initialized.result?.protocolVersion)).toBe(true);
  session.version = initialized.result.protocolVersion;
  session.id = initialized.responseSession;
  await postMcp(url, { jsonrpc: "2.0", method: "notifications/initialized" }, {
    token: "fixture", session, onMessage: () => false,
  });
  return { call: async (signal?: AbortSignal, maxResponseBytes?: number) => {
    const { result } = await request("tools/call", { name: "read", arguments: {} }, signal, maxResponseBytes);
    if (!result || !Array.isArray(result.content)) throw new Error("invalid tools/call result");
    return result;
  } };
}

it("shared transport matches SSE terminal id after progress, wrong ids and split multiline CRLF/UTF-8 without EOF", async () => {
  let closed = false;
  const { call } = await fixture((request, res, headers) => {
    expect(headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(headers["mcp-session-id"]).toBe("s1");
    res.setHeader("content-type", "text/event-stream");
    res.on("close", () => { closed = true; });
    res.write('data: {"method":"notifications/progress","params":{}}\r\n\r\n');
    res.write('data: {"id":999,"result":{"content":[]}}\r\n\r\n');
    const event = Buffer.from(`data: {"id":${request.id},\r\ndata: "result":{"content":[{"type":"text","text":"结果"}]}}\r\n\r\n`);
    const split = event.indexOf(Buffer.from("结")) + 1;
    res.write(event.subarray(0, split));
    setImmediate(() => { res.write(event.subarray(split, event.length - 1)); setImmediate(() => res.write(event.subarray(event.length - 1))); });
  });
  await expect(call()).resolves.toMatchObject({ content: [{ type: "text", text: "结果" }] });
  await vi.waitFor(() => expect(closed).toBe(true));
});

it("shared transport completes a matching MCP error without EOF and closes the stream", async () => {
  let closed = false;
  const { call } = await fixture((request, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.on("close", () => { closed = true; });
    res.write(`data: {"id":${request.id},"error":{"code":-1,"message":"private"}}\n\n`);
  });
  await expect(call()).rejects.toThrow("invalid or error response");
  await vi.waitFor(() => expect(closed).toBe(true));
});

it("shared transport completes CR-only SSE events without waiting for another byte", async () => {
  const { call } = await fixture((request, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write(`data: {"id":${request.id},"result":{"content":[]}}\r\r`);
  });
  await expect(call()).resolves.toEqual({ content: [] });
});

it("shared transport rejects oversized declared responses before retaining their bodies", async () => {
  const { call } = await fixture((_request, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "content-length": 11 * 1024 * 1024 });
    res.write("data: ");
  });
  await expect(call()).rejects.toThrow(/exceeded/);
});

it("shared transport bounds undeclared stream bytes and cancels an oversized open stream", async () => {
  let closed = false;
  const { call } = await fixture((_request, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.on("close", () => { closed = true; });
    res.write(`data: ${"x".repeat(1024)}`);
  });
  await expect(call(undefined, 1024)).rejects.toThrow(/exceeded/);
  await vi.waitFor(() => expect(closed).toBe(true));
});

it("shared transport aborts an open tool stream without replaying the request", async () => {
  let closed = false;
  let calls = 0;
  const { call } = await fixture((_request, res) => {
    calls++;
    res.setHeader("content-type", "text/event-stream");
    res.on("close", () => { closed = true; });
    res.write('data: {"method":"notifications/progress"}\n\n');
  });
  const controller = new AbortController();
  const assertion = expect(call(controller.signal)).rejects.toThrow();
  await vi.waitFor(() => expect(calls).toBe(1));
  controller.abort();
  await assertion;
  await vi.waitFor(() => expect(closed).toBe(true));
  expect(calls).toBe(1);
});
