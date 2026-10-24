import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GatewayController } from "../src/control.js";

const harness = vi.hoisted(() => ({ route: null as any, preClose: null as any, requests: [] as any[] }));
vi.mock("fastify", () => ({ default: () => ({
  register: async () => {},
  addHook(name: string, callback: unknown) { if (name === "preClose") harness.preClose = callback; },
  get(route: string, ...args: any[]) { if (route === "/ws") harness.route = args.at(-1); },
  setNotFoundHandler() {}, listen() {}, close: async () => {},
}) }));
vi.mock("@fastify/websocket", () => ({ default: vi.fn() }));
vi.mock("@fastify/static", () => ({ default: vi.fn() }));
vi.mock("../src/codex/process.js", () => ({ CodexSupervisor: class {
  state = "ready";
  request(method: string, params: unknown) { harness.requests.push({ method, params }); return Promise.resolve({}); }
  start() {} stop() { return Promise.resolve(); }
} }));

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  ping = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.emit("close"); });
  terminate = vi.fn(() => { this.readyState = 3; this.emit("close"); });
}

const token = ["heartbeat", "test", "secret", ""].join("-").repeat(3);
const sockets: Socket[] = [];
const signals = ["SIGINT", "SIGTERM"] as const;
const oldSignals = new Map<string, ReturnType<typeof process.listeners>>();
let home: string;
let controller: GatewayController;

beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "gateway-heartbeat-"));
  vi.stubEnv("GATEWAY_CONTROL_HOME", home);
  vi.stubEnv("GATEWAY_UNSAFE_SINGLE_USER", "1");
  vi.stubEnv("CODEX_WORKER_LAUNCHER", "");
  vi.stubEnv("GATEWAY_TOKEN", token);
  vi.stubEnv("GATEWAY_BOOTSTRAP_AUTH", "required");
  vi.stubEnv("HOST", "127.0.0.1"); vi.stubEnv("PORT", "8410");
  for (const signal of signals) oldSignals.set(signal, process.listeners(signal));
  const connect = GatewayController.prototype.connect;
  vi.spyOn(GatewayController.prototype, "connect").mockImplementation(function(id, client) {
    controller = this;
    return connect.call(this, id, client);
  });
  await import("../src/index.js");
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.resolve();
  expect(controller.clientCount).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  harness.requests.length = 0;
  vi.useRealTimers();
});
afterAll(() => {
  for (const signal of signals) for (const listener of process.listeners(signal)) {
    if (!oldSignals.get(signal)?.includes(listener)) process.removeListener(signal, listener);
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
function connect(): Socket {
  const socket = new Socket();
  sockets.push(socket);
  harness.route(socket, { headers: { host: "127.0.0.1:8410", origin: "http://127.0.0.1:8410", authorization: `Bearer ${token}` } });
  return socket;
}
const detached = () => harness.requests.filter(request => request.method === "gateway/disconnect");

it("reclaims all silent connections and sends worker cleanup before admitting replacement browsers", async () => {
  vi.useFakeTimers();
  const vanished = Array.from({ length: 16 }, connect);
  await Promise.resolve();
  expect(controller.clientCount).toBe(16);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(vanished.every(socket => socket.ping.mock.calls.length === 1)).toBe(true);
  expect(detached()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(vanished.every(socket => socket.terminate.mock.calls.length === 1)).toBe(true);
  expect(controller.clientCount).toBe(0);
  expect(detached()).toHaveLength(16);
  const replacement = connect(); await Promise.resolve();
  expect(replacement.close).not.toHaveBeenCalled();
  expect(controller.clientCount).toBe(1);
});

it("keeps an idle background page alive through protocol pongs without application messages", async () => {
  vi.useFakeTimers();
  const socket = connect(); await Promise.resolve();
  for (let interval = 0; interval < 20; interval++) {
    await vi.advanceTimersByTimeAsync(30_000);
    socket.emit("pong");
  }
  expect(socket.ping).toHaveBeenCalledTimes(20);
  expect(socket.send).not.toHaveBeenCalled();
  expect(socket.terminate).not.toHaveBeenCalled();
  expect(controller.clientCount).toBe(1);
  expect(detached()).toHaveLength(0);
});

it("detaches exactly once across error, terminate and close and drops late RPC frames", async () => {
  vi.useFakeTimers();
  const socket = connect(); await Promise.resolve();
  socket.emit("error", new Error("network lost"));
  socket.emit("close");
  socket.emit("error", new Error("late error"));
  socket.emit("message", Buffer.from(JSON.stringify({ kind: "rpc", id: 1, method: "model/list" })));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(detached()).toHaveLength(1);
  expect(socket.terminate).toHaveBeenCalledOnce();
  expect(socket.ping).not.toHaveBeenCalled();
  expect(harness.requests.some(request => request.method === "gateway/dispatch")).toBe(false);
});

it("terminates sockets and clears heartbeat timers on server shutdown without a peer handshake", async () => {
  vi.useFakeTimers();
  const one = connect(), two = connect(); await Promise.resolve();
  await harness.preClose();
  await harness.preClose();
  expect(one.terminate).toHaveBeenCalledOnce();
  expect(two.terminate).toHaveBeenCalledOnce();
  expect(detached()).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});
