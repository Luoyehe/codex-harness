import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "../src/api/ws.js";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  bufferedAmount = 0;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

describe("GatewayClient connection generations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:8410" });
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("ignores late close/message callbacks from a replaced socket", async () => {
    const client = new GatewayClient();
    const notification = vi.fn();
    client.onNotification(notification);
    client.connect();
    const oldSocket = FakeWebSocket.instances[0];
    oldSocket.open();
    const oldRequest = client.rpc("old/request");
    const oldRejected = expect(oldRequest).rejects.toThrow("connection replaced");

    // Model a CLOSED socket whose close callback is still queued.
    oldSocket.readyState = FakeWebSocket.CLOSED;
    client.connect();
    const currentSocket = FakeWebSocket.instances[1];
    currentSocket.open();
    const currentRequest = client.rpc<string>("current/request");
    const currentId = JSON.parse(currentSocket.sent.at(-1)!).id;

    oldSocket.message({ kind: "rpcResult", id: currentId, error: "stale failure" });
    oldSocket.message({ kind: "notification", method: "stale/event", params: {} });
    oldSocket.onclose?.();
    expect(client.state).toBe("open");
    expect(notification).not.toHaveBeenCalled();

    currentSocket.message({ kind: "rpcResult", id: currentId, result: "ok" });
    await expect(currentRequest).resolves.toBe("ok");
    await oldRejected;
    client.close();
  });

  it("cancels a queued reconnect when an explicit connection succeeds first", () => {
    const client = new GatewayClient();
    client.connect();
    const oldSocket = FakeWebSocket.instances[0];
    oldSocket.open();

    oldSocket.readyState = FakeWebSocket.CLOSED;
    oldSocket.onclose?.(); // queues the 500ms retry
    client.connect(); // explicit retry must consume/cancel that timer
    const currentSocket = FakeWebSocket.instances[1];
    currentSocket.open();

    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(client.state).toBe("open");
    client.close();
  });

  it.each([[4001, "authentication"], [4003, "configuration"]])("does not hot-loop on explicit auth/configuration close %s", (code, expected) => {
    const client = new GatewayClient(); client.connect();
    const socket = FakeWebSocket.instances[0]; socket.open(); socket.readyState = FakeWebSocket.CLOSED;
    socket.onclose?.({ code: Number(code) });
    vi.advanceTimersByTime(60_000);
    expect(client.failure).toBe(expected); expect(FakeWebSocket.instances).toHaveLength(1);
    client.connect(); expect(FakeWebSocket.instances).toHaveLength(2); client.close();
  });

  it("bounds requests, frees timed-out entries and preserves delivery uncertainty", async () => {
    const client = new GatewayClient(); client.connect(); const socket = FakeWebSocket.instances[0]; socket.open();
    const pending = Array.from({ length: 128 }, () => client.rpc("test/pending").catch((error) => error));
    await expect(client.rpc("test/excess")).rejects.toMatchObject({ delivery: "not_sent" });
    await vi.advanceTimersByTimeAsync(180_000);
    const results = await Promise.all(pending);
    expect(results.every((error) => (error as { delivery?: string }).delivery === "unknown")).toBe(true);
    const next = client.rpc("test/next"); const id = JSON.parse(socket.sent.at(-1)!).id;
    socket.message({ kind: "rpcResult", id, error: "upstream uncertain", errorCode: "OPERATION_UNKNOWN", operationState: "unknown" });
    await expect(next).rejects.toMatchObject({ delivery: "unknown", code: "OPERATION_UNKNOWN" });
    client.close();
  });

  it("rejects an over-budget outbound socket before enqueueing additional bytes", async () => {
    const client = new GatewayClient(); client.connect(); const socket = FakeWebSocket.instances[0]; socket.open();
    socket.bufferedAmount = 40 * 1024 * 1024 + 1;
    await expect(client.rpc("test/excess")).rejects.toMatchObject({ delivery: "not_sent" });
    expect(socket.sent).toHaveLength(0); client.close();
  });

  it("preserves management transport uncertainty instead of calling it a rejection", async () => {
    const client = new GatewayClient(); client.connect(); const socket = FakeWebSocket.instances[0]; socket.open();
    const pending = client.rpc("admin/provider/switch"); const id = JSON.parse(socket.sent.at(-1)!).id;
    socket.message({ kind: "rpcResult", id, error: "worker timeout", errorCode: "MANAGEMENT_UNKNOWN" });
    await expect(pending).rejects.toMatchObject({ delivery: "unknown", code: "MANAGEMENT_UNKNOWN" });
    expect(socket.sent).toHaveLength(1); client.close();
  });
});
