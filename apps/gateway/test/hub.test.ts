import { describe, expect, it } from "vitest";
import { Hub } from "../src/hub.js";

function makeClient() {
  const sent: any[] = [];
  return { sent, client: { send: (msg: any) => sent.push(msg) } };
}

describe("Hub", () => {
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
      requestId: 7,
      method: "item/fileChange/requestApproval",
      params: { changes: [] },
    });
    expect(b.sent[0]).toEqual(a.sent[0]);

    expect(hub.resolveBrowserAnswer(7, { decision: "accept" })).toBe(true);
    expect(hub.resolveBrowserAnswer(7, { decision: "decline" })).toBe(false); // late answer dropped

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
});
