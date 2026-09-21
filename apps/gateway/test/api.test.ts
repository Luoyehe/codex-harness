import { afterEach, describe, it, expect } from "vitest";
import { makeDispatcher, type ApiContext } from "../src/api.js";
import { AttachmentStore } from "../src/attachments.js";
import { AppServerConnection, AppServerRequestError } from "../src/codex/rpc.js";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function attachmentFixture() {
  const home = mkdtempSync(path.join(tmpdir(), "gateway-send-"));
  homes.push(home);
  const store = new AttachmentStore(home);
  const file = store.save("test.txt", Buffer.from("important attachment").toString("base64"), "file");
  return { home, store, file };
}

function fakeCtx(overrides: Partial<ApiContext> = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const ctx: ApiContext = {
    supervisor: {
      state: "ready",
      request: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        return { data: [], nextCursor: null };
      },
    } as any,
    workspaceRoot: "/ws",
    gatewayVersion: "test",
    projects: {} as any,
    displayPrefs: { get: () => ({ autoCompactThreshold: 0.9 }) } as any,
    attachments: { isOwned: () => true } as any,
    providerInfo: () => ({ mode: "openai", efforts: [] }),
    notify: () => {},
    ...overrides,
  };
  return { dispatch: makeDispatcher(ctx), calls };
}

describe("thread/list param validation", () => {
  it("non-finite limits fall back to the default instead of NaN", async () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const { dispatch, calls } = fakeCtx();
      await dispatch("thread/list", { limit: bad });
      const sent = calls[0].params;
      expect(Number.isFinite(sent.limit)).toBe(true);
      expect(sent.limit).toBe(50);
    }
  });

  it("finite limits are clamped to 1..100", async () => {
    const { dispatch, calls } = fakeCtx();
    await dispatch("thread/list", { limit: 5000 });
    expect(calls[0].params.limit).toBe(100);
    const d2 = fakeCtx();
    await d2.dispatch("thread/list", { limit: 0 });
    expect(d2.calls[0].params.limit).toBe(1);
  });

  it("non-enum sourceKinds are filtered out; unknown-only falls back to defaults", async () => {
    const { dispatch, calls } = fakeCtx();
    await dispatch("thread/list", { sourceKinds: ["appServer", "evil-injection", 42] });
    expect(calls[0].params.sourceKinds).toEqual(["appServer"]);
    const d2 = fakeCtx();
    await d2.dispatch("thread/list", { sourceKinds: ["not-a-kind"] });
    expect(d2.calls[0].params.sourceKinds).toEqual(["cli", "vscode", "exec", "appServer"]);
    await expect(d2.dispatch("thread/list", { sourceKinds: Array.from({ length: 11 }, () => "appServer") })).rejects.toThrow(/too many/);
    expect(d2.calls).toHaveLength(1);
  });

  it("forwards bounded opaque cursors unchanged and rejects overlong tokens", async () => {
    const { dispatch, calls } = fakeCtx();
    const cursor = "opaque:" + "x".repeat(500);
    await dispatch("thread/list", { cursor, searchTerm: "  hello world  " });
    expect(calls[0].params.cursor).toBe(cursor);
    expect(calls[0].params.searchTerm).toBe("hello world");
    await expect(dispatch("thread/list", { cursor: "x".repeat(4097) })).rejects.toThrow(/cursor/);
    expect(calls).toHaveLength(1);
  });
});

describe("model/list param validation", () => {
  it("non-finite limit falls back to undefined (server default), never NaN", async () => {
    const { dispatch, calls } = fakeCtx();
    for (const bad of [NaN, Infinity, -Infinity]) {
      await dispatch("model/list", { limit: bad });
      expect(calls.at(-1)!.params.limit).toBeUndefined();
    }
    const d2 = fakeCtx();
    await d2.dispatch("model/list", { limit: 5000 });
    expect(d2.calls[0].params.limit).toBe(200);
  });
  it("forwards bounded opaque cursors unchanged and rejects overlong tokens", async () => {
    const { dispatch, calls } = fakeCtx();
    const cursor = "opaque:model:" + "x".repeat(500);
    await dispatch("model/list", { cursor });
    expect(calls[0].params.cursor).toBe(cursor);
    await expect(dispatch("model/list", { cursor: "x".repeat(4097) })).rejects.toThrow(/cursor/);
    expect(calls).toHaveLength(1);
  });
});

describe("MCP inventory pagination", () => {
  it("forwards the opaque cursor and supported scope/detail fields instead of repeating the first page", async () => {
    const requests: any[] = [];
    const { dispatch } = fakeCtx({ supervisor: { request: async (_method: string, params: any) => {
      requests.push(params);
      return params.cursor ? { data: [{ name: "second" }], nextCursor: null } : { data: [{ name: "first" }], nextCursor: "opaque-next" };
    } } as any });
    const first: any = await dispatch("mcpServerStatus/list", { limit: 1, detail: "toolsAndAuthOnly", threadId: "thread-one" });
    const second: any = await dispatch("mcpServerStatus/list", { cursor: first.nextCursor, limit: 1, detail: "toolsAndAuthOnly", threadId: "thread-one" });
    expect(second.data).toEqual([{ name: "second" }]);
    expect(requests[1]).toEqual({ cursor: "opaque-next", limit: 1, detail: "toolsAndAuthOnly", threadId: "thread-one" });
  });
  it("keeps defaults absent and rejects unsupported details or an overlong opaque cursor before dispatch", async () => {
    const { dispatch, calls } = fakeCtx();
    await dispatch("mcpServerStatus/list", {});
    expect(calls[0].params).toEqual({});
    for (const params of [{ detail: "invented" }, { cursor: "x".repeat(4097) }, { threadId: "bad\0thread" }]) {
      await expect(dispatch("mcpServerStatus/list", params)).rejects.toThrow();
    }
    expect(calls).toHaveLength(1);
  });
});

describe("method allowlist", () => {
  it("unknown methods are rejected", async () => {
    const { dispatch } = fakeCtx();
    await expect(dispatch("fs/readFile", { path: "/etc/passwd" })).rejects.toThrow(/not allowed/);
    await expect(dispatch("process/spawn", {})).rejects.toThrow(/not allowed/);
    await expect(dispatch("constructor", {})).rejects.toThrow(/not allowed/);
    await expect(dispatch("toString", {})).rejects.toThrow(/not allowed/);
  });
});

describe("asynchronous project registry boundary", () => {
  it("awaits registry reads and mutations instead of serializing promises", async () => {
    const project = { path: "/project", addedAt: 1, lastUsedAt: 2, available: true };
    const events: string[] = [];
    const projects = {
      list: async () => { await Promise.resolve(); events.push("list"); return [project]; },
      add: async () => { await Promise.resolve(); events.push("add"); return project; },
      remove: async () => { await Promise.resolve(); events.push("remove"); },
      touch: async () => { await Promise.resolve(); events.push("touch"); },
      resolveRegistered: async () => "/project",
    } as any;
    const { dispatch } = fakeCtx({ projects });
    await expect(dispatch("projects/list", {})).resolves.toEqual({ projects: [project] });
    await expect(dispatch("projects/add", { path: "/project" })).resolves.toEqual({ project });
    await expect(dispatch("projects/remove", { path: "/project" })).resolves.toEqual({ ok: true });
    await expect(dispatch("projects/touch", { path: "/project" })).resolves.toEqual({ ok: true });
    expect(events).toEqual(["list", "add", "remove", "touch"]);
  });

  it("does not dispatch thread/start until asynchronous cwd verification succeeds", async () => {
    let verify!: (value: string | null) => void;
    const registered = new Promise<string | null>((resolve) => { verify = resolve; });
    const { dispatch, calls } = fakeCtx({ projects: { resolveRegistered: () => registered } as any });
    const starting = dispatch("thread/start", { cwd: "/project" });
    await Promise.resolve();
    expect(calls).toEqual([]);
    verify("/project");
    await starting;
    expect(calls).toEqual([{ method: "thread/start", params: { cwd: "/project" } }]);
  });
});

describe("account login lifecycle", () => {
  it("exposes only a bounded login cancellation id", async () => {
    const { dispatch, calls } = fakeCtx();
    await dispatch("account/login/cancel", { loginId: "login-1" });
    expect(calls).toEqual([{ method: "account/login/cancel", params: { loginId: "login-1" } }]);
    for (const loginId of ["", "x".repeat(257), "bad\0id", 7]) {
      await expect(dispatch("account/login/cancel", { loginId })).rejects.toThrow(/loginId/);
    }
    expect(calls).toHaveLength(1);
  });
});

describe("custom provider validation", () => {
  it("rejects endpoint credentials, queries, and fragments before running setup", async () => {
    const { dispatch } = fakeCtx();
    for (const customBaseUrl of ["https://u:p@example.com/v1", "https://api.example.com/v1?key=secret", "https://api.example.com/v1#fragment", "https://api.exa\tmple.com/v1", "https://api.example.com/\nv1"]) {
      await expect(dispatch("admin/provider/switch", { mode: "custom", customBaseUrl })).rejects.toThrow(/customBaseUrl/);
    }
  });
});

describe("turn/start", () => {
  it("registers attachment paths for refcounting", async () => {
    const { store, file } = attachmentFixture();
    const { dispatch } = fakeCtx({ attachments: store });
    await dispatch("turn/start", {
      threadId: "t1",
      text: "hi",
      attachments: [{ kind: "file", name: "test.txt", path: file.path }],
    });
    expect(store.registeredOwners(file.path)).toEqual(["t1"]);
  });

  it("rejects an oversized localImage even when upload used the file cap", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "gateway-image-cap-"));
    homes.push(home);
    const store = new AttachmentStore(home);
    const file = store.save(
      "oversized.png",
      Buffer.alloc(store.maxImageBytes + 1).toString("base64"),
      "file",
    );
    const { dispatch, calls } = fakeCtx({ attachments: store });

    await expect(dispatch("turn/start", {
      threadId: "image-cap",
      text: "inspect",
      attachments: [{ kind: "image", name: "oversized.png", path: file.path }],
    })).rejects.toThrow(/图片.*5MB/);
    expect(calls).toEqual([]);
    expect(store.registeredOwners(file.path)).toEqual([expect.stringContaining("@codex-harness:unclaimed:")]);
  });

  it("rejects textless turns without attachments", async () => {
    const { dispatch } = fakeCtx();
    await expect(dispatch("turn/start", { threadId: "t1", text: "   " })).rejects.toThrow(/text/);
  });

  it("rechecks the message budget after appending file attachment notes", async () => {
    const attachments = {
      isOwned: () => true,
      reservePaths: () => { throw new Error("must reject before reservation"); },
    } as any;
    const { dispatch, calls } = fakeCtx({ attachments });
    await expect(dispatch("turn/start", {
      threadId: "t1",
      text: "x".repeat(2 * 1024 * 1024 - 1),
      attachments: [{ kind: "file", name: "f", path: "/" + "p".repeat(4095) }],
    })).rejects.toThrow(/attachment notes/);
    expect(calls).toHaveLength(0);
  });
});

describe("attachment send reservations", () => {
  it("a malformed transport error preserves the real send lease instead of marking the attachment unused", async () => {
    const { store, file } = attachmentFixture();
    const input = new PassThrough(), output = new PassThrough();
    const connection = new AppServerConnection("synthetic", [], {}, {
      onNotification() {}, onStderr() {}, onExit() {}, onServerRequest: async () => ({}),
    });
    connection.attach(input, output);
    const { dispatch } = fakeCtx({ attachments: store, supervisor: { state: "ready", request: connection.request.bind(connection) } as any });
    const send = dispatch("turn/start", { threadId: "thread-malformed", text: "fixture", attachments: [{ kind: "file", name: "test.txt", path: file.path }] });
    output.write(JSON.stringify({ id: 1, error: null }) + "\n");
    await expect(send).rejects.toMatchObject({ delivery: "unknown" });
    expect(store.registeredOwners(file.path)).toEqual([expect.stringContaining("@codex-harness:pending:thread-malformed:")]);
    await expect(store.removeUnreferenced(file.path)).rejects.toThrow(/引用/);
    expect(existsSync(file.path)).toBe(true);
    await connection.kill();
  });
  it("an explicitly unknown private-worker response preserves the send lease", async () => {
    const { store, file } = attachmentFixture();
    const { dispatch } = fakeCtx({
      attachments: store,
      supervisor: { state: "ready", request: async () => { throw new AppServerRequestError("worker result unavailable", { code: -32000, data: { delivery: "unknown" } }); } } as any,
    });
    await expect(dispatch("turn/start", {
      threadId: "thread-unknown", text: "fixture", attachments: [{ kind: "file", name: "test.txt", path: file.path }],
    })).rejects.toBeInstanceOf(AppServerRequestError);
    expect(store.registeredOwners(file.path)).toEqual([expect.stringContaining("@codex-harness:pending:thread-unknown:")]);
  });
  it("a local pre-send app-server refusal releases the uncertain lease as a retryable draft", async () => {
    const { store, file } = attachmentFixture();
    const { dispatch } = fakeCtx({
      attachments: store,
      supervisor: { state: "ready", request: async () => { throw new AppServerRequestError("outgoing queue full"); } } as any,
    });
    await expect(dispatch("turn/start", {
      threadId: "thread-rejected", text: "fixture", attachments: [{ kind: "file", name: "test.txt", path: file.path }],
    })).rejects.toBeInstanceOf(AppServerRequestError);
    expect(store.registeredOwners(file.path)).toEqual([expect.stringContaining("@codex-harness:unclaimed:")]);
  });
  it("prevents deletion during turn acceptance and preserves a lease across restart", async () => {
    const { home, store, file } = attachmentFixture();
    let accept!: (value: unknown) => void;
    const { dispatch } = fakeCtx({
      attachments: store,
      supervisor: { request: () => new Promise((resolve) => { accept = resolve; }) } as any,
    });
    const sending = dispatch("turn/start", { threadId: "t1", text: "read", attachments: [{ path: file.path }] });
    await expect(dispatch("attachment/delete", { path: file.path })).rejects.toThrow(/引用/);
    expect(existsSync(file.path)).toBe(true);
    expect(new AttachmentStore(home).registeredOwners(file.path)).toEqual(["@codex-harness:scan-incomplete"]);
    accept({ turn: { id: "turn1" } });
    await sending;
    expect(store.registeredOwners(file.path)).toEqual(["t1"]);
  });

  it("releases a definitively rejected send without deleting another thread's reference", async () => {
    const { store, file } = attachmentFixture();
    store.rememberPaths("older-thread", [file.path]);
    const { dispatch } = fakeCtx({
      attachments: store,
      supervisor: { request: async () => { throw new AppServerRequestError("rejected"); } } as any,
    });
    await expect(dispatch("turn/start", { threadId: "new-thread", text: "read", attachments: [{ path: file.path }] })).rejects.toThrow("rejected");
    expect(store.registeredOwners(file.path)).toContain("older-thread");
    await expect(dispatch("attachment/delete", { path: file.path })).rejects.toThrow(/引用/);
  });

  it("allows cleanup of an otherwise unreferenced, definitively rejected upload", async () => {
    const { store, file } = attachmentFixture();
    const { dispatch } = fakeCtx({
      attachments: store,
      supervisor: { request: async () => { throw new AppServerRequestError("invalid thread"); } } as any,
    });
    await expect(dispatch("turn/start", { threadId: "missing", text: "read", attachments: [{ path: file.path }] })).rejects.toThrow("invalid thread");
    await expect(dispatch("attachment/delete", { path: file.path })).resolves.toEqual({ ok: true });
    expect(existsSync(file.path)).toBe(false);
  });

  it("keeps an uncertain send protected until its real thread is deleted", async () => {
    const { store, file } = attachmentFixture();
    const { dispatch } = fakeCtx({
      attachments: store,
      supervisor: { request: async () => { throw new Error("connection lost"); } } as any,
    });
    await expect(dispatch("turn/start", { threadId: "t1", text: "read", attachments: [{ path: file.path }] })).rejects.toThrow("connection lost");
    expect(store.registeredOwners(file.path)[0]).toMatch(/^@codex-harness:pending:t1:/);
    await expect(dispatch("attachment/delete", { path: file.path })).rejects.toThrow(/引用/);
    store.cleanupForThread("t1", {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(file.path)).toBe(false);
  });
});
