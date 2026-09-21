import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreadStartLedger } from "../src/thread-start-operations.js";

let helpers: any;
const fixtures: string[] = [];
const token = process.env.GATEWAY_TOKEN;
beforeAll(async () => {
  process.env.GATEWAY_TOKEN = "synthetic-creation-verification-token";
  helpers = await import("../../../deploy/verification-client.mjs");
});
afterAll(() => { if (token === undefined) delete process.env.GATEWAY_TOKEN; else process.env.GATEWAY_TOKEN = token; });
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(mode = "success") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "verification-creation-")); fixtures.push(dir);
  const ledger = new ThreadStartLedger(dir);
  const upstream = vi.fn(async () => ({ thread: { id: "owned-thread" }, model: "fixture-model" }));
  const calls: Array<{ method: string; params: any }> = [];
  const client = { closed: false, ws: { readyState: 1 }, async rpc(method: string, params: any) {
    calls.push({ method, params });
    if (method === "thread/start") {
      if (mode === "not_received") throw new Error("transport outcome uncertain");
      const result = await ledger.run(params.clientOperationId, params, upstream, () => false);
      if (mode === "lost_ack") throw new Error("lost acknowledgement");
      if (mode === "malformed") return { thread: null };
      return result;
    }
    if (method === "thread/start/operation") return ledger.status(params.clientOperationId);
    if (method === "turn/interrupt") return {};
    if (method === "thread/delete") {
      expect(params).toEqual({ threadId: "owned-thread" });
      if (mode === "cleanup_failure") throw new Error("deletion failed");
      return {};
    }
    throw new Error("unexpected method");
  } };
  return { client, calls, upstream };
}

it("verification creation passes the real ledger with one ID and keeps original thread metadata", async () => {
  const f = fixture();
  const result = await helpers.startVerificationThread(f.client, { cwd: "/fixture", sandbox: "read-only", clientOperationId: "caller-must-not-reuse" });
  expect(result).toMatchObject({ thread: { id: "owned-thread" }, model: "fixture-model" });
  expect(f.calls[0]!.params.clientOperationId).toMatch(/^[a-zA-Z0-9_-]{16,128}$/);
  expect(f.calls[0]!.params.clientOperationId).not.toBe("caller-must-not-reuse");
  expect(f.upstream).toHaveBeenCalledOnce();
  expect(helpers.hasPendingVerificationThread(f.client)).toBe(false);
  await helpers.cleanupThread(f.client, result.thread.id);
  expect(f.calls.filter(call => call.method === "thread/delete")).toHaveLength(1);
});

it.each(["lost_ack", "malformed"])("reconciles %s for cleanup without a second creation or paid turn", async (mode) => {
  const f = fixture(mode);
  await expect(helpers.startVerificationThread(f.client)).rejects.toThrow();
  expect(helpers.hasPendingVerificationThread(f.client)).toBe(true);
  await helpers.cleanupThread(f.client, undefined);
  expect(f.calls.map(call => call.method)).toEqual(["thread/start", "thread/start/operation", "turn/interrupt", "thread/delete"]);
  expect(f.calls[1]!.params.clientOperationId).toBe(f.calls[0]!.params.clientOperationId);
  expect(f.upstream).toHaveBeenCalledOnce();
  expect(helpers.hasPendingVerificationThread(f.client)).toBe(false);
});

it("an absent or uncertain receipt cannot pass cleanup or authorize a new creation", async () => {
  const f = fixture("not_received");
  await expect(helpers.startVerificationThread(f.client)).rejects.toThrow();
  await expect(helpers.cleanupThread(f.client, undefined)).rejects.toThrow(/remains unresolved/);
  expect(f.calls.map(call => call.method)).toEqual(["thread/start", "thread/start/operation"]);
  expect(f.upstream).not.toHaveBeenCalled();
  expect(helpers.hasPendingVerificationThread(f.client)).toBe(true);
});

it("definitive rejections are not confused with uncertain delivery", async () => {
  for (const delivery of ["rejected", "not_sent", "unknown"]) {
    const client = { rpc: vi.fn(async () => { throw new helpers.VerificationRpcError("thread/start", delivery); }) };
    await expect(helpers.startVerificationThread(client)).rejects.toThrow();
    expect(helpers.hasPendingVerificationThread(client)).toBe(delivery === "unknown");
  }
});
