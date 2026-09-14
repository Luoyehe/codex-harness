import { afterEach, describe, expect, it, vi } from "vitest";
import { Hub } from "../src/hub.js";

function makeClient() {
  const sent: any[] = [];
  return { sent, client: { send: (msg: any) => sent.push(msg) } };
}

describe("Hub", () => {
  afterEach(() => vi.useRealTimers());

  const questions = { questions: [{ id: "q", header: "Choice", question: "Choose", isOther: false, isSecret: false, options: [{ label: "yes", description: "" }, { label: "no", description: "" }] }] };

  it("rejects invalid input without consuming the waiter and accepts a corrected second answer", async () => {
    const hub = new Hub();
    const browser = makeClient();
    hub.addClient(browser.client);
    const wait = hub.waitForBrowserAnswer(1, "item/tool/requestUserInput", questions);
    const id = browser.sent[0].requestId;
    const secret = "example";
    expect(hub.resolveBrowserAnswer(id, { answers: { q: { answers: [secret] } } })).toBe(false);
    expect(browser.sent.at(-1)).toMatchObject({ kind: "notification", method: "serverRequest/answerRejected", params: { serverRequestId: id } });
    expect(JSON.stringify(browser.sent)).not.toContain(secret);
    expect(hub.resolveBrowserAnswer(id, { answers: { q: { answers: ["yes"] } } })).toBe(true);
    await expect(wait).resolves.toMatchObject({ answered: true, payload: { answers: { q: { answers: ["yes"] } } } });
  });

  it("replays input prompts after reconnect while declining approvals immediately", async () => {
    vi.useFakeTimers();
    const hub = new Hub({ inputDisconnectGraceMs: 1000 });
    const first = makeClient();
    hub.addClient(first.client);
    const input = hub.waitForBrowserAnswer(1, "item/tool/requestUserInput", questions);
    const approval = hub.waitForBrowserAnswer(2, "item/fileChange/requestApproval", {});
    const inputId = first.sent[0].requestId;
    hub.removeClient(first.client);
    await expect(approval).resolves.toMatchObject({ answered: false });
    await vi.advanceTimersByTimeAsync(999);
    const next = makeClient();
    hub.addClient(next.client);
    expect(next.sent).toEqual([expect.objectContaining({ kind: "serverRequest", requestId: inputId, method: "item/tool/requestUserInput" })]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(hub.resolveBrowserAnswer(inputId, { answers: {} })).toBe(true);
    await expect(input).resolves.toMatchObject({ answered: true, payload: { answers: {} } });
  });

  it("ends input waiters on reconnect grace, original timeout, and upstream cancellation", async () => {
    vi.useFakeTimers();
    const hub = new Hub({ inputDisconnectGraceMs: 100, serverRequestTimeoutMs: 200 });
    const noBrowser = hub.waitForBrowserAnswer(1, "item/tool/requestUserInput", questions);
    await vi.advanceTimersByTimeAsync(100);
    await expect(noBrowser).resolves.toMatchObject({ answered: false, error: "browser reconnect grace expired" });
    const browser = makeClient();
    hub.addClient(browser.client);
    const timeout = hub.waitForBrowserAnswer(2, "item/tool/requestUserInput", questions);
    await vi.advanceTimersByTimeAsync(200);
    await expect(timeout).resolves.toMatchObject({ answered: false, error: "browser answer timeout" });
    const cancelled = hub.waitForBrowserAnswer(3, "item/tool/requestUserInput", questions);
    expect(hub.cancelServerRequest(3)).toBe(true);
    await expect(cancelled).resolves.toMatchObject({ answered: false });
  });

  it("bounds pending input count and prompt bytes", async () => {
    const hub = new Hub();
    hub.addClient(makeClient().client);
    const waiting = Array.from({ length: 32 }, (_, id) => hub.waitForBrowserAnswer(id, "item/tool/requestUserInput", questions));
    await expect(hub.waitForBrowserAnswer(33, "item/tool/requestUserInput", questions)).resolves.toMatchObject({ answered: false, error: "pending browser input limit reached" });
    await expect(hub.waitForBrowserAnswer(34, "item/tool/requestUserInput", { value: "x".repeat(512 * 1024) })).resolves.toMatchObject({ answered: false, error: "browser prompt exceeded size limit" });
    hub.resetPendingAnswers();
    await Promise.all(waiting);
  });

  it("does not accept an unsupported MCP schema but permits explicit cancellation", async () => {
    const hub = new Hub();
    const browser = makeClient();
    hub.addClient(browser.client);
    const wait = hub.waitForBrowserAnswer(1, "mcpServer/elicitation/request", { mode: "form", requestedSchema: { type: "object", properties: { x: { type: "string", pattern: "^safe$" } } } });
    const id = browser.sent[0].requestId;
    expect(hub.resolveBrowserAnswer(id, { action: "accept", content: { x: "unsafe" }, _meta: null })).toBe(false);
    expect(hub.resolveBrowserAnswer(id, { action: "cancel", content: null, _meta: null })).toBe(true);
    await expect(wait).resolves.toMatchObject({ answered: true, payload: { action: "cancel" } });
  });
  it("replays pending approvals to a replacement client and never replays resolved ones", async () => {
    const hub = new Hub();
    const first = makeClient();
    const replacement = makeClient();
    hub.addClient(first.client);
    const answer = hub.waitForBrowserAnswer(13, "item/fileChange/requestApproval", { threadId: "t1" });
    hub.addClient(replacement.client);
    hub.removeClient(first.client);
    expect(hub.clientCount).toBe(1);
    expect(replacement.sent).toEqual(first.sent);
    expect(hub.resolveBrowserAnswer(replacement.sent[0].requestId, { decision: "decline" })).toBe(true);
    await expect(answer).resolves.toEqual({ answered: true, payload: { decision: "decline" } });
    const later = makeClient();
    hub.addClient(later.client);
    expect(later.sent).toEqual([]);
  });

  it("broadcasts notifications to all clients", () => {
    const hub = new Hub();
    const a = makeClient();
    const b = makeClient();
    hub.addClient(a.client);
    hub.addClient(b.client);

    hub.broadcastNotification("item/started", { item: { id: "x" } });

    expect(a.sent).toEqual([{ kind: "notification", method: "item/started", params: { item: { id: "x" } } }]);
    expect(b.sent).toEqual(a.sent);
  });

  it("stops delivering after a client is removed", () => {
    const hub = new Hub();
    const a = makeClient();
    hub.addClient(a.client);
    hub.removeClient(a.client);
    hub.broadcastNotification("item/completed", {});
    expect(a.sent).toHaveLength(0);
    expect(hub.clientCount).toBe(0);
  });

  it("first browser answer wins and late answers are ignored", async () => {
    const hub = new Hub();
    const a = makeClient();
    const b = makeClient();
    hub.addClient(a.client);
    hub.addClient(b.client);

    const wait = hub.waitForBrowserAnswer(7, "item/fileChange/requestApproval", { changes: [] });
    expect(a.sent[0]).toMatchObject({
      kind: "serverRequest",
      method: "item/fileChange/requestApproval",
      params: { changes: [] },
    });
    expect(b.sent[0]).toEqual(a.sent[0]);

    const browserRequestId = a.sent[0].requestId;
    expect(browserRequestId).toMatch(/^approval:0:\d+$/);
    expect(hub.resolveBrowserAnswer(browserRequestId, { decision: "accept" })).toBe(true);
    expect(hub.resolveBrowserAnswer(browserRequestId, { decision: "decline" })).toBe(false); // late answer dropped

    await expect(wait).resolves.toEqual({ answered: true, payload: { decision: "accept" } });
  });

  it("reports unanswered when no client is connected", async () => {
    const hub = new Hub();
    await expect(hub.waitForBrowserAnswer(1)).resolves.toMatchObject({ answered: false });
  });

  it("times out when no client answers", async () => {
    const hub = new Hub({ serverRequestTimeoutMs: 10 });
    hub.addClient(makeClient().client);
    const wait = hub.waitForBrowserAnswer(2);
    await expect(wait).resolves.toMatchObject({ answered: false, error: "browser answer timeout" });
  });

  it("invalidates every generation-scoped answer waiter on app-server reset", async () => {
    const hub = new Hub({ serverRequestTimeoutMs: 60_000 });
    hub.addClient(makeClient().client);
    const first = hub.waitForBrowserAnswer(1, "item/tool/requestUserInput", {});
    const second = hub.waitForBrowserAnswer(2, "item/fileChange/requestApproval", {});
    hub.resetPendingAnswers("generation changed");
    await expect(first).resolves.toEqual({ answered: false, error: "generation changed" });
    await expect(second).resolves.toEqual({ answered: false, error: "generation changed" });
    expect(hub.resolveBrowserAnswer(1, {})).toBe(false);
  });

  it("cannot apply a stale browser answer to a reused app-server request id", async () => {
    const hub = new Hub({ serverRequestTimeoutMs: 60_000 });
    const browser = makeClient();
    hub.addClient(browser.client);

    const oldWait = hub.waitForBrowserAnswer(1, "item/fileChange/requestApproval", { old: true });
    const oldBrowserId = browser.sent.find((m) => m.kind === "serverRequest").requestId;
    hub.resetPendingAnswers("app-server restarted");
    await expect(oldWait).resolves.toEqual({ answered: false, error: "app-server restarted" });

    const newWait = hub.waitForBrowserAnswer(1, "item/fileChange/requestApproval", { old: false });
    const requests = browser.sent.filter((m) => m.kind === "serverRequest");
    const newBrowserId = requests.at(-1).requestId;
    expect(newBrowserId).not.toBe(oldBrowserId);
    expect(hub.resolveBrowserAnswer(oldBrowserId, { decision: "accept" })).toBe(false);
    expect(hub.resolveBrowserAnswer(newBrowserId, { decision: "decline" })).toBe(true);
    await expect(newWait).resolves.toEqual({ answered: true, payload: { decision: "decline" } });
  });

  it("installs the waiter before broadcasting to synchronous clients", async () => {
    const hub = new Hub();
    hub.addClient({
      send(msg) {
        if (msg.kind === "serverRequest") {
          expect(hub.resolveBrowserAnswer(msg.requestId, { decision: "decline" })).toBe(true);
        }
      },
    });
    await expect(hub.waitForBrowserAnswer(9, "item/fileChange/requestApproval", {})).resolves.toEqual({
      answered: true,
      payload: { decision: "decline" },
    });
  });

  it("cancels a waiter by the underlying server id", async () => {
    const hub = new Hub({ serverRequestTimeoutMs: 60_000 });
    hub.addClient(makeClient().client);
    const wait = hub.waitForBrowserAnswer("server-4", "item/tool/requestUserInput", {});
    expect(hub.cancelServerRequest("server-4")).toBe(true);
    expect(hub.cancelServerRequest("server-4")).toBe(false);
    await expect(wait).resolves.toMatchObject({ answered: false });
  });
});
