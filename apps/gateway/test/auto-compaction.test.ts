import { describe, it, expect, vi, beforeEach } from "vitest";
import { AutoCompaction } from "../src/auto-compaction.js";
import { AppServerRequestError } from "../src/codex/rpc.js";

function makeCompaction(threshold: number) {
  const request = vi.fn(async () => ({}));
  const notify = vi.fn();
  const ac = new AutoCompaction(
    { supervisor: { request } as any, notify },
    () => threshold,
  );
  return { ac, request, notify };
}

const usage = (last: number, window: number) => ({
  threadId: "t1",
  tokenUsage: { last: { totalTokens: last }, modelContextWindow: window },
});
const idle = (ac: AutoCompaction, threadId = "t1") =>
  ac.observe("thread/status/changed", { threadId, status: { type: "idle" } });

describe("AutoCompaction state machine", () => {
  it("waits for both acceptance and completion before any new trigger", async () => {
    let reject!: (error: Error) => void;
    const request = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
    const ac = new AutoCompaction({ supervisor: { request } as any, notify: vi.fn() }, () => 0.9);
    idle(ac);
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    ac.observe("thread/compacted", { threadId: "t1" });
    ac.observe("thread/tokenUsage/updated", usage(100, 1000));
    ac.observe("thread/tokenUsage/updated", usage(960, 1000));
    expect(request).toHaveBeenCalledOnce();
    reject(new Error("lost acknowledgement"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    ac.observe("thread/compacted", { threadId: "t1" });
    ac.observe("thread/tokenUsage/updated", usage(100, 1000));
    ac.observe("thread/tokenUsage/updated", usage(960, 1000));
    expect(request).toHaveBeenCalledOnce();
    ac.reset();
  });
  it("does not automatically retry a compaction whose acceptance is unknown", async () => {
    const request = vi.fn(async () => { throw new Error("lost response"); });
    const ac = new AutoCompaction({ supervisor: { request } as any, notify: vi.fn() }, () => 0.9);
    idle(ac);
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    await new Promise((resolve) => setTimeout(resolve, 0));
    ac.observe("thread/tokenUsage/updated", usage(960, 1000));
    expect(request).toHaveBeenCalledOnce();
    ac.observe("thread/compacted", { threadId: "t1" });
    ac.observe("thread/tokenUsage/updated", usage(100, 1000));
    ac.observe("thread/tokenUsage/updated", usage(960, 1000));
    expect(request).toHaveBeenCalledOnce();
    ac.reset();
  });

  it("fails closed on a non-Error compaction rejection without leaking its value", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const notify = vi.fn();
    const request = vi.fn(async () => Promise.reject("provider-secret-shaped-value"));
    const ac = new AutoCompaction({ supervisor: { request } as any, notify }, () => 0.9);

    idle(ac);
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notify).toHaveBeenCalledWith("thread/autoCompactFailed", expect.objectContaining({
      threadId: "t1",
      error: "compaction request rejected without an Error",
      outcome: "unknown",
    }));
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("provider-secret-shaped-value");
    ac.observe("thread/tokenUsage/updated", usage(960, 1000));
    expect(request).toHaveBeenCalledOnce();
    ac.reset();
  });

  it("a missing completion watchdog never treats still-running compaction as retryable", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({}));
    const ac = new AutoCompaction({ supervisor: { request } as any, notify: vi.fn(), watchdogMs: 10 }, () => 0.9);
    try {
      idle(ac);
      ac.observe("thread/tokenUsage/updated", usage(950, 1000));
      await vi.advanceTimersByTimeAsync(20);
      ac.observe("thread/tokenUsage/updated", usage(960, 1000));
      expect(request).toHaveBeenCalledOnce();
    } finally { ac.reset(); vi.useRealTimers(); }
  });
  it("does not compact during retries or on an older turn's completion", () => {
    const { ac, request } = makeCompaction(0.9);
    ac.observe("turn/started", { threadId: "t1", turn: { id: "current" } });
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    ac.observe("error", { threadId: "t1", turnId: "current", willRetry: true, error: {} });
    ac.observe("turn/completed", { threadId: "t1", turn: { id: "older" } });
    ac.observe("thread/tokenUsage/updated", usage(960, 1000));
    expect(request).not.toHaveBeenCalled();
    ac.observe("turn/completed", { threadId: "t1", turn: { id: "current" } });
    expect(request).toHaveBeenCalledOnce();
  });

  it("disables compaction after conflicting active turn identities", () => {
    const { ac, request } = makeCompaction(0.9);
    ac.observe("turn/started", { threadId: "t1", turn: { id: "first" } });
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    ac.observe("turn/started", { threadId: "t1", turn: { id: "second" } });
    ac.observe("turn/completed", { threadId: "t1", turn: { id: "second" } });
    ac.observe("thread/tokenUsage/updated", usage(960, 1000));
    expect(request).not.toHaveBeenCalled();
  });

  it("does not publish a stale failure after app-server state is reset", async () => {
    let reject!: (error: Error) => void;
    const request = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
    const notify = vi.fn();
    const ac = new AutoCompaction({ supervisor: { request } as any, notify }, () => 0.9);
    idle(ac);
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    ac.reset();
    reject(new Error("old connection closed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).not.toHaveBeenCalledWith("thread/autoCompactFailed", expect.anything());
  });
  it("does not compact below the threshold", () => {
    const { ac, request } = makeCompaction(0.9);
    idle(ac);
    ac.observe("thread/tokenUsage/updated", usage(100, 1000));
    expect(request).not.toHaveBeenCalled();
  });

  it("compacts between turns when usage crosses the threshold", async () => {
    const { ac, request, notify } = makeCompaction(0.9);
    ac.observe("turn/started", { threadId: "t1", turn: { id: "turn1" } });
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    // turn active — must NOT fire mid-turn
    expect(request).not.toHaveBeenCalled();
    ac.observe("turn/completed", { threadId: "t1", turn: { id: "turn1" } });
    expect(request).toHaveBeenCalledWith("thread/compact/start", { threadId: "t1" });
    expect(notify).toHaveBeenCalledWith("thread/autoCompacting", expect.objectContaining({
      threadId: "t1",
      thresholdPct: 90,
    }));
  });

  it("does not double-fire while a compaction is in flight", () => {
    const { ac, request } = makeCompaction(0.9);
    idle(ac);
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    ac.observe("thread/tokenUsage/updated", usage(960, 1000));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not mistake a late normal-turn error for compaction completion", async () => {
    const { ac, request } = makeCompaction(0.9);
    idle(ac);
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    await Promise.resolve();
    ac.observe("error", { threadId: "t1", turnId: "old-turn", willRetry: false, error: {} });
    ac.observe("thread/tokenUsage/updated", usage(960, 1000));
    expect(request).toHaveBeenCalledOnce();
  });

  it("after a compaction, re-arming requires a below-threshold reading first", async () => {
    const { ac, request } = makeCompaction(0.9);
    idle(ac);
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    expect(request).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    ac.observe("item/completed", {
      threadId: "t1",
      turnId: "compact-turn",
      item: { type: "contextCompaction" },
    });
    // Stale high reading right after compaction — must NOT re-trigger.
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    expect(request).toHaveBeenCalledTimes(1);
    // Usage drops below the threshold → re-armed (still no trigger below).
    ac.observe("thread/tokenUsage/updated", usage(300, 1000));
    expect(request).toHaveBeenCalledTimes(1);
    // A genuinely new rise over the threshold → triggers again.
    ac.observe("thread/tokenUsage/updated", usage(960, 1000));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("thread/compacted is a fallback completion signal with the same re-arm rule", async () => {
    const { ac, request } = makeCompaction(0.9);
    idle(ac);
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    expect(request).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    ac.observe("thread/compacted", { threadId: "t1" });
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    expect(request).toHaveBeenCalledTimes(1); // stale reading held off
    ac.observe("thread/tokenUsage/updated", usage(400, 1000)); // re-arm
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("threshold 0 disables compaction entirely", () => {
    const { ac, request } = makeCompaction(0);
    for (let index = 0; index < 2000; index += 1) {
      ac.observe("thread/tokenUsage/updated", { ...usage(999, 1000), threadId: `disabled-${index}` });
    }
    expect(request).not.toHaveBeenCalled();
    expect((ac as any).threads.size).toBe(0);
  });

  it("bounds valid unique thread state while auto-compaction is enabled", () => {
    const { ac } = makeCompaction(0.9);
    for (let index = 0; index <= AutoCompaction.MAX_TRACKED_THREADS; index += 1) {
      ac.observe("thread/tokenUsage/updated", { ...usage(100, 1000), threadId: `thread-${index}` });
    }
    expect((ac as any).threads.size).toBe(AutoCompaction.MAX_TRACKED_THREADS);
    expect((ac as any).threads.has("thread-0")).toBe(false);
    expect((ac as any).threads.has(`thread-${AutoCompaction.MAX_TRACKED_THREADS}`)).toBe(true);
  });

  it("does not evict a post-compaction tombstone and replay stale high usage", async () => {
    const { ac, request } = makeCompaction(0.9);
    idle(ac);
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    await Promise.resolve();
    ac.observe("thread/compacted", { threadId: "t1" });
    for (let index = 0; index < AutoCompaction.MAX_TRACKED_THREADS; index += 1) {
      ac.observe("thread/tokenUsage/updated", { ...usage(100, 1000), threadId: `idle-${index}` });
    }
    expect((ac as any).threads.has("t1")).toBe(true);
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    expect(request).toHaveBeenCalledOnce();
  });

  it("ignores malformed token counters without allocating thread state", () => {
    const { ac, request } = makeCompaction(0.9);
    for (const [last, window] of [["950", 1000], [-1, 1000], [950, "1000"], [950, -1], [Number.NaN, 1000]] as any[]) {
      ac.observe("thread/tokenUsage/updated", {
        threadId: `malformed-${String(last)}-${String(window)}`,
        tokenUsage: { last: { totalTokens: last }, modelContextWindow: window },
      });
    }
    expect((ac as any).threads.size).toBe(0);
    expect(request).not.toHaveBeenCalled();
  });

  it("a failed compaction retries on the next trigger", async () => {
    const request = vi.fn(async () => { throw new AppServerRequestError("boom"); });
    const notify = vi.fn();
    const ac = new AutoCompaction({ supervisor: { request } as any, notify }, () => 0.9);
    idle(ac);
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    // flush microtasks (the .then().catch() rejection chain needs several hops)
    await new Promise((r) => setTimeout(r, 0));
    expect(notify).toHaveBeenCalledWith("thread/autoCompactFailed", expect.objectContaining({ threadId: "t1" }));
    ac.observe("thread/tokenUsage/updated", usage(960, 1000));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails closed until an explicit idle boundary is observed", () => {
    const { ac, request } = makeCompaction(0.9);
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    ac.observe("turn/completed", { threadId: "t1", turn: { id: "unobserved-old-turn" } });
    expect(request).not.toHaveBeenCalled();
    idle(ac);
    expect(request).toHaveBeenCalledOnce();
  });

  it("an active status blocks compaction even after an earlier turn completion", () => {
    const { ac, request } = makeCompaction(0.9);
    ac.observe("turn/started", { threadId: "t1", turn: { id: "turn1" } });
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    ac.observe("thread/status/changed", { threadId: "t1", status: { type: "active", activeFlags: [] } });
    ac.observe("turn/completed", { threadId: "t1", turn: { id: "turn1" } });
    expect(request).not.toHaveBeenCalled();
    idle(ac);
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not trust status observed while disabled after enabling mid-stream", () => {
    let threshold = 0;
    const request = vi.fn(async () => ({}));
    const ac = new AutoCompaction({ supervisor: { request } as any, notify: vi.fn() }, () => threshold);
    idle(ac); // ignored while disabled; no retained state
    threshold = 0.9;
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    expect(request).not.toHaveBeenCalled();
    idle(ac);
    expect(request).toHaveBeenCalledOnce();
  });
});
