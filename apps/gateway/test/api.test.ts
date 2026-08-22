import { describe, it, expect } from "vitest";
import { makeDispatcher, type ApiContext } from "../src/api.js";

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
  });
});

describe("turn/start", () => {
  it("registers attachment paths for refcounting", async () => {
    const remembered: Array<{ tid: string; paths: string[] }> = [];
    const { dispatch } = fakeCtx({
      attachments: {
        isOwned: () => true,
        rememberPaths: (tid: string, paths: string[]) => remembered.push({ tid, paths }),
      } as any,
    });
    await dispatch("turn/start", {
      threadId: "t1",
      text: "hi",
      attachments: [{ kind: "image", name: "a.png", path: "/up/a.png" }],
    });
    expect(remembered).toEqual([{ tid: "t1", paths: ["/up/a.png"] }]);
  });

  it("rejects textless turns without attachments", async () => {
    const { dispatch } = fakeCtx();
    await expect(dispatch("turn/start", { threadId: "t1", text: "   " })).rejects.toThrow(/text/);
  });
});
