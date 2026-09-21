import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FLOW_LIMITS, RpcBudget } from "../src/flow-control.js";

const harness = vi.hoisted(() => ({
  route: undefined as undefined | ((socket: any, request: any) => void),
  connect: vi.fn(),
  dispatch: vi.fn(),
  disconnect: vi.fn(async () => {}),
  answer: vi.fn(),
}));

vi.mock("fastify", () => ({
  default: () => ({
    register: vi.fn(async () => {}),
    addHook: vi.fn(),
    get: (route: string, ...args: any[]) => {
      if (route === "/ws") harness.route = args.at(-1);
    },
    setNotFoundHandler: vi.fn(),
    // Exercise the executable's actual message handler without a listener,
    // worker process, provider credentials, or pressure on any live service.
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
    start = vi.fn();
    stop = vi.fn(async () => {});
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
  receive(message: unknown) {
    const raw = Buffer.from(JSON.stringify(message));
    this.emit("message", raw);
    return raw;
  }
  results() { return this.send.mock.calls.map(([message]) => JSON.parse(message)); }
}

const signals = ["SIGINT", "SIGTERM"] as const;
const originalListeners = new Map<string, ReturnType<typeof process.listeners>>();
const sockets: Socket[] = [];
const answerBytes = 1024 * 1024;
let home: string;
let attached: () => void;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), "index-answer-budget-"));
  vi.stubEnv("GATEWAY_CONTROL_HOME", path.join(home, "control"));
  vi.stubEnv("HOST", "127.0.0.1");
  vi.stubEnv("PORT", "8410");
  for (const signal of signals) originalListeners.set(signal, process.listeners(signal));
  await import("../src/index.js");
  expect(harness.route).toBeTypeOf("function");
});

beforeEach(() => {
  vi.clearAllMocks();
  harness.connect.mockReturnValue(new Promise<void>((resolve) => { attached = resolve; }));
  harness.answer.mockImplementation(async () => true);
  harness.dispatch.mockImplementation(async (method, params) => ({ method, params }));
});

afterEach(async () => {
  attached();
  await settle();
  for (const socket of sockets.splice(0)) socket.close();
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) {
      if (!originalListeners.get(signal)?.includes(listener)) process.removeListener(signal, listener);
    }
  }
  vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
});

function connect(): Socket {
  const socket = new Socket();
  sockets.push(socket);
  harness.route!(socket, {
    headers: { host: "127.0.0.1:8410", origin: "http://127.0.0.1:8410", authorization: "Bearer example" },
  });
  return socket;
}

function responseOfSize(bytes: number, requestId = "approval") {
  const response = { kind: "serverRequestResponse", requestId, payload: "" };
  response.payload = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(response)));
  expect(Buffer.byteLength(JSON.stringify(response))).toBe(bytes);
  return response;
}

it("charges the whole UTF-8 frame and snapshots only response fields before waiting for attachment", async () => {
  const acquire = vi.spyOn(RpcBudget.prototype, "acquire");
  const socket = connect();
  const parsed = { kind: "serverRequestResponse", requestId: "input-1", payload: { answer: "中文" }, ignored: "extra" };
  const parse = vi.spyOn(JSON, "parse").mockReturnValueOnce(parsed);
  const raw = socket.receive(parsed);
  parse.mockRestore();

  expect(acquire).toHaveBeenCalledWith(expect.any(String), "serverRequestResponse", raw.byteLength);
  expect(raw.byteLength).toBeGreaterThan(raw.toString().length);
  expect(harness.answer).not.toHaveBeenCalled();
  // Mutating the original parsed envelope distinguishes capturing msg from a
  // sanitized snapshot; there is no reliance on nondeterministic GC metrics.
  parsed.requestId = "replaced";
  parsed.payload = { answer: "replaced" };
  attached();
  await settle();
  expect(harness.answer).toHaveBeenCalledExactlyOnceWith("input-1", { answer: "中文" }, undefined);
  expect(socket.close).not.toHaveBeenCalled();
});

it("admits eight exact 1 MiB answers from two clients using the reserved 8 MiB under ordinary saturation", async () => {
  let budget: RpcBudget | undefined;
  const original = RpcBudget.prototype.acquire;
  vi.spyOn(RpcBudget.prototype, "acquire").mockImplementation(function (this: RpcBudget, ...args) {
    budget = this;
    return original.apply(this, args);
  });
  const first = connect();
  first.receive({ kind: "serverRequestResponse", requestId: "seed", payload: {} });
  attached();
  await settle();
  expect(budget).toBeDefined();
  harness.answer.mockClear();
  // Only accounting is saturated: no 40 MiB body or real worker is allocated.
  const ordinaryOne = budget!.acquire("ordinary-one", "model/list", 36 * answerBytes);
  const ordinaryTwo = budget!.acquire("ordinary-two", "projects/list", 4 * answerBytes);
  harness.connect.mockReturnValue(new Promise<void>((resolve) => { attached = resolve; }));
  const one = connect();
  const two = connect();
  const three = connect();
  try {
    for (let n = 0; n < FLOW_LIMITS.controlsPerClient; n++) {
      one.receive(responseOfSize(answerBytes, `one-${n}`));
      two.receive(responseOfSize(answerBytes, `two-${n}`));
    }
    three.receive({ kind: "serverRequestResponse", requestId: "no-space", payload: {} });
    expect(harness.answer).not.toHaveBeenCalled();
    expect(one.results()).toEqual([]);
    expect(two.results()).toEqual([]);
    expect(three.results()).toEqual([expect.objectContaining({
      kind: "notification", method: "serverRequest/answerRejected",
      params: expect.objectContaining({ serverRequestId: "no-space" }),
    })]);
    expect(one.close).not.toHaveBeenCalled();
    expect(two.close).not.toHaveBeenCalled();

    attached();
    await settle();
    expect(harness.answer).toHaveBeenCalledTimes(8);
    three.receive({ kind: "serverRequestResponse", requestId: "after-release", payload: {} });
    await settle();
    expect(harness.answer).toHaveBeenLastCalledWith("after-release", {}, undefined);
  } finally {
    ordinaryOne();
    ordinaryTwo();
  }
});

it("rejects an oversized frame through answerRejected even when its allowed fields are small", async () => {
  const socket = connect();
  const response = { kind: "serverRequestResponse", requestId: "padded", payload: {}, ignored: "" };
  response.ignored = "x".repeat(FLOW_LIMITS.controlIncomingPerClientBytes + 1 - Buffer.byteLength(JSON.stringify(response)));
  socket.receive(response);
  expect(socket.results()).toEqual([expect.objectContaining({
    kind: "notification", method: "serverRequest/answerRejected",
    params: expect.objectContaining({ serverRequestId: "padded" }),
  })]);
  expect(socket.close).not.toHaveBeenCalled();
  attached();
  await settle();
  expect(harness.answer).not.toHaveBeenCalled();
  socket.receive({ kind: "rpc", id: 1, method: "thread/list", params: { limit: 1 } });
  await settle();
  expect(socket.results().at(-1)).toMatchObject({ kind: "rpcResult", id: 1, result: { method: "thread/list", params: { limit: 1 } } });
});

it("includes the envelope in the 1 MiB retained response limit", async () => {
  const socket = connect();
  const payload = "x".repeat(answerBytes - Buffer.byteLength(JSON.stringify({ payload: "" })));
  expect(Buffer.byteLength(JSON.stringify({ payload }))).toBe(answerBytes);
  socket.receive({ kind: "serverRequestResponse", requestId: "old-subset-boundary", payload });
  expect(socket.close).toHaveBeenCalledExactlyOnceWith(1008, "invalid server response");
  attached();
  await settle();
  expect(harness.answer).not.toHaveBeenCalled();
});

it("preserves bounded rejection notifications and releases answer capacity after controller failure", async () => {
  const socket = connect();
  harness.answer.mockRejectedValue(new Error("x".repeat(5000)));
  for (let n = 0; n < FLOW_LIMITS.controlsPerClient; n++) {
    socket.receive({ kind: "serverRequestResponse", requestId: `failure-${n}`, payload: {} });
  }
  attached();
  await settle();
  expect(harness.answer).toHaveBeenCalledTimes(4);
  for (const [n, message] of socket.results().entries()) {
    expect(message).toEqual({
      kind: "notification", method: "serverRequest/answerRejected",
      params: { serverRequestId: `failure-${n}`, error: "x".repeat(4096) },
    });
  }
  harness.answer.mockResolvedValue(true);
  socket.receive(responseOfSize(answerBytes, "recovered"));
  await settle();
  expect(harness.answer).toHaveBeenCalledTimes(5);
  expect(socket.results()).toHaveLength(4);
});
