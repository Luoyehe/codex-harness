import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GatewayController } from "../src/control.js";

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
