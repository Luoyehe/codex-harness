import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { GatewayController } from "../src/control.js";
import { AppServerConnection } from "../src/codex/rpc.js";
import { rpcFailureMessage } from "../src/hub.js";

const homes: string[] = [];
const connections: AppServerConnection[] = [];
function fixture() {
  vi.stubEnv("GATEWAY_UNSAFE_SINGLE_USER", "1");
  vi.stubEnv("CODEX_WORKER_LAUNCHER", "");
  const home = mkdtempSync(path.join(os.tmpdir(), "harness-control-unicode-"));
  homes.push(home);
  const instance = new GatewayController(home);
  const backend = (instance as any).backend;
  backend.events.onNotification("gateway/clientMessage", { clientId: "*", message: { kind: "notification", method: "appServer/stateChanged", params: { state: "ready" } } });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const conn = new AppServerConnection("fake", [], {}, { onNotification() {}, onServerRequest: async () => ({}), onExit() {}, onStderr() {} });
  connections.push(conn);
  conn.attach(stdin, stdout);
  backend.state = "ready";
  backend.conn = conn;
  const frames: any[] = [];
  stdin.on("data", chunk => frames.push(JSON.parse(String(chunk))));
  return { instance, backend, conn, frames, reply: (id: number, result: unknown) => stdout.write(JSON.stringify({ id, result }) + "\n") };
}
afterEach(async () => {
  for (const conn of connections.splice(0)) await conn.kill();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it("records an invalid Unicode turn as rejected with no write or unknown reservation, then accepts a new valid operation", async () => {
  const { instance, conn, frames, reply } = fixture();
  const params = { clientOperationId: "unicode-turn-operation", threadId: "thread-one", text: "unpaired \ud800" };
  await expect(instance.dispatch("turn/start", params, "browser")).rejects.toMatchObject({ delivery: "rejected" });
  expect(frames).toHaveLength(0);
  expect((conn as any).pending.size).toBe(0);
  expect((instance as any).pendingTurnStarts.size).toBe(0);
  expect(await instance.dispatch("turn/operation", { clientOperationId: params.clientOperationId }, "browser")).toMatchObject({ state: "rejected" });
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "idle" });
  const healthy = instance.dispatch("turn/start", { ...params, clientOperationId: "unicode-valid-operation", text: "中文🙂" }, "browser");
  await vi.waitFor(() => expect(frames).toHaveLength(1));
  reply(frames[0].id, { turn: { id: "valid-turn", status: "completed" } });
  await expect(healthy).resolves.toMatchObject({ turn: { id: "valid-turn" } });
  expect(await instance.dispatch("management/status", {}, "browser")).toMatchObject({ state: "idle" });
});

it("permits correcting an invalid Unicode prompt answer after a definite pre-send failure", async () => {
  const { instance, backend, frames, reply } = fixture();
  (instance as any).clients.set("browser", { send() {}, close() {} });
  backend.events.onNotification("gateway/clientMessage", { clientId: "browser", message: {
    kind: "serverRequest", requestId: "prompt-one", method: "item/tool/requestUserInput", params: {},
  } });
  const failure = await instance.answer("prompt-one", { answers: { question: { answers: ["\udfff"] } } }).catch(error => error);
  expect(rpcFailureMessage(1, failure)).toMatchObject({ delivery: "not_sent" });
  expect(frames).toHaveLength(0);
  expect((instance as any).answeringServerRequests.size).toBe(0);
  expect((instance as any).pendingServerRequests.has("prompt-one")).toBe(true);
  const healthy = instance.answer("prompt-one", { answers: { question: { answers: ["🙂"] } } });
  await vi.waitFor(() => expect(frames).toHaveLength(1));
  reply(frames[0].id, true);
  await expect(healthy).resolves.toBe(true);
  expect((instance as any).pendingServerRequests.size).toBe(0);
  expect((instance as any).answeringServerRequests.size).toBe(0);
});
