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
    expect(turns.get("t")).toBe("second");
    observe("turn/completed", { threadId: "t", turn: { id: "second" } });
    expect(turns.get("t")).toBeNull();
  });

  it("ignores malformed or unsupported notification envelopes", () => {
    expect(observedNotification("turn/started", { threadId: "t" })).toBeNull();
    expect(observedNotification("error", { threadId: "t", turnId: "1" })).toBeNull();
    expect(observedNotification("turn/interrupted", { threadId: "t", turnId: "1" })).toBeNull();
    expect(observedNotification("thread/status/changed", { threadId: "t", status: "idle" })).toBeNull();
  });
});
