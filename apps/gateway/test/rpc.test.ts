import { describe, expect, it, vi } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppServerConnection, AppServerRequestError, RPC_LIMITS, appServerEnvironment, initialize, isDefiniteAppServerRejection, parseProcessStat, type AppServerHandlers } from "../src/codex/rpc.js";

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
  return { conn, handlers, frames, reply, stdin, stdout, stderr, writeRaw: (s: string) => stdout.write(s) };
}

describe("AppServerConnection", () => {
  it("parses only complete proc identities and treats malformed cleanup metadata as failure", () => {
    const fields = ["t", "1", "123", ...Array.from({ length: 16 }, () => "0"), "456"];
    expect(parseProcessStat(42, `42 (fixture ) name) ${fields.join(" ")}`)).toEqual({
      identity: { pid: 42, start: "456" }, parent: 1, group: 123, live: true,
    });
    for (const value of ["", "42 fixture", "42 (fixture) S 1 nope", `42 (fixture) ${["S", "1", "2", ...Array.from({ length: 16 }, () => "0"), "bad"].join(" ")}`]) {
      expect(() => parseProcessStat(42, value)).toThrow("proc stat");
    }
  });
  it("distinguishes local pre-send and explicit rejection from uncertain delivery", () => {
    expect(isDefiniteAppServerRejection(new AppServerRequestError("local queue limit"))).toBe(true);
    expect(isDefiniteAppServerRejection(new AppServerRequestError("upstream rejected", { code: -32000 }))).toBe(true);
    expect(isDefiniteAppServerRejection(new AppServerRequestError("worker unknown", { code: -32000, data: { delivery: "unknown" } }))).toBe(false);
    expect(isDefiniteAppServerRejection(Object.assign(new Error("transport lost"), { delivery: "unknown" }))).toBe(false);
  });
  it("caps oversized drain bytes even without a newline", async () => {
    const fake = makeFake();
    const request = fake.conn.request("thread/read").catch((error) => error);
    fake.writeRaw('{"id":1,"result":"');
    const chunk = "x".repeat(65536);
    for (let bytes = 0; bytes <= RPC_LIMITS.discardBytes; bytes += chunk.length) fake.writeRaw(chunk);
    expect(await request).toBeInstanceOf(Error);
    expect(fake.handlers.onExit).toHaveBeenCalledOnce();
    await fake.conn.kill();
  });
  it("caps drain time and does not accept an oversized notification as a response", async () => {
    vi.useFakeTimers();
    const fake = makeFake();
    const request = fake.conn.request("thread/read").catch((error) => error);
    try {
      fake.writeRaw('{"id":1,"result":"' + "x".repeat(RPC_LIMITS.frameBytes));
      expect(fake.handlers.onExit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(RPC_LIMITS.discardMs);
      expect(await request).toMatchObject({ message: expect.stringContaining("drain timed out") });
      expect(fake.handlers.onExit).toHaveBeenCalledOnce();
    } finally { await fake.conn.kill(); vi.useRealTimers(); }
    const notification = makeFake();
    notification.writeRaw('{"method":"event","params":"' + "x".repeat(RPC_LIMITS.frameBytes) + '"}\n');
    expect(notification.handlers.onExit).toHaveBeenCalledOnce();
    expect(notification.handlers.onNotification).not.toHaveBeenCalled();
    await notification.conn.kill();
  });
  it.each([false, true])("discards only an oversized response and continues the same transport (id last: %s)", async (idLast) => {
    const fake = makeFake({ onTransportLost: vi.fn() });
    const history = fake.conn.request("thread/read").catch((error) => error);
    const other = fake.conn.request("model/list").catch((error) => error);
    const payload = '"' + "x".repeat(37 * 1024 * 1024) + '"';
    const line = idLast ? `{"result":{"id":2,"text":${payload}},"id":1}\r\n` : `{"id":1,"result":{"text":${payload}}}\n`;
    for (let offset = 0; offset < line.length; offset += 65536) fake.writeRaw(line.slice(offset, offset + 65536));
    expect(await history).toMatchObject({ errorCode: "RESPONSE_TOO_LARGE", delivery: "unknown" });
    expect(fake.handlers.onTransportLost).not.toHaveBeenCalled();
    expect(fake.handlers.onExit).not.toHaveBeenCalled();
    fake.reply({ id: 2, result: { data: [] } });
    await expect(other).resolves.toEqual({ data: [] });
    await fake.conn.kill();
  });
  it("preserves fixed reverse-admission rejection metadata on the real RPC wire", async () => {
    const fake = makeFake({ onServerRequest: async () => { throw Object.assign(new Error("busy"), { delivery: "rejected" }); } });
    fake.reply({ id: "auto-compact-1", method: "gateway/autoCompact", params: { threadId: "t1" } });
    await vi.waitFor(() => expect(fake.frames).toHaveLength(1));
    expect(fake.frames[0]).toMatchObject({ id: "auto-compact-1", error: { data: { delivery: "rejected" } } });
    await fake.conn.kill();
  });
  it("reports unexpected transport loss once, before cleanup, but not for deliberate stop", async () => {
    const lost = vi.fn();
    const failed = makeFake({ onTransportLost: lost });
    failed.stdout.destroy(new Error("synthetic pipe loss"));
    await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce());
    await failed.conn.kill();
    expect(lost).toHaveBeenCalledOnce();

    const intentional = makeFake({ onTransportLost: lost });
    await intentional.conn.kill();
    intentional.stdout.end();
    expect(lost).toHaveBeenCalledOnce();
  });

  it.each([0, 17])("requires the cleanup owner's exact exit status, independent of stdout claims (exit %s)", async (code) => {
    const onExit = vi.fn();
    const onCleanupUnconfirmed = vi.fn();
    const conn = new AppServerConnection(process.execPath, ["-e", `console.log(JSON.stringify({method:"cleanup/complete",params:{clean:true}}));setTimeout(()=>process.exit(${code}),100)`], {}, {
      onNotification() {}, onServerRequest: async () => ({}), onExit, onStderr() {}, onCleanupUnconfirmed,
    }, { cleanExitCode: 0 });
    conn.spawn();
    if (code === 0) {
      await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce());
      await conn.kill();
      expect(onCleanupUnconfirmed).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(onCleanupUnconfirmed).toHaveBeenCalledOnce());
      await expect(conn.kill()).rejects.toThrow("cleanup was not confirmed");
      expect(onExit).not.toHaveBeenCalled();
    }
  });

  it("waits for a cleanup owner to finish after EOF instead of killing its authority", async () => {
    let ready = false;
    let settled = false;
    const conn = new AppServerConnection(process.execPath, ["-e", 'process.stdin.resume();process.stdin.on("end",()=>setTimeout(()=>process.exit(0),150));console.log(JSON.stringify({method:"ready"}));'], {}, {
      onNotification() { ready = true; }, onServerRequest: async () => ({}), onExit() {}, onStderr() {},
    }, { cleanExitCode: 0, terminateGraceMs: 1 });
    conn.spawn();
    await vi.waitFor(() => expect(ready).toBe(true));
    const completion = conn.kill().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    await completion;
  });

  it.runIf(process.platform === "linux")("fails closed if the cleanup owner is killed, even after a fake success frame", async () => {
    let ownerPid = 0;
    const onExit = vi.fn();
    const onCleanupUnconfirmed = vi.fn();
    const conn = new AppServerConnection(process.execPath, ["-e", 'console.log(JSON.stringify({method:"cleanup/complete",params:{pid:process.pid,clean:true}}));setInterval(()=>{},1000);'], {}, {
      onNotification: (_method, params: any) => { ownerPid = params.pid; }, onServerRequest: async () => ({}), onExit, onStderr() {}, onCleanupUnconfirmed,
    }, { cleanExitCode: 0 });
    conn.spawn();
    await vi.waitFor(() => expect(ownerPid).toBeGreaterThan(0));
    process.kill(ownerPid, "SIGKILL");
    await vi.waitFor(() => expect(onCleanupUnconfirmed).toHaveBeenCalledOnce());
    await expect(conn.kill()).rejects.toThrow("cleanup was not confirmed");
    expect(onExit).not.toHaveBeenCalled();
  });

  it("supports a bounded per-transport timeout without changing long-lived command semantics", async () => {
    vi.useFakeTimers();
    const handlers = { onNotification() {}, onServerRequest: async () => ({}), onExit() {}, onStderr() {} };
    const conn = new AppServerConnection("fake", [], {}, handlers, { requestTimeoutMs: 10 });
    conn.attach(new PassThrough(), new PassThrough());
    const timed = expect(conn.request("model/list")).rejects.toMatchObject({
      message: expect.stringContaining("timed out after 0.01s"), delivery: "unknown",
    });
    let commandSettled = false;
    const command = conn.request("command/exec").catch(() => { commandSettled = true; });
    try {
      await vi.advanceTimersByTimeAsync(10);
      await timed;
      expect(commandSettled).toBe(false);
    } finally { await conn.kill(); await command; vi.useRealTimers(); }
    for (const requestTimeoutMs of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
      expect(() => new AppServerConnection("fake", [], {}, handlers, { requestTimeoutMs })).toThrow(/positive bounded integer/);
    }
  });
  it("scrubs gateway control-plane credentials, including case variants and explicit overrides", () => {
    vi.stubEnv("Gateway_Token", "do-not-inherit");
    vi.stubEnv("CODEX_HARNESS_MANAGED_WORKER", "1");
    try {
      const env = appServerEnvironment({ GATEWAY_TOKEN: "also-remove", EDGE_PASSWORD: "secret", SUDO_USER: "root", AUTHELIA_SECRET: "secret", Z_AI_API_KEY: "provider-worker-key", CODEX_HOME: "/worker/home" });
      expect(Object.keys(env).some((key) => /^(GATEWAY_|EDGE_|SUDO_|AUTHELIA_)/i.test(key))).toBe(false);
      expect(env.Z_AI_API_KEY).toBe("provider-worker-key");
      expect(env.CODEX_HOME).toBe("/worker/home");
      expect(env.CODEX_HARNESS_MANAGED_WORKER).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });

  it("preserves explicit upstream error delivery metadata", async () => {
    const { conn, reply } = makeFake();
    const request = conn.request("turn/start");
    reply({ id: 1, error: { code: -32000, message: "unknown", data: { delivery: "unknown" } } });
    await expect(request).rejects.toMatchObject({ rpcError: { code: -32000, data: { delivery: "unknown" } } });
  });

  it("preserves the private worker's bounded-history error code through the outer RPC", async () => {
    const { conn, reply } = makeFake();
    const request = conn.request("gateway/dispatch");
    reply({ id: 1, error: { code: -32000, message: "response too large", data: { errorCode: "RESPONSE_TOO_LARGE", delivery: "unknown" } } });
    await expect(request).rejects.toMatchObject({ errorCode: "RESPONSE_TOO_LARGE", rpcError: { data: { delivery: "unknown" } } });
    await conn.kill();
  });

  it("keeps UTF-8 decoder state and handles a following legal frame after oversized drain", async () => {
    const fake = makeFake();
    const oversized = fake.conn.request("thread/read").catch((error) => error);
    fake.writeRaw('{"id":1,"result":"' + "x".repeat(RPC_LIMITS.frameBytes));
    const suffix = Buffer.from('中文 😀 \\" nested id:2 \\""}\r\n');
    for (const byte of suffix) fake.stdout.write(Buffer.from([byte]));
    expect(await oversized).toMatchObject({ errorCode: "RESPONSE_TOO_LARGE" });
    const next = fake.conn.request("model/list");
    fake.reply({ id: 2, result: { text: "中文 😀" } });
    await expect(next).resolves.toEqual({ text: "中文 😀" });
    expect(fake.handlers.onExit).not.toHaveBeenCalled();
    await fake.conn.kill();
  });

  it("bounds pending requests while reserving control admission", async () => {
    const { conn, frames } = makeFake();
    const requests = Array.from({ length: RPC_LIMITS.pending }, () => conn.request("command/exec").catch((error) => error));
    await expect(conn.request("model/list")).rejects.toBeInstanceOf(AppServerRequestError);
    const control = conn.request("turn/interrupt").catch((error) => error);
    expect(frames).toHaveLength(RPC_LIMITS.pending + 1);
    await conn.kill();
    await Promise.all([...requests, control]);
  });

  it.each([
    ["nested interrupt", "gateway/dispatch", { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" }, clientId: "browser-1" }],
    ["nested terminal terminate", "gateway/dispatch", { method: "terminal/terminate", params: { processId: "terminal-1" }, clientId: "browser-1" }],
    ["nested terminal resize", "gateway/dispatch", { method: "terminal/resize", params: { processId: "terminal-1", rows: 24, cols: 80 }, clientId: "browser-1" }],
    ["worker disconnect", "gateway/disconnect", { clientId: "browser-1" }],
    ["worker answer", "gateway/answer", { requestId: "approval-1", payload: { decision: "decline" } }],
    ["worker reconnect", "gateway/connect", { clientId: "browser-1" }],
  ])("reserves private-worker pending capacity for %s", async (_label, method, params) => {
    const { conn, frames } = makeFake();
    const requests = Array.from({ length: RPC_LIMITS.pending }, (_, index) => conn.request("gateway/dispatch", {
      method: "command/exec",
      params: { processId: `bulk-${index}` },
      clientId: "browser-1",
    }).catch((error) => error));
    await expect(conn.request("gateway/dispatch", { method: "model/list", params: {}, clientId: "browser-1" })).rejects.toBeInstanceOf(AppServerRequestError);
    const control = conn.request(method, params).catch((error) => error);
    expect(frames).toHaveLength(RPC_LIMITS.pending + 1);
    await conn.kill();
    await Promise.all([...requests, control]);
  });

  it("keeps a wrapped long-lived terminal request timeout-exempt", async () => {
    vi.useFakeTimers();
    const handlers = { onNotification() {}, onServerRequest: async () => ({}), onExit() {}, onStderr() {} };
    const conn = new AppServerConnection("fake", [], {}, handlers, { requestTimeoutMs: 10 });
    conn.attach(new PassThrough(), new PassThrough());
    let settled = false;
    const terminal = conn.request("gateway/dispatch", {
      method: "command/exec", params: { processId: "terminal-1" }, clientId: "browser-1",
    }).catch(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(false);
    } finally {
      await conn.kill();
      await terminal;
      vi.useRealTimers();
    }
  });

  it("backpressures stdin, prioritizes control, and expires unsent queued requests without executing them", async () => {
    vi.useFakeTimers();
    const written: any[] = [];
    const callbacks: Array<(error?: Error) => void> = [];
    const stdin = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { written.push(JSON.parse(String(chunk))); callbacks.push(callback); } });
    const stdout = new PassThrough();
    const conn = new AppServerConnection("fake", [], {}, { onNotification() {}, onServerRequest: async () => ({}), onExit() {}, onStderr() {} });
    conn.attach(stdin, stdout);
    try {
      const processId = "term-00000000-0000-4000-8000-000000000000";
      const first = conn.request("command/exec", { processId }).catch((error) => error);
      const expired = conn.request("model/list").catch((error) => error);
      const control = conn.request("command/exec/terminate", { processId }).catch((error) => error);
      expect(written.map((frame) => frame.method)).toEqual(["command/exec"]);
      callbacks.shift()!();
      await vi.advanceTimersByTimeAsync(0);
      expect(written.map((frame) => frame.method)).toEqual(["command/exec", "command/exec/terminate"]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await expired).toBeInstanceOf(AppServerRequestError);
      callbacks.shift()!();
      await vi.advanceTimersByTimeAsync(0);
      expect(written.some((frame) => frame.method === "model/list")).toBe(false);
      await conn.kill();
      await Promise.all([first, control]);
    } finally { await conn.kill(); vi.useRealTimers(); }
  });

  it.each([
    {
      createMethod: "command/exec",
      createParams: { processId: "term-11111111-1111-4111-8111-111111111111" },
      controlMethod: "command/exec/terminate",
      controlParams: { processId: "term-11111111-1111-4111-8111-111111111111" },
    },
    {
      createMethod: "turn/start",
      createParams: { threadId: "thread-1", input: [] },
      controlMethod: "turn/interrupt",
      controlParams: { threadId: "thread-1", turnId: "turn-1" },
    },
  ])("does not prioritize $controlMethod ahead of an earlier same-resource $createMethod", async ({ createMethod, createParams, controlMethod, controlParams }) => {
    const written: any[] = [];
    const callbacks: Array<(error?: Error) => void> = [];
    const stdin = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { written.push(JSON.parse(String(chunk))); callbacks.push(callback); } });
    const conn = new AppServerConnection("fake", [], {}, { onNotification() {}, onServerRequest: async () => ({}), onExit() {}, onStderr() {} });
    conn.attach(stdin, new PassThrough());
    const blocker = conn.request("model/list").catch((error) => error);
    const create = conn.request(createMethod, createParams).catch((error) => error);
    const control = conn.request(controlMethod, controlParams).catch((error) => error);
    try {
      expect(written.map((frame) => frame.method)).toEqual(["model/list"]);
      callbacks.shift()!();
      await vi.waitFor(() => expect(written).toHaveLength(2));
      expect(written.map((frame) => frame.method)).toEqual(["model/list", createMethod]);
      callbacks.shift()!();
      await vi.waitFor(() => expect(written).toHaveLength(3));
      expect(written.map((frame) => frame.method)).toEqual(["model/list", createMethod, controlMethod]);
    } finally {
      await conn.kill();
      await Promise.all([blocker, create, control]);
    }
  });

  it("prioritizes wrapped controls without overtaking earlier work for the same nested resource", async () => {
    const written: any[] = [];
    const callbacks: Array<(error?: Error) => void> = [];
    const stdin = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { written.push(JSON.parse(String(chunk))); callbacks.push(callback); } });
    const conn = new AppServerConnection("fake", [], {}, { onNotification() {}, onServerRequest: async () => ({}), onExit() {}, onStderr() {} });
    conn.attach(stdin, new PassThrough());
    const blocker = conn.request("gateway/dispatch", { method: "model/list", params: {}, clientId: "browser-1" }).catch((error) => error);
    const create = conn.request("gateway/dispatch", { method: "turn/start", params: { threadId: "thread-1", input: [] }, clientId: "browser-1" }).catch((error) => error);
    const other = conn.request("gateway/dispatch", { method: "thread/read", params: { threadId: "thread-2" }, clientId: "browser-1" }).catch((error) => error);
    const interrupt = conn.request("gateway/dispatch", { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" }, clientId: "browser-1" }).catch((error) => error);
    try {
      expect(written.map((frame) => frame.params?.method)).toEqual(["model/list"]);
      callbacks.shift()!();
      await vi.waitFor(() => expect(written).toHaveLength(2));
      // The interrupt bypasses unrelated thread/read, but turn/start for the
      // same thread is a strict predecessor and therefore goes first.
      expect(written.map((frame) => frame.params?.method)).toEqual(["model/list", "turn/start"]);
      callbacks.shift()!();
      await vi.waitFor(() => expect(written).toHaveLength(3));
      expect(written.map((frame) => frame.params?.method)).toEqual(["model/list", "turn/start", "turn/interrupt"]);
    } finally {
      await conn.kill();
      await Promise.all([blocker, other, create, interrupt]);
    }
  });

  it("prioritizes the wrapped terminal alias only after its same-process creator", async () => {
    const written: any[] = [];
    const callbacks: Array<(error?: Error) => void> = [];
    const stdin = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { written.push(JSON.parse(String(chunk))); callbacks.push(callback); } });
    const conn = new AppServerConnection("fake", [], {}, { onNotification() {}, onServerRequest: async () => ({}), onExit() {}, onStderr() {} });
    conn.attach(stdin, new PassThrough());
    const processId = "terminal-22222222-2222-4222-8222-222222222222";
    const blocker = conn.request("gateway/dispatch", { method: "model/list", params: {}, clientId: "browser-1" }).catch((error) => error);
    const create = conn.request("gateway/dispatch", { method: "terminal/exec", params: { processId }, clientId: "browser-1" }).catch((error) => error);
    const other = conn.request("gateway/dispatch", { method: "thread/read", params: { threadId: "thread-2" }, clientId: "browser-1" }).catch((error) => error);
    const terminate = conn.request("gateway/dispatch", { method: "terminal/terminate", params: { processId }, clientId: "browser-1" }).catch((error) => error);
    try {
      callbacks.shift()!();
      await vi.waitFor(() => expect(written).toHaveLength(2));
      expect(written.map((frame) => frame.params?.method)).toEqual(["model/list", "terminal/exec"]);
      callbacks.shift()!();
      await vi.waitFor(() => expect(written).toHaveLength(3));
      expect(written.map((frame) => frame.params?.method)).toEqual(["model/list", "terminal/exec", "terminal/terminate"]);
    } finally {
      await conn.kill();
      await Promise.all([blocker, create, other, terminate]);
    }
  });

  it("does not retain oversized resource identifiers in private-worker queue metadata", async () => {
    const stdin = new Writable({ highWaterMark: 1, write() { /* deliberately stalled */ } });
    const conn = new AppServerConnection("fake", [], {}, { onNotification() {}, onServerRequest: async () => ({}), onExit() {}, onStderr() {} });
    conn.attach(stdin, new PassThrough());
    const blocker = conn.request("gateway/dispatch", { method: "model/list", params: {}, clientId: "browser-1" }).catch((error) => error);
    const invalid = conn.request("gateway/dispatch", {
      method: "terminal/terminate", params: { processId: "x".repeat(4096) }, clientId: "browser-1",
    }).catch((error) => error);
    try {
      expect((conn as any).writeQueue).toHaveLength(1);
      expect((conn as any).writeQueue[0].resources).toEqual([]);
    } finally {
      await conn.kill();
      await Promise.all([blocker, invalid]);
      stdin.destroy();
    }
  });

  it("keeps byte capacity for a wrapped emergency control under bulk backpressure", async () => {
    const stdin = new Writable({ highWaterMark: 1, write() { /* deliberately stalled */ } });
    const conn = new AppServerConnection("fake", [], {}, { onNotification() {}, onServerRequest: async () => ({}), onExit() {}, onStderr() {} });
    conn.attach(stdin, new PassThrough());
    const first = conn.request("gateway/dispatch", { method: "thread/read", params: { text: "x".repeat(35 * 1024 * 1024) }, clientId: "browser-1" }).catch((error) => error);
    const second = conn.request("gateway/dispatch", { method: "thread/read", params: { text: "x".repeat(12.5 * 1024 * 1024) }, clientId: "browser-1" }).catch((error) => error);
    const padding = "x".repeat(768 * 1024);
    await expect(conn.request("gateway/dispatch", { method: "thread/read", params: { text: padding }, clientId: "browser-1" })).rejects.toBeInstanceOf(AppServerRequestError);
    const control = conn.request("gateway/dispatch", {
      method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1", padding }, clientId: "browser-1",
    }).catch((error) => error);
    await conn.kill();
    await Promise.all([first, second, control]);
    stdin.destroy();
  });

  it("rejects oversized outbound frames before writing and bounds unterminated input", async () => {
    const { conn, frames, handlers, writeRaw } = makeFake();
    await expect(conn.request("too-big", { text: "x".repeat(RPC_LIMITS.frameBytes) })).rejects.toBeInstanceOf(AppServerRequestError);
    expect(frames).toHaveLength(0);
    writeRaw("x".repeat(RPC_LIMITS.frameBytes + 1));
    expect(handlers.onExit).toHaveBeenCalledTimes(1);
  });

  it("bounds queued plus native writable bytes under a stalled consumer", async () => {
    let writes = 0;
    const stdin = new Writable({ highWaterMark: 1, write() { writes++; /* deliberately stalled */ } });
    const conn = new AppServerConnection("fake", [], {}, { onNotification() {}, onServerRequest: async () => ({}), onExit() {}, onStderr() {} });
    conn.attach(stdin, new PassThrough());
    const payload = { text: "x".repeat(25 * 1024 * 1024) };
    const first = conn.request("command/exec", payload).catch((error) => error);
    await expect(conn.request("command/exec", payload)).rejects.toBeInstanceOf(AppServerRequestError);
    expect(writes).toBe(1);
    expect(stdin.writableLength).toBeLessThan(RPC_LIMITS.queuedBytes);
    await conn.kill();
    await first;
    stdin.destroy();
  });

  it("caps concurrent server requests and sends an explicit rejection for excess work", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { conn, handlers, frames, reply } = makeFake({ onServerRequest: vi.fn(async () => { await held; return {}; }) });
    for (let id = 1; id <= RPC_LIMITS.serverRequests + 1; id++) reply({ id, method: "approval" });
    expect(handlers.onServerRequest).toHaveBeenCalledTimes(RPC_LIMITS.serverRequests);
    expect(frames.at(-1)).toMatchObject({ id: RPC_LIMITS.serverRequests + 1, error: { message: expect.stringContaining("concurrency") } });
    release();
    await conn.kill();
  });

  it("fails a transport that reuses an active server-request id without invoking the handler twice", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const onServerRequest = vi.fn(async () => { await held; return { ok: true }; });
    const { conn, handlers, reply } = makeFake({ onServerRequest });
    reply({ id: "same", method: "dynamic/tool", params: { sequence: 1 } });
    reply({ id: "same", method: "dynamic/tool", params: { sequence: 2 } });
    expect(onServerRequest).toHaveBeenCalledOnce();
    expect(handlers.onExit).toHaveBeenCalledOnce();
    release();
    await conn.kill();
  });

  it("reserves queue bytes for a large server-request reply ahead of unrelated bulk", async () => {
    const written: any[] = [];
    const callbacks: Array<(error?: Error) => void> = [];
    const stdin = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { written.push(JSON.parse(String(chunk))); callbacks.push(callback); } });
    const stdout = new PassThrough();
    const conn = new AppServerConnection("fake", [], {}, {
      onNotification() {}, onServerRequest: async () => ({ content: "r".repeat(10 * 1024 * 1024) }), onExit() {}, onStderr() {},
    });
    conn.attach(stdin, stdout);
    const first = conn.request("thread/read", { text: "x".repeat(35 * 1024 * 1024) }).catch((error) => error);
    const second = conn.request("thread/read", { text: "y".repeat(12 * 1024 * 1024) }).catch((error) => error);
    stdout.write(JSON.stringify({ id: "server-large", method: "dynamic/tool", params: {} }) + "\n");
    try {
      await vi.waitFor(() => expect((conn as any).writeQueue.length).toBe(2));
      callbacks.shift()!();
      await vi.waitFor(() => expect(written).toHaveLength(2), { timeout: 3000 });
      expect(written[1]).toMatchObject({ id: "server-large", result: { content: expect.any(String) } });
    } finally {
      await conn.kill();
      await Promise.all([first, second]);
    }
  }, 10_000);

  it("falls back to a small correlated error when a server-request result cannot be framed", async () => {
    const { conn, frames, reply } = makeFake({ onServerRequest: vi.fn(async () => ({ content: "x".repeat(RPC_LIMITS.frameBytes) })) });
    reply({ id: "server-oversized", method: "dynamic/tool", params: {} });
    await vi.waitFor(() => expect(frames.some((frame) => frame.id === "server-oversized")).toBe(true));
    expect(frames.find((frame) => frame.id === "server-oversized")).toMatchObject({
      error: { message: expect.stringContaining("could not encode or queue") },
    });
    await conn.kill();
  });

  it.runIf(process.platform === "linux")("waits for SIGTERM-ignoring child and its descendant to stop before reporting exit", async () => {
    let pids: number[] = [];
    const onExit = vi.fn();
    const childScript = 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)';
    const script = `process.on("SIGTERM",()=>{});const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{detached:true,stdio:["ignore","pipe","ignore"]});child.stdout.once("data",()=>console.log(JSON.stringify({method:"ready",params:[process.pid,child.pid]})));setInterval(()=>{},1000)`;
    const conn = new AppServerConnection(process.execPath, ["-e", script], {}, {
      onNotification: (_method, params) => { pids = params as number[]; },
      onServerRequest: async () => ({}), onExit, onStderr() {},
    });
    const live = (pid: number) => {
      try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2)[0]); }
      catch { return false; }
    };
    try {
      conn.spawn();
      await vi.waitFor(() => expect(pids).toHaveLength(2));
      const stopped = conn.kill();
      expect(onExit).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(pids.every(live)).toBe(true);
      await stopped;
      expect(pids.some(live)).toBe(false);
      expect(onExit).toHaveBeenCalledTimes(1);
    } finally { await conn.kill(); }
  }, 8_000);
  it.runIf(process.platform === "win32")("stops a Windows descendant even when it ignores stdin EOF", async () => {
    let childPid: number | undefined;
    const conn = new AppServerConnection("node", ["-e", 'console.log(JSON.stringify({method:"test/pid",params:{pid:process.pid}}));setTimeout(()=>{},10000)'], {}, {
      onNotification: (_method, params: any) => { childPid = params.pid; },
      onServerRequest: async () => ({}), onExit: () => {}, onStderr: () => {},
    });
    const alive = () => {
      if (!childPid) return false;
      try { process.kill(childPid, 0); return true; } catch { return false; }
    };
    try {
      conn.spawn();
      await vi.waitFor(() => expect(childPid).toBeTypeOf("number"), { timeout: 3000 });
      expect(alive()).toBe(true);
      conn.kill();
      await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 3000 });
    } finally {
      conn.kill();
      if (alive()) process.kill(childPid!);
    }
  });

  it.runIf(process.platform === "win32")("launches executables and explicit or bare npm cmd shims from paths containing spaces", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "rpc windows path "));
    const executable = path.join(directory, "harmless node.exe");
    const script = path.join(directory, "fixture.mjs");
    copyFileSync(process.execPath, executable);
    writeFileSync(script, 'console.log(JSON.stringify({method:"test/args",params:process.argv.slice(2)}));setTimeout(()=>{},10000);');
    writeFileSync(path.join(directory, "codex.cmd"), '@"' + process.execPath + '" "%~dp0fixture.mjs" %*\r\n');
    const examples: { command: string; args: string[]; env: Record<string, string> }[] = [
      { command: executable, args: [script, "argument with spaces"], env: {} },
      { command: path.join(directory, "codex.cmd"), args: ["argument with spaces"], env: {} },
      { command: "codex", args: ["argument with spaces"], env: { PATH: directory } },
    ];
    try {
      for (const example of examples) {
        let received: unknown;
        const errors: string[] = [];
        const conn = new AppServerConnection(example.command, example.args, example.env, {
          onNotification: (_method, params) => { received = params; },
          onServerRequest: async () => ({}), onExit: () => {}, onStderr: (text) => errors.push(text),
        });
        try {
          conn.spawn();
          await vi.waitFor(() => expect(received, errors.join("")).toEqual(["argument with spaces"]), { timeout: 5000 });
        } finally { conn.kill(); }
      }
    } finally {
      await vi.waitFor(() => rmSync(directory, { recursive: true, force: true }), { timeout: 5000 });
    }
  }, 20_000);

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

  it.each([null, [], "failure", {}, { code: -32000 }, { message: "private malformed failure" }, { code: {}, message: "private malformed failure" }].map((error) => ({ error })))(
    "a malformed error envelope does not prove a turn was rejected ($error)", async ({ error }) => {
      const { conn, reply, handlers } = makeFake();
      const promise = conn.request("turn/start", {}).catch((failure) => failure);
      reply({ id: 1, error });
      const failure = await promise;
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(AppServerRequestError);
      expect(failure.delivery).toBe("unknown");
      expect(failure.message).not.toContain("private malformed failure");
      const next = conn.request("account/read");
      reply({ id: 2, result: { account: null } });
      await expect(next).resolves.toEqual({ account: null });
      expect(handlers.onExit).not.toHaveBeenCalled();
      await conn.kill();
    },
  );

  it("routes notifications to the handler", () => {
    const { handlers, reply } = makeFake();
    reply({ method: "item/started", params: { item: { id: "a" } } });
    expect(handlers.onNotification).toHaveBeenCalledWith("item/started", { item: { id: "a" } });
  });

  it("ignores malformed JSON values without throwing or echoing their payload", () => {
    const { handlers, writeRaw } = makeFake();
    writeRaw("null\n[]\n");
    expect(handlers.onNotification).not.toHaveBeenCalled();
    expect(handlers.onServerRequest).not.toHaveBeenCalled();
    expect(handlers.onStderr).toHaveBeenCalledTimes(2);
    expect(handlers.onStderr).toHaveBeenLastCalledWith("[gateway-rpc] ignored malformed JSON-RPC frame\n");
  });

  it("does not let a malformed method+result frame hijack a pending response", async () => {
    const { conn, handlers, reply } = makeFake();
    const pending = conn.request("account/read");
    reply({ id: 1, method: "evil", result: { signedIn: true } });
    expect(handlers.onStderr).toHaveBeenCalledWith("[gateway-rpc] ignored malformed JSON-RPC frame\n");
    reply({ id: 1, result: { signedIn: false } });
    await expect(pending).resolves.toEqual({ signedIn: false });
  });

  it("rejects malformed or oversized ids and methods", async () => {
    const { conn, handlers, reply } = makeFake();
    reply({ id: "x".repeat(257), method: "approval", params: {} });
    reply({ id: 2, method: "x".repeat(513), params: {} });
    expect(handlers.onServerRequest).not.toHaveBeenCalled();
    expect(handlers.onStderr).toHaveBeenCalledTimes(2);
    await expect(conn.request("", {})).rejects.toThrow(/invalid.*method/);
  });

  it("contains notification handler failures", () => {
    const { handlers, reply } = makeFake({
      onNotification: () => { throw new Error("consumer boom"); },
    });
    expect(() => reply({ method: "item/started", params: {} })).not.toThrow();
    expect(handlers.onStderr).toHaveBeenCalledWith(expect.stringContaining("consumer boom"));
  });

  it("reports non-JSON stdout without logging untrusted payloads", () => {
    const { handlers, writeRaw } = makeFake();
    writeRaw("this is not json\n");
    expect(handlers.onStderr).toHaveBeenCalledWith("[gateway-rpc] ignored non-JSON stdout frame\n");
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

  it("rejects timeout-exempt command/exec when the transport breaks", async () => {
    const { conn, handlers, stdout } = makeFake();
    const pending = conn.request("command/exec", {});
    stdout.end();
    await expect(pending).rejects.toMatchObject({
      message: expect.stringMatching(/stdout (ended|closed)/), delivery: "unknown",
    });
    expect(handlers.onExit).toHaveBeenCalledTimes(1);
  });

  it("rejects immediately when stdin is already unwritable and reports one exit", async () => {
    const { conn, handlers, stdin } = makeFake();
    stdin.destroy();
    await expect(conn.request("command/exec", {})).rejects.toThrow(/not writable|closed/);
    await vi.waitFor(() => expect(handlers.onExit).toHaveBeenCalledTimes(1));
  });

  it("rejects an unserializable request without poisoning the transport", async () => {
    const { conn, reply, frames } = makeFake();
    const cyclic: any = {};
    cyclic.self = cyclic;
    await expect(conn.request("bad", cyclic)).rejects.toThrow(/serialize/);

    const healthy = conn.request("account/read");
    expect(frames.at(-1)).toMatchObject({ id: 2, method: "account/read" });
    reply({ id: 2, result: { ok: true } });
    await expect(healthy).resolves.toEqual({ ok: true });
  });

  it("reports kill/stream-close only once", async () => {
    const { conn, handlers, stdout } = makeFake();
    conn.kill();
    stdout.end();
    await vi.waitFor(() => expect(handlers.onExit).toHaveBeenCalledTimes(1));
  });

  it("does not allow a closed connection object to be reattached", () => {
    const { conn, stdin, stdout } = makeFake();
    expect(() => conn.attach(stdin, stdout)).toThrow(/already attached/);
    conn.kill();
    expect(() => conn.attach(new PassThrough(), new PassThrough())).toThrow(/already attached|closed/);
  });
});
