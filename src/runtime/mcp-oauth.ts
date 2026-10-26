import { randomUUID } from 'node:crypto';
import { DeliveryError, jsonBytes, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
import type { NativeOptions } from './native.js';
import type { DiagnosticRedactor } from './redaction.js';

type Write = (method: string, params: JsonValue, options?: NativeOptions) => Promise<JsonValue>;
type Login = {
  handoffId: string; name: string; threadId: string | null; clientId: string; channel: string;
  loginId?: string; responded: boolean; dispatched: boolean; revoked: boolean;
  status: 'pending' | 'completed' | 'failed'; authorizationUrl?: string;
  expiresAt: number; timer: NodeJS.Timeout; early: Map<string | null, boolean>;
};
const TTL = 10 * 60 * 1000;
const MAX_LOGINS = 32;
function checked(schema: string, value: JsonValue): JsonObject {
  try { jsonBytes(value, 16384); validateOfficial(schema, value); return object(value); }
  catch { throw new DeliveryError('invalid_native_response', 'MCP OAuth response could not be verified', 'unknown'); }
}
/** No native cancellation exists. Revoking a URL does not prove its login ended. */
export class McpOauth {
  private logins = new Map<string, Login>();
  private closed = false;
  constructor(private host: { epoch: string; redactor: DiagnosticRedactor; notify: (params: JsonObject, channel: string) => void }) {}
  private key(name: string, threadId: string | null): string { return JSON.stringify([name, threadId]); }
  private identity(login: Login): JsonObject { return { handoffId: login.handoffId, epoch: this.host.epoch, name: login.name, threadId: login.threadId }; }
  private revoke(login: Login): void { login.revoked = true; delete login.authorizationUrl; clearTimeout(login.timer); }
  private finish(login: Login, success: boolean): void {
    login.status = success ? 'completed' : 'failed'; delete login.authorizationUrl; clearTimeout(login.timer);
    this.host.notify({ ...this.identity(login), clientId: login.clientId, success, restartRequired: !login.loginId }, login.channel);
  }
  async start(params: JsonObject, write: Write, context: CallContext): Promise<JsonValue> {
    onlyKeys(params, ['name', 'threadId', 'clientRegistration', 'scopes', 'timeoutSecs']);
    jsonBytes(params, 16384); validateOfficial('McpServerOauthLoginParams', params);
    const name = string(params.name, 'MCP server name', 256);
    const threadId = params.threadId == null ? null : string(params.threadId, 'threadId', 256);
    const channel = string(context.eventChannelId, 'event channel', 256);
    if (this.closed) throw new DeliveryError('runtime_unavailable', 'MCP OAuth runtime closed');
    const key = this.key(name, threadId), prior = this.logins.get(key);
    if (prior && (prior.status === 'pending' || !prior.responded || !prior.loginId))
      throw new DeliveryError('login_pending', 'Original MCP login is pending or uncertain; read its original receipt and server status, or explicitly restart the runtime before another login');
    // Only a correlated terminal notification permits replacement. Pending and
    // older no-loginId attempts keep bounded reservations even after URL expiry.
    if (prior) { this.revoke(prior); this.logins.delete(key); }
    if (this.logins.size >= MAX_LOGINS) for (const [oldKey, old] of this.logins) {
      if (old.responded && old.loginId && old.status !== 'pending') { this.revoke(old); this.logins.delete(oldKey); break; }
    }
    if (this.logins.size >= MAX_LOGINS) throw new DeliveryError('capacity', 'MCP OAuth handoff capacity reached; finish pending logins or explicitly restart the runtime');
    const expiresAt = Date.now() + Math.min(TTL, typeof params.timeoutSecs === 'number' ? params.timeoutSecs * 1000 : TTL);
    const login: Login = { handoffId: randomUUID(), name, threadId, clientId: context.clientId, channel, responded: false, dispatched: false, revoked: false, status: 'pending', expiresAt,
      timer: setTimeout(() => this.revoke(login), Math.max(0, expiresAt - Date.now())), early: new Map() };
    login.timer.unref(); this.logins.set(key, login);
    try {
      const result = checked('McpServerOauthLoginResponse', await write('mcpServer/oauth/login', params, { beforeWrite: () => {
        if (this.closed || login.revoked || this.logins.get(key) !== login || Date.now() >= login.expiresAt) throw new DeliveryError('client_disconnected', 'MCP login owner or handoff expired before dispatch');
        login.dispatched = true;
      } }));
      if (result.loginId != null) login.loginId = string(result.loginId, 'loginId', 256);
      const url = string(result.authorizationUrl, 'authorizationUrl', 8192);
      this.host.redactor.addSecret(url);
      let parsed: URL; try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Unsafe authorization URL');
      login.responded = true;
      const early = login.early.get(login.loginId ?? null); login.early.clear();
      if (early !== undefined) this.finish(login, early);
      if (!this.closed && !login.revoked && this.logins.get(key) === login && Date.now() < login.expiresAt && login.status === 'pending') login.authorizationUrl = url;
      return this.identity(login);
    } catch (error) {
      if (!login.dispatched && error instanceof DeliveryError && error.delivery === 'not_sent') {
        this.revoke(login); if (this.logins.get(key) === login) this.logins.delete(key); throw error;
      }
      this.revoke(login);
      // Never persist native error text: it can echo the authorization URL.
      throw new DeliveryError('login_outcome_unknown', 'MCP login may have started; inspect its original receipt and server status or explicitly restart the runtime. Do not repeat the login', 'unknown');
    }
  }
  read(params: JsonObject, context: CallContext): JsonValue {
    onlyKeys(params, ['handoffId', 'epoch']);
    const handoffId = string(params.handoffId, 'handoffId', 256), epoch = string(params.epoch, 'epoch', 256);
    const login = [...this.logins.values()].find(item => item.handoffId === handoffId);
    if (this.closed || epoch !== this.host.epoch || !login || login.clientId !== context.clientId || login.channel !== context.eventChannelId)
      throw new DeliveryError('not_found', 'MCP authorization handoff is unavailable to this connection; inspect the original receipt and server status before explicit runtime recovery');
    if (Date.now() >= login.expiresAt) this.revoke(login);
    return { ...this.identity(login), status: login.status, expiresAt: login.expiresAt,
      unavailable: login.revoked || !login.authorizationUrl,
      restartRequired: login.status === 'pending' && login.revoked || !login.loginId,
      ...(!login.revoked && login.authorizationUrl ? { authorizationUrl: login.authorizationUrl } : {}) };
  }
  notification(method: string, params: JsonObject): boolean {
    if (method !== 'mcpServer/oauthLogin/completed') return false;
    // Consume malformed and uncorrelated native messages without exposing their
    // free-form error text or allowing them to retire another login's reservation.
    let value: JsonObject; try { value = checked('McpServerOauthLoginCompletedNotification', params); } catch { return true; }
    const login = this.logins.get(this.key(String(value.name), value.threadId as string | null));
    if (!login || this.closed || !login.dispatched || login.status !== 'pending') return true;
    const loginId = typeof value.loginId === 'string' ? value.loginId : null;
    if (!login.responded) { if (login.early.size < 16) login.early.set(loginId, value.success === true); return true; }
    if (loginId === (login.loginId ?? null)) this.finish(login, value.success === true);
    return true;
  }
  disconnect(clientId?: string, channel?: string): void {
    for (const login of this.logins.values()) if ((clientId === undefined || clientId === login.clientId) && (channel === undefined || channel === login.channel)) this.revoke(login);
  }
  close(): void { this.closed = true; for (const login of this.logins.values()) this.revoke(login); this.logins.clear(); }
}
