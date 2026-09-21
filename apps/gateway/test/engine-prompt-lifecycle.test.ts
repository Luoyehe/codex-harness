import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerMessage } from "../src/hub.js";

const fixture = vi.hoisted(() => ({ supervisors: [] as any[], restart: vi.fn(async () => {}) }));
vi.mock("../src/codex/process.js", () => ({ CodexSupervisor: class {
  state = "ready";
  request = vi.fn();
  constructor(_command: string, _args: string[], _env: unknown, readonly events: any) { fixture.supervisors.push(this); }
  start() {}
  async stop() { this.state = "stopped"; this.events.onStateChange("stopped"); }
} }));
vi.mock("../src/admin.js", async (original) => ({
  ...await original<typeof import("../src/admin.js")>(), scheduleServiceRestart: fixture.restart,
}));

const homes: string[] = [];
const engines: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fixture.supervisors.length = 0;
  fixture.restart.mockClear();
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
});

async function connectedEngine() {
  const home = mkdtempSync(path.join(tmpdir(), "harness-prompt-lifecycle-"));
  homes.push(home);
  vi.stubEnv("CODEX_HOME", home);
  vi.stubEnv("CODEX_WORKSPACE", home);
  vi.stubEnv("GATEWAY_UNSAFE_SINGLE_USER", "1");
  vi.stubEnv("CODEX_WORKER_LAUNCHER", "");
  vi.resetModules();
  const { GatewayController } = await import("../src/control.js");
  const { createEngine } = await import("../src/engine.js");
  const control = new GatewayController(home);
  const outer = fixture.supervisors.at(-1);
  const frames: Array<{ clientId: string; message: ServerMessage }> = [];
  const engine = createEngine((clientId, message) => {
    frames.push({ clientId, message });
    outer.events.onNotification("gateway/clientMessage", { clientId, message });
  });
  engines.push(engine);
  const inner = fixture.supervisors.at(-1);
  outer.request.mockImplementation(async (method: string, params: any) => {
    if (method === "gateway/connect") { engine.connect(params.clientId); return {}; }
    if (method === "gateway/disconnect") { engine.disconnect(params.clientId); return {}; }
    if (method === "gateway/answer") return engine.answer(params.requestId, params.payload, params.error);
    if (method === "gateway/dispatch" && params.method === "thread/compact/start") return {};
    if (method === "gateway/dispatch" && ["admin/catalog/sync", "admin/provider/switch"].includes(params.method)) {
      return { ok: true, changed: false, restartRequired: false };
    }
    throw new Error(`unexpected fixture request: ${method}`);
  });
  inner.events.onStateChange("ready");
  const connect = async (id: string) => {
    const messages: ServerMessage[] = [];
    await control.connect(id, { send: (message) => messages.push(message), close: () => {} });
    return messages;
  };
  const request = (id: number, method = "item/commandExecution/requestApproval") =>
    inner.events.onServerRequest(id, method, { threadId: "thread-one", questions: [] }) as Promise<unknown>;
  const resolved = () => frames.filter(({ message }) => message.kind === "notification" && message.method === "serverRequest/resolved");
  return { control, inner, connect, request, resolved };
}

function requestId(messages: ServerMessage[]): string {
  const message = messages.findLast((message) => message.kind === "serverRequest");
  if (message?.kind !== "serverRequest" || typeof message.requestId !== "string") throw new Error("missing browser prompt");
  return message.requestId;
}

it("releases the controller reservation when its last browser disconnects and the engine declines approval", async () => {
  const { control, inner, connect, request, resolved } = await connectedEngine();
  const first = await connect("first-browser");
  const approval = request(1);
  const id = requestId(first);
  await expect(control.dispatch("admin/catalog/sync", {}, "first-browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  await control.disconnect("first-browser");
  await expect(approval).resolves.toEqual({ decision: "decline" });
  expect(resolved()).toEqual([{ clientId: "*", message: {
    kind: "notification", method: "serverRequest/resolved", params: { serverRequestId: id, reason: { type: "cancelled" } },
  } }]);
  inner.events.onNotification("serverRequest/resolved", { threadId: "thread-one", requestId: 1 });
  expect(resolved()).toHaveLength(1);
  const replacement = await connect("replacement-browser");
  expect(replacement).not.toContainEqual(expect.objectContaining({ kind: "serverRequest" }));
  await expect(control.dispatch("admin/catalog/sync", {}, "replacement-browser")).resolves.toMatchObject({ ok: true });
  await expect(control.dispatch("admin/provider/switch", {}, "replacement-browser")).resolves.toMatchObject({ ok: true });
  await expect(control.dispatch("thread/compact/start", { threadId: "thread-one" }, "replacement-browser")).resolves.toEqual({});
  inner.events.onNotification("thread/compacted", { threadId: "thread-one" });
  await expect(control.dispatch("admin/service/restart", {}, "replacement-browser")).resolves.toMatchObject({ ok: true });
  expect(fixture.restart).toHaveBeenCalledOnce();
});

it("releases a previously delivered input prompt after its reconnect grace expires without browsers", async () => {
  vi.useFakeTimers();
  const { control, connect, request, resolved } = await connectedEngine();
  await connect("input-browser");
  const input = request(2, "item/tool/requestUserInput").catch((error) => error);
  await control.disconnect("input-browser");
  await vi.advanceTimersByTimeAsync(29_999);
  expect(resolved()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(await input).toMatchObject({ message: "browser reconnect grace expired" });
  expect(resolved()).toHaveLength(1);
  expect(resolved()[0].clientId).toBe("*");
  await connect("later-browser");
  await expect(control.dispatch("admin/catalog/sync", {}, "later-browser")).resolves.toMatchObject({ ok: true });
});

it("publishes one resolution for all browsers and preserves first-answer-wins and unrelated reservations", async () => {
  const { control, connect, request, resolved } = await connectedEngine();
  const first = await connect("first-browser");
  const second = await connect("second-browser");
  const approval = request(3);
  const id = requestId(first);
  expect(requestId(second)).toBe(id);
  const other = request(4);
  const otherId = requestId(second);
  await expect(control.answer(id, { decision: "accept" })).resolves.toBe(true);
  await expect(approval).resolves.toEqual({ decision: "accept" });
  await expect(control.answer(id, { decision: "decline" })).rejects.toMatchObject({ errorCode: "ANSWER_REJECTED" });
  expect(resolved()).toHaveLength(1);
  for (const messages of [first, second]) {
    expect(messages.filter((message) => message.kind === "notification" && message.method === "serverRequest/resolved")).toHaveLength(1);
  }
  await expect(control.dispatch("admin/catalog/sync", {}, "second-browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  await control.disconnect("first-browser");
  expect(resolved()).toHaveLength(1);
  await expect(control.answer(otherId, { decision: "decline" })).resolves.toBe(true);
  await expect(other).resolves.toEqual({ decision: "decline" });
  expect(resolved()).toHaveLength(2);
  await expect(control.dispatch("admin/catalog/sync", {}, "second-browser")).resolves.toMatchObject({ ok: true });
});

it("publishes timeout, replacement, and reset resolutions once without letting stale ids answer a new generation", async () => {
  vi.useFakeTimers();
  const { control, inner, connect, request, resolved } = await connectedEngine();
  const browser = await connect("browser");
  const expired = request(5);
  await vi.advanceTimersByTimeAsync(600_000);
  await expect(expired).resolves.toEqual({ decision: "decline" });
  await expect(control.dispatch("admin/catalog/sync", {}, "browser")).resolves.toMatchObject({ ok: true });
  expect(resolved()).toHaveLength(1);

  const replaced = request(6);
  const oldId = requestId(browser);
  const replacement = request(6);
  const replacementId = requestId(browser);
  expect(replacementId).not.toBe(oldId);
  await expect(replaced).resolves.toEqual({ decision: "decline" });
  await expect(control.answer(oldId, { decision: "accept" })).rejects.toMatchObject({ errorCode: "ANSWER_REJECTED" });
  await expect(control.dispatch("admin/catalog/sync", {}, "browser")).rejects.toMatchObject({ errorCode: "BUSY" });
  expect(resolved()).toHaveLength(2);

  inner.events.onStateChange("restarting");
  await expect(replacement).resolves.toEqual({ decision: "decline" });
  expect(resolved()).toHaveLength(3);
  inner.events.onStateChange("ready");
  const nextGeneration = request(6);
  const newId = requestId(browser);
  expect(newId.split(":")[1]).not.toBe(replacementId.split(":")[1]);
  await expect(control.answer(replacementId, { decision: "accept" })).rejects.toMatchObject({ errorCode: "ANSWER_REJECTED" });
  await expect(control.answer(newId, { decision: "decline" })).resolves.toBe(true);
  await expect(nextGeneration).resolves.toEqual({ decision: "decline" });
  expect(resolved()).toHaveLength(4);
  expect(resolved().every(({ clientId }) => clientId === "*")).toBe(true);
});
