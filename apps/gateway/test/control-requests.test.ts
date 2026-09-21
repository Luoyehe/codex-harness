import { afterEach, expect, it, vi } from "vitest";
import { ControlRequests } from "../src/control-requests.js";

afterEach(() => vi.useRealTimers());
it("correlates only exact response ids while permitting independent nested dispatch", async () => {
  const send = vi.fn();
  const requests = new ControlRequests(send);
  const pending = requests.compact("t1");
  const frame = send.mock.calls[0][0];
  expect(frame).toEqual({ id: "auto-compact-1", method: "gateway/autoCompact", params: { threadId: "t1" } });
  expect(requests.receive({ id: frame.id, method: "gateway/dispatch", params: {} })).toBe(false);
  expect(requests.receive({ id: "other", result: {} })).toBe(false);
  expect(requests.receive({ id: frame.id, result: {}, error: {} })).toBe(false);
  expect(requests.receive({ id: frame.id, result: { accepted: true } })).toBe(true);
  await expect(pending).resolves.toEqual({ accepted: true });
  requests.close();
});
it("keeps timeout and connection-loss outcomes unknown without resending", async () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const requests = new ControlRequests(send, 10);
  const timed = expect(requests.compact("t1")).rejects.toMatchObject({ delivery: "unknown" });
  await vi.advanceTimersByTimeAsync(10);
  await timed;
  expect(requests.receive({ id: "auto-compact-1", result: {} })).toBe(false);
  expect(send).toHaveBeenCalledOnce();
  const closed = expect(requests.compact("t2")).rejects.toMatchObject({ delivery: "unknown" });
  requests.close();
  await closed;
  await expect(requests.compact("t3")).rejects.toMatchObject({ delivery: "rejected" });
});
it("bounds outstanding admission requests and preserves explicit rejection metadata", async () => {
  const send = vi.fn();
  const requests = new ControlRequests(send);
  const waiting = Array.from({ length: 32 }, (_, index) => requests.compact(`t${index}`).catch((error) => error));
  await expect(requests.compact("excess")).rejects.toMatchObject({ delivery: "rejected" });
  requests.receive({ id: "auto-compact-1", error: { message: "busy", data: { delivery: "rejected" } } });
  expect(await waiting[0]).toMatchObject({ delivery: "rejected" });
  expect(send).toHaveBeenCalledTimes(32);
  requests.close();
  await Promise.all(waiting);
});
