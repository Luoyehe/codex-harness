import { describe, expect, it, vi } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppServerConnection, AppServerRequestError, RPC_LIMITS, appServerEnvironment, initialize, type AppServerHandlers } from "../src/codex/rpc.js";

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
    const timed = expect(conn.request("model/list")).rejects.toThrow("timed out after 0.01s");
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

  it("bounds pending requests while reserving control admission", async () => {
    const { conn, frames } = makeFake();
    const requests = Array.from({ length: RPC_LIMITS.pending }, () => conn.request("command/exec").catch((error) => error));
    await expect(conn.request("model/list")).rejects.toBeInstanceOf(AppServerRequestError);
    const control = conn.request("turn/interrupt").catch((error) => error);
    expect(frames).toHaveLength(RPC_LIMITS.pending + 1);
    await conn.kill();
    await Promise.all([...requests, control]);
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
      const first = conn.request("command/exec").catch((error) => error);
      const expired = conn.request("model/list").catch((error) => error);
      const control = conn.request("command/exec/terminate").catch((error) => error);
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
    await expect(pending).rejects.toThrow(/stdout (ended|closed)/);
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
