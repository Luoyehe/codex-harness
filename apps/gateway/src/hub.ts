/**
 * Browser-facing WebSocket hub.
 *
 * The gateway keeps one app-server connection and fans its notifications out
 * to every connected browser tab. Server-initiated requests (approvals, ...)
 * are broadcast to all clients; the first client to answer wins and everyone
 * else observes `serverRequest/resolved`.
 */
import { validateResponse } from "../../../shared/input-forms.mjs";

const INPUT_METHODS = new Set(["item/tool/requestUserInput", "mcpServer/elicitation/request"]);
const MAX_PENDING_ANSWERS = 32;
const MAX_PROMPT_BYTES = 512 * 1024;
const MAX_BROWSER_ERROR_CHARS = 4096;

export type ClientMessage =
  | { kind: "rpc"; id: number; method: string; params?: unknown }
  | { kind: "serverRequestResponse"; requestId: number | string; payload: unknown; error?: string };

export type RpcDelivery = "not_sent" | "unknown" | "rejected";

export type ServerMessage =
  | { kind: "rpcResult"; id: number; result?: unknown; error?: string; errorCode?: string; delivery?: RpcDelivery; operationState?: "unknown" }
  | { kind: "notification"; method: string; params?: unknown }
  | { kind: "serverRequest"; requestId: number | string; method: string; params?: unknown };

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function validDelivery(value: unknown): value is RpcDelivery {
  return value === "not_sent" || value === "unknown" || value === "rejected";
}

/** Build the only browser-facing failure shape. Never forward arbitrary error
 * data, but retain the small delivery receipt needed to decide whether retrying
 * a mutating operation is safe. */
export function rpcFailureMessage(
  id: number,
  error: unknown,
  fallback: { errorCode?: string; delivery?: RpcDelivery } = {},
): Extract<ServerMessage, { kind: "rpcResult" }> {
  const record = objectRecord(error);
  const rpcError = objectRecord(record?.rpcError);
  const rpcData = objectRecord(rpcError?.data);
  const data = objectRecord(record?.data);
  const deliveryCandidates = [fallback.delivery, record?.delivery, rpcData?.delivery, data?.delivery];
  let delivery = deliveryCandidates.find(validDelivery);
  const rawMessage = typeof record?.message === "string" && record.message ? record.message : "gateway request failed";
  const message = rawMessage.slice(0, MAX_BROWSER_ERROR_CHARS);
  const validErrorCode = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
  const directCode = validErrorCode(record?.errorCode) ? record.errorCode : undefined;
  const nestedCode = validErrorCode(rpcData?.errorCode) ? rpcData.errorCode : undefined;
  const errorCode = validErrorCode(fallback.errorCode) ? fallback.errorCode : directCode ?? nestedCode;
  const operationUnknown = record?.operationState === "unknown" || rpcData?.operationState === "unknown" || data?.operationState === "unknown";
  if (operationUnknown) delivery = "unknown";
  // BUSY is a returned refusal, while an unclassified error may have crossed
  // a mutation boundary. Make the latter conservative even if a future
  // producer forgets to attach its receipt.
  if (!delivery) delivery = errorCode === "BUSY" || errorCode === "OPERATION_REJECTED" ? "rejected" : "unknown";
  return {
    kind: "rpcResult",
    id,
    error: message,
    ...(errorCode ? { errorCode } : {}),
    delivery,
    ...(delivery === "unknown" ? { operationState: "unknown" as const } : {}),
  };
}

export interface BrowserClient {
  send(msg: ServerMessage): void;
}

export interface HubOptions {
  /** How long a broadcast server request waits for a browser answer. */
  serverRequestTimeoutMs?: number;
  /** Brief reconnect window only for non-approval input prompts. */
  inputDisconnectGraceMs?: number;
  /** Owner-level notification transport. When supplied, it handles browser
   * fan-out and observes resolutions even when no browser remains connected. */
  broadcastNotification?(method: string, params: unknown): void;
}

export class Hub {
  private clients = new Set<BrowserClient>();
  private generation = 0;
  private nextBrowserRequestId = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: HubOptions = {}) {}

  addClient(client: BrowserClient): void {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
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
    if (this.clients.size === 0) {
      // Permissions never survive the loss of all reviewing browsers. Plain
      // input forms can survive a short reconnect without inventing answers.
      for (const entry of [...this.browserAnswers.values()]) {
        if (!INPUT_METHODS.has(entry.message.method)) entry.finish({ answered: false, error: "all browser clients disconnected" });
      }
      this.startDisconnectGrace();
    }
  }

  private startDisconnectGrace(): void {
    if (this.disconnectTimer || this.clients.size > 0 || !this.browserAnswers.size) return;
    const grace = Math.max(0, Math.min(120_000, this.options.inputDisconnectGraceMs ?? 30_000));
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      if (this.clients.size) return;
      for (const entry of [...this.browserAnswers.values()]) entry.finish({ answered: false, error: "browser reconnect grace expired" });
    }, grace);
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
    if (this.options.broadcastNotification) this.options.broadcastNotification(method, params);
    else this.broadcast({ kind: "notification", method, params });
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
    try {
      if (params !== undefined && Buffer.byteLength(JSON.stringify(params)) > MAX_PROMPT_BYTES) return Promise.resolve({ answered: false, error: "browser prompt exceeded size limit" });
    } catch { return Promise.resolve({ answered: false, error: "invalid browser prompt" }); }
    if (this.clients.size === 0 && !INPUT_METHODS.has(method)) {
      return Promise.resolve({ answered: false, error: "no browser client connected" });
    }
    if (this.browserAnswers.size >= MAX_PENDING_ANSWERS && !this.pendingByServerId.has(serverRequestId)) return Promise.resolve({ answered: false, error: "pending browser input limit reached" });
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
          if (!this.browserAnswers.size && this.disconnectTimer) {
            clearTimeout(this.disconnectTimer);
            this.disconnectTimer = null;
          }
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
      const message: Extract<ServerMessage, { kind: "serverRequest" }> = { kind: "serverRequest", requestId: browserRequestId, method, params };
      const entry = { serverRequestId, finish, message };
      this.browserAnswers.set(browserRequestId, entry);
      this.pendingByServerId.set(serverRequestId, entry);
      // Install the waiter before broadcasting. A synchronous test client (or
      // future in-process client) is then allowed to answer from send().
      this.broadcast(message);
      this.startDisconnectGrace();
    });
  }

  private browserAnswers = new Map<
    string,
    {
      serverRequestId: number | string;
      message: Extract<ServerMessage, { kind: "serverRequest" }>;
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
    let invalid: string | undefined;
    if (error !== undefined && (typeof error !== "string" || error.length > 2000)) invalid = "回答错误字段无效";
    else if (!error && INPUT_METHODS.has(entry.message.method)) invalid = validateResponse({ method: entry.message.method as "item/tool/requestUserInput" | "mcpServer/elicitation/request", params: entry.message.params }, payload).error;
    if (invalid) {
      // Do not consume the waiter. A corrected second answer must still be
      // possible and other tabs must not interpret rejection as resolution.
      this.broadcastNotification("serverRequest/answerRejected", { serverRequestId: requestId, error: invalid });
      return false;
    }
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
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
    this.generation += 1;
    for (const entry of [...this.browserAnswers.values()]) {
      entry.finish({ answered: false, error: reason });
    }
    this.browserAnswers.clear();
    this.pendingByServerId.clear();
  }
}
