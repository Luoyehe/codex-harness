import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreadStartLedger } from "../src/thread-start-operations.js";

const fixtures: string[] = [];
function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), "harness-thread-start-"));
  fixtures.push(home);
  return home;
}
afterEach(() => { for (const home of fixtures.splice(0)) rmSync(home, { recursive: true, force: true }); });

const params = (clientOperationId: string, cwd = "/project") => ({ clientOperationId, cwd, model: "model", approvalPolicy: "on-request" });
const rejected = () => false;

it("persists accepted thread identity and replays it without another upstream creation", async () => {
  const home = fixture();
  const id = "accepted-thread-operation";
  const send = vi.fn(async () => ({ thread: { id: "thread-one", cwd: "/project" } }));
  await expect(new ThreadStartLedger(home).run(id, params(id), send, rejected)).resolves.toMatchObject({
    thread: { id: "thread-one" }, clientOperationId: id,
  });

  const restarted = new ThreadStartLedger(home);
  await expect(restarted.run(id, params(id), send, rejected)).resolves.toMatchObject({
    thread: { id: "thread-one" }, clientOperationId: id, replayed: true,
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(restarted.status(id)).toEqual({ state: "accepted", cwd: "/project", threadId: "thread-one", error: undefined });
});

it("singleflights concurrent attempts carrying the same operation and parameters", async () => {
  const ledger = new ThreadStartLedger(fixture());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = vi.fn(async () => { await gate; return { thread: { id: "thread-one" } }; });
  const first = ledger.run("concurrent-thread-start", params("concurrent-thread-start"), send, rejected);
  const second = ledger.run("concurrent-thread-start", params("concurrent-thread-start"), send, rejected);
  release();
  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  expect(send).toHaveBeenCalledTimes(1);
});

it("retains an explicit unknown record across restart and never resends it", async () => {
  const home = fixture();
  const id = "unknown-thread-operation";
  const send = vi.fn(async () => { throw new Error("connection lost after dispatch"); });
  await expect(new ThreadStartLedger(home).run(id, params(id), send, rejected)).rejects.toMatchObject({
    errorCode: "OPERATION_UNKNOWN", delivery: "unknown",
  });
  const restarted = new ThreadStartLedger(home);
  expect(restarted.status(id)).toMatchObject({ state: "unknown", cwd: "/project", error: "connection lost after dispatch" });
  await expect(restarted.run(id, params(id), send, rejected)).rejects.toMatchObject({ errorCode: "OPERATION_UNKNOWN" });
  expect(send).toHaveBeenCalledTimes(1);
});

it("records a definitive rejection and rejects parameter reuse or capacity before dispatch", async () => {
  const home = fixture();
  const id = "rejected-thread-operation";
  const send = vi.fn(async () => { throw new Error("invalid project"); });
  await expect(new ThreadStartLedger(home).run(id, params(id), send, () => true)).rejects.toMatchObject({
    errorCode: "OPERATION_REJECTED", delivery: "rejected",
  });
  expect(new ThreadStartLedger(home).status(id)).toMatchObject({ state: "rejected" });
  await expect(new ThreadStartLedger(home).run(id, params(id, "/other"), send, () => true)).rejects.toThrow("不同的会话创建参数");
  const full = new ThreadStartLedger(fixture(), 0);
  await expect(full.run("capacity-thread-operation", params("capacity-thread-operation"), send, rejected)).rejects.toMatchObject({
    errorCode: "OPERATION_REJECTED",
  });
  expect(send).toHaveBeenCalledTimes(1);
});

it("treats a malformed accepted response as unknown instead of retryable failure", async () => {
  const home = fixture();
  const id = "malformed-thread-response";
  await expect(new ThreadStartLedger(home).run(id, params(id), async () => ({ thread: { id: "" } }), rejected)).rejects.toMatchObject({
    errorCode: "OPERATION_UNKNOWN", delivery: "unknown",
  });
  expect(new ThreadStartLedger(home).status(id)).toMatchObject({ state: "unknown" });
});
