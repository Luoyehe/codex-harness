import { describe, it, expect, vi, beforeEach } from "vitest";
import { AutoCompaction } from "../src/auto-compaction.js";

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

describe("AutoCompaction state machine", () => {
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

  it("does not publish a stale failure after app-server state is reset", async () => {
    let reject!: (error: Error) => void;
    const request = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
    const notify = vi.fn();
    const ac = new AutoCompaction({ supervisor: { request } as any, notify }, () => 0.9);
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    ac.reset();
    reject(new Error("old connection closed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).not.toHaveBeenCalledWith("thread/autoCompactFailed", expect.anything());
  });
  it("does not compact below the threshold", () => {
    const { ac, request } = makeCompaction(0.9);
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
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    ac.observe("thread/tokenUsage/updated", usage(960, 1000));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("after a compaction, re-arming requires a below-threshold reading first", () => {
    const { ac, request } = makeCompaction(0.9);
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    expect(request).toHaveBeenCalledTimes(1);
    ac.observe("item/completed", {
      threadId: "t1",
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

  it("thread/compacted is a fallback completion signal with the same re-arm rule", () => {
    const { ac, request } = makeCompaction(0.9);
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    expect(request).toHaveBeenCalledTimes(1);
    ac.observe("thread/compacted", { threadId: "t1" });
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    expect(request).toHaveBeenCalledTimes(1); // stale reading held off
    ac.observe("thread/tokenUsage/updated", usage(400, 1000)); // re-arm
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("threshold 0 disables compaction entirely", () => {
    const { ac, request } = makeCompaction(0);
    ac.observe("thread/tokenUsage/updated", usage(999, 1000));
    expect(request).not.toHaveBeenCalled();
  });

  it("a failed compaction retries on the next trigger", async () => {
    const request = vi.fn(async () => { throw new Error("boom"); });
    const notify = vi.fn();
    const ac = new AutoCompaction({ supervisor: { request } as any, notify }, () => 0.9);
    ac.observe("thread/tokenUsage/updated", usage(950, 1000));
    // flush microtasks (the .then().catch() rejection chain needs several hops)
    await new Promise((r) => setTimeout(r, 0));
    expect(notify).toHaveBeenCalledWith("thread/autoCompactFailed", expect.objectContaining({ threadId: "t1" }));
    ac.observe("thread/tokenUsage/updated", usage(960, 1000));
    expect(request).toHaveBeenCalledTimes(2);
  });
});
