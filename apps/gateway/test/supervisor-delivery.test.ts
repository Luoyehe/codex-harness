import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexSupervisor, type SupervisorConnection } from "../src/codex/process.js";
import { AppServerConnection, AppServerRequestError, isDefiniteAppServerRejection, type AppServerHandlers } from "../src/codex/rpc.js";
import { rpcFailureMessage } from "../src/hub.js";
import { GatewayController } from "../src/control.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function fixture() {
  let handlers!: AppServerHandlers;
  const requests = vi.fn((method: string) => method === "initialize" ? new Promise(() => {}) : Promise.resolve({}));
  const supervisor = new CodexSupervisor("fake", [], {}, {
    onNotification() {}, onServerRequest: async () => ({}), onStateChange() {}, onFatalConnectionLoss() {},
  }, (events) => {
    handlers = events;
    return { spawn() {}, request: requests, notify() {}, kill() {} } as SupervisorConnection;
  });
  supervisor.start();
  return { supervisor, requests, handlers };
}

function expectNotSent(error: unknown) {
  expect(isDefiniteAppServerRejection(error)).toBe(true);
  expect(rpcFailureMessage(1, error)).toMatchObject({ delivery: "not_sent" });
}

it.each(["timeout", "stop", "blocked", "waiter-limit", "ready-invalidated", "ready-no-connection"] as const)(
  "classifies %s before transport handoff as definitely not sent", async (failure) => {
    const { supervisor, requests, handlers } = fixture();
    const extraWaiters: Promise<unknown>[] = [];
    try {
      if (failure === "waiter-limit") {
        for (let index = 0; index < 72; index++) extraWaiters.push(supervisor.waitReady().catch(error => error));
      }
      if (failure === "ready-no-connection") {
        (supervisor as any).setState("ready");
        (supervisor as any).conn = null;
      }
      const pending = supervisor.request("turn/start", { threadId: "thread", input: [] }).catch(error => error);
      if (failure === "timeout") await vi.advanceTimersByTimeAsync(60_000);
      if (failure === "stop") await supervisor.stop();
      if (failure === "blocked") handlers.onCleanupUnconfirmed?.(new Error("owner cleanup is unconfirmed"));
      if (failure === "ready-invalidated") {
        (supervisor as any).setState("ready");
        handlers.onTransportLost?.(new Error("owner lost before continuation"));
      }
      expectNotSent(await pending);
      expect(requests.mock.calls.map(([method]) => method)).toEqual(["initialize"]);
      if (failure === "blocked") expectNotSent(await supervisor.request("model/list", {}).catch(error => error));
    } finally {
      await supervisor.stop();
      await Promise.all(extraWaiters);
    }
  },
);

it("preserves the admission guard's own error before transport handoff", async () => {
  const { supervisor, requests } = fixture();
  (supervisor as any).setState("ready");
  const refusal = new AppServerRequestError("activity became unknown", { code: -32000, data: { delivery: "rejected" } });
  try {
    await expect(supervisor.request("model/list", {}, () => { throw refusal; })).rejects.toBe(refusal);
    expect(requests.mock.calls.map(([method]) => method)).toEqual(["initialize"]);
  } finally { await supervisor.stop(); }
});

it("keeps a real written transport timeout unknown after supervisor handoff", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const frames: any[] = [];
  stdin.on("data", chunk => {
    const frame = JSON.parse(String(chunk));
    frames.push(frame);
    if (frame.method === "initialize") stdout.write(JSON.stringify({ id: frame.id, result: {} }) + "\n");
  });
  const supervisor = new CodexSupervisor("fake", [], {}, {
    onNotification() {}, onServerRequest: async () => ({}), onStateChange() {},
  }, handlers => {
    const transport = new AppServerConnection("fake", [], {}, handlers, { requestTimeoutMs: 10 });
    return {
      spawn: () => transport.attach(stdin, stdout), request: transport.request.bind(transport),
      notify: transport.notify.bind(transport), kill: transport.kill.bind(transport),
    };
  });
  supervisor.start();
  try {
    await supervisor.waitReady();
    const pending = supervisor.request("thread/read", { threadId: "thread" }).catch(error => error);
    expect(frames.at(-1)).toMatchObject({ method: "thread/read", params: { threadId: "thread" } });
    await vi.advanceTimersByTimeAsync(10);
    const error = await pending;
    expect(isDefiniteAppServerRejection(error)).toBe(false);
    expect(rpcFailureMessage(1, error)).toMatchObject({ delivery: "unknown", operationState: "unknown" });
  } finally { await supervisor.stop(); }
});

it("records an unwritten replacement-readiness failure as rejected without locking later controller work", async () => {
  vi.stubEnv("GATEWAY_UNSAFE_SINGLE_USER", "1");
  vi.stubEnv("CODEX_WORKER_LAUNCHER", "");
  const home = mkdtempSync(path.join(tmpdir(), "harness-supervisor-delivery-"));
  const controller = new GatewayController(home);
  const backend = (controller as any).backend;
  const connected = vi.spyOn(backend, "request").mockResolvedValue({});
  await controller.connect("attached-browser", { send() {}, close() {} });
  connected.mockRestore();
  // The old owner is already gone. An in-flight browser frame can still
  // arrive before its close handshake completes, during replacement startup.
  backend.events.onStateChange("restarting");
  backend.state = "starting";
  const written = vi.fn(async () => ({ turn: { id: "fresh-turn", status: "completed" } }));
  backend.conn = { request: written, kill() {} };
  const request = { clientOperationId: "unwritten-replacement-operation", threadId: "thread", text: "fixture" };
  try {
    const pending = controller.dispatch("turn/start", request, "attached-browser", Promise.resolve()).catch(error => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toMatchObject({ errorCode: "OPERATION_REJECTED", delivery: "rejected" });
    expect(written).not.toHaveBeenCalled();
    expect(await controller.dispatch("turn/operation", { clientOperationId: request.clientOperationId }, "attached-browser"))
      .toMatchObject({ state: "rejected" });
    expect(await controller.dispatch("management/status", {}, "attached-browser")).toMatchObject({ state: "idle" });

    backend.state = "ready";
    backend.events.onNotification("gateway/clientMessage", { clientId: "*", message: {
      kind: "notification", method: "appServer/stateChanged", params: { state: "ready" },
    } });
    await expect(controller.dispatch("turn/start", { ...request, clientOperationId: "fresh-replacement-operation" }, "attached-browser"))
      .resolves.toMatchObject({ turn: { id: "fresh-turn" } });
    expect(written).toHaveBeenCalledOnce();
    expect(await controller.dispatch("management/status", {}, "attached-browser")).toMatchObject({ state: "idle" });
  } finally {
    await controller.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
