import { expect, it, vi } from "vitest";
import { ManagementGate } from "../src/management.js";
import { RpcBudget, FLOW_LIMITS, encodeBounded } from "../src/flow-control.js";
import { scriptChangeResult } from "../src/admin.js";

it("holds management lock across script and delayed restart and reserves job admission", async () => {
  const notify = vi.fn();
  const gate = new ManagementGate(() => false, notify);
  let finishRestart!: () => void;
  const restart = vi.fn(() => new Promise<void>((resolve) => { finishRestart = resolve; }));
  await gate.run("sync", async () => ({ restartRequired: true }), restart);
  expect(gate.snapshot().state).toBe("restart_pending");
  await expect(gate.admit(async () => 1)).rejects.toMatchObject({ errorCode: "BUSY" });
  await expect(gate.run("second", async () => ({}), restart)).rejects.toMatchObject({ errorCode: "BUSY" });
  finishRestart();
  await vi.waitFor(() => expect(gate.snapshot().state).toBe("idle"));
  let finishJob!: () => void;
  const job = gate.admit(() => new Promise<void>((resolve) => { finishJob = resolve; }));
  await expect(gate.run("sync", async () => ({}), restart)).rejects.toThrow("运行中");
  finishJob(); await job;
});

it("does not restart no-op sync; rejects active jobs and exposes restart failure", async () => {
  const restart = vi.fn(async () => {});
  const notify = vi.fn();
  const gate = new ManagementGate(() => false, notify);
  const noop = scriptChangeResult({ code: 0, output: '[codex-harness-result] {"changed":false,"restartRequired":false}\n' });
  await gate.run("sync", async () => noop, restart);
  expect(restart).not.toHaveBeenCalled();
  await gate.run("restart", async () => ({ restartRequired: true }), async () => { throw new Error("service unavailable"); });
  await vi.waitFor(() => expect(gate.snapshot().state).toBe("idle"));
  expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ lastOperation: expect.objectContaining({ outcome: "failed" }), error: expect.stringContaining("重启未确认成功") }));
  await expect(new ManagementGate(() => true, notify).run("sync", async () => noop, restart)).rejects.toMatchObject({ errorCode: "BUSY" });
});

it("bounds requests per socket/global/bulk while preserving interrupt capacity", () => {
  const budget = new RpcBudget();
  const release = Array.from({ length: FLOW_LIMITS.perClient }, () => budget.acquire("one", "model/list"));
  expect(() => budget.acquire("one", "model/list")).toThrow("队列");
  const stop = budget.acquire("one", "turn/interrupt"); stop();
  for (const done of release) done();
  const bulk = budget.acquire("one", "thread/read");
  expect(() => budget.acquire("two", "attachment/upload")).toThrow("队列");
  bulk(); bulk();
  budget.acquire("two", "attachment/upload")();
});

it("reserves emergency-control capacity fairly across browser owners", () => {
  const budget = new RpcBudget();
  const first = Array.from({ length: FLOW_LIMITS.controlsPerClient }, () => budget.acquire("one", "turn/interrupt"));
  expect(() => budget.acquire("one", "turn/interrupt")).toThrow("队列");
  const second = Array.from({ length: FLOW_LIMITS.controlsPerClient }, () => budget.acquire("two", "terminal/terminate"));
  expect(() => budget.acquire("three", "account/login/cancel")).toThrow("队列");
  first[0]();
  expect(() => budget.acquire("three", "account/login/cancel")()).not.toThrow();
  for (const release of [...first.slice(1), ...second]) release();
});

it("bounds retained request bytes across clients and releases the accounting", () => {
  const budget = new RpcBudget();
  const first = budget.acquire("one", "model/list", 30 * 1024 * 1024);
  expect(() => budget.acquire("one", "projects/list", 11 * 1024 * 1024)).toThrow("队列");
  expect(() => budget.acquire("two", "projects/list", 19 * 1024 * 1024)).toThrow("队列");
  expect(() => budget.acquire("one", "model/list", FLOW_LIMITS.frameBytes + 1)).toThrow("大小无效");
  first();
  expect(() => budget.acquire("two", "projects/list", 19 * 1024 * 1024)()).not.toThrow();
});

it("keeps an independent emergency byte reserve under ordinary-byte saturation", () => {
  const budget = new RpcBudget();
  const ordinaryOne = budget.acquire("one", "model/list", 36 * 1024 * 1024);
  const ordinaryTwo = budget.acquire("two", "projects/list", 4 * 1024 * 1024);
  expect(() => budget.acquire("three", "model/list", 1)).toThrow("队列");

  const controlOne = budget.acquire("one", "turn/interrupt", 4 * 1024 * 1024);
  const controlTwo = budget.acquire("two", "serverRequestResponse", 4 * 1024 * 1024);
  // Ordinary work plus the dedicated reserve reaches, but never exceeds, the
  // total 48 MiB hard ceiling.
  expect(() => budget.acquire("three", "account/login/cancel", 1)).toThrow("队列");
  expect(() => budget.acquire("one", "terminal/terminate", 1)).toThrow("队列");

  for (const release of [controlOne, controlTwo, ordinaryOne, ordinaryTwo]) release();
  expect(() => budget.acquire("three", "model/list", 1)()).not.toThrow();
});

it.each(["turn/start", "attachment/delete", "thread/delete", "fs/readDirectory"])(
  "serializes resource-heavy %s with other bulk work",
  (method) => {
    const budget = new RpcBudget();
    const release = budget.acquire("one", method);
    expect(() => budget.acquire("two", "thread/read")).toThrow("队列");
    release();
    expect(() => budget.acquire("two", "thread/read")()).not.toThrow();
  },
);

it("counts response budgets in UTF8 bytes without silently clipping history", () => {
  expect(() => encodeBounded({ text: "中".repeat(10) }, 25)).toThrow("安全大小");
  expect(JSON.parse(encodeBounded({ text: "small" }, 100))).toEqual({ text: "small" });
});
