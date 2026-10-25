import { DeliveryError, jsonBytes, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
import type { NativeOptions } from './native.js';
import type { DiagnosticRedactor } from './redaction.js';

type Native = (method: string, params: JsonValue, options?: NativeOptions) => Promise<JsonValue>;
type Login = { clientId: string; channel?: string | undefined; loginId?: string; dispatched: boolean; revoked: boolean; status: 'pending' | 'completed' | 'failed'; secret?: { userCode: string; verificationUrl: string }; early: Map<string, boolean>; expiresAt: number; timer: NodeJS.Timeout };
function checked(schema: string, result: JsonValue): JsonObject {
  try { jsonBytes(result, 16384); validateOfficial(schema, result); return object(result); }
  catch { throw new DeliveryError('invalid_native_response', 'Native device login response could not be verified', 'unknown'); }
}
/** Device credentials are volatile; the durable receipt contains identity only. */
export class DeviceLogin {
  private current: Login | undefined;
  constructor(private host: { native: Native; redactor: DiagnosticRedactor }) {}
  private owns(login: Login, context: CallContext): boolean { return login.clientId === context.clientId && login.channel === context.eventChannelId; }
  private revoke(login: Login): void { clearTimeout(login.timer); login.revoked = true; delete login.secret; }
  private clear(login: Login): void { this.revoke(login); if (this.current === login) this.current = undefined; }
  private async cancelNative(login: Login, call: Native): Promise<JsonObject> {
    if (!login.loginId) throw new DeliveryError('login_unknown', 'Login identity is unknown; restart the native service before another login', 'unknown');
    const result = checked('CancelLoginAccountResponse', await call('account/login/cancel', { loginId: login.loginId }));
    this.clear(login); return result;
  }
  async start(params: JsonObject, write: Native, context: CallContext): Promise<JsonValue> {
    onlyKeys(params, []);
    if (this.current?.status !== 'pending' && this.current) this.clear(this.current);
    if (this.current) throw new DeliveryError('login_pending', 'A device login is pending or uncertain; inspect its original receipt, cancel it, or restart the native service');
    const timer = setTimeout(() => { void this.disconnect().catch(() => {}); }, 600000); timer.unref();
    const login: Login = { clientId: context.clientId, channel: context.eventChannelId, dispatched: false, revoked: false, status: 'pending', early: new Map(), expiresAt: Date.now() + 600000, timer }; this.current = login;
    try {
      const result = checked('LoginAccountResponse', await write('account/login/start', { type: 'chatgptDeviceCode' }, { beforeWrite: () => {
        if (this.current !== login || login.revoked) throw new DeliveryError('client_disconnected', 'Device login owner disconnected before dispatch');
        login.dispatched = true;
      } }));
      if (result.type !== 'chatgptDeviceCode') throw new DeliveryError('invalid_native_response', 'Device login returned a different authentication method', 'unknown');
      const loginId = string(result.loginId, 'loginId', 256), userCode = string(result.userCode, 'userCode', 1024), verificationUrl = string(result.verificationUrl, 'verificationUrl', 4096);
      this.host.redactor.addSecret(userCode); this.host.redactor.addSecret(verificationUrl);
      let url: URL; try { url = new URL(verificationUrl); } catch { throw new DeliveryError('invalid_native_response', 'Device verification URL is invalid', 'unknown'); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new DeliveryError('invalid_native_response', 'Device verification requires HTTPS without embedded credentials', 'unknown');
      login.loginId = loginId;
      const early = login.early.get(loginId); login.early.clear();
      if (early !== undefined) login.status = early ? 'completed' : 'failed';
      if (login.revoked || this.current !== login) await this.cancelNative(login, this.host.native);
      else if (login.status === 'pending') login.secret = { userCode, verificationUrl };
      else clearTimeout(login.timer);
      return { type: 'chatgptDeviceCode', loginId };
    } catch (error) {
      if (error instanceof DeliveryError && error.delivery === 'not_sent') {
        if (!login.dispatched) this.clear(login);
        else throw new DeliveryError('login_outcome_unknown', 'Device login was dispatched; read the original receipt and do not start a duplicate login', 'unknown');
      }
      throw error;
    }
  }
  read(params: JsonObject, context: CallContext): JsonValue {
    onlyKeys(params, ['loginId']); const loginId = string(params.loginId, 'loginId', 256), login = this.current;
    if (!login || login.revoked || !this.owns(login, context) || login.loginId !== loginId) throw new DeliveryError('not_found', 'Device login handoff is unavailable to this connection');
    return { type: 'chatgptDeviceCode', loginId, status: login.status, expiresAt: login.expiresAt, ...(login.status === 'pending' ? login.secret : {}) };
  }
  async cancel(params: JsonObject, write: Native, context: CallContext): Promise<JsonValue> {
    onlyKeys(params, ['loginId']); const loginId = string(params.loginId, 'loginId', 256), login = this.current;
    if (!login || login.loginId !== loginId || !this.owns(login, context)) throw new DeliveryError('not_found', 'Only the initiating connection can cancel this device login');
    this.revoke(login); return this.cancelNative(login, write);
  }
  async logout(params: JsonObject, write: Native): Promise<JsonValue> {
    onlyKeys(params, []);
    if (this.current?.status === 'pending') throw new DeliveryError('login_pending', 'Cancel or recover the pending login before logging out');
    if (this.current) this.clear(this.current);
    return checked('LogoutAccountResponse', await write('account/logout', null));
  }
  notification(method: string, params: JsonObject): void {
    if (method !== 'account/login/completed') return;
    checked('AccountLoginCompletedNotification', params);
    const login = this.current; if (!login || typeof params.loginId !== 'string') return;
    if (!login.loginId) { if (login.early.size < 32) login.early.set(params.loginId, params.success === true); return; }
    if (params.loginId !== login.loginId) return;
    login.status = params.success === true ? 'completed' : 'failed'; delete login.secret; clearTimeout(login.timer);
  }
  async disconnect(clientId?: string, channel?: string): Promise<void> {
    const login = this.current;
    if (!login || clientId !== undefined && login.clientId !== clientId || channel !== undefined && login.channel !== channel || login.revoked) return;
    this.revoke(login);
    if (!login.dispatched || login.status !== 'pending') { this.clear(login); return; }
    if (login.loginId) try { await this.cancelNative(login, this.host.native); } catch { /* Keep the revoked reservation until cancellation or native restart. */ }
  }
  close(): void { if (this.current) this.clear(this.current); }
}
