import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { GatewayController } from "../src/control.js";
import { AppServerConnection } from "../src/codex/rpc.js";

const homes: string[] = [];
function controller() {
  vi.stubEnv("GATEWAY_UNSAFE_SINGLE_USER", "1");
  vi.stubEnv("CODEX_WORKER_LAUNCHER", "");
  const home = mkdtempSync(path.join(os.tmpdir(), "harness-activity-admission-"));
  homes.push(home);
  const instance = new GatewayController(home);
  const backend = (instance as any).backend;
  notify(backend, "appServer/stateChanged", { state: "ready" });
  return { instance, backend };
}
function notify(backend: any, method: string, params: unknown) {
  backend.events.onNotification("gateway/clientMessage", { clientId: "*", message: { kind: "notification", method, params } });
}
function unknownActivity(backend: any) { notify(backend, "turn/started", {}); }
const turn = { clientOperationId: "activity-turn-operation", threadId: "thread-one", text: "fixture" };
const thread = { clientOperationId: "activity-thread-operation", cwd: "/project" };
const starts = [
  { method: "turn/start", params: turn, receipt: "turn/operation", reply: { turn: { id: "accepted-turn", status: "completed" } } },
  { method: "thread/start", params: thread, receipt: "thread/start/operation", reply: { thread: { id: "accepted-thread" } } },
];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it("refuses fresh work on an existing client after tracking overflows without replacing accepted turn metadata", async () => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => ({ turn: { id: "same-native-turn", status: "inProgress" } }));
  for (let i = 0; i < 256; i++) {
    notify(backend, "turn/started", { threadId: `busy-${i}`, turn: { id: `turn-${i}` } });
    notify(backend, "thread/status/changed", { threadId: `busy-${i}`, status: { type: "active", activeFlags: [] } });
  }
  await instance.dispatch("turn/start", turn, "existing-browser");
  expect(await instance.dispatch("management/status", {}, "existing-browser")).toMatchObject({ state: "unknown" });
  await expect(instance.dispatch("turn/start", { ...turn, clientOperationId: "activity-second-operation" }, "existing-browser"))
    .rejects.toMatchObject({ delivery: "rejected" });
  expect(backend.request).toHaveBeenCalledOnce();
  expect((instance as any).ledger.decorateItem(turn.threadId, "same-native-turn", { id: "first-user", type: "userMessage", content: [] }))
    .toMatchObject({ clientOperationId: turn.clientOperationId });
  for (const method of ["thread/resume", "terminal/exec", "thread/compact/start", "account/login/start", "admin/provider/switch", "admin/catalog/sync", "admin/service/restart", "displayPrefs/set", "mcpServer/tool/call"]) {
    await expect(instance.dispatch(method, { threadId: "other-thread" }, "existing-browser")).rejects.toMatchObject({ errorCode: "BUSY", delivery: "rejected" });
  }
  expect(backend.request).toHaveBeenCalledOnce();
});

it.each(starts)("checks unknown activity after attachment for $method and records a definite rejection", async ({ method, params, receipt }) => {
  const { instance, backend } = controller();
  backend.request = vi.fn();
  let attach!: () => void;
  const waiting = instance.dispatch(method, params, "browser", new Promise<void>(resolve => { attach = resolve; }));
  const result = expect(waiting).rejects.toMatchObject({ delivery: "rejected" });
  unknownActivity(backend);
  attach();
  await result;
  expect(backend.request).not.toHaveBeenCalled();
  expect(await instance.dispatch(receipt, { clientOperationId: params.clientOperationId }, "browser")).toMatchObject({ state: "rejected" });
  expect((instance as any).pendingTurnStarts.size).toBe(0);
  expect((instance as any).management.admissions).toBe(0);
});

it.each([
  ...starts,
  { method: "account/login/start", params: {}, receipt: undefined },
  { method: "terminal/exec", params: {}, receipt: undefined },
  { method: "thread/compact/start", params: { threadId: "compact-thread" }, receipt: undefined },
])("rechecks activity after supervisor readiness for $method and releases reservations", async ({ method, params, receipt }) => {
  const { instance, backend } = controller();
  const native = vi.fn(async () => ({}));
  backend.conn = { request: native };
  backend.state = "starting";
  const waiting = instance.dispatch(method, params, "browser");
  const result = expect(waiting).rejects.toMatchObject({ delivery: "rejected" });
  await vi.waitFor(() => expect(backend.readyWaiters.size).toBe(1));
  unknownActivity(backend);
  backend.setState("ready");
  await result;
  expect(native).not.toHaveBeenCalled();
  expect((instance as any).pendingTurnStarts.size).toBe(0);
  expect((instance as any).pendingLoginStarts.size).toBe(0);
  expect((instance as any).compactions.size).toBe(0);
  expect((instance as any).uncertainTurnStart).toBe(false);
  expect((instance as any).uncertainLogin).toBe(false);
  expect((instance as any).management.admissions).toBe(0);
  if (receipt) expect(await instance.dispatch(receipt, { clientOperationId: (params as any).clientOperationId }, "browser")).toMatchObject({ state: "rejected" });
});

it.each(starts)("retains accepted and unknown $method receipts when activity becomes unknown", async ({ method, params, reply }) => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => reply);
  await instance.dispatch(method, params, "browser");
  const lost = { ...params, clientOperationId: "activity-lost-operation" };
  backend.request.mockRejectedValueOnce(new Error("response lost"));
  await expect(instance.dispatch(method, lost, "browser")).rejects.toMatchObject({ operationState: "unknown" });
  unknownActivity(backend);
  await expect(instance.dispatch(method, params, "browser")).resolves.toMatchObject({ replayed: true });
  await expect(instance.dispatch(method, lost, "browser")).rejects.toMatchObject({ operationState: "unknown", delivery: "unknown" });
  await expect(instance.dispatch(method, { ...params, clientOperationId: "activity-fresh-operation" }, "browser")).rejects.toMatchObject({ delivery: "rejected" });
  expect(backend.request).toHaveBeenCalledTimes(2);
});

it.each(starts)("keeps the successful $method receipt when activity becomes unknown after dispatch", async ({ method, params, reply }) => {
  const { instance, backend } = controller();
  let finish!: (value: unknown) => void;
  backend.request = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const waiting = instance.dispatch(method, params, "browser");
  await vi.waitFor(() => expect(backend.request).toHaveBeenCalledOnce());
  unknownActivity(backend);
  finish(reply);
  await expect(waiting).resolves.toMatchObject(reply);
  await expect(instance.dispatch(method, params, "browser")).resolves.toMatchObject({ replayed: true });
  expect(backend.request).toHaveBeenCalledOnce();
});

it("keeps reads and convergence controls available, including canceling an active device login", async () => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => ({ type: "chatgptDeviceCode", loginId: "login-one", userCode: "CODE", verificationUrl: "https://example.com/device" }));
  await instance.dispatch("account/login/start", {}, "browser");
  unknownActivity(backend);
  backend.request.mockResolvedValue({ status: "canceled" });
  await instance.dispatch("account/read", {}, "browser");
  await instance.dispatch("turn/interrupt", { threadId: "thread-one" }, "browser");
  await instance.dispatch("terminal/terminate", { processId: "terminal-one" }, "browser");
  await expect(instance.dispatch("account/login/cancel", { loginId: "login-one" }, "browser")).resolves.toEqual({ status: "canceled" });
  expect(await instance.dispatch("account/login/status", {}, "browser")).toEqual({ state: "idle" });
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "unknown" });
  expect(backend.request).toHaveBeenCalledTimes(5);
  // Cancel remains subject to the existing configuration transaction gate.
  (instance as any).management.state = "running";
  await expect(instance.dispatch("account/login/cancel", { loginId: "login-one" }, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  expect(backend.request).toHaveBeenCalledTimes(5);
});

it("replays a thread receipt while another turn start is unknown", async () => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => ({ thread: { id: "accepted-thread" } }));
  await instance.dispatch("thread/start", thread, "browser");
  backend.request.mockRejectedValue(new Error("turn response lost"));
  await expect(instance.dispatch("turn/start", turn, "browser")).rejects.toMatchObject({ operationState: "unknown" });
  await expect(instance.dispatch("thread/start", thread, "browser")).resolves.toMatchObject({ thread: { id: "accepted-thread" }, replayed: true });
  await expect(instance.dispatch("thread/start", { ...thread, clientOperationId: "uncertain-fresh-thread" }, "browser")).rejects.toMatchObject({ delivery: "rejected" });
  expect(backend.request).toHaveBeenCalledTimes(2);
});

it("refuses a queued turn after activity becomes unknown while preserving written work and safe controls", async () => {
  const { instance, backend } = controller();
  const frames: any[] = [];
  let release!: () => void;
  const stdin = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    frames.push(JSON.parse(String(chunk)));
    if (frames.length === 1) release = callback;
    else callback();
  } });
  const stdout = new PassThrough();
  const conn = new AppServerConnection("fake", [], {}, { onNotification() {}, onServerRequest: async () => ({}), onExit() {}, onStderr() {} });
  conn.attach(stdin, stdout);
  backend.conn = conn;
  backend.state = "ready";
  try {
    const written = instance.dispatch("thread/start", thread, "browser");
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    const queued = instance.dispatch("turn/start", turn, "browser");
    const refused = expect(queued).rejects.toMatchObject({ delivery: "rejected" });
    await vi.waitFor(() => expect((conn as any).writeQueue).toHaveLength(1));
    unknownActivity(backend);
    release();
    await refused;
    expect(frames).toHaveLength(1);
    expect((conn as any).queuedBytes).toBe(0);
    expect((conn as any).pending.size).toBe(1); // the previously written start
    expect((instance as any).pendingTurnStarts.size).toBe(0);
    stdout.write(JSON.stringify({ id: frames[0].id, result: { thread: { id: "accepted-thread" } } }) + "\n");
    await expect(written).resolves.toMatchObject({ thread: { id: "accepted-thread" } });
    const stopping = instance.dispatch("turn/interrupt", { threadId: turn.threadId }, "browser");
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames[1].params.method).toBe("turn/interrupt");
    stdout.write(JSON.stringify({ id: frames[1].id, result: {} }) + "\n");
    await stopping;
    expect((conn as any).pending.size).toBe(0);
    expect(await instance.dispatch("turn/operation", { clientOperationId: turn.clientOperationId }, "browser")).toMatchObject({ state: "rejected" });
  } finally { await conn.kill(); }
});
