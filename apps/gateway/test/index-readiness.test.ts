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

const methods = ["management/status", "turn/operation", "thread/start/operation", "admin/logs"] as const;
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
  harness.disconnect.mockImplementation(async () => {});
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

it("records a queued turn before a control-local receipt query even while worker attachment is stalled", async () => {
  vi.stubEnv("GATEWAY_UNSAFE_SINGLE_USER", "1");
  vi.stubEnv("CODEX_WORKER_LAUNCHER", "");
  const { GatewayController } = await vi.importActual<typeof import("../src/control.js")>("../src/control.js");
  const controller = new GatewayController(path.join(home, "receipt-race"));
  const sent: unknown[] = [];
  (controller as any).backend.request = vi.fn(async (method: string, params: any) => {
    if (method === "gateway/connect") return new Promise<void>((resolve) => { attached = resolve; });
    if (method === "gateway/dispatch") { sent.push(params); return { turn: { id: "accepted-turn", status: "inProgress" } }; }
    return {};
  });
  harness.connect.mockImplementation(controller.connect.bind(controller));
  harness.dispatch.mockImplementation(controller.dispatch.bind(controller));
  harness.disconnect.mockImplementation(controller.disconnect.bind(controller));
  const socket = connect(true);
  const params = { clientOperationId: "queued-before-attachment", threadId: "thread-one", text: "one intended send" };
  socket.rpc(1, "turn/start", params);
  socket.rpc(2, "turn/operation", { clientOperationId: params.clientOperationId });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(socket.results().find((message) => message.id === 2)?.result).toMatchObject({ state: "unknown", threadId: "thread-one" });
  expect(sent).toHaveLength(0);
  attached();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(sent).toHaveLength(1);
  expect(socket.results().find((message) => message.id === 1)?.result.turn.id).toBe("accepted-turn");
});

it("records a queued thread creation before its receipt query can overtake stalled worker attachment", async () => {
  vi.stubEnv("GATEWAY_UNSAFE_SINGLE_USER", "1");
  vi.stubEnv("CODEX_WORKER_LAUNCHER", "");
  const { GatewayController } = await vi.importActual<typeof import("../src/control.js")>("../src/control.js");
  const controller = new GatewayController(path.join(home, "thread-receipt-race"));
  const sent: unknown[] = [];
  (controller as any).backend.request = vi.fn(async (method: string, params: any) => {
    if (method === "gateway/connect") return new Promise<void>((resolve) => { attached = resolve; });
    if (method === "gateway/dispatch") { sent.push(params); return { thread: { id: "created-thread", cwd: params.params.cwd } }; }
    return {};
  });
  harness.connect.mockImplementation(controller.connect.bind(controller));
  harness.dispatch.mockImplementation(controller.dispatch.bind(controller));
  harness.disconnect.mockImplementation(controller.disconnect.bind(controller));
  const socket = connect(true);
  const params = { clientOperationId: "queued-thread-before-attachment", cwd: "/project" };
  socket.rpc(1, "thread/start", params);
  socket.rpc(2, "thread/start/operation", { clientOperationId: params.clientOperationId });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(socket.results().find((message) => message.id === 2)?.result).toMatchObject({ state: "unknown", cwd: "/project" });
  expect(sent).toHaveLength(0);
  attached();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(sent).toHaveLength(1);
  expect(socket.results().find((message) => message.id === 1)?.result).toMatchObject({
    thread: { id: "created-thread" }, clientOperationId: params.clientOperationId,
  });
});

it("serves every authenticated local query during stalled attachment while ordinary RPC still waits", async () => {
  const socket = connect(true);
  const params = { clientOperationId: "example-operation" };
  for (const [index, method] of methods.entries()) socket.rpc(index + 1, method, params);
  socket.rpc(methods.length + 1, "thread/list", { limit: 1 });

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
  expect(harness.dispatch).toHaveBeenCalledTimes(methods.length + 1);
  expect(harness.dispatch).toHaveBeenLastCalledWith("thread/list", { limit: 1 }, clientId);
  expect(socket.results().at(-1)).toEqual({
    kind: "rpcResult", id: methods.length + 1, result: { method: "thread/list", params: { limit: 1 } },
  });
});

it.each([
  ["direct error metadata", Object.assign(new Error("outcome unavailable"), { delivery: "unknown" })],
  ["app-server error data", Object.assign(new Error("worker outcome unavailable"), { rpcError: { data: { delivery: "unknown" } } })],
  ["missing error metadata", new Error("unclassified failure")],
])("preserves %s delivery uncertainty in browser RPC failures", async (_label, failure) => {
  const socket = connect(true);
  harness.dispatch.mockRejectedValueOnce(failure);
  socket.rpc(1, "management/status", {});
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(socket.results()).toEqual([{
    kind: "rpcResult",
    id: 1,
    error: failure.message,
    delivery: "unknown",
    operationState: "unknown",
  }]);
});

it("marks gateway admission rejection as not sent", async () => {
  const socket = connect(true);
  harness.dispatch.mockImplementation(() => new Promise(() => {}));
  for (let id = 1; id <= 8; id++) socket.rpc(id, "management/status", {});
  socket.rpc(9, "management/status", {});
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(socket.results()).toContainEqual(expect.objectContaining({
    kind: "rpcResult",
    id: 9,
    errorCode: "BUSY",
    delivery: "not_sent",
  }));
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
