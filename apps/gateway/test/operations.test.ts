import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OperationLedger } from "../src/operations.js";

const homes: string[] = [];
const fixture = () => { const home = mkdtempSync(path.join(tmpdir(), "operations-audit-")); homes.push(home); return home; };
const id = "operation-fixture-0001";
const params = { clientOperationId: id, threadId: "thread-one", text: "fixture", attachments: [{ path: "/upload/fixture.csv", name: "原始数据.csv", kind: "file" }] };
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it("deduplicates concurrent requests and accepted retries after gateway restart", async () => {
  const home = fixture();
  const ledger = new OperationLedger(home);
  let accept!: (value: any) => void;
  const send = vi.fn(() => new Promise((resolve) => { accept = resolve; }));
  const one = ledger.run(id, params, send, () => false);
  const two = ledger.run(id, params, send, () => false);
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(1);
  expect(ledger.status(id).state).toBe("unknown");
  accept({ turn: { id: "turn-one", items: [] } });
  await Promise.all([one, two]);
  const restarted = new OperationLedger(home);
  expect(restarted.status(id)).toMatchObject({ state: "accepted", turnId: "turn-one" });
  await expect(restarted.run(id, params, send, () => false)).resolves.toMatchObject({ replayed: true, turn: { id: "turn-one" } });
  expect(send).toHaveBeenCalledTimes(1);
  const result = restarted.decorateThreadResult({ thread: { id: "thread-one", turns: [{ id: "turn-one", items: [{ id: "user", type: "userMessage", content: [] }] }] } });
  expect(result.thread.turns[0].items[0]).toMatchObject({ clientOperationId: id, harnessAttachments: params.attachments });
});

it("never repeats unknown delivery, including a crash before dispatch", async () => {
  const home = fixture();
  const ledger = new OperationLedger(home);
  const send = vi.fn(async () => { throw new Error("lost upstream response"); });
  await expect(ledger.run(id, params, send, () => false)).rejects.toMatchObject({ errorCode: "OPERATION_UNKNOWN" });
  const restarted = new OperationLedger(home);
  await expect(restarted.run(id, params, send, () => false)).rejects.toMatchObject({ errorCode: "OPERATION_UNKNOWN" });
  expect(send).toHaveBeenCalledTimes(1);
});

it("reports definite rejection distinctly and rejects UUID content changes", async () => {
  const ledger = new OperationLedger(fixture());
  const send = vi.fn(async () => { throw new Error("invalid input"); });
  await expect(ledger.run(id, params, send, () => true)).rejects.toMatchObject({ errorCode: "OPERATION_REJECTED" });
  expect(ledger.status(id)).toMatchObject({ state: "rejected" });
  await expect(ledger.run(id, { ...params, text: "different" }, send, () => true)).rejects.toThrow("不同");
  expect(send).toHaveBeenCalledTimes(1);
});

it("fails closed on unreadable/corrupt admission records and before capacity exhaustion", async () => {
  const home = fixture();
  const ledger = new OperationLedger(home, 0);
  const send = vi.fn();
  await expect(ledger.run(id, params, send, () => false)).rejects.toThrow("容量");
  expect(send).not.toHaveBeenCalled();
  writeFileSync(path.join(home, "operations", id + ".json"), "truncated");
  expect(() => ledger.status(id)).toThrow("无法可靠读取");
  expect(ledger.status("operation-not-received")).toEqual({ state: "not_received" });
});

it("an accepted upstream turn remains unknown if final persistence fails", async () => {
  const home = fixture();
  const ledger = new OperationLedger(home);
  const send = vi.fn(async () => {
    rmSync(path.join(home, "message-metadata"), { recursive: true });
    writeFileSync(path.join(home, "message-metadata"), "not a directory");
    return { turn: { id: "accepted-before-disk-failure" } };
  });
  await expect(ledger.run(id, params, send, () => false)).rejects.toMatchObject({ errorCode: "OPERATION_UNKNOWN" });
  expect(ledger.status(id).state).toBe("unknown");
  await expect(ledger.run(id, params, send, () => false)).rejects.toMatchObject({ errorCode: "OPERATION_UNKNOWN" });
  expect(send).toHaveBeenCalledTimes(1);
});
