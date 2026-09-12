/**
 * Browser-facing WebSocket hub.
 *
 * The gateway keeps one app-server connection and fans its notifications out
 * to every connected browser tab. Server-initiated requests (approvals, ...)
 * are broadcast to all clients; the first client to answer wins and everyone
 * else observes `serverRequest/resolved`.
 */

export type ClientMessage =
  | { kind: "rpc"; id: number; method: string; params?: unknown }
  | { kind: "serverRequestResponse"; requestId: number | string; payload: unknown; error?: string };

export type ServerMessage =
  | { kind: "rpcResult"; id: number; result?: unknown; error?: string }
  | { kind: "notification"; method: string; params?: unknown }
  | { kind: "serverRequest"; requestId: number | string; method: string; params?: unknown };

export interface BrowserClient {
  send(msg: ServerMessage): void;
}

export interface HubOptions {
  /** How long a broadcast server request waits for a browser answer. */
  serverRequestTimeoutMs?: number;
}

export class Hub {
  private clients = new Set<BrowserClient>();
  private generation = 0;
  private nextBrowserRequestId = 0;

  constructor(private readonly options: HubOptions = {}) {}

  addClient(client: BrowserClient): void {
    this.clients.add(client);
    // A second tab can replace the original without the client count ever
    // reaching zero. Transfer every still-pending prompt to that tab too.
    for (const [requestId, entry] of [...this.browserAnswers]) {
      if (this.browserAnswers.get(requestId) !== entry) continue;
      try { client.send(entry.message); } catch { /* close event removes it */ }
    }
  }

  removeClient(client: BrowserClient): void {
    this.clients.delete(client);
    // If this was the LAST client and there are pending approval waiters,
    // resolve them immediately — nobody can answer, so waiting out the full
    // timeout just blocks the codex turn for no reason.
    if (this.clients.size === 0) {
      this.resetPendingAnswers("all browser clients disconnected");
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  broadcast(msg: ServerMessage): void {
    for (const c of this.clients) {
      try {
        c.send(msg);
      } catch {
        // A dead client is dropped on its close event; ignore send failures.
      }
    }
  }

  broadcastNotification(method: string, params: unknown): void {
    this.broadcast({ kind: "notification", method, params });
  }

  /**
   * Broadcasts a server-initiated request to all browsers and resolves when
   * one of them answers. Returns `{ answered: false }` if no client is
   * connected or none answered within the timeout; the caller then applies a
   * safe fallback (decline).
   */
  waitForBrowserAnswer(
    serverRequestId: number | string,
    method: string,
    params: unknown,
  ): Promise<{ answered: boolean; payload?: unknown; error?: string }> {
    if (this.clients.size === 0) {
      return Promise.resolve({ answered: false, error: "no browser client connected" });
    }
    const timeoutMs = this.options.serverRequestTimeoutMs ?? 600_000;
    return new Promise((resolve) => {
      // app-server request ids restart at small integers after a reconnect.
      // Never expose those as browser correlation ids: a delayed answer from
      // an old tab could otherwise approve a new request that reused the id.
      const browserRequestId = `approval:${this.generation}:${++this.nextBrowserRequestId}`;
      this.pendingByServerId.get(serverRequestId)?.finish({
        answered: false,
        error: "server request id was replaced",
      });
      const finish = (value: { answered: boolean; payload?: unknown; error?: string }) => {
        clearTimeout(timer);
        const entry = this.browserAnswers.get(browserRequestId);
        if (entry?.finish === finish) {
          this.browserAnswers.delete(browserRequestId);
          if (this.pendingByServerId.get(serverRequestId) === entry) {
            this.pendingByServerId.delete(serverRequestId);
          }
          // Clear approval cards on timeout/reset/replacement too. A normal
          // browser answer goes through this same single resolution path.
          this.broadcastNotification("serverRequest/resolved", {
            serverRequestId: browserRequestId,
            reason: value.answered ? { type: "answered" } : { type: "cancelled" },
          });
        }
        resolve(value);
      };
      const timer = setTimeout(() => finish({ answered: false, error: "browser answer timeout" }), timeoutMs);
      const message: ServerMessage = { kind: "serverRequest", requestId: browserRequestId, method, params };
      const entry = { serverRequestId, finish, message };
      this.browserAnswers.set(browserRequestId, entry);
      this.pendingByServerId.set(serverRequestId, entry);
      // Install the waiter before broadcasting. A synchronous test client (or
      // future in-process client) is then allowed to answer from send().
      this.broadcast(message);
    });
  }

  private browserAnswers = new Map<
    string,
    {
      serverRequestId: number | string;
      message: ServerMessage;
      finish(value: { answered: boolean; payload?: unknown; error?: string }): void;
    }
  >();
  private pendingByServerId = new Map<number | string, {
    serverRequestId: number | string;
    finish(value: { answered: boolean; payload?: unknown; error?: string }): void;
  }>();

  /** Feeds a browser client's answer into a waiting server request. */
  resolveBrowserAnswer(requestId: number | string, payload: unknown, error?: string): boolean {
    if (typeof requestId !== "string") return false;
    const entry = this.browserAnswers.get(requestId);
    if (!entry) return false;
    entry.finish(error ? { answered: true, error } : { answered: true, payload });
    return true;
  }

  /** Cancel a waiter when app-server announces serverRequest/resolved. */
  cancelServerRequest(serverRequestId: number | string, reason = "server request resolved upstream"): boolean {
    const entry = this.pendingByServerId.get(serverRequestId);
    if (!entry) return false;
    entry.finish({ answered: false, error: reason });
    return true;
  }

  /** Resolve and remove every app-server-owned waiter during restart/stop. */
  resetPendingAnswers(reason = "app-server connection reset"): void {
    this.generation += 1;
    for (const entry of [...this.browserAnswers.values()]) {
      entry.finish({ answered: false, error: reason });
    }
    this.browserAnswers.clear();
    this.pendingByServerId.clear();
  }
}
