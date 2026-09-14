import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ManagementGate } from "../src/management.js";

const fixtures: string[] = [];
function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), "harness-management-"));
  fixtures.push(home);
  const notify = vi.fn();
  return { home, notify, gate: new ManagementGate(() => false, notify, home), file: path.join(home, "management-operation.json") };
}
afterEach(() => { for (const home of fixtures.splice(0)) rmSync(home, { recursive: true, force: true }); });

it("persists bounded intent before execution and keeps only safe result fields", async () => {
  const { gate, file, home } = fixture();
  const result = await gate.run("admin/catalog/sync", async () => {
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ state: "running", lastOperation: { outcome: "running" } });
    return { ok: true, changed: false, restartRequired: false, output: "private-fixture-do-not-journal", arbitrary: "unbounded".repeat(2000) };
  }, vi.fn());
  expect(result.operationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(gate.snapshot()).toMatchObject({ state: "idle", operationId: result.operationId, lastOperation: { outcome: "succeeded", changed: false } });
  const raw = readFileSync(file, "utf8");
  expect(raw).not.toMatch(/private-fixture|unbounded|arbitrary|output/);
  expect(Buffer.byteLength(raw)).toBeLessThan(8192);
  expect(readdirSync(home)).toEqual(["management-operation.json"]);
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  const copy = gate.snapshot(); copy.lastOperation!.outcome = "failed";
  expect(gate.snapshot().lastOperation?.outcome).toBe("succeeded");
});

it("writes restart pending before helper invocation and observes recovery after new backend readiness", async () => {
  const { gate, file, home } = fixture();
  const restart = vi.fn(() => {
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ state: "restart_pending" });
    return new Promise<void>(() => {});
  });
  const result = await gate.run("admin/provider/switch", async () => ({ ok: true, changed: true, restartRequired: true }), restart);
  await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
  const recovered = new ManagementGate(() => false, vi.fn(), home);
  expect(recovered.snapshot()).toMatchObject({ state: "restart_pending", operationId: result.operationId });
  await expect(recovered.admit(async () => 1)).rejects.toMatchObject({ errorCode: "BUSY" });
  recovered.backendReady();
  expect(recovered.snapshot()).toMatchObject({ state: "idle", lastOperation: { operationId: result.operationId, outcome: "recovered", changed: true, restartRequired: true } });
  expect(new ManagementGate(() => false, vi.fn(), home).snapshot().lastOperation?.outcome).toBe("recovered");
  expect(restart).toHaveBeenCalledTimes(1); // recovery never replays a restart
});

it("startup during an unconfirmed script retains unknown even after service recovery", async () => {
  const { gate, home } = fixture();
  void gate.run("admin/provider/switch", () => new Promise(() => {}), vi.fn());
  const recovered = new ManagementGate(() => false, vi.fn(), home);
  expect(recovered.snapshot()).toMatchObject({ state: "unknown", lastOperation: { outcome: "unknown" } });
  await expect(recovered.admit(async () => 1)).rejects.toMatchObject({ errorCode: "BUSY" });
  recovered.backendReady();
  expect(recovered.snapshot()).toMatchObject({ state: "idle", lastOperation: { outcome: "unknown" } });
  expect(await recovered.admit(async () => 1)).toBe(1);
});

it("transport timeout blocks admission until actual outer-worker termination, not another ready event", async () => {
  const { gate, home, file } = fixture();
  const restart = vi.fn();
  await expect(gate.run("admin/catalog/sync", async () => { throw new Error("request timed out: opaque-private-value"); }, restart)).rejects.toMatchObject({ errorCode: "MANAGEMENT_UNKNOWN" });
  expect(gate.snapshot().state).toBe("unknown");
  gate.backendReady();
  await expect(gate.admit(async () => 1)).rejects.toMatchObject({ errorCode: "BUSY" });
  await expect(gate.run("admin/service/restart", async () => ({ restartRequired: true }), restart)).rejects.toMatchObject({ errorCode: "BUSY" });
  expect(readFileSync(file, "utf8")).not.toContain("opaque-private-value");
  gate.backendTerminated();
  expect(gate.snapshot()).toMatchObject({ state: "idle", lastOperation: { outcome: "unknown" } });
  expect(new ManagementGate(() => false, vi.fn(), home).snapshot().lastOperation?.outcome).toBe("unknown");
  expect(restart).not.toHaveBeenCalled();
});

it("unconfirmed script kill or busy response keeps the management lock despite a completed RPC", async () => {
  const { gate } = fixture();
  const restart = vi.fn();
  const result = await gate.run("admin/provider/switch", async () => ({ ok: false, code: 124, changed: false, restartRequired: false, executionPending: true }), restart);
  expect(result.management.state).toBe("unknown");
  await expect(gate.admit(async () => 1)).rejects.toMatchObject({ errorCode: "BUSY" });
  expect(restart).not.toHaveBeenCalled();
});

it("confirmed script failure and explicit completed rejection persist failure without restarting", async () => {
  const { gate, home } = fixture();
  const restart = vi.fn();
  await gate.run("admin/catalog/sync", async () => ({ ok: false, code: 124 }), restart);
  expect(gate.snapshot()).toMatchObject({ state: "idle", lastOperation: { outcome: "failed" } });
  await expect(gate.run("admin/provider/switch", async () => { throw new Error("invalid model"); }, restart, () => true)).rejects.toThrow("invalid model");
  expect(new ManagementGate(() => false, vi.fn(), home).snapshot()).toMatchObject({ state: "idle", lastOperation: { outcome: "failed" } });
  expect(restart).not.toHaveBeenCalled();
});

it("late worker completion after its generation stopped cannot restart or overwrite a newer operation", async () => {
  const { gate } = fixture();
  let finish!: (value: { restartRequired: boolean }) => void;
  const restart = vi.fn();
  const old = gate.run("admin/provider/switch", () => new Promise<{ restartRequired: boolean }>((resolve) => { finish = resolve; }), restart);
  const observed = expect(old).rejects.toMatchObject({ errorCode: "MANAGEMENT_UNKNOWN" });
  gate.backendTerminated();
  const current = await gate.run("admin/catalog/sync", async () => ({ changed: false, restartRequired: false }), restart);
  finish({ restartRequired: true });
  await observed;
  expect(gate.snapshot()).toMatchObject({ operationId: current.operationId, lastOperation: { outcome: "succeeded" } });
  expect(restart).not.toHaveBeenCalled();
});

it("restart failure remains observable after reload and does not persist arbitrary helper errors", async () => {
  const { gate, home, file } = fixture();
  await gate.run("admin/service/restart", async () => ({ restartRequired: true }), async () => { throw new Error("secret-looking-helper-output"); });
  await vi.waitFor(() => expect(gate.snapshot().state).toBe("idle"));
  expect(gate.snapshot()).toMatchObject({ lastOperation: { outcome: "failed", restartRequired: true }, error: expect.stringContaining("重启未确认成功") });
  expect(new ManagementGate(() => false, vi.fn(), home).snapshot().lastOperation?.outcome).toBe("failed");
  expect(readFileSync(file, "utf8")).not.toContain("secret-looking-helper-output");
});

it("timed-out restart helper cannot release admission while a queued restart remains possible", async () => {
  const { gate } = fixture();
  await gate.run("admin/service/restart", async () => ({ restartRequired: true }), async () => { throw Object.assign(new Error("helper timed out"), { killed: true }); });
  await vi.waitFor(() => expect(gate.snapshot().state).toBe("unknown"));
  await expect(gate.admit(async () => 1)).rejects.toMatchObject({ errorCode: "BUSY" });
});

it("corrupt or oversized journals fail closed, and persistence failure prevents script execution", async () => {
  const { gate, home, file } = fixture();
  for (const content of ["{broken", "x".repeat(8193)]) {
    writeFileSync(file, content);
    expect(() => new ManagementGate(() => false, vi.fn(), home)).toThrow("无法可靠读取");
  }
  rmSync(file); mkdirSync(file);
  const work = vi.fn(async () => ({ changed: true }));
  await expect(gate.run("admin/catalog/sync", work, vi.fn())).rejects.toMatchObject({ errorCode: "MANAGEMENT_UNKNOWN" });
  expect(work).not.toHaveBeenCalled();
  await expect(gate.admit(async () => 1)).rejects.toMatchObject({ errorCode: "BUSY" });
});
