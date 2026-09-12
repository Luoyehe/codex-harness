/**
 * WebSocket client for the gateway. Same protocol as hub.ts on the gateway side:
 * - rpc / rpcResult: request-response by id
 * - notification: fan-out of app-server events
 * - serverRequest / serverRequestResponse: approvals answered from the UI
 */

import type { GatewayNotification, GatewayServerRequest, ProtocolRpc } from "./protocol";

export type RpcResultMsg = { kind: "rpcResult"; id: number; result?: unknown; error?: string };
export type NotificationMsg = { kind: "notification" } & GatewayNotification;
export type ServerRequestMsg = { kind: "serverRequest" } & GatewayServerRequest;

type ConnState = "connecting" | "open" | "closed";

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  /** Socket generation that issued the request. An old socket must never
   * settle (or reject) work sent on a replacement connection. */
  generation: number;
}

const RECONNECT_DELAYS = [500, 1_000, 2_000, 5_000, 10_000];

export class GatewayClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notifHandlers = new Set<(event: GatewayNotification) => void>();
  private stateHandlers = new Set<(state: ConnState) => void>();
  private serverRequestHandler: ((msg: ServerRequestMsg) => void) | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private manuallyClosed = false;
  private connectionGeneration = 0;

  get state(): ConnState {
    if (this.ws?.readyState === WebSocket.OPEN) return "open";
    if (this.ws?.readyState === WebSocket.CONNECTING) return "connecting";
    return "closed";
  }

  /** Monotonically increasing identity of the current connection attempt.
   * Store-level async workflows use this to discard results that crossed a
   * disconnect/reconnect boundary after their RPC already resolved. */
  get generation(): number {
    return this.connectionGeneration;
  }

  private heartbeatTimer: number | null = null;

  connect(): void {
    this.manuallyClosed = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    // A caller may explicitly retry before a scheduled reconnect fires.
    // Cancel that timer now so it cannot create a second connection later.
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (location.protocol !== "http:" && location.protocol !== "https:") {
      console.error(`[ws] unsupported page URL scheme: ${location.protocol}`);
      this.notifyState("closed");
      return;
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    // The gateway authenticates every WS with the gw_token cookie it sets
    // when serving the SPA on a trusted host — the browser presents it
    // automatically on the upgrade (cookies ignore ports, so a cookie from
    // http://127.0.0.1:8410 also covers other localhost ports).
    // In dev, the proxy first requires a same-origin loopback page, then
    // supplies the token cookie server-side.
    const url = `${proto}//${location.host}/ws`;
    // If a CLOSED socket's close callback has not run yet, settle only its
    // own requests before replacing it. The callback may still arrive later.
    this.failPending(new Error("connection replaced"), this.connectionGeneration);
    const generation = ++this.connectionGeneration;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.notifyState("connecting");

    ws.onopen = () => {
      if (!this.isCurrent(ws, generation)) {
        ws.close();
        return;
      }
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectAttempt = 0;
      this.notifyState("open");
      this.startHeartbeat(ws, generation);
    };
    ws.onmessage = (ev) => {
      if (this.isCurrent(ws, generation)) this.handleMessage(String(ev.data), generation);
    };
    ws.onclose = () => {
      // Always reject requests issued by this socket, but never requests from
      // a newer one. All remaining state transitions belong to the current
      // socket only; late callbacks from a replaced socket are inert.
      this.failPending(new Error("connection closed"), generation);
      if (!this.isCurrent(ws, generation)) return;
      this.ws = null;
      this.stopHeartbeat();
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
  private isCurrent(ws: WebSocket, generation: number): boolean {
    return this.ws === ws && this.connectionGeneration === generation;
  }

  private startHeartbeat(ws: WebSocket, generation: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.isCurrent(ws, generation) || ws.readyState !== WebSocket.OPEN) return;
      const timeout = window.setTimeout(() => {
        if (this.isCurrent(ws, generation) && ws.readyState === WebSocket.OPEN) {
          console.warn("[ws] heartbeat timeout, closing");
          ws.close();
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
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPending(new Error("connection closed"), this.connectionGeneration);
    this.ws?.close();
  }

  private handleMessage(raw: string, generation: number): void {
    let msg: RpcResultMsg | NotificationMsg | ServerRequestMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg?.kind) {
      case "rpcResult": {
        const entry = this.pending.get(msg.id);
        if (!entry || entry.generation !== generation) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error));
        else entry.resolve(msg.result);
        return;
      }
      case "notification":
        for (const h of this.notifHandlers) h(msg);
        return;
      case "serverRequest":
        this.serverRequestHandler?.(msg);
        return;
    }
  }

  private failPending(err: Error, generation?: number): void {
    for (const [id, entry] of this.pending) {
      if (generation !== undefined && entry.generation !== generation) continue;
      this.pending.delete(id);
      entry.reject(err);
    }
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

  rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    const ws = this.ws;
    const generation = this.connectionGeneration;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("gateway not connected"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, generation });
      try {
        ws.send(JSON.stringify({ kind: "rpc", id, method, params: params ?? {} }));
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  respondServerRequest(requestId: number | string, payload: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ kind: "serverRequestResponse", requestId, payload }));
    } catch {
      /* the server timeout safely declines unanswered requests */
    }
  }

  request<M extends keyof ProtocolRpc>(method: M, params: ProtocolRpc[M]["params"]): Promise<ProtocolRpc[M]["result"]> {
    return this.rpc<ProtocolRpc[M]["result"]>(method, params);
  }

  onNotification(handler: (event: GatewayNotification) => void): () => void {
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
