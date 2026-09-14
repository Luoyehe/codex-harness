import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const harness = vi.hoisted(() => ({
  route: undefined as undefined | ((socket: any, request: any) => void),
  connect: vi.fn(),
  dispatch: vi.fn(),
  disconnect: vi.fn(async () => {}),
  answer: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(async () => {}),
}));

vi.mock("fastify", () => ({
  default: () => ({
    register: vi.fn(async () => {}),
    addHook: vi.fn(),
    get: (route: string, ...args: any[]) => {
      if (route === "/ws") harness.route = args.at(-1);
    },
    setNotFoundHandler: vi.fn(),
    // Capture the real entrypoint's routes without opening a network listener.
    listen: vi.fn(),
    close: vi.fn(async () => {}),
  }),
}));
vi.mock("@fastify/websocket", () => ({ default: vi.fn() }));
vi.mock("@fastify/static", () => ({ default: vi.fn() }));
vi.mock("../src/auth-token.js", () => ({
  AuthToken: class {
    isTrustedHost(host: string) { return host === "127.0.0.1:8410"; }
    extract(request: any) { return request.headers.authorization; }
    verify(presented: unknown) { return presented === "Bearer example"; }
  },
  setBootstrapCookie: vi.fn(),
}));
vi.mock("../src/control.js", () => ({
  GatewayController: class {
    codexState = "starting";
    clientCount = 0;
    connect = harness.connect;
    dispatch = harness.dispatch;
    disconnect = harness.disconnect;
    answer = harness.answer;
    start = harness.start;
    stop = harness.stop;
  },
}));

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  terminate = vi.fn();
  close = vi.fn((code?: number, reason?: string) => {
    this.readyState = 3;
    this.emit("close", code, reason);
  });
  rpc(id: number, method: string, params: unknown) {
    this.emit("message", Buffer.from(JSON.stringify({ kind: "rpc", id, method, params })));
  }
  results() { return this.send.mock.calls.map(([message]) => JSON.parse(message)); }
}

const methods = ["management/status", "turn/operation", "admin/logs"] as const;
const sockets: Socket[] = [];
const signals = ["SIGINT", "SIGTERM"] as const;
const originalListeners = new Map<string, ReturnType<typeof process.listeners>>();
let home: string;
let attached: () => void;

beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), "index-readiness-audit-"));
  vi.stubEnv("GATEWAY_CONTROL_HOME", path.join(home, "control"));
  vi.stubEnv("CODEX_HOME", path.join(home, "worker"));
  vi.stubEnv("HOST", "127.0.0.1");
  vi.stubEnv("PORT", "8410");
  for (const signal of signals) originalListeners.set(signal, process.listeners(signal));
  await import("../src/index.js");
  expect(harness.route).toBeTypeOf("function");
});

beforeEach(() => {
  vi.clearAllMocks();
  const attachment = new Promise<void>((resolve) => { attached = resolve; });
  harness.connect.mockReturnValue(attachment);
  harness.dispatch.mockImplementation(async (method, params) => ({ method, params }));
});

afterEach(async () => {
  attached();
  for (const socket of sockets.splice(0)) socket.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.restoreAllMocks();
});

afterAll(() => {
  // Importing the executable installs signal handlers. Leave the test runner's
  // original handlers untouched, and never emit a signal or invoke process.exit.
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) {
      if (!originalListeners.get(signal)?.includes(listener)) process.removeListener(signal, listener);
    }
  }
  vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
});

function connect(authenticated: boolean): Socket {
  const socket = new Socket();
  sockets.push(socket);
  harness.route!(socket, {
    headers: {
      host: "127.0.0.1:8410",
      origin: "http://127.0.0.1:8410",
      ...(authenticated ? { authorization: "Bearer example" } : {}),
    },
  });
  return socket;
}

it("serves all three authenticated local queries during stalled attachment while ordinary RPC still waits", async () => {
  const socket = connect(true);
  const params = { clientOperationId: "example-operation" };
  for (const [index, method] of methods.entries()) socket.rpc(index + 1, method, params);
  socket.rpc(4, "thread/list", { limit: 1 });

  // A complete event-loop turn, not a timed sleep: pending attachment must not
  // prevent controller-local replies from reaching the authenticated socket.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(harness.connect).toHaveBeenCalledTimes(1);
  const clientId = harness.connect.mock.calls[0][0];
  expect(harness.dispatch.mock.calls).toEqual(methods.map((method) => [method, params, clientId]));
  expect(socket.results()).toEqual(methods.map((method, index) => ({
    kind: "rpcResult", id: index + 1, result: { method, params },
  })));
  expect(socket.close).not.toHaveBeenCalled();

  attached();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(harness.dispatch).toHaveBeenCalledTimes(4);
  expect(harness.dispatch).toHaveBeenLastCalledWith("thread/list", { limit: 1 }, clientId);
  expect(socket.results().at(-1)).toEqual({
    kind: "rpcResult", id: 4, result: { method: "thread/list", params: { limit: 1 } },
  });
});

it.each(methods)("does not let an unauthenticated socket dispatch %s before worker readiness", async (method) => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const socket = connect(false);
  // Even a peer that sends an RPC after rejection has no dispatch listener.
  socket.rpc(1, method, { clientOperationId: "example-operation" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(socket.close).toHaveBeenCalledWith(4001, "unauthorized");
  expect(harness.connect).not.toHaveBeenCalled();
  expect(harness.dispatch).not.toHaveBeenCalled();
  expect(socket.send).not.toHaveBeenCalled();
  expect(socket.listenerCount("message")).toBe(0);
});
