import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GatewayController } from "../src/control.js";
import { AppServerRequestError } from "../src/codex/rpc.js";

const homes: string[] = [];
function controller() {
  vi.stubEnv("GATEWAY_UNSAFE_SINGLE_USER", "1");
  vi.stubEnv("CODEX_WORKER_LAUNCHER", "");
  const home = mkdtempSync(path.join(os.tmpdir(), "harness-unknown-start-"));
  homes.push(home);
  const instance = new GatewayController(home);
  const backend = (instance as any).backend;
  notify(backend, "appServer/stateChanged", { state: "ready" });
  return { instance, backend };
}
function notify(backend: any, method: string, params: unknown) {
  backend.events.onNotification("gateway/clientMessage", { clientId: "*", message: { kind: "notification", method, params } });
}
const request = { clientOperationId: "unknown-start-regression", threadId: "thread-one", text: "fixture" };
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it("keeps unknown delivery reserved across late events and inner restarts without blocking diagnostics", async () => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => { throw Object.assign(new Error("response timed out"), { delivery: "unknown" }); });
  await expect(instance.dispatch("turn/start", request, "browser")).rejects.toMatchObject({ operationState: "unknown" });
  expect((instance as any).pendingTurnStarts.size).toBe(0);
  backend.request = vi.fn(async () => ({ thread: { id: request.threadId, turns: [] } }));
  await expect(instance.dispatch("thread/read", { threadId: request.threadId }, "browser")).resolves.toHaveProperty("thread");
  for (const method of ["admin/provider/switch", "admin/catalog/sync", "admin/service/restart", "thread/compact/start", "terminal/exec"]) {
    await expect(instance.dispatch(method, { ...request }, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  }
  await expect(instance.dispatch("turn/start", request, "browser")).rejects.toMatchObject({ operationState: "unknown", delivery: "unknown" });
  await expect(instance.dispatch("turn/start", { ...request, clientOperationId: "new-blocked-operation" }, "browser")).rejects.toMatchObject({ delivery: "rejected" });
  expect(backend.request).toHaveBeenCalledTimes(1);
  notify(backend, "turn/started", { threadId: request.threadId, turn: { id: "late-turn" } });
  notify(backend, "turn/completed", { threadId: request.threadId, turn: { id: "late-turn" } });
  notify(backend, "thread/status/changed", { threadId: request.threadId, status: { type: "idle" } });
  notify(backend, "thread/closed", { threadId: request.threadId });
  notify(backend, "appServer/stateChanged", { state: "restarting" });
  notify(backend, "appServer/stateChanged", { state: "ready" });
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "unknown", error: expect.stringContaining("任务启动结果未知") });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  backend.events.onStateChange("blocked");
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "unknown" });
  backend.events.onStateChange("restarting");
  notify(backend, "appServer/stateChanged", { state: "ready" });
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "idle" });
  expect(await instance.dispatch("turn/operation", { clientOperationId: request.clientOperationId }, "browser")).toMatchObject({ state: "unknown" });
  await expect(instance.dispatch("turn/start", request, "browser")).rejects.toMatchObject({ operationState: "unknown" });
  expect(backend.request).toHaveBeenCalledTimes(1);
  backend.request.mockResolvedValue({ ok: true, changed: false, restartRequired: false });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).resolves.toMatchObject({ management: { state: "idle" } });
});

it("does not reserve a definite rejection or a failed pre-dispatch attachment", async () => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => { throw new AppServerRequestError("rejected"); });
  await expect(instance.dispatch("turn/start", request, "browser")).rejects.toMatchObject({ delivery: "rejected" });
  await expect(instance.dispatch("turn/start", { ...request, clientOperationId: "attachment-rejected-start" }, "browser", Promise.reject(new Error("attach failed"))))
    .rejects.toMatchObject({ delivery: "rejected" });
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "idle" });
  expect(backend.request).toHaveBeenCalledTimes(1);
});

it("replays an accepted receipt while another start is unknown without dispatching again", async () => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => ({ turn: { id: "completed-turn", status: "completed" } }));
  await instance.dispatch("turn/start", request, "browser");
  backend.request.mockRejectedValue(new Error("next response lost"));
  await expect(instance.dispatch("turn/start", { ...request, clientOperationId: "second-unknown-operation" }, "browser"))
    .rejects.toMatchObject({ operationState: "unknown" });
  await expect(instance.dispatch("turn/start", request, "browser"))
    .resolves.toMatchObject({ replayed: true, turn: { id: "completed-turn" } });
  expect(backend.request).toHaveBeenCalledTimes(2);
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "unknown" });
});

it.each(["restarting", "stopped"])("ignores a late unknown rejection after confirmed outer %s", async (state) => {
  const { instance, backend } = controller();
  let reject!: (error: Error) => void;
  backend.request = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
  const pending = instance.dispatch("turn/start", request, "browser");
  const assertion = expect(pending).rejects.toMatchObject({ operationState: "unknown" });
  await vi.waitFor(() => expect(backend.request).toHaveBeenCalledTimes(1));
  backend.events.onStateChange(state);
  reject(new Error("old request transport lost"));
  await assertion;
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "idle" });
});

it("does not mistake a thread close during dispatch for confirmed worker termination", async () => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => {
    notify(backend, "thread/closed", { threadId: request.threadId });
    throw new Error("reply lost");
  });
  await expect(instance.dispatch("turn/start", request, "browser")).rejects.toMatchObject({ operationState: "unknown" });
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "unknown" });
});

it.each([{}, { turn: {} }, { turn: { id: "", status: "completed" } }])("reserves malformed successful replies %#", async (reply) => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => reply);
  await expect(instance.dispatch("turn/start", request, "browser")).rejects.toMatchObject({ operationState: "unknown" });
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "unknown" });
});

it.each([undefined, "futureStatus"])("does not consider an accepted turn with status %s terminal", async (status) => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => ({ turn: { id: "accepted-turn", status } }));
  await instance.dispatch("turn/start", request, "browser");
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  notify(backend, "turn/completed", { threadId: request.threadId, turn: { id: "accepted-turn" } });
  backend.request.mockResolvedValue({ ok: true, changed: false, restartRequired: false });
  await expect(instance.dispatch("admin/catalog/sync", {}, "browser")).resolves.toMatchObject({ management: { state: "idle" } });
});
