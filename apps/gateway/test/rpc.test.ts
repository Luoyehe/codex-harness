import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { AppServerConnection, initialize, type AppServerHandlers } from "../src/codex/rpc.js";

/**
 * attach() lets tests drive the JSONL transport with fake streams instead of
 * a real `codex app-server` process.
 */
function makeFake(overrides: Partial<AppServerHandlers> = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const handlers: AppServerHandlers = {
    onNotification: vi.fn(),
    onServerRequest: vi.fn(async () => ({})),
    onExit: vi.fn(),
    onStderr: vi.fn(),
    ...overrides,
  };
  const conn = new AppServerConnection("fake", [], {}, handlers);
  conn.attach(stdin, stdout, stderr);
  const frames: any[] = [];
  stdin.on("data", (c) => {
    for (const line of String(c).split("\n")) {
      if (line.trim()) frames.push(JSON.parse(line));
    }
  });
  const reply = (frame: unknown) => stdout.write(JSON.stringify(frame) + "\n");
  return { conn, handlers, frames, reply, stderr, writeRaw: (s: string) => stdout.write(s) };
}

describe("AppServerConnection", () => {
  it("sends requests with incrementing ids and resolves responses", async () => {
    const { conn, frames, reply } = makeFake();
    const p1 = conn.request("account/read");
    const p2 = conn.request<{ models: unknown[] }>("model/list");

    expect(frames[0]).toMatchObject({ id: 1, method: "account/read" });
    expect(frames[1]).toMatchObject({ id: 2, method: "model/list" });

    reply({ id: 1, result: { signedIn: false } });
    reply({ id: 2, result: { models: [] } });
    await expect(p1).resolves.toEqual({ signedIn: false });
    await expect(p2).resolves.toEqual({ models: [] });
  });

  it("rejects pending requests on error responses", async () => {
    const { conn, reply } = makeFake();
    const promise = conn.request("thread/start", {});
    reply({ id: 1, error: { code: -32001, message: "nope" } });
    await expect(promise).rejects.toThrow("nope");
  });

  it("routes notifications to the handler", () => {
    const { handlers, reply } = makeFake();
    reply({ method: "item/started", params: { item: { id: "a" } } });
    expect(handlers.onNotification).toHaveBeenCalledWith("item/started", { item: { id: "a" } });
  });

  it("forwards non-JSON lines to onStderr", () => {
    const { handlers, writeRaw } = makeFake();
    writeRaw("this is not json\n");
    expect(handlers.onStderr).toHaveBeenCalledWith(expect.stringContaining("this is not json"));
  });

  it("answers server-initiated requests with the handler result", async () => {
    const { reply, frames } = makeFake({
      onServerRequest: async () => ({ decision: "decline" }),
    });
    reply({ id: 41, method: "item/fileChange/requestApproval", params: { changes: [] } });
    await vi.waitFor(() => {
      const last = frames[frames.length - 1];
      expect(last).toMatchObject({ id: 41, result: { decision: "decline" } });
    });
  });

  it("answers server-initiated requests with an error when the handler throws", async () => {
    const { reply, frames } = makeFake({
      onServerRequest: async () => {
        throw new Error("client refused");
      },
    });
    reply({ id: 42, method: "item/commandExecution/requestApproval", params: {} });
    await vi.waitFor(() => {
      const last = frames[frames.length - 1];
      expect(last).toMatchObject({ id: 42, error: { message: "client refused" } });
    });
  });

  it("initialize performs handshake then sends the initialized notification", async () => {
    const { conn, reply, frames } = makeFake();
    const promise = initialize(conn, { name: "t", title: "t", version: "0" });
    reply({ id: 1, result: {} });
    await promise;
    expect(frames[0]).toMatchObject({ id: 1, method: "initialize" });
    expect(frames[1]).toMatchObject({ method: "initialized" });
  });
});
