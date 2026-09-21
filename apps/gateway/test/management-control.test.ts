import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GatewayController } from "../src/control.js";
import { AppServerRequestError } from "../src/codex/rpc.js";
import { rpcFailureMessage } from "../src/hub.js";

const restart = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../src/admin.js", async (original) => ({ ...await original<typeof import("../src/admin.js")>(), scheduleServiceRestart: restart }));
const homes: string[] = [];
function controller() {
  vi.stubEnv("GATEWAY_UNSAFE_SINGLE_USER", "1");
  vi.stubEnv("CODEX_WORKER_LAUNCHER", "");
  const home = mkdtempSync(path.join(os.tmpdir(), "harness-control-management-"));
  homes.push(home);
  const instance = new GatewayController(home);
  return { instance, backend: (instance as any).backend };
}
afterEach(() => { vi.unstubAllEnvs(); restart.mockReset(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function notify(backend: any, method: string, params: unknown) {
  backend.events.onNotification("gateway/clientMessage", { clientId: "*", message: { kind: "notification", method, params } });
}
const managementSuccess = () => ({ ok: true, changed: false, restartRequired: false });

it("admits one durable thread/start per client operation and exposes its controller receipt", async () => {
  const { instance, backend } = controller();
  const upstream = vi.fn(async (_method: string, envelope: any) => ({
    thread: { id: "created-thread", cwd: envelope.params.cwd },
  }));
  backend.request = upstream;
  const params = { clientOperationId: "controller-thread-start", cwd: "/project", model: "chosen" };

  const [first, second] = await Promise.all([
    instance.dispatch("thread/start", params, "browser"),
    instance.dispatch("thread/start", { ...params }, "browser"),
  ]);

  expect(first).toMatchObject({ thread: { id: "created-thread" }, clientOperationId: params.clientOperationId });
  expect(second).toMatchObject({ thread: { id: "created-thread" }, clientOperationId: params.clientOperationId });
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(upstream.mock.calls[0][1]).toMatchObject({
    method: "thread/start",
    params: { cwd: "/project", model: "chosen" },
  });
  expect(upstream.mock.calls[0][1].params).not.toHaveProperty("clientOperationId");
  await expect(instance.dispatch("thread/start/operation", { clientOperationId: params.clientOperationId }, "other-tab"))
    .resolves.toMatchObject({ state: "accepted", cwd: "/project", threadId: "created-thread" });
});

it("records a failed worker attachment as definitely not dispatched thread creation", async () => {
  const { instance, backend } = controller();
  backend.request = vi.fn();
  const id = "attachment-rejected-thread";
  await expect(instance.dispatch("thread/start", { clientOperationId: id, cwd: "/project" }, "browser",
    Promise.reject(new Error("worker failed")))).rejects.toMatchObject({ errorCode: "OPERATION_REJECTED", delivery: "rejected" });
  expect(backend.request).not.toHaveBeenCalled();
  await expect(instance.dispatch("thread/start/operation", { clientOperationId: id }, "browser"))
    .resolves.toMatchObject({ state: "rejected" });
});

it("an accepted in-progress turn blocks management before its started notification arrives", async () => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  backend.request = vi.fn(async (_method, params) => params.method === "turn/start" ? { turn: { id: "accepted-turn", status: "inProgress" } } : managementSuccess());
  await instance.dispatch("turn/start", { clientOperationId: "accepted-before-notification", threadId: "thread-one", text: "fixture" }, "browser");
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  notify(backend, "turn/completed", { threadId: "thread-one", turn: { id: "accepted-turn" } });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).resolves.toMatchObject({ management: { state: "idle" } });
});

it.each([
  { label: "empty", turnId: "" },
  { label: "overlong", turnId: "x".repeat(257) },
  { label: "NUL-containing", turnId: "turn\0id" },
  { label: "non-string", turnId: 42 },
])("does not trust a $label turn id returned by turn/start", async ({ label, turnId }) => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  backend.request = vi.fn(async (_method, params) => params.method === "turn/start"
    ? { turn: { id: turnId, status: "inProgress" } }
    : managementSuccess());
  await instance.dispatch("turn/start", {
    clientOperationId: `invalid-response-${label}`, threadId: "thread-one", text: "fixture",
  }, "browser").catch(() => undefined);
  expect((instance as any).activeTurns.size).toBe(0);
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "unknown" });
  backend.events.onStateChange("restarting");
  expect((instance as any).activeTurns.size).toBe(0);
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "idle" });
});

it("fails closed on malformed activity notifications without retaining attacker-controlled ids", async () => {
  const { instance, backend } = controller();
  notify(backend, "turn/started", { threadId: "thread-one", turn: { id: "x".repeat(257) } });
  notify(backend, "terminal/started", { processId: "terminal\0id" });
  expect((instance as any).activeTurns.size).toBe(0);
  expect((instance as any).activeTerminals.size).toBe(0);
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "unknown" });
  backend.events.onStateChange("restarting");
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "idle" });
});

it("bounds activity notification cardinality and stays unknown until confirmed outer replacement", async () => {
  const { instance, backend } = controller();
  for (let index = 0; index < 256; index += 1) {
    notify(backend, "turn/started", { threadId: `thread-${index}`, turn: { id: `turn-${index}` } });
  }
  notify(backend, "turn/started", { threadId: "thread-over-capacity", turn: { id: "turn-over-capacity" } });
  expect((instance as any).activeTurns.size).toBe(256);
  expect((instance as any).activeTurns.has("thread-over-capacity")).toBe(false);
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "unknown" });
  backend.events.onStateChange("restarting");
  expect((instance as any).activeTurns.size).toBe(0);
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "idle" });
});

it("fails closed when two active turn identities are reported for one thread", async () => {
  const { instance, backend } = controller();
  notify(backend, "turn/started", { threadId: "thread-one", turn: { id: "turn-a" } });
  notify(backend, "turn/started", { threadId: "thread-one", turn: { id: "turn-b" } });
  notify(backend, "turn/completed", { threadId: "thread-one", turn: { id: "turn-b" } });
  expect((instance as any).activeTurns.get("thread-one")).toBe("turn-a");
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "unknown" });
});

it.each(["idle", "notLoaded", "systemError"])(
  "tracks active thread status and releases only its status reservation on %s",
  async (releasedStatus) => {
    const { instance, backend } = controller();
    notify(backend, "appServer/stateChanged", { state: "ready" });
    backend.request = vi.fn(async () => managementSuccess());
    notify(backend, "thread/status/changed", { threadId: "thread-status", status: { type: "active", activeFlags: [] } });
    await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
    await expect(backend.events.onServerRequest("auto", "gateway/autoCompact", { threadId: "thread-status" }))
      .rejects.toMatchObject({ delivery: "rejected" });
    notify(backend, "thread/status/changed", { threadId: "thread-status", status: { type: releasedStatus } });
    await expect(instance.dispatch("admin/catalog/sync", {}, "browser"))
      .resolves.toMatchObject({ management: { state: "idle" } });
  },
);

it("does not let an out-of-order idle status release an exact active turn", async () => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  backend.request = vi.fn(async () => managementSuccess());
  notify(backend, "turn/started", { threadId: "thread-one", turn: { id: "turn-one" } });
  notify(backend, "thread/status/changed", { threadId: "thread-one", status: { type: "idle" } });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  notify(backend, "turn/completed", { threadId: "thread-one", turn: { id: "turn-one" } });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser"))
    .resolves.toMatchObject({ management: { state: "idle" } });
});

it.each([
  { type: "paused" },
  { type: "active" },
  { type: "active", activeFlags: ["futureFlag"] },
])("fails closed on an unknown or malformed thread status %#", async (status) => {
  const { instance, backend } = controller();
  notify(backend, "thread/status/changed", { threadId: "thread-one", status });
  expect((instance as any).activeStatusThreads.size).toBe(0);
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "unknown" });
});

it("bounds active thread-status reservations", async () => {
  const { instance, backend } = controller();
  for (let index = 0; index <= 256; index += 1) {
    notify(backend, "thread/status/changed", {
      threadId: `status-${index}`,
      status: { type: "active", activeFlags: [] },
    });
  }
  expect((instance as any).activeStatusThreads.size).toBe(256);
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "unknown" });
});

it("tracks a device login until matching completion or confirmed cancellation", async () => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  backend.request = vi.fn(async (_method, params) => {
    if (params.method === "account/login/start") return { type: "chatgptDeviceCode", loginId: "login-1", userCode: "CODE", verificationUrl: "https://example.com/device" };
    if (params.method === "account/login/cancel") return { status: "canceled" };
    return { ok: true, changed: false, restartRequired: false };
  });
  await instance.dispatch("account/login/start", { type: "chatgptDeviceCode" }, "browser");
  await expect(instance.dispatch("account/login/status", {}, "browser")).resolves.toEqual({
    state: "active",
    login: { type: "chatgptDeviceCode", loginId: "login-1", userCode: "CODE", verificationUrl: "https://example.com/device" },
  });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  notify(backend, "account/login/completed", { loginId: "another-login", success: true, error: null });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  await expect(instance.dispatch("account/login/cancel", { loginId: "login-1" }, "browser")).resolves.toEqual({ status: "canceled" });
  await expect(instance.dispatch("account/login/status", {}, "browser")).resolves.toEqual({ state: "idle" });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).resolves.toMatchObject({ management: { state: "idle" } });
});

it("keeps an active login reserved when cancellation returns a malformed success envelope", async () => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  backend.request = vi.fn(async (_method, params) => {
    if (params.method === "account/login/start") {
      return { type: "chatgptDeviceCode", loginId: "login-1", userCode: "CODE", verificationUrl: "https://example.com/device" };
    }
    if (params.method === "account/login/cancel") return { status: "success" };
    return managementSuccess();
  });
  await instance.dispatch("account/login/start", { type: "chatgptDeviceCode" }, "browser");
  await expect(instance.dispatch("account/login/cancel", { loginId: "login-1" }, "browser")).rejects.toMatchObject({
    errorCode: "LOGIN_OUTCOME_UNKNOWN", delivery: "unknown", operationState: "unknown",
  });
  await expect(instance.dispatch("account/login/status", {}, "browser")).resolves.toMatchObject({
    state: "active", login: { loginId: "login-1" },
  });
  expect((instance as any).activeLogins.has("login-1")).toBe(true);
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
});

it("does not revive login activity when completion precedes the start response", async () => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  let finish!: (value: unknown) => void;
  backend.request = vi.fn(async (_method, params) => params.method === "account/login/start"
    ? new Promise((resolve) => { finish = resolve; })
    : { ok: true, changed: false, restartRequired: false });
  const login = instance.dispatch("account/login/start", { type: "chatgptDeviceCode" }, "browser");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  notify(backend, "account/login/completed", { loginId: "login-race", success: true, error: null });
  finish({ type: "chatgptDeviceCode", loginId: "login-race", userCode: "CODE", verificationUrl: "https://example.com/device" });
  await login;
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).resolves.toMatchObject({ management: { state: "idle" } });
});

it("keeps an unknown login admission locked until the backend is confirmed replaced", async () => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  backend.request = vi.fn(async (_method, params) => {
    if (params.method === "account/login/start") throw Object.assign(new Error("lost response"), { delivery: "unknown" });
    return { ok: true, changed: false, restartRequired: false };
  });
  await expect(instance.dispatch("account/login/start", { type: "chatgptDeviceCode" }, "browser")).rejects.toThrow("lost response");
  await expect(instance.dispatch("account/login/status", {}, "browser")).resolves.toEqual({ state: "unknown" });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  backend.events.onStateChange("restarting");
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).resolves.toMatchObject({ management: { state: "idle" } });
});

it("treats malformed successful login responses as unknown and reconciles a later completion", async () => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  backend.request = vi.fn(async (_method, params) => params.method === "account/login/start"
    ? { type: "chatgpt", loginId: "wrong-type", userCode: "CODE", verificationUrl: "https://example.com/device" }
    : { ok: true, changed: false, restartRequired: false });
  await expect(instance.dispatch("account/login/start", { type: "chatgptDeviceCode" }, "browser")).rejects.toMatchObject({
    errorCode: "LOGIN_OUTCOME_UNKNOWN", delivery: "unknown",
  });
  await expect(instance.dispatch("account/login/status", {}, "browser")).resolves.toEqual({ state: "unknown" });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  notify(backend, "account/login/completed", { loginId: "lost-login-id", success: false, error: "expired" });
  await expect(instance.dispatch("account/login/status", {}, "browser")).resolves.toEqual({ state: "idle" });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).resolves.toMatchObject({ management: { state: "idle" } });
});

it("does not let a canceled login's late completion unlock a newer unknown login", async () => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  let starts = 0;
  backend.request = vi.fn(async (_method, params) => {
    if (params.method === "account/login/start" && starts++ === 0) {
      return { type: "chatgptDeviceCode", loginId: "login-a", userCode: "CODE-A", verificationUrl: "https://example.com/device" };
    }
    if (params.method === "account/login/start") throw Object.assign(new Error("login B response lost"), { delivery: "unknown" });
    if (params.method === "account/login/cancel") return { status: "canceled" };
    return managementSuccess();
  });
  await instance.dispatch("account/login/start", { type: "chatgptDeviceCode" }, "browser");
  await instance.dispatch("account/login/cancel", { loginId: "login-a" }, "browser");
  await expect(instance.dispatch("account/login/start", { type: "chatgptDeviceCode" }, "browser")).rejects.toThrow("login B response lost");
  expect(await instance.dispatch("account/login/status", {}, "browser")).toEqual({ state: "unknown" });

  notify(backend, "account/login/completed", { loginId: "login-a", success: true, error: null });
  expect(await instance.dispatch("account/login/status", {}, "browser")).toEqual({ state: "unknown" });
  await expect(instance.dispatch("account/login/start", { type: "chatgptDeviceCode" }, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });

  notify(backend, "account/login/completed", { loginId: "login-b", success: false, error: "expired" });
  expect(await instance.dispatch("account/login/status", {}, "browser")).toEqual({ state: "idle" });
});

it("rejects malformed emergency resource ids locally and projects accepted control params", async () => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  backend.request = vi.fn(async () => ({}));
  await expect(instance.dispatch("terminal/terminate", { processId: "x".repeat(257) }, "browser")).rejects.toMatchObject({
    errorCode: "INVALID_REQUEST", delivery: "rejected",
  });
  expect(backend.request).not.toHaveBeenCalled();
  await instance.dispatch("turn/interrupt", {
    threadId: "thread-one", turnId: "turn-one", ignored: "x".repeat(1024 * 1024),
  }, "browser");
  expect(backend.request).toHaveBeenCalledWith("gateway/dispatch", {
    method: "turn/interrupt", params: { threadId: "thread-one", turnId: "turn-one" }, clientId: "browser",
  });
});

it("always cleans backend state even when management journal publication throws", async () => {
  const { instance, backend } = controller();
  const client = { send: vi.fn(), close: vi.fn() };
  (instance as any).clients.set("browser", client);
  (instance as any).activeTurns.set("thread", "turn");
  (instance as any).activeTerminals.add("terminal");
  (instance as any).activeLogins.set("login", { type: "chatgptDeviceCode", loginId: "login", userCode: "CODE", verificationUrl: "https://example.com" });
  vi.spyOn((instance as any).management, "backendTerminated").mockImplementation(() => { throw new Error("disk full"); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(() => backend.events.onStateChange("restarting")).not.toThrow();
  expect(instance.codexState).toBe("restarting");
  expect((instance as any).activeTurns.size).toBe(0);
  expect((instance as any).activeTerminals.size).toBe(0);
  expect((instance as any).activeLogins.size).toBe(0);
  expect(client.close).toHaveBeenCalledWith(1012, expect.stringContaining("reconnect"));
});

it("still forwards ready notifications when readiness journal publication throws", () => {
  const { instance, backend } = controller();
  const client = { send: vi.fn(), close: vi.fn() };
  (instance as any).clients.set("browser", client);
  vi.spyOn((instance as any).management, "backendReady").mockImplementation(() => { throw new Error("disk full"); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(() => notify(backend, "appServer/stateChanged", { state: "ready" })).not.toThrow();
  expect(instance.codexState).toBe("ready");
  expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ method: "appServer/stateChanged" }));
});

it("broadcasts the ledger's normalized attachment snapshot", async () => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  backend.request = vi.fn(async () => ({ turn: { id: "turn-normalized", status: "completed" } }));
  const broadcast = vi.spyOn(instance as any, "broadcast");
  await instance.dispatch("turn/start", {
    clientOperationId: "normalized-attachment-operation", threadId: "thread-one", text: "fixture",
    attachments: [{ path: "/upload/report.csv" }],
  }, "browser");
  expect(broadcast).toHaveBeenCalledWith("harness/turnAccepted", expect.objectContaining({
    attachments: [{ path: "/upload/report.csv", name: "report.csv", kind: "file" }],
  }));
});

it.each(["thread/delete", "thread/name/set", "thread/archive", "projects/add", "attachment/upload"])(
  "an in-flight stateful %s operation blocks a configuration transaction",
  async (statefulMethod) => {
    const { instance, backend } = controller();
    notify(backend, "appServer/stateChanged", { state: "ready" });
    let finish!: (value: unknown) => void;
    backend.request = vi.fn(async (_method, params) => params.method === statefulMethod
      ? new Promise((resolve) => { finish = resolve; })
      : { ok: true, changed: false, restartRequired: false });
    const pending = instance.dispatch(statefulMethod, {}, "browser");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
    finish({});
    await pending;
    await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).resolves.toMatchObject({ management: { state: "idle" } });
  },
);

it("a running configuration transaction rejects new stateful work but keeps safe reads and stop controls available", async () => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  let finish!: (value: unknown) => void;
  backend.request = vi.fn(async (_method, params) => {
    if (params.method === "admin/catalog/sync") return new Promise((resolve) => { finish = resolve; });
    return {};
  });
  const management = instance.dispatch("admin/catalog/sync", {}, "browser");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const callsBefore = backend.request.mock.calls.length;
  for (const method of ["thread/delete", "thread/name/set", "thread/archive", "projects/add", "attachment/upload", "terminal/write"]) {
    await expect(instance.dispatch(method, {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  }
  expect(backend.request).toHaveBeenCalledTimes(callsBefore);
  await expect(instance.dispatch("thread/read", {}, "browser")).resolves.toEqual({});
  await expect(instance.dispatch("turn/interrupt", { threadId: "thread-one", turnId: "turn-one" }, "browser")).resolves.toEqual({});
  await expect(instance.dispatch("terminal/terminate", { processId: "terminal-one" }, "browser")).resolves.toEqual({});
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "running" });
  finish({ ok: true, changed: false, restartRequired: false });
  await management;
});

it.each(["completed", "error", "closed", "inner-restart", "outer-restart"])("a late turn acceptance after %s does not revive management activity or replay upstream", async (event) => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  let accept!: (value: unknown) => void;
  backend.request = vi.fn(async (_method, params) => params.method === "turn/start"
    ? new Promise((resolve) => { accept = resolve; }) : managementSuccess());
  const params = { clientOperationId: "late-acceptance-operation", threadId: "thread-one", text: "fixture" };
  const pending = instance.dispatch("turn/start", params, "browser");
  await vi.waitFor(() => expect(accept).toBeTypeOf("function"));
  if (event === "completed") notify(backend, "turn/completed", { threadId: "thread-one", turn: { id: "accepted-turn" } });
  else if (event === "error") notify(backend, "error", { threadId: "thread-one", turnId: "accepted-turn", willRetry: false });
  else if (event === "closed") notify(backend, "thread/closed", { threadId: "thread-one" });
  else if (event === "inner-restart") notify(backend, "appServer/stateChanged", { state: "restarting" });
  else backend.events.onStateChange("restarting");
  accept({ turn: { id: "accepted-turn", status: "inProgress" } });
  await pending;
  notify(backend, "appServer/stateChanged", { state: "ready" });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).resolves.toMatchObject({ management: { state: "idle" } });
  const calls = backend.request.mock.calls.length;
  await expect(instance.dispatch("turn/start", params, "browser")).resolves.toMatchObject({ replayed: true });
  expect(backend.request).toHaveBeenCalledTimes(calls);
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).resolves.toMatchObject({ management: { state: "idle" } });
});

it("receipt is rejected without dispatch if the recorded turn's original worker attachment fails", async () => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => { throw new Error("unexpected upstream dispatch"); });
  let fail!: (error: Error) => void;
  const attached = new Promise<void>((_, reject) => { fail = reject; });
  const params = { clientOperationId: "attachment-failure-operation", threadId: "thread-one", text: "fixture" };
  const pending = instance.dispatch("turn/start", params, "browser", attached).catch((error) => error);
  expect(await instance.dispatch("turn/operation", { clientOperationId: params.clientOperationId }, "other-tab")).toMatchObject({ state: "unknown" });
  fail(new Error("synthetic connection failure"));
  expect(await pending).toMatchObject({ errorCode: "OPERATION_REJECTED" });
  expect(await instance.dispatch("turn/operation", { clientOperationId: params.clientOperationId }, "other-tab")).toMatchObject({ state: "rejected" });
  expect(backend.request).not.toHaveBeenCalled();
});

it.each(["completion", "inner-restart"])("retains uncertain admission when %s arrives before the RPC outcome", async (event) => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  let reject!: (error: Error) => void;
  backend.request = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
  const compact = instance.dispatch("thread/compact/start", { threadId: "t1" }, "browser").catch((error) => error);
  if (event === "completion") notify(backend, "thread/compacted", { threadId: "t1" });
  else notify(backend, "appServer/stateChanged", { state: "restarting" });
  reject(new Error("response lost"));
  await compact;
  notify(backend, "appServer/stateChanged", { state: "ready" });
  backend.request = vi.fn(async (_method, params) => params.method === "admin/catalog/sync" ? managementSuccess() : {});
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "unknown" });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  expect(await instance.dispatch("app/status", {}, "browser")).toMatchObject({ management: { state: "unknown" } });
});

it("admits automatic compaction through the same control gate before starting native work", async () => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  backend.request = vi.fn(async (_method, params) => params.method === "admin/catalog/sync" ? managementSuccess() : {});
  await expect(backend.events.onServerRequest("auto-1", "gateway/autoCompact", { threadId: "t1" })).resolves.toEqual({});
  expect(backend.request).toHaveBeenCalledWith("gateway/dispatch", { method: "thread/compact/start", params: { threadId: "t1" }, clientId: "auto-compaction" });
  // The original normal turn can complete before native compaction announces a turn.
  notify(backend, "turn/completed", { threadId: "t1", turn: { id: "previous" } });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  notify(backend, "thread/compacted", { threadId: "t1" });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).resolves.toMatchObject({ management: { state: "idle" } });
});

it("rejects automatic compaction during management without invoking worker commands", async () => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  let finish!: (value: unknown) => void;
  backend.request = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  const management = instance.dispatch("admin/catalog/sync", {}, "browser");
  await expect(backend.events.onServerRequest("auto-1", "gateway/autoCompact", { threadId: "t1" })).rejects.toMatchObject({ delivery: "rejected" });
  expect(backend.request).toHaveBeenCalledOnce();
  finish(managementSuccess());
  await management;
  await expect(backend.events.onServerRequest("fake", "admin/service/restart", {})).rejects.toThrow("cannot invoke");
});

it.each([false, true])("holds compaction activity until completion unless rejection is definite (%s)", async (definite) => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  backend.request = vi.fn(async () => { throw new AppServerRequestError("compaction failed", { data: { delivery: definite ? "rejected" : "unknown" } }); });
  await expect(backend.events.onServerRequest("auto-1", "gateway/autoCompact", { threadId: "t1" })).rejects.toThrow();
  notify(backend, "thread/autoCompactFailed", { threadId: "t1", error: "watchdog" });
  backend.request = vi.fn(async (_method, params) => params.method === "admin/catalog/sync" ? managementSuccess() : {});
  if (definite) await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).resolves.toMatchObject({ management: { state: "idle" } });
  else {
    await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
    notify(backend, "thread/compacted", { threadId: "t1" });
    await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
    notify(backend, "appServer/stateChanged", { state: "ready" });
    await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
    backend.events.onStateChange("restarting");
    await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).resolves.toMatchObject({ management: { state: "idle" } });
  }
});

it.each(["t1", "t2"])("rejects overlapping compaction admissions for %s until native completion", async (second) => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  backend.request = vi.fn(async (_method, params) => params.method === "admin/catalog/sync" ? managementSuccess() : {});
  await instance.dispatch("thread/compact/start", { threadId: "t1" }, "browser");
  await expect(backend.events.onServerRequest("auto", "gateway/autoCompact", { threadId: second })).rejects.toMatchObject({ delivery: "rejected" });
  expect(backend.request).toHaveBeenCalledOnce();
  notify(backend, "turn/started", { threadId: "t1", turn: { id: "compaction" } });
  notify(backend, "turn/completed", { threadId: "t1", turn: { id: "old-turn" } });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  notify(backend, "turn/completed", { threadId: "t1", turn: { id: "compaction" } });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).resolves.toMatchObject({ management: { state: "idle" } });
});

it("rejects active-work and malformed reverse requests before dispatching anything", async () => {
  const { backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  backend.request = vi.fn(async () => ({}));
  for (const params of [null, [], {}, { threadId: "" }, { threadId: "x".repeat(257) }, { threadId: "t", method: "admin/service/restart" }, { threadId: "a\0b" }]) {
    await expect(backend.events.onServerRequest("auto", "gateway/autoCompact", params)).rejects.toMatchObject({ delivery: "rejected" });
  }
  notify(backend, "turn/started", { threadId: "other", turn: { id: "active" } });
  await expect(backend.events.onServerRequest("auto", "gateway/autoCompact", { threadId: "t" })).rejects.toMatchObject({ delivery: "rejected" });
  expect(backend.request).not.toHaveBeenCalled();
});

it("rejects automatic compaction while a normal work admission awaits its first notification", async () => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  let finish!: (value: unknown) => void;
  backend.request = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue({});
  const starting = instance.dispatch("terminal/exec", {}, "browser");
  await expect(backend.events.onServerRequest("auto", "gateway/autoCompact", { threadId: "t1" })).rejects.toMatchObject({ delivery: "rejected" });
  expect(backend.request).toHaveBeenCalledOnce();
  finish({}); await starting;
});

it("management status is control-local and remains queryable after worker transport failure", async () => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => { throw new Error("private transport timed out"); });
  expect(await instance.dispatch("management/status", {}, "browser")).toEqual({ state: "idle" });
  expect(backend.request).not.toHaveBeenCalled();
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "MANAGEMENT_UNKNOWN" });
  const status = await instance.dispatch("management/status", {}, "browser");
  expect(status).toMatchObject({ state: "unknown", lastOperation: { outcome: "unknown", operation: "admin/catalog/sync" } });
  backend.events.onNotification("gateway/clientMessage", { clientId: "*", message: { kind: "notification", method: "appServer/stateChanged", params: { state: "ready" } } });
  expect((await instance.dispatch("management/status", {}, "browser")).state).toBe("unknown");
  await expect(instance.dispatch("terminal/exec", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  backend.events.onStateChange("restarting");
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "idle", lastOperation: { outcome: "unknown" } });
  expect(restart).not.toHaveBeenCalled();
});

it.each([
  { label: "missing fields", value: {} },
  { label: "wrong field types", value: { ok: "yes", changed: false, restartRequired: false } },
  { label: "incoherent restart state", value: { ok: true, changed: false, restartRequired: true, restarting: false } },
])("locks the management gate when the worker returns $label", async ({ value }) => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => value);
  const failure = await instance.dispatch("admin/catalog/sync", {}, "browser").catch((error) => error);
  expect(failure).toMatchObject({ errorCode: "MANAGEMENT_UNKNOWN", operationId: expect.any(String) });
  expect(rpcFailureMessage(1, failure)).toMatchObject({ delivery: "unknown", operationState: "unknown" });
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({
    state: "unknown", lastOperation: { outcome: "unknown", operation: "admin/catalog/sync" },
  });
  await expect(instance.dispatch("admin/provider/switch", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  expect(backend.request).toHaveBeenCalledOnce();
});

it("accepts answers only for current registered server requests and permits a correction after false", async () => {
  const { instance, backend } = controller();
  const client = { send: vi.fn(), close: vi.fn() };
  (instance as any).clients.set("browser", client);
  backend.request = vi.fn();
  await expect(instance.answer("never-registered", { decision: "accept" })).rejects.toMatchObject({
    errorCode: "ANSWER_REJECTED", delivery: "rejected",
  });
  expect(backend.request).not.toHaveBeenCalled();

  backend.events.onNotification("gateway/clientMessage", { clientId: "browser", message: {
    kind: "serverRequest", requestId: "approval-first", method: "item/commandExecution/requestApproval", params: {},
  } });
  backend.request.mockResolvedValueOnce(true);
  await expect(instance.answer("approval-first", { decision: "accept" })).resolves.toBe(true);
  await expect(instance.answer("approval-first", { decision: "accept" })).rejects.toMatchObject({ errorCode: "ANSWER_REJECTED" });

  backend.events.onNotification("gateway/clientMessage", { clientId: "browser", message: {
    kind: "serverRequest", requestId: "approval-correctable", method: "item/commandExecution/requestApproval", params: {},
  } });
  backend.request.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await expect(instance.answer("approval-correctable", { decision: "decline" })).resolves.toBe(false);
  await expect(instance.answer("approval-correctable", { decision: "accept" })).resolves.toBe(true);
  expect(backend.request).toHaveBeenCalledTimes(3);
  expect(backend.request).toHaveBeenLastCalledWith("gateway/answer", {
    requestId: "approval-correctable", payload: { decision: "accept" }, error: undefined,
  });
});

it("reserves an answer whose delivery is unknown until the worker resolves the server request", async () => {
  const { instance, backend } = controller();
  const client = { send: vi.fn(), close: vi.fn() };
  (instance as any).clients.set("browser", client);
  backend.events.onNotification("gateway/clientMessage", { clientId: "browser", message: {
    kind: "serverRequest", requestId: "approval-unknown", method: "item/commandExecution/requestApproval", params: {},
  } });
  backend.request = vi.fn(async () => { throw Object.assign(new Error("answer response lost"), { delivery: "unknown" }); });
  await expect(instance.answer("approval-unknown", { decision: "accept" })).rejects.toMatchObject({ delivery: "unknown" });
  await expect(instance.answer("approval-unknown", { decision: "accept" })).rejects.toMatchObject({ errorCode: "BUSY" });
  expect(backend.request).toHaveBeenCalledOnce();
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  notify(backend, "serverRequest/resolved", { serverRequestId: "approval-unknown" });
  await expect(instance.answer("approval-unknown", { decision: "accept" })).rejects.toMatchObject({ errorCode: "ANSWER_REJECTED" });
  backend.request = vi.fn(async () => managementSuccess());
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).resolves.toMatchObject({ management: { state: "idle" } });
});

it("compensates a connect whose response was lost with an idempotent worker disconnect", async () => {
  const { instance, backend } = controller();
  const client = { send: vi.fn(), close: vi.fn() };
  backend.request = vi.fn(async (method) => {
    if (method === "gateway/connect") throw Object.assign(new Error("connect response lost"), { delivery: "unknown" });
    if (method === "gateway/disconnect") return {};
    throw new Error(`unexpected method ${method}`);
  });
  await expect(instance.connect("browser", client)).rejects.toThrow("connect response lost");
  await vi.waitFor(() => expect(backend.request).toHaveBeenCalledWith("gateway/disconnect", { clientId: "browser" }));
  await vi.waitFor(() => expect((instance as any).pendingDisconnects.size).toBe(0));
  expect(instance.clientCount).toBe(0);
});

it("retries worker disconnect after a failed browser detach", async () => {
  const { instance, backend } = controller();
  const client = { send: vi.fn(), close: vi.fn() };
  let disconnectAttempts = 0;
  backend.request = vi.fn(async (method) => {
    if (method === "gateway/connect") return {};
    if (method === "gateway/disconnect" && ++disconnectAttempts === 1) throw new Error("disconnect response lost");
    if (method === "gateway/disconnect") return {};
    throw new Error(`unexpected method ${method}`);
  });
  await instance.connect("browser", client);
  await expect(instance.disconnect("browser")).rejects.toThrow("disconnect response lost");
  await vi.waitFor(() => expect(disconnectAttempts).toBe(2));
  await vi.waitFor(() => expect((instance as any).pendingDisconnects.size).toBe(0));
  expect(instance.clientCount).toBe(0);
});

it("bounds unresolved disconnect compensation and rejects further client attachment", async () => {
  const { instance, backend } = controller();
  notify(backend, "appServer/stateChanged", { state: "ready" });
  backend.request = vi.fn(() => new Promise(() => {}));
  for (let index = 0; index <= 64; index += 1) {
    (instance as any).scheduleDisconnect(`browser-${index}`, 0);
  }
  expect((instance as any).pendingDisconnects.size).toBe(64);
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "unknown" });
  const client = { send: vi.fn(), close: vi.fn() };
  await expect(instance.connect("new-browser", client)).rejects.toMatchObject({ errorCode: "ACTIVITY_UNKNOWN" });
  expect(client.close).toHaveBeenCalledOnce();
});

it("retains diagnostic-only client connections when cleanup is blocked before or during attachment", async () => {
  const { instance, backend } = controller();
  let rejectConnect!: (error: Error) => void;
  backend.request = vi.fn(() => new Promise((_, reject) => { rejectConnect = reject; }));
  const client = { send: vi.fn(), close: vi.fn() };
  const connecting = instance.connect("during", client);
  backend.events.onStateChange("blocked");
  rejectConnect(new Error("owner died"));
  await expect(connecting).resolves.toBeUndefined();
  backend.request.mockClear();
  const newClient = { send: vi.fn(), close: vi.fn() };
  await expect(instance.connect("after", newClient)).resolves.toBeUndefined();
  expect(newClient.close).not.toHaveBeenCalled();
  expect(await instance.dispatch("management/status", {}, "after")).toMatchObject({ state: "unknown", error: expect.stringContaining("systemd") });
  await expect(instance.dispatch("thread/start", {}, "after")).rejects.toMatchObject({ errorCode: "BACKEND_CLEANUP_UNCONFIRMED" });
  await instance.disconnect("during");
  await instance.disconnect("after");
  expect(instance.clientCount).toBe(0);
  expect(backend.request).not.toHaveBeenCalled();
});

it("a worker's provisional executionPending failure cannot unlock admission or restart service", async () => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => ({ ok: false, changed: false, restartRequired: false, executionPending: true }));
  const result = await instance.dispatch("admin/provider/switch", { mode: "custom" }, "browser");
  expect(result).toMatchObject({ operationId: expect.any(String), management: { state: "unknown", lastOperation: { outcome: "unknown" } } });
  expect(result.management.lastOperation.changed).toBeUndefined();
  await expect(instance.dispatch("admin/service/restart", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  expect(restart).not.toHaveBeenCalled();
});

it("no-op catalog responses still receive an observable operation id without restarting", async () => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => ({ ok: true, mode: "openai", changed: false, restartRequired: false, restarting: false }));
  const result = await instance.dispatch("admin/catalog/sync", {}, "browser");
  expect(result.operationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "idle", operationId: result.operationId, lastOperation: { outcome: "succeeded", changed: false } });
  expect(restart).not.toHaveBeenCalled();
});

it("does not clear work, release management uncertainty, or admit mutations after its cleanup owner dies", async () => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => { throw new Error("lost management result"); });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "MANAGEMENT_UNKNOWN" });
  backend.events.onNotification("gateway/clientMessage", { clientId: "*", message: { kind: "notification", method: "turn/started", params: { threadId: "T", turn: { id: "turn" } } } });
  backend.events.onNotification("gateway/clientMessage", { clientId: "*", message: { kind: "notification", method: "terminal/started", params: { processId: "pty" } } });
  backend.events.onStateChange("blocked");
  expect((instance as any).activeTurns.size).toBe(1);
  expect((instance as any).activeTerminals.size).toBe(1);
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "unknown", lastOperation: { outcome: "unknown" }, error: expect.stringContaining("systemd") });
  backend.request.mockClear();
  for (const method of ["thread/start", "turn/start", "admin/catalog/sync", "admin/service/restart"]) {
    await expect(instance.dispatch(method, {}, "browser")).rejects.toMatchObject({ errorCode: "BACKEND_CLEANUP_UNCONFIRMED" });
  }
  expect(backend.request).not.toHaveBeenCalled();
  expect(restart).not.toHaveBeenCalled();
});
