import { describe, expect, it } from "vitest";
import { ActiveTurns } from "../src/active-turns.js";
import { observedNotification } from "../src/protocol.js";

describe("active turn identity", () => {
  it("preserves retryable turns and ignores stale completion/error events", () => {
    const turns = new ActiveTurns();
    const observe = (method: string, params: unknown) => {
      const event = observedNotification(method, params);
      expect(event).not.toBeNull();
      turns.observe(event!);
    };
    observe("turn/started", { threadId: "t", turn: { id: "first" } });
    observe("error", { threadId: "t", turnId: "first", willRetry: true, error: { message: "retry" } });
    expect(turns.get("t")).toBe("first");
    observe("turn/started", { threadId: "t", turn: { id: "second" } });
    observe("turn/completed", { threadId: "t", turn: { id: "first" } });
    observe("error", { threadId: "t", turnId: "first", willRetry: false, error: {} });
    expect(turns.get("t")).toBeNull();
    observe("turn/completed", { threadId: "t", turn: { id: "second" } });
    expect(turns.get("t")).toBeNull();
    observe("thread/closed", { threadId: "t" });
    observe("turn/started", { threadId: "t", turn: { id: "fresh" } });
    expect(turns.get("t")).toBe("fresh");
  });

  it("ignores malformed or unsupported notification envelopes", () => {
    expect(observedNotification("turn/started", { threadId: "t" })).toBeNull();
    expect(observedNotification("error", { threadId: "t", turnId: "1" })).toBeNull();
    expect(observedNotification("turn/interrupted", { threadId: "t", turnId: "1" })).toBeNull();
    expect(observedNotification("thread/status/changed", { threadId: "t", status: "idle" })).toBeNull();
    expect(observedNotification("thread/status/changed", { threadId: "t", status: { type: "paused" } })).toBeNull();
    expect(observedNotification("thread/status/changed", { threadId: "t", status: { type: "active" } })).toBeNull();
    expect(observedNotification("thread/status/changed", { threadId: "t", status: { type: "active", activeFlags: ["unknown"] } })).toBeNull();
    expect(observedNotification("thread/status/changed", { threadId: "t", status: { type: "idle" } })).not.toBeNull();
    expect(observedNotification("thread/status/changed", {
      threadId: "t", status: { type: "active", activeFlags: ["waitingOnApproval"] },
    })).not.toBeNull();
    expect(observedNotification("turn/started", { threadId: "x".repeat(257), turn: { id: "1" } })).toBeNull();
    expect(observedNotification("turn/started", { threadId: "t", turn: { id: "bad\0id" } })).toBeNull();
    expect(observedNotification("serverRequest/resolved", { threadId: "t", requestId: "x".repeat(257) })).toBeNull();
  });

  it("bounds valid unique active-turn identities within one backend generation", () => {
    const turns = new ActiveTurns();
    for (let index = 0; index <= ActiveTurns.MAX_TRACKED; index += 1) {
      const event = observedNotification("turn/started", { threadId: `thread-${index}`, turn: { id: `turn-${index}` } });
      expect(event).not.toBeNull();
      turns.observe(event!);
    }
    expect((turns as any).turns.size).toBe(ActiveTurns.MAX_TRACKED);
    expect(turns.get(`thread-${ActiveTurns.MAX_TRACKED}`)).toBeNull();
  });
});
