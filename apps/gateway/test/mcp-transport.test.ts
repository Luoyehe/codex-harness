import { afterEach, expect, it, vi } from "vitest";
import http, { type ServerResponse } from "node:http";
import { once } from "node:events";

const actualFetch = globalThis.fetch;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function fixture(tool: (request: any, response: ServerResponse, headers: http.IncomingHttpHeaders) => void, onInitialize?: (count: number) => void) {
  vi.resetModules();
  let initializations = 0;
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    if (request.method === "initialize") {
      initializations++;
      onInitialize?.(initializations);
      expect(req.headers["mcp-session-id"]).toBeUndefined();
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": `s${initializations}` });
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
  vi.stubGlobal("fetch", (_: unknown, init: RequestInit) => actualFetch(url, init));
  vi.stubEnv("Z_AI_API_KEY", "fixture-only");
  const { handleDynamicToolCall } = await import("../src/mcp-proxy.js");
  return { call: (signal?: AbortSignal) => handleDynamicToolCall({ namespace: "web-reader", tool: "read", arguments: {} }, { signal }), initializations: () => initializations };
}

it("gateway matches SSE terminal id after progress, wrong ids and split multiline CRLF/UTF-8 without EOF", async () => {
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
  await expect(call()).resolves.toMatchObject({ success: true, contentItems: [{ text: "结果" }] });
  await vi.waitFor(() => expect(closed).toBe(true));
});

it("gateway completes a matching MCP error without EOF and closes the stream", async () => {
  let closed = false;
  const { call } = await fixture((request, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.on("close", () => { closed = true; });
    res.write(`data: {"id":${request.id},"error":{"code":-1,"message":"private"}}\n\n`);
  });
  await expect(call()).rejects.toThrow("invalid or error response");
  await vi.waitFor(() => expect(closed).toBe(true));
});

it("gateway completes CR-only SSE events without waiting for another byte", async () => {
  const { call } = await fixture((request, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write(`data: {"id":${request.id},"result":{"content":[]}}\r\r`);
  });
  await expect(call()).resolves.toMatchObject({ success: true });
});

it("gateway rejects oversized declared responses before retaining their bodies", async () => {
  const { call } = await fixture((_request, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "content-length": 11 * 1024 * 1024 });
    res.write("data: ");
  });
  await expect(call()).rejects.toThrow(/exceeded/);
});

it.each([401, 404, 410])("gateway shares a single HTTP %s session recovery and ignores stale response session headers", async (status) => {
  const expired: ServerResponse[] = [];
  const run = await fixture((request, res, headers) => {
    if (headers["mcp-session-id"] === "s1") {
      expired.push(res);
      if (expired.length === 3) for (const response of expired) response.writeHead(status).end();
    } else {
      expect(headers["mcp-session-id"]).toBe("s2");
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "stale" });
      res.end(JSON.stringify({ id: request.id, result: { content: [{ type: "text", text: "ok" }] } }));
    }
  });
  await Promise.all([run.call(), run.call(), run.call()]);
  await run.call();
  expect(run.initializations()).toBe(2);
});

it("gateway aborts an open tool stream without replaying the request", async () => {
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
