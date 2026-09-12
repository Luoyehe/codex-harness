import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  return { conn, handlers, frames, reply, stdin, stdout, stderr, writeRaw: (s: string) => stdout.write(s) };
}

describe("AppServerConnection", () => {
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
