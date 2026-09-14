import { afterEach, describe, it, expect } from "vitest";
import { makeDispatcher, type ApiContext } from "../src/api.js";
import { AttachmentStore } from "../src/attachments.js";
import { AppServerRequestError } from "../src/codex/rpc.js";
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
  });

  it("cursor is capped and searchTerm trimmed/capped", async () => {
    const { dispatch, calls } = fakeCtx();
    await dispatch("thread/list", { cursor: "x".repeat(600), searchTerm: "  hello world  " });
    expect(calls[0].params.cursor.length).toBe(512);
    expect(calls[0].params.searchTerm).toBe("hello world");
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

describe("custom provider validation", () => {
  it("rejects endpoint credentials, queries, and fragments before running setup", async () => {
    const { dispatch } = fakeCtx();
    for (const customBaseUrl of ["https://u:p@api.example.com/v1", "https://api.example.com/v1?key=secret", "https://api.example.com/v1#fragment", "https://api.exa\tmple.com/v1", "https://api.example.com/\nv1"]) {
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

  it("rejects textless turns without attachments", async () => {
    const { dispatch } = fakeCtx();
    await expect(dispatch("turn/start", { threadId: "t1", text: "   " })).rejects.toThrow(/text/);
  });
});

describe("attachment send reservations", () => {
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
    expect(store.registeredOwners(file.path)).toEqual(["older-thread"]);
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
