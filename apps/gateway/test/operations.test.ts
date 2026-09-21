import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OperationLedger } from "../src/operations.js";
import * as atomicFiles from "../src/atomic-file.js";

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
  await expect(ledger.run(id, params, send, () => false)).rejects.toMatchObject({ errorCode: "OPERATION_UNKNOWN", delivery: "unknown", operationState: "unknown" });
  const restarted = new OperationLedger(home);
  await expect(restarted.run(id, params, send, () => false)).rejects.toMatchObject({ errorCode: "OPERATION_UNKNOWN" });
  expect(send).toHaveBeenCalledTimes(1);
});

it("reports definite rejection distinctly and rejects UUID content changes", async () => {
  const ledger = new OperationLedger(fixture());
  const send = vi.fn(async () => { throw new Error("invalid input"); });
  await expect(ledger.run(id, params, send, () => true)).rejects.toMatchObject({ errorCode: "OPERATION_REJECTED", delivery: "rejected" });
  expect(ledger.status(id)).toMatchObject({ state: "rejected" });
  await expect(ledger.run(id, { ...params, text: "different" }, send, () => true)).rejects.toMatchObject({ message: expect.stringContaining("不同"), delivery: "rejected" });
  expect(send).toHaveBeenCalledTimes(1);
});

it("bounds persisted and returned upstream error text", async () => {
  const home = fixture();
  const ledger = new OperationLedger(home);
  const huge = "failure-" + "x".repeat(100_000);
  await expect(ledger.run(id, params, async () => { throw new Error(huge); }, () => true))
    .rejects.toMatchObject({ errorCode: "OPERATION_REJECTED", message: expect.stringMatching(/^failure-/) });
  const status = new OperationLedger(home).status(id);
  expect(status).toMatchObject({ state: "rejected" });
  expect((status as any).error.length).toBe(64 * 1024);
});

it("fails closed on unreadable/corrupt admission records and before capacity exhaustion", async () => {
  const home = fixture();
  const ledger = new OperationLedger(home, 0);
  const send = vi.fn();
  await expect(ledger.run(id, params, send, () => false)).rejects.toMatchObject({ message: expect.stringContaining("容量"), errorCode: "OPERATION_REJECTED", delivery: "rejected" });
  expect(send).not.toHaveBeenCalled();
  writeFileSync(path.join(home, "operations", id + ".json"), "truncated");
  expect(() => ledger.status(id)).toThrow("无法可靠读取");
  writeFileSync(path.join(home, "operations", id + ".json"), JSON.stringify({ clientOperationId: id, state: "accepted" }));
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

it("persists a valid bounded attachment snapshot when optional display metadata is absent", async () => {
  const home = fixture();
  const operationId = "operation-fixture-0002";
  const ledger = new OperationLedger(home);
  await ledger.run(operationId, {
    clientOperationId: operationId,
    threadId: "thread-one",
    text: "fixture",
    attachments: [{ path: "/upload/fixture.csv", size: Number.POSITIVE_INFINITY }],
  }, async () => ({ turn: { id: "turn-two" } }), () => false);
  const restarted = new OperationLedger(home);
  expect(restarted.status(operationId)).toMatchObject({ state: "accepted", threadId: "thread-one", turnId: "turn-two" });
  const decorated = restarted.decorateThreadResult({ thread: { id: "thread-one", turns: [{ id: "turn-two", items: [{ type: "userMessage" }] }] } });
  expect(decorated.thread.turns[0].items[0].harnessAttachments).toEqual([
    { path: "/upload/fixture.csv", name: "fixture.csv", kind: "file" },
  ]);
  const metadata = createHash("sha256").update(JSON.stringify(["thread-one", "turn-two"])).digest("hex") + ".json";
  writeFileSync(path.join(home, "message-metadata", metadata), JSON.stringify({
    clientOperationId: operationId, state: "accepted", threadId: "thread-one", turnId: "turn-two", attachments: "corrupt",
  }));
  const ignored = restarted.decorateThreadResult({ thread: { id: "thread-one", turns: [{ id: "turn-two", items: [{ type: "userMessage" }] }] } });
  expect(ignored.thread.turns[0].items[0]).not.toHaveProperty("harnessAttachments");
});

it("rejects invalid attachment metadata before recording or dispatching an operation", async () => {
  const home = fixture();
  const operationId = "operation-fixture-0003";
  const ledger = new OperationLedger(home);
  const send = vi.fn();
  await expect(ledger.run(operationId, {
    clientOperationId: operationId,
    threadId: "thread-one",
    text: "fixture",
    attachments: [{ path: "/upload/fixture.csv", name: "x".repeat(256), kind: "file" }],
  }, send, () => false)).rejects.toMatchObject({ errorCode: "OPERATION_REJECTED" });
  expect(send).not.toHaveBeenCalled();
  expect(ledger.status(operationId)).toEqual({ state: "not_received" });

  const derivedNameId = "operation-fixture-0004";
  await expect(ledger.run(derivedNameId, {
    clientOperationId: derivedNameId,
    threadId: "thread-one",
    text: "fixture",
    attachments: [{ path: `/upload/${"x".repeat(256)}` }],
  }, send, () => false)).rejects.toMatchObject({ errorCode: "OPERATION_REJECTED" });
  expect(send).not.toHaveBeenCalled();
  expect(ledger.status(derivedNameId)).toEqual({ state: "not_received" });
});

it("projects only validated turn semantics to the sender and rejects unknown fields before recording", async () => {
  const home = fixture();
  const ledger = new OperationLedger(home);
  const operationId = "operation-fixture-0005";
  const send = vi.fn(async (request: Record<string, unknown>) => {
    expect(request).not.toHaveProperty("clientOperationId");
    expect(request).toMatchObject({
      threadId: "thread-one",
      text: "fixture",
      attachments: [{ path: "/upload/fixture.csv", name: "fixture.csv", kind: "file" }],
      model: null,
    });
    return { turn: { id: "turn-five" } };
  });
  await ledger.run(operationId, {
    clientOperationId: operationId, threadId: "thread-one", text: "fixture", model: null,
    attachments: [{ path: "/upload/fixture.csv" }],
  }, send, () => false);
  expect(send).toHaveBeenCalledOnce();

  const rejectedId = "operation-fixture-0006";
  const oversizedKey = "ignored-" + "k".repeat(4096);
  const rejection = ledger.run(rejectedId, {
    clientOperationId: rejectedId, threadId: "thread-one", text: "fixture", [oversizedKey]: "x".repeat(1024 * 1024),
  }, send, () => false);
  await expect(rejection).rejects.toMatchObject({ errorCode: "OPERATION_REJECTED", delivery: "rejected" });
  await rejection.catch((error) => expect(error.message.length).toBeLessThan(512));
  expect(ledger.status(rejectedId)).toEqual({ state: "not_received" });
  expect(send).toHaveBeenCalledOnce();
});

it("reports an initial admission write failure as definitely not dispatched", async () => {
  const home = fixture();
  const ledger = new OperationLedger(home);
  const send = vi.fn();
  vi.spyOn(atomicFiles, "atomicWriteFileSync").mockImplementationOnce(() => { throw new Error("disk full"); });
  await expect(ledger.run("operation-fixture-0007", {
    clientOperationId: "operation-fixture-0007", threadId: "thread-one", text: "fixture",
  }, send, () => false)).rejects.toMatchObject({ errorCode: "OPERATION_REJECTED", delivery: "rejected" });
  expect(send).not.toHaveBeenCalled();
});

it("bounds synchronous metadata reads while decorating a large history", () => {
  const home = fixture();
  const seed = new OperationLedger(home);
  expect(seed).toBeDefined();
  const turns = Array.from({ length: 129 }, (_, index) => {
    const turnId = `turn-${index}`;
    const clientOperationId = `history-operation-${String(index).padStart(4, "0")}`;
    const name = createHash("sha256").update(JSON.stringify(["thread-one", turnId])).digest("hex") + ".json";
    writeFileSync(path.join(home, "message-metadata", name), JSON.stringify({
      clientOperationId, state: "accepted", fingerprint: "a".repeat(64), threadId: "thread-one", turnId,
      attachments: [{ path: `/upload/${index}`, name: `${index}.txt`, kind: "file" }],
    }));
    return { id: turnId, items: [{ type: "userMessage" }] };
  });
  const ledger = new OperationLedger(home);
  const decorated = ledger.decorateThreadResult({ thread: { id: "thread-one", turns } });
  expect(decorated.thread.turns[0].items[0]).not.toHaveProperty("harnessAttachments");
  expect(decorated.thread.turns.slice(1).every((turn: any) => turn.items[0].harnessAttachments)).toBe(true);
});

it("decorates one notification with a shared metadata read and skips implausibly large item arrays", async () => {
  const home = fixture();
  const ledger = new OperationLedger(home);
  await ledger.run("notification-operation-0001", {
    clientOperationId: "notification-operation-0001", threadId: "thread-one", text: "fixture",
    attachments: [{ path: "/upload/fixture.csv", name: "fixture.csv", kind: "file" }],
  }, async () => ({ turn: { id: "turn-notification" } }), () => false);
  const items = Array.from({ length: 4096 }, () => ({ type: "userMessage" }));
  const decorated = ledger.decorateNotificationItems("thread-one", "turn-notification", items);
  expect(decorated).toHaveLength(4096);
  expect(decorated.every((item: any) => item.harnessAttachments?.[0]?.name === "fixture.csv")).toBe(true);
  const oversized = [...items, { type: "userMessage" }];
  expect(ledger.decorateNotificationItems("thread-one", "turn-notification", oversized)).toBe(oversized);
});
