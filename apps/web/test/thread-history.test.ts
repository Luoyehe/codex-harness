import { describe, expect, it, vi } from "vitest";
import { hydrateThreadHistory } from "../src/utils/thread-history";
import { agent, thread, turn } from "./fixtures";

const page = (data: unknown[], nextCursor: string | null = null) => ({ data, nextCursor, backwardsCursor: null });
const metadata = () => ({ thread: thread("T", [], { historyMode: "paginated" }) });

describe("Codex 0.164 paginated history", () => {
  it("hydrates newest-first turn pages and returns chronological complete history", async () => {
    const request = vi.fn().mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(page([turn("new", [agent("new-item", "new")])], "opaque older cursor"))
      .mockResolvedValueOnce(page([turn("old", [agent("old-item", "old")])]));
    const result = await hydrateThreadHistory("T", request, () => true, "paginated");
    expect(result).toMatchObject({ truncated: false, response: { thread: {
      id: "T", turns: [{ id: "old" }, { id: "new" }],
    } } });
    expect(request).toHaveBeenNthCalledWith(1, "thread/read", { threadId: "T", includeTurns: false });
    expect(request).toHaveBeenNthCalledWith(3, "thread/turns/list", expect.objectContaining({ cursor: "opaque older cursor" }));
    expect(request.mock.calls.every(([method]) => method !== "thread/items/list")).toBe(true);
  });

  it("hydrates summary turns through bounded per-turn item pages", async () => {
    const summary = { ...turn("r", [agent("summary", "not the full item")]), itemsView: "summary" };
    const request = vi.fn().mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(page([summary]))
      .mockResolvedValueOnce(page([{ turnId: "r", item: agent("new", "new") }], "items-older"))
      .mockResolvedValueOnce(page([{ turnId: "r", item: agent("old", "old") }]));
    const result = await hydrateThreadHistory("T", request, () => true);
    expect(result).toMatchObject({ truncated: false, response: { thread: { turns: [{
      id: "r", itemsView: "full", items: [{ id: "old" }, { id: "new" }],
    }] } } });
    expect(request).toHaveBeenNthCalledWith(3, "thread/items/list", { threadId: "T", turnId: "r", limit: 100, sortDirection: "desc" });
  });

  it("does not mistake partial turns returned with paginated metadata for complete history", async () => {
    const response = { thread: thread("T", [turn("partial", [])], { historyMode: "paginated" }) };
    const request = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(page([turn("real", [])]));
    const result = await hydrateThreadHistory("T", request, () => true);
    expect(result).toMatchObject({ response: { thread: { turns: [{ id: "real" }] } } });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("uses the supported full-history path only for confirmed legacy threads", async () => {
    const response = { thread: thread("T", [turn("legacy", [agent("a", "history")])]) };
    const request = vi.fn().mockResolvedValue(response);
    expect(await hydrateThreadHistory("T", request, () => true, "legacy")).toEqual({ response, truncated: false });
    expect(request).toHaveBeenCalledExactlyOnceWith("thread/read", { threadId: "T", includeTurns: true });
  });

  it("requests legacy full history after a metadata-only read with no turns", async () => {
    const request = vi.fn().mockResolvedValueOnce({ thread: thread("T") })
      .mockResolvedValueOnce({ thread: thread("T", [turn("legacy", [])]) });
    expect(await hydrateThreadHistory("T", request, () => true)).toMatchObject({ truncated: false });
    expect(request).toHaveBeenLastCalledWith("thread/read", { threadId: "T", includeTurns: true });
  });

  it.each(["future", null, 4])("rejects an unknown history mode %s", async (historyMode) => {
    const request = vi.fn().mockResolvedValue({ thread: { ...thread("T"), historyMode } });
    await expect(hydrateThreadHistory("T", request, () => true)).rejects.toThrow("历史模式");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["", undefined, 4, {}, "x".repeat(4_097)])("rejects malformed cursors without sending them back (%#)", async (nextCursor) => {
    const request = vi.fn().mockResolvedValueOnce(metadata()).mockResolvedValue({ data: [], nextCursor });
    await expect(hydrateThreadHistory("T", request, () => true)).rejects.toThrow("游标");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects repeated turn cursors instead of polling indefinitely", async () => {
    const request = vi.fn().mockResolvedValueOnce(metadata()).mockResolvedValue(page([], "same"));
    await expect(hydrateThreadHistory("T", request, () => true)).rejects.toThrow("游标重复");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("rejects repeated item cursors and cross-turn item data", async () => {
    const request = vi.fn().mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(page([{ ...turn("r", []), itemsView: "notLoaded" }]))
      .mockResolvedValue(page([], "same"));
    await expect(hydrateThreadHistory("T", request, () => true)).rejects.toThrow("游标重复");
    expect(request).toHaveBeenCalledTimes(4);
    request.mockReset().mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(page([{ ...turn("r", []), itemsView: "summary" }]))
      .mockResolvedValue(page([{ turnId: "different", item: agent("a", "text") }]));
    await expect(hydrateThreadHistory("T", request, () => true)).rejects.toThrow("错误的回合");
  });

  it("rejects a different metadata identity before issuing any page request", async () => {
    const request = vi.fn().mockResolvedValue({ thread: thread("wrong", [], { historyMode: "paginated" }) });
    await expect(hydrateThreadHistory("T", request, () => true)).rejects.toThrow("会话身份");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not commit or continue a request whose navigation changed while awaiting", async () => {
    let current = true;
    const request = vi.fn(async () => { current = false; return metadata(); });
    await expect(hydrateThreadHistory("T", request, () => current)).rejects.toThrow("新的导航");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("caps total pages and explicitly marks the result incomplete", async () => {
    let index = 0;
    const request = vi.fn().mockResolvedValueOnce(metadata()).mockImplementation(async () => page([], `cursor-${index++}`));
    const result = await hydrateThreadHistory("T", request, () => true);
    expect(result.truncated).toBe(true);
    expect(request).toHaveBeenCalledTimes(65);
  });

  it("does not retain a single oversized turn or inspect fields after reaching the budget", async () => {
    const oversized = turn("large", [agent("large-item", "x".repeat(13 * 1024 * 1024))]);
    Object.defineProperty(oversized, "late", { enumerable: true, get: () => { throw new Error("must not execute"); } });
    const request = vi.fn().mockResolvedValueOnce(metadata()).mockResolvedValueOnce(page([turn("new", []), oversized]));
    expect(await hydrateThreadHistory("T", request, () => true)).toMatchObject({
      truncated: true, response: { thread: { turns: [{ id: "new" }] } },
    });
  });

  it("rejects repeated turn IDs rather than silently merging different snapshots", async () => {
    const request = vi.fn().mockResolvedValueOnce(metadata()).mockResolvedValueOnce(page([turn("r", []), turn("r", [])]));
    await expect(hydrateThreadHistory("T", request, () => true)).rejects.toThrow("同一回合");
  });

  it("shrinks only oversized turn pages and preserves the exact cursor and smaller page size", async () => {
    const sizeError = () => Object.assign(new Error("too large"), { code: "RESPONSE_TOO_LARGE" });
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read") return metadata();
      if (Number(params.limit) > 5) throw sizeError();
      return params.cursor ? page([turn("older", [])]) : page([turn("newer", [])], "opaque/next+=");
    });
    expect(await hydrateThreadHistory("T", request, () => true)).toMatchObject({ truncated: false,
      response: { thread: { turns: [{ id: "older" }, { id: "newer" }] } } });
    expect(request.mock.calls.slice(1).map(([, params]) => params.limit)).toEqual([20, 10, 5, 5]);
    expect(request).toHaveBeenLastCalledWith("thread/turns/list", expect.objectContaining({ cursor: "opaque/next+=", limit: 5 }));
  });

  it("falls back from an oversized single turn to bounded per-item pages", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read") return metadata();
      if (method === "thread/turns/list" && params.itemsView === "notLoaded") return page([{ ...turn("r", []), itemsView: "notLoaded" }]);
      if (method === "thread/items/list" && params.limit === 1) return params.cursor
        ? page([{ turnId: "r", item: agent("older", "older output") }])
        : page([{ turnId: "r", item: agent("newer", "newer output") }], "item/opaque");
      throw Object.assign(new Error("too large"), { code: "RESPONSE_TOO_LARGE" });
    });
    expect(await hydrateThreadHistory("T", request, () => true)).toMatchObject({ truncated: false,
      response: { thread: { turns: [{ id: "r", itemsView: "full", items: [{ id: "older" }, { id: "newer" }] }] } } });
    expect(request.mock.calls.filter(([method]) => method === "thread/turns/list").map(([, p]) => [p.limit, p.itemsView]))
      .toEqual([[20, "full"], [10, "full"], [5, "full"], [2, "full"], [1, "full"], [1, "summary"], [1, "notLoaded"]]);
    expect(request.mock.calls.filter(([method]) => method === "thread/items/list").map(([, p]) => p.limit))
      .toEqual([100, 50, 25, 12, 6, 3, 1, 1]);
    expect(request).toHaveBeenLastCalledWith("thread/items/list", expect.objectContaining({ cursor: "item/opaque", limit: 1 }));
  });

  it.each(["BUSY", "OPERATION_UNKNOWN", undefined])("does not shrink or replay a non-size failure (%s)", async (code) => {
    const request = vi.fn().mockResolvedValueOnce(metadata()).mockRejectedValue(Object.assign(new Error("too large"), { code }));
    await expect(hydrateThreadHistory("T", request, () => true)).rejects.toThrow("too large");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("charges size refusals to the same total page budget and retains the complete readable tail", async () => {
    let index = 0;
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read") return metadata();
      if (method === "thread/items/list") return page([{ turnId: params.turnId, item: agent(`item-${params.turnId}`, "readable") }]);
      if (params.itemsView === "full") throw Object.assign(new Error("too large"), { code: "RESPONSE_TOO_LARGE" });
      const id = `turn-${index++}`;
      return page([{ ...turn(id, []), itemsView: "summary" }], `older-${index}`);
    });
    const result = await hydrateThreadHistory("T", request, () => true);
    expect(result.truncated).toBe(true);
    expect(request).toHaveBeenCalledTimes(65);
    expect(result).toMatchObject({ response: { thread: { turns: expect.arrayContaining([
      expect.objectContaining({ id: "turn-0", itemsView: "full", items: [expect.objectContaining({ id: "item-turn-0" })] }),
    ]) } } });
  });

  it("retains bounded newer items when one older item cannot fit at limit one", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read") return metadata();
      if (method === "thread/turns/list") return page([{ ...turn("r", []), itemsView: "notLoaded" }]);
      if (!params.cursor) return page([{ turnId: "r", item: agent("newer", "retained output") }], "too-big");
      throw Object.assign(new Error("too large"), { code: "RESPONSE_TOO_LARGE" });
    });
    expect(await hydrateThreadHistory("T", request, () => true)).toMatchObject({ truncated: true, warning: expect.stringContaining("单条历史"),
      response: { thread: { turns: [{ id: "r", itemsView: "summary", items: [{ id: "newer" }] }] } } });
  });

  it("uses bounded turn pages when a confirmed legacy full-history read is oversized", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read" && params.includeTurns) throw Object.assign(new Error("too large"), { code: "RESPONSE_TOO_LARGE" });
      if (method === "thread/read") return { thread: thread("T", [], { historyMode: "legacy" }) };
      return page([turn("old", [agent("a", "legacy history")])]);
    });
    expect(await hydrateThreadHistory("T", request, () => true, "legacy")).toMatchObject({ truncated: false,
      response: { thread: { turns: [{ id: "old" }] } } });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read", "thread/read", "thread/turns/list"]);
  });

  it("keeps an oversized legacy turn explicitly incomplete instead of calling unsupported item pagination", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read" && !params.includeTurns) return { thread: thread("T", [], { historyMode: "legacy" }) };
      if (method === "thread/turns/list" && params.itemsView === "summary") return page([{ ...turn("old", [agent("summary", "summary")]), itemsView: "summary" }]);
      throw Object.assign(new Error("too large"), { code: "RESPONSE_TOO_LARGE" });
    });
    expect(await hydrateThreadHistory("T", request, () => true, "legacy")).toMatchObject({ truncated: true,
      warning: expect.stringContaining("旧版会话"), response: { thread: { turns: [{ id: "old", itemsView: "summary" }] } } });
    expect(request.mock.calls.some(([method]) => method === "thread/items/list")).toBe(false);
  });
});
