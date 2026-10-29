import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import WebSocket from 'ws';
import { HarnessError } from '../core/errors.js';
import type { CallContext, HarnessEvent, JsonObject, JsonValue, WorkerPort } from '../core/contracts.js';
import { LIMITS } from '../core/contracts.js';
import { object, safeJson, uuid } from '../core/validation.js';

export interface WorkerAddress { socketPath?: string; port?: number; token?: string }
export class WorkerClient extends EventEmitter implements WorkerPort {
  connected = false;
  #closed = false; #socket: WebSocket | undefined; #retry: NodeJS.Timeout | undefined;
  #eventChannelId: string | undefined;
  #clientChannels = new Map<string, string>();
  #ping: NodeJS.Timeout | undefined; #alive = false;
  constructor(readonly address: WorkerAddress) { super(); }
  connect(): void {
    if (this.#closed || this.#socket) return;
    const options: WebSocket.ClientOptions = {
      maxPayload: LIMITS.responseBytes, handshakeTimeout: 10_000,
      headers: this.address.token ? { Authorization: `Bearer ${this.address.token}` } : {},
      ...(this.address.socketPath ? { createConnection: () => net.connect(this.address.socketPath!) } : {}),
    };
    const socket = new WebSocket(`ws://127.0.0.1:${this.address.port ?? 80}/events`, options);
    this.#socket = socket;
    socket.on('open', () => {
      this.#alive = true;
      this.#ping = setInterval(() => { if (!this.#alive) socket.terminate(); else { this.#alive = false; socket.ping(); } }, 15000);
    });
    socket.on('pong', () => { this.#alive = true; });
    socket.on('message', (data, binary) => {
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        if (binary) throw new Error('binary event');
        const event = safeJson(data.toString(), LIMITS.responseBytes); object(event);
        if (typeof event.type !== 'string' || !Object.hasOwn(event, 'data')) throw new Error('event envelope');
        if (event.type === 'state') {
          object(event.data);
          if (Object.hasOwn(event.data, 'eventChannelId')) {
            const id = uuid(event.data.eventChannelId);
            if (this.#eventChannelId && this.#eventChannelId !== id) throw new Error('event channel changed');
            this.#eventChannelId = id;
          }
          if (!this.#eventChannelId) throw new Error('event channel handshake missing');
          this.connected = true;
          // The transport credential belongs only to this gateway-worker channel.
          const state = { ...event.data }; delete state.eventChannelId; event.data = state;
        }
        if (!this.connected) throw new Error('event before channel handshake');
        this.emit('event', event as unknown as HarnessEvent);
      } catch { socket.terminate(); }
    });
    socket.on('error', () => { /* close controls recovery; no raw socket errors reach clients */ });
    socket.on('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined; this.connected = false; this.#eventChannelId = undefined; this.#clientChannels.clear();
      if (this.#ping) clearInterval(this.#ping); this.#ping = undefined;
      this.emit('disconnect');
      if (!this.#closed) this.#retry = setTimeout(() => { this.#retry = undefined; this.connect(); }, 1500);
    });
  }
  call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    if (!this.connected) return Promise.reject(new HarnessError('worker_unavailable', '后台尚未连接，请稍后重试。'));
    return this.request('/rpc', { method, params, context: { clientId: context.clientId, ...(context.operationId ? { operationId: context.operationId } : {}), ...(context.gatewayRequestDigest ? { gatewayRequestDigest: context.gatewayRequestDigest } : {}), ...(context.projectId ? { projectId: context.projectId } : {}) } }, () => {
      // Connection establishment can yield after admission, including for reads and live calls.
      context.requireAuthorization?.(); context.requireConnection?.(); context.beforeWrite?.();
    });
  }
  async clientDisconnected(clientId: string): Promise<void> {
    const channelId = this.#clientChannels.get(clientId);
    if (!channelId || channelId !== this.#eventChannelId) { this.#clientChannels.delete(clientId); return; }
    try { await this.request('/disconnect', { clientId }); }
    catch (error) { if (this.#eventChannelId === channelId) this.invalidateConnection(); throw error; }
    finally { this.#clientChannels.delete(clientId); }
  }
  async clientConnected(clientId: string): Promise<void> {
    const channelId = this.#eventChannelId;
    if (channelId) this.#clientChannels.set(clientId, channelId);
    try {
      await this.request('/connect', { clientId });
      if (!this.connected || !channelId || channelId !== this.#eventChannelId) throw new HarnessError('worker_unavailable', '后台连接已更换，请重新连接。');
    } catch (error) {
      // A lost registration response cannot prove the lease was never registered.
      // Closing that exact channel fences a delayed /connect without tombstones.
      if (channelId && this.#eventChannelId === channelId) this.invalidateConnection();
      throw error;
    }
  }
  invalidateConnection(): void { this.connected = false; this.#eventChannelId = undefined; this.#clientChannels.clear(); this.#socket?.terminate(); }
  request(path: string, body: JsonValue, beforeWrite?: () => void): Promise<JsonValue> {
    const channelId = this.#eventChannelId;
    if (!this.connected || !channelId || this.#socket?.readyState !== WebSocket.OPEN) return Promise.reject(new HarnessError('worker_unavailable', '后台事件连接尚未就绪，请稍后重试。'));
    const payload = Buffer.from(JSON.stringify(body));
    if (payload.length > LIMITS.requestBytes) return Promise.reject(new HarnessError('capacity', '请求过大。'));
    return new Promise((resolve, reject) => {
      let wrote = false; let settled = false;
      const finish = (error?: unknown, result?: JsonValue) => {
        if (settled) return; settled = true; clearTimeout(timeout);
        if (error) reject(error); else resolve(result ?? null);
      };
      const req = http.request({
        ...(this.address.socketPath ? { socketPath: this.address.socketPath } : { host: '127.0.0.1', port: this.address.port }),
        path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length,
          'x-harness-event-channel': channelId,
          ...(this.address.token ? { authorization: `Bearer ${this.address.token}` } : {}) },
      }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > LIMITS.responseBytes) { req.destroy(); finish(new HarnessError('worker_capacity', '后台结果超出容量，请检查状态。', wrote ? 'unknown' : 'not_sent')); }
          else chunks.push(chunk);
        });
        res.on('aborted', () => finish(new HarnessError('worker_lost', '后台连接中断，请检查操作结果。', wrote ? 'unknown' : 'not_sent')));
        res.on('error', () => finish(new HarnessError('worker_lost', '后台连接中断。', wrote ? 'unknown' : 'not_sent')));
        res.on('end', () => {
          if (settled) return;
          try {
            const response = safeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), LIMITS.responseBytes); object(response);
            if (response.ok === true && Object.hasOwn(response, 'result')) finish(undefined, response.result);
            else {
              object(response.error); const error = response.error;
              if (typeof error.code !== 'string' || typeof error.message !== 'string') throw new Error('Invalid error');
              const detail = error.data && typeof error.data === 'object' && !Array.isArray(error.data) ? error.data : null;
              const data = (detail?.phase === 'first_turn' || detail?.phase === 'review') && typeof detail.threadId === 'string' && detail.threadId.length > 0 && detail.threadId.length <= 256 && typeof detail.causeCode === 'string' && detail.causeCode.length > 0 && detail.causeCode.length <= 128
                ? { phase: detail.phase, threadId: detail.threadId, causeCode: detail.causeCode } : undefined;
              finish(new HarnessError(error.code.slice(0, 128), error.message.slice(0, 4096), error.delivery === 'not_sent' ? 'not_sent' : 'unknown', data));
            }
          } catch (error) { finish(error instanceof HarnessError && error.delivery === 'unknown' ? error : new HarnessError('worker_protocol', '后台返回不符合协议，结果需要核对。', wrote ? 'unknown' : 'not_sent')); }
        });
      });
      const timeout = setTimeout(() => { req.destroy(); finish(new HarnessError('worker_timeout', '后台确认超时，请核对结果，不要重复提交。', wrote ? 'unknown' : 'not_sent')); }, 350000);
      req.on('error', () => finish(new HarnessError('worker_lost', '后台连接中断，请核对结果。', wrote ? 'unknown' : 'not_sent')));
      req.once('socket', socket => {
        const send = () => {
          if (settled || req.destroyed) return;
          try {
            if (!this.connected || this.#eventChannelId !== channelId || this.#socket?.readyState !== WebSocket.OPEN) throw new HarnessError('worker_unavailable', '后台事件连接已更换，此请求未发送。');
            beforeWrite?.(); wrote = true; req.end(payload);
          }
          catch (error) { req.destroy(); finish(error); }
        };
        if (socket.connecting) socket.once('connect', send); else send();
      });
    });
  }
  close(): void {
    this.#closed = true;
    if (this.#retry) clearTimeout(this.#retry);
    if (this.#ping) clearInterval(this.#ping);
    this.#socket?.terminate(); this.#socket = undefined; this.connected = false; this.#eventChannelId = undefined; this.#clientChannels.clear();
  }
}
