/**
 * WebSocket client for the gateway. Same protocol as hub.ts on the gateway side:
 * - rpc / rpcResult: request-response by id
 * - notification: fan-out of app-server events
 * - serverRequest / serverRequestResponse: approvals answered from the UI
 */

export type RpcResultMsg = { kind: "rpcResult"; id: number; result?: unknown; error?: string };
export type NotificationMsg = { kind: "notification"; method: string; params?: unknown };
export type ServerRequestMsg = { kind: "serverRequest"; requestId: number | string; method: string; params?: unknown };

type ConnState = "connecting" | "open" | "closed";

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

const RECONNECT_DELAYS = [500, 1_000, 2_000, 5_000, 10_000];

export class GatewayClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notifHandlers = new Set<(method: string, params: any) => void>();
  private stateHandlers = new Set<(state: ConnState) => void>();
  private serverRequestHandler: ((msg: ServerRequestMsg) => void) | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private manuallyClosed = false;

  get state(): ConnState {
    if (this.ws?.readyState === WebSocket.OPEN) return "open";
    if (this.ws?.readyState === WebSocket.CONNECTING) return "connecting";
    return "closed";
  }

  private heartbeatTimer: number | null = null;

  connect(): void {
    this.manuallyClosed = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    // The gateway authenticates every WS with the gw_token cookie it sets
    // when serving the SPA on a trusted host — the browser presents it
    // automatically on the upgrade (cookies ignore ports, so a cookie from
    // http://127.0.0.1:8410 also covers other localhost ports).
    // In dev, vite.config.ts's proxy strips Origin and injects the token
    // cookie server-side, so no direct gateway visit is needed.
    const url = `${proto}//${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.notifyState("open");
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => this.handleMessage(String(ev.data));
    ws.onclose = () => {
      this.stopHeartbeat();
      this.failPending(new Error("connection closed"));
      this.notifyState("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* close event follows */
    };
  }

  /**
   * Half-open connections (NAT timeout, network change) keep readyState OPEN
   * forever with no traffic. A periodic cheap RPC acts as an application-level
   * ping: if it doesn't answer in time, close the socket so the reconnect
   * logic kicks in instead of leaving every pending RPC hanging.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      const timeout = window.setTimeout(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          console.warn("[ws] heartbeat timeout, closing");
          this.ws.close();
        }
      }, 10_000);
      this.rpc("app/status")
        .catch(() => {})
        .finally(() => clearTimeout(timeout));
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  close(): void {
    this.manuallyClosed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private handleMessage(raw: string): void {
    let msg: RpcResultMsg | NotificationMsg | ServerRequestMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg?.kind) {
      case "rpcResult": {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error));
        else entry.resolve(msg.result);
        return;
      }
      case "notification":
        for (const h of this.notifHandlers) h(msg.method, msg.params ?? {});
        return;
      case "serverRequest":
        this.serverRequestHandler?.(msg);
        return;
    }
  }

  private failPending(err: Error): void {
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed) return;
    if (this.reconnectTimer !== null) return;
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private notifyState(state: ConnState): void {
    for (const h of this.stateHandlers) h(state);
  }

  rpc<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.state !== "open") return Promise.reject(new Error("gateway not connected"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ kind: "rpc", id, method, params: params ?? {} }));
    });
  }

  respondServerRequest(requestId: number | string, payload: unknown): void {
    this.ws?.send(JSON.stringify({ kind: "serverRequestResponse", requestId, payload }));
  }

  onNotification(handler: (method: string, params: any) => void): () => void {
    this.notifHandlers.add(handler);
    return () => this.notifHandlers.delete(handler);
  }

  onStateChange(handler: (state: ConnState) => void): () => void {
    this.stateHandlers.add(handler);
    handler(this.state);
    return () => this.stateHandlers.delete(handler);
  }

  setServerRequestHandler(handler: ((msg: ServerRequestMsg) => void) | null): void {
    this.serverRequestHandler = handler;
  }
}

export const gateway = new GatewayClient();
