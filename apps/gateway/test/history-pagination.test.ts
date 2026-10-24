import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeDispatcher, type ApiContext } from "../src/api.js";
import { GatewayController } from "../src/control.js";

function fixture() {
  const response = { data: [], nextCursor: "next:opaque", backwardsCursor: "previous:opaque" };
  const request = vi.fn(async () => response);
  const dispatch = makeDispatcher({ supervisor: { request } } as unknown as ApiContext);
  return { request, dispatch, response };
}

describe("0.164 history pagination boundary", () => {
  it("uses bounded defaults and preserves the native cursors without auto-fetching", async () => {
    const { request, dispatch, response } = fixture();
    await expect(dispatch("thread/turns/list", { threadId: "thread" })).resolves.toBe(response);
    expect(request).toHaveBeenLastCalledWith("thread/turns/list", {
      threadId: "thread", cursor: undefined, limit: 20, sortDirection: "desc", itemsView: "full",
    });
    await expect(dispatch("thread/items/list", { threadId: "thread" })).resolves.toBe(response);
    expect(request).toHaveBeenLastCalledWith("thread/items/list", {
      threadId: "thread", turnId: undefined, cursor: undefined, limit: 100, sortDirection: "desc",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("forwards explicit history selection but never arbitrary client fields", async () => {
    const { request, dispatch } = fixture();
    await dispatch("thread/turns/list", { threadId: "thread", cursor: "opaque+token/==", limit: 100,
      sortDirection: "asc", itemsView: "notLoaded", includeHidden: true, path: "/other" });
    expect(request).toHaveBeenLastCalledWith("thread/turns/list", {
      threadId: "thread", cursor: "opaque+token/==", limit: 100, sortDirection: "asc", itemsView: "notLoaded",
    });
    await dispatch("thread/items/list", { threadId: "thread", turnId: "turn", limit: 200,
      sortDirection: "asc", cursor: { type: "item", itemId: "item" }, path: "/other" });
    expect(request).toHaveBeenLastCalledWith("thread/items/list", {
      threadId: "thread", turnId: "turn", limit: 200, sortDirection: "asc", cursor: { type: "item", itemId: "item" },
    });
  });

  it.each(["thread/turns/list", "thread/items/list"])("rejects malformed %s page requests before dispatch", async method => {
    const { request, dispatch } = fixture();
    const invalid = [
      { threadId: "" }, { threadId: "x".repeat(257) }, { threadId: "bad\0thread" }, { threadId: [] },
      ...[0, -1, 1.5, 201, NaN, Infinity, "10", {}].map(limit => ({ limit })),
      ...["", "x".repeat(4097), "bad\0cursor", [], 7, false].map(cursor => ({ cursor })),
      { sortDirection: "future" }, { sortDirection: 1 },
    ];
    for (const params of invalid) await expect(dispatch(method, { threadId: "thread", ...params })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects oversized turn pages, invented item views and unscoped/extended item anchors", async () => {
    const { request, dispatch } = fixture();
    await expect(dispatch("thread/turns/list", { threadId: "thread", limit: 101 })).rejects.toThrow("limit");
    await expect(dispatch("thread/turns/list", { threadId: "thread", itemsView: "future" })).rejects.toThrow("itemsView");
    await expect(dispatch("thread/turns/list", { threadId: "thread", cursor: { type: "item", itemId: "item" } })).rejects.toThrow("cursor");
    for (const params of [
      { cursor: { type: "item", itemId: "item" } },
      { turnId: "turn", cursor: { type: "turn", itemId: "item" } },
      { turnId: "turn", cursor: { type: "item", itemId: "item", extra: "unsafe" } },
      { turnId: "turn", cursor: { type: "item", itemId: "" } },
      { turnId: "turn", cursor: { type: "item", itemId: "x".repeat(257) } },
      { turnId: "", cursor: "opaque" },
    ]) await expect(dispatch("thread/items/list", { threadId: "thread", ...params })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("opts metadata-only resume in explicitly without changing legacy callers", async () => {
    const { request, dispatch } = fixture();
    await dispatch("thread/resume", { threadId: "thread" });
    expect(request).toHaveBeenLastCalledWith("thread/resume", { threadId: "thread" });
    await dispatch("thread/resume", { threadId: "thread", excludeTurns: true, path: "/ignored" });
    expect(request).toHaveBeenLastCalledWith("thread/resume", { threadId: "thread", excludeTurns: true });
    await expect(dispatch("thread/resume", { threadId: "thread", excludeTurns: "true" })).rejects.toThrow("excludeTurns");
    expect(request).toHaveBeenCalledTimes(2);
  });
});

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
it("allows paginated diagnostic reads when a turn's delivery is unknown", async () => {
  vi.stubEnv("GATEWAY_UNSAFE_SINGLE_USER", "1");
  vi.stubEnv("CODEX_WORKER_LAUNCHER", "");
  const home = mkdtempSync(path.join(os.tmpdir(), "harness-pagination-"));
  homes.push(home);
  const controller = new GatewayController(home);
  const backend = (controller as any).backend;
  backend.events.onNotification("gateway/clientMessage", { clientId: "*", message: {
    kind: "notification", method: "appServer/stateChanged", params: { state: "ready" },
  } });
  backend.request = vi.fn(async () => { throw Object.assign(new Error("reply lost"), { delivery: "unknown" }); });
  await expect(controller.dispatch("turn/start", {
    clientOperationId: "history-unknown-start", threadId: "thread", text: "fixture",
  }, "browser")).rejects.toMatchObject({ operationState: "unknown" });
  backend.request = vi.fn(async () => ({ data: [], nextCursor: null, backwardsCursor: null }));
  for (const method of ["thread/turns/list", "thread/items/list"]) {
    await expect(controller.dispatch(method, { threadId: "thread" }, "browser")).resolves.toHaveProperty("data");
  }
  expect(backend.request).toHaveBeenCalledTimes(2);
  await expect(controller.dispatch("terminal/exec", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  expect(await controller.dispatch("management/status", {}, "browser")).toMatchObject({ state: "unknown" });
});

it.each(["thread/turns/list", "thread/items/list"])("decorates %s receipts and bounds raw and decorated history in the control plane", async method => {
  vi.stubEnv("GATEWAY_UNSAFE_SINGLE_USER", "1");
  vi.stubEnv("CODEX_WORKER_LAUNCHER", "");
  const home = mkdtempSync(path.join(os.tmpdir(), "harness-page-metadata-"));
  homes.push(home);
  const controller = new GatewayController(home);
  const backend = (controller as any).backend;
  const ledger = (controller as any).ledger;
  backend.events.onNotification("gateway/clientMessage", { clientId: "*", message: {
    kind: "notification", method: "appServer/stateChanged", params: { state: "ready" },
  } });
  backend.request = vi.fn(async () => ({ turn: { id: "turn", status: "completed" } }));
  const clientOperationId = "pagination-metadata-operation";
  const attachments = Array.from({ length: 32 }, (_, i) => ({ path: `/upload/${i}-${"p".repeat(4000)}`, name: "文件.txt", kind: "file" }));
  await controller.dispatch("turn/start", { clientOperationId, threadId: "thread", text: "fixture", attachments }, "browser");
  const user = { id: "message", type: "userMessage", content: [] };
  const page = (items: unknown[]) => method === "thread/turns/list"
    ? { data: [{ id: "turn", items }], nextCursor: "older", backwardsCursor: "newer" }
    : { data: items.map(item => ({ turnId: "turn", item, startedAtMs: 1, completedAtMs: 2 })), nextCursor: "older", backwardsCursor: "newer" };
  backend.request.mockResolvedValue(page([user]));
  const result: any = await controller.dispatch(method, { threadId: "thread" }, "browser");
  const item = method === "thread/turns/list" ? result.data[0].items[0] : result.data[0].item;
  expect(item).toMatchObject({ clientOperationId, harnessAttachments: attachments });
  expect(result).toMatchObject({ nextCursor: "older", backwardsCursor: "newer" });
  const decorate = vi.spyOn(ledger, "decorateHistoryPage");
  backend.request.mockResolvedValue(page([{ ...user, text: "x".repeat(9 * 1024 * 1024) }]));
  await expect(controller.dispatch(method, { threadId: "thread" }, "browser")).rejects.toMatchObject({ errorCode: "RESPONSE_TOO_LARGE" });
  expect(decorate).not.toHaveBeenCalled();
  backend.request.mockResolvedValue(page(Array.from({ length: 100 }, () => user)));
  await expect(controller.dispatch(method, { threadId: "thread" }, "browser")).rejects.toMatchObject({ errorCode: "RESPONSE_TOO_LARGE" });
  expect(decorate).toHaveBeenCalledOnce();
  backend.request.mockResolvedValue({ data: [], nextCursor: null, backwardsCursor: null });
  await expect(controller.dispatch(method, { threadId: "thread" }, "browser")).resolves.toHaveProperty("data");
});
