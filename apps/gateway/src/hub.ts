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

  constructor(private readonly options: HubOptions = {}) {}

  addClient(client: BrowserClient): void {
    this.clients.add(client);
  }

  removeClient(client: BrowserClient): void {
    this.clients.delete(client);
    // If this was the LAST client and there are pending approval waiters,
    // resolve them immediately — nobody can answer, so waiting out the full
    // timeout just blocks the codex turn for no reason.
    if (this.clients.size === 0) {
      for (const finish of this.browserAnswers.values()) {
        finish({ answered: false, error: "all browser clients disconnected" });
      }
      this.browserAnswers.clear();
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
    requestId: number | string,
    method: string,
    params: unknown,
  ): Promise<{ answered: boolean; payload?: unknown; error?: string }> {
    if (this.clients.size === 0) {
      return Promise.resolve({ answered: false, error: "no browser client connected" });
    }
    this.broadcast({ kind: "serverRequest", requestId, method, params });
    const timeoutMs = this.options.serverRequestTimeoutMs ?? 600_000;
    return new Promise((resolve) => {
      const finish = (value: { answered: boolean; payload?: unknown; error?: string }) => {
        clearTimeout(timer);
        this.browserAnswers.delete(requestId);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ answered: false, error: "browser answer timeout" }), timeoutMs);
      this.browserAnswers.set(requestId, finish);
    });
  }

  private browserAnswers = new Map<
    number | string,
    (value: { answered: boolean; payload?: unknown; error?: string }) => void
  >();

  /** Feeds a browser client's answer into a waiting server request. */
  resolveBrowserAnswer(requestId: number | string, payload: unknown, error?: string): boolean {
    const finish = this.browserAnswers.get(requestId);
    if (!finish) return false;
    finish(error ? { answered: true, error } : { answered: true, payload });
    return true;
  }
}
