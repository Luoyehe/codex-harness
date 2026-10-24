import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GatewayController } from "../src/control.js";

const homes: string[] = [];
function controller() {
  vi.stubEnv("GATEWAY_UNSAFE_SINGLE_USER", "1");
  vi.stubEnv("CODEX_WORKER_LAUNCHER", "");
  const home = mkdtempSync(path.join(os.tmpdir(), "harness-turn-admission-"));
  homes.push(home);
  const instance = new GatewayController(home);
  const backend = (instance as any).backend;
  notify(backend, "appServer/stateChanged", { state: "ready" });
  return { instance, backend };
}
function notify(backend: any, method: string, params: unknown) {
  backend.events.onNotification("gateway/clientMessage", { clientId: "*", message: { kind: "notification", method, params } });
}
const request = (clientOperationId: string, threadId = "thread-one") => ({ clientOperationId, threadId, text: "fixture" });
const rejected = { errorCode: "OPERATION_REJECTED", delivery: "rejected" };
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it("admits one fresh same-thread start while preserving a concurrent same-operation retry", async () => {
  const { instance, backend } = controller();
  let finish!: (value: unknown) => void;
  backend.request = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const first = instance.dispatch("turn/start", request("pending-first-operation"), "browser-one");
  const second = instance.dispatch("turn/start", request("pending-second-operation"), "browser-two");
  const secondResult = expect(second).rejects.toMatchObject(rejected);
  const retry = instance.dispatch("turn/start", request("pending-first-operation"), "browser-two");

  await vi.waitFor(() => expect(backend.request).toHaveBeenCalledTimes(1));
  await secondResult;
  await expect(instance.dispatch("turn/operation", { clientOperationId: "pending-second-operation" }, "browser-two"))
    .resolves.toMatchObject({ state: "rejected" });
  finish({ turn: { id: "first-turn", status: "inProgress" } });
  await expect(first).resolves.toMatchObject({ turn: { id: "first-turn" } });
  await expect(retry).resolves.toMatchObject({ turn: { id: "first-turn" } });
  expect(backend.request).toHaveBeenCalledTimes(1);
  expect(await instance.dispatch("management/status", {}, "browser-one")).toMatchObject({ state: "idle" });
});

it("checks activity after a delayed worker attachment instead of admitting a stale send intent", async () => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async () => ({ turn: { id: "active-turn", status: "inProgress" } }));
  let attach!: () => void;
  const attached = new Promise<void>(resolve => { attach = resolve; });
  const waiting = instance.dispatch("turn/start", request("attachment-waiting-operation"), "browser-one", attached);
  const waitingResult = expect(waiting).rejects.toMatchObject(rejected);
  await instance.dispatch("turn/start", request("attachment-ready-operation"), "browser-two");
  attach();
  await waitingResult;
  expect(backend.request).toHaveBeenCalledTimes(1);
});

it.each(["response", "started", "status"] as const)(
  "blocks a fresh send for %s activity, allows another thread, and releases after completion",
  async source => {
    const { instance, backend } = controller();
    backend.request = vi.fn(async (_method, envelope) => ({ turn: { id: `${envelope.params.threadId}-turn`, status: "inProgress" } }));
    if (source === "response") await instance.dispatch("turn/start", request("activity-original-operation"), "browser-one");
    else if (source === "started") notify(backend, "turn/started", { threadId: "thread-one", turn: { id: "thread-one-turn" } });
    else notify(backend, "thread/status/changed", { threadId: "thread-one", status: { type: "active", activeFlags: [] } });
    const before = backend.request.mock.calls.length;

    await expect(instance.dispatch("turn/start", request("activity-refused-operation"), "browser-two")).rejects.toMatchObject(rejected);
    expect(backend.request).toHaveBeenCalledTimes(before);
    await expect(instance.dispatch("turn/start", request("activity-other-operation", "thread-two"), "browser-two"))
      .resolves.toMatchObject({ turn: { id: "thread-two-turn" } });
    if (source === "status") notify(backend, "thread/status/changed", { threadId: "thread-one", status: { type: "idle" } });
    else notify(backend, "turn/completed", { threadId: "thread-one", turn: { id: "thread-one-turn" } });
    await expect(instance.dispatch("turn/start", request("activity-after-operation"), "browser-one"))
      .resolves.toMatchObject({ turn: { id: "thread-one-turn" } });
    expect(backend.request).toHaveBeenCalledTimes(before + 2);
  },
);

it("admits pending starts independently for different threads", async () => {
  const { instance, backend } = controller();
  const pending = new Map<string, (value: unknown) => void>();
  backend.request = vi.fn((_method, envelope) => new Promise(resolve => { pending.set(envelope.params.threadId, resolve); }));
  const first = instance.dispatch("turn/start", request("independent-first-operation"), "browser-one");
  const second = instance.dispatch("turn/start", request("independent-second-operation", "thread-two"), "browser-two");
  await vi.waitFor(() => expect(backend.request).toHaveBeenCalledTimes(2));
  pending.get("thread-one")!({ turn: { id: "turn-one", status: "inProgress" } });
  pending.get("thread-two")!({ turn: { id: "turn-two", status: "inProgress" } });
  await expect(first).resolves.toMatchObject({ turn: { id: "turn-one" } });
  await expect(second).resolves.toMatchObject({ turn: { id: "turn-two" } });
});

it("replays an accepted operation during a newer active turn without replacing its identity", async () => {
  const { instance, backend } = controller();
  backend.request = vi.fn()
    .mockResolvedValueOnce({ turn: { id: "completed-turn", status: "completed" } })
    .mockResolvedValueOnce({ turn: { id: "new-active-turn", status: "inProgress" } });
  await instance.dispatch("turn/start", request("replay-original-operation"), "browser-one");
  await instance.dispatch("turn/start", request("replay-new-operation"), "browser-two");
  await expect(instance.dispatch("turn/start", request("replay-original-operation"), "browser-two"))
    .resolves.toMatchObject({ replayed: true, turn: { id: "completed-turn" } });
  expect(backend.request).toHaveBeenCalledTimes(2);
  expect((instance as any).activeTurns.get("thread-one")).toBe("new-active-turn");
});

it("preserves the first message metadata when a second operation would steer the same native turn", async () => {
  const { instance, backend } = controller();
  backend.request = vi.fn(async (_method, envelope) => envelope.method === "turn/start"
    ? { turn: { id: "shared-native-turn", status: "inProgress" } }
    : { data: [{ id: "shared-native-turn", items: [{ id: "first-user-message", type: "userMessage", content: [] }] }], nextCursor: null });
  const firstAttachment = { path: "/upload/first.txt", name: "first.txt", kind: "file" };
  await instance.dispatch("turn/start", { ...request("metadata-first-operation"), attachments: [firstAttachment] }, "browser-one");
  await expect(instance.dispatch("turn/start", {
    ...request("metadata-second-operation"), attachments: [{ path: "/upload/second.txt", name: "second.txt", kind: "file" }],
  }, "browser-two")).rejects.toMatchObject(rejected);
  const history = await instance.dispatch("thread/turns/list", { threadId: "thread-one" }, "browser-one");
  expect(history.data[0].items[0]).toMatchObject({ clientOperationId: "metadata-first-operation", harnessAttachments: [firstAttachment] });
  expect(backend.request).toHaveBeenCalledTimes(2); // One start, then one history read.
});
