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

it("counts response budgets in UTF8 bytes without silently clipping history", () => {
  expect(() => encodeBounded({ text: "中".repeat(10) }, 25)).toThrow("安全大小");
  expect(JSON.parse(encodeBounded({ text: "small" }, 100))).toEqual({ text: "small" });
});
