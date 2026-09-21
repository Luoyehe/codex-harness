import { expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { AppServerConnection, AppServerRequestError, RPC_LIMITS } from "../src/codex/rpc.js";

function fixture() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const conn = new AppServerConnection("fake", [], {}, {
    onNotification() {}, onServerRequest: async () => ({}), onExit() {}, onStderr() {},
  }, { requestTimeoutMs: 10 });
  conn.attach(stdin, stdout);
  const frames: any[] = [];
  stdin.on("data", chunk => {
    for (const line of String(chunk).split("\n")) if (line.trim()) frames.push(JSON.parse(line));
  });
  return { conn, frames, stdout, reply: (frame: unknown) => stdout.write(JSON.stringify(frame) + "\n") };
}

it.each([false, true])("keeps native MCP pending past the local deadline and accepts its late reply (wrapped: %s)", async wrapped => {
  vi.useFakeTimers();
  const f = fixture();
  const params = { threadId: "T", server: "web-reader", tool: "read", arguments: {} };
  let settled = false;
  const native = (wrapped
    ? f.conn.request("gateway/dispatch", { method: "mcpServer/tool/call", params, clientId: "browser" })
    : f.conn.request("mcpServer/tool/call", params)).then(result => { settled = true; return result; }, error => { settled = true; return error; });
  const normal = expect(f.conn.request("model/list")).rejects.toMatchObject({ delivery: "unknown", message: expect.stringContaining("timed out") });
  try {
    await vi.advanceTimersByTimeAsync(120_000);
    await normal;
    expect(settled).toBe(false);
    f.reply({ id: f.frames[0].id, result: { content: [{ type: "text", text: "late result" }] } });
    await expect(native).resolves.toEqual({ content: [{ type: "text", text: "late result" }] });
  } finally { await f.conn.kill(); await native.catch(() => {}); vi.useRealTimers(); }
});

it("retains the native pending hard cap across local deadlines and releases only settled calls", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const pending = Array.from({ length: RPC_LIMITS.pending }, () => f.conn.request("mcpServer/tool/call", {}).catch(error => error));
  try {
    for (let round = 0; round < 3; round++) {
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(f.conn.request("mcpServer/tool/call", {})).rejects.toBeInstanceOf(AppServerRequestError);
      expect(f.frames).toHaveLength(RPC_LIMITS.pending);
    }
    const interrupt = f.conn.request("turn/interrupt", { threadId: "T", turnId: "turn" });
    f.reply({ id: f.frames.at(-1).id, result: {} });
    await interrupt;
    f.reply({ id: f.frames[0].id, error: { code: -32000, message: "native server tool timeout" } });
    expect(await pending[0]).toMatchObject({ message: expect.stringContaining("native server tool timeout") });
    const recovered = f.conn.request("mcpServer/tool/call", {}).catch(error => error);
    await expect(f.conn.request("mcpServer/tool/call", {})).rejects.toBeInstanceOf(AppServerRequestError);
    f.reply({ id: f.frames.at(-1).id, result: { content: [] } });
    await expect(recovered).resolves.toEqual({ content: [] });
  } finally { await f.conn.kill(); await Promise.all(pending); vi.useRealTimers(); }
});

it.each(["eof", "stop"])("settles a native MCP request on connection termination: %s", async mode => {
  vi.useFakeTimers();
  const f = fixture();
  let settled = false;
  const pending = f.conn.request("mcpServer/tool/call", {}).then(() => { settled = true; return "unexpected success"; }, error => { settled = true; return error; });
  try {
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
    if (mode === "eof") { f.stdout.end(); await vi.advanceTimersByTimeAsync(0); }
    else await f.conn.kill();
    expect(await pending).toMatchObject({ delivery: "unknown", message: expect.stringMatching(/closed|ended/) });
  } finally { await f.conn.kill(); await pending; vi.useRealTimers(); }
});
