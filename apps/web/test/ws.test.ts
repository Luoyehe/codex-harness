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
  onclose: (() => void) | null = null;
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
});
