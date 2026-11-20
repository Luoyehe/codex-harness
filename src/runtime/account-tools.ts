import { createHash, randomUUID } from 'node:crypto';
import { canonical, DeliveryError, jsonBytes, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
import type { NativeOptions } from './native.js';
import type { DiagnosticRedactor } from './redaction.js';

type Native = (method: string, params: JsonValue, options?: NativeOptions) => Promise<JsonValue>;
interface Host { native: Native; redactor: DiagnosticRedactor; notify?: (method: string, params: JsonObject) => void }
type Login = { handoffId: string; clientId: string; channel: string | undefined; providerId: string; revoked: boolean; dispatched: boolean; observed: boolean; status: string; authUrl?: string; userCode?: string; nativeLoginId?: string; error?: string | undefined; expiresAt: number; timer: NodeJS.Timeout };
const hash = (value: JsonValue) => createHash('sha256').update(canonical(value)).digest('hex');
function checked(schema: string, result: JsonValue): JsonObject { try { jsonBytes(result, 1024 * 1024); validateOfficial(schema, result); return object(result); } catch { throw new DeliveryError('invalid_native_response', 'Native account response could not be verified', 'unknown'); } }
const owns = (login: Login, context: CallContext) => !login.revoked && login.clientId === context.clientId && login.channel === context.eventChannelId;

/** Account-side effects retain native idempotency and private OAuth handoffs. */
export class AccountTools {
  private login: Login | undefined;
  constructor(private host: Host) {}
  private async creditPreview(): Promise<JsonObject> {
    const result = checked('GetAccountRateLimitsResponse', await this.host.native('account/rateLimits/read', {}));
    const summary = result.rateLimitResetCredits == null ? null : object(result.rateLimitResetCredits);
    const value: JsonObject = { accountId: result.accountId ?? null, summary };
    return { ...value, previewHash: hash(value), redeemable: typeof result.accountId === 'string' && result.accountId.length > 0 && summary !== null && typeof summary.availableCount === 'number' && Number.isSafeInteger(summary.availableCount) && summary.availableCount > 0 };
  }
  async read(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    if (method === 'account/resetCredit/preview') { onlyKeys(params, []); return this.creditPreview(); }
    if (method === 'account/gatewayOAuth/read') { onlyKeys(params, []); return { ...checked('GatewayOAuthReadResponse', await this.host.native(method, {})), restartRequired: this.login?.revoked === true }; }
    if (method === 'account/gatewayOAuth/handoff') {
      onlyKeys(params, ['handoffId']); const id = string(params.handoffId, 'handoffId', 36), login = this.login;
      if (!login || login.handoffId !== id || !owns(login, context)) throw new DeliveryError('not_found', 'OAuth handoff is unavailable for this connection');
      return { handoffId: id, providerId: login.providerId, status: login.status, expiresAt: login.expiresAt, ...(login.authUrl ? { authUrl: login.authUrl } : {}), ...(login.userCode ? { userCode: login.userCode } : {}), ...(login.error ? { error: login.error } : {}) };
    }
    throw new DeliveryError('method_not_found', 'Unsupported account read');
  }
  async mutate(method: string, params: JsonObject, write: Native, context: CallContext): Promise<JsonValue> {
    if (method === 'account/sendAddCreditsNudgeEmail') {
      onlyKeys(params, ['previewHash', 'creditType', 'confirm']);
      if (params.confirm !== true) throw new DeliveryError('confirmation_required', 'Explicit confirmation is required to email the current workspace owner');
      const p = { creditType: params.creditType! }; validateOfficial('SendAddCreditsNudgeEmailParams', p);
      const current = await this.creditPreview();
      if (params.previewHash !== current.previewHash || typeof current.accountId !== 'string' || !current.accountId) throw new DeliveryError('account_changed', 'Reload the current account before requesting its workspace owner email');
      let dispatched = false;
      try {
        const result = checked('SendAddCreditsNudgeEmailResponse', await write(method, p, { beforeWrite: () => { dispatched = true; } }));
        return { status: result.status!, accountId: current.accountId, creditType: p.creditType };
      } catch (error) {
        if (dispatched) throw new DeliveryError('email_outcome_unknown', 'Email delivery is uncertain; inspect the original receipt and do not send another request', 'unknown');
        throw error;
      }
    }
    if (method === 'account/resetCredit/consume') {
      onlyKeys(params, ['previewHash', 'creditId', 'confirm']);
      if (params.confirm !== true) throw new DeliveryError('confirmation_required', 'Explicit confirmation is required to spend one reset credit');
      const shown = string(params.previewHash, 'previewHash', 64), current = await this.creditPreview();
      if (shown !== current.previewHash || current.redeemable !== true) throw new DeliveryError('credit_preview_changed', 'Reload the current account and available reset credits before redeeming');
      const id = params.creditId == null ? null : string(params.creditId, 'creditId', 1024), summary = object(current.summary);
      if (id !== null && (!Array.isArray(summary.credits) || !summary.credits.some(value => { const credit = object(value); return credit.id === id && credit.status === 'available' && (credit.expiresAt === null || typeof credit.expiresAt === 'number' && credit.expiresAt * 1000 > Date.now()); }))) throw new DeliveryError('credit_unavailable', 'Select a currently available, unexpired reset credit');
      const p = { idempotencyKey: string(context.operationId, 'operationId', 128), ...(id === null ? {} : { creditId: id }) }; validateOfficial('ConsumeAccountRateLimitResetCreditParams', p);
      const result = checked('ConsumeAccountRateLimitResetCreditResponse', await write('account/rateLimitResetCredit/consume', p));
      return { outcome: result.outcome!, accountId: current.accountId! };
    }
    if (method === 'account/gatewayOAuth/login') {
      onlyKeys(params, ['providerId', 'confirm']); if (params.confirm !== true) throw new DeliveryError('confirmation_required', 'Explicit gateway authorization is required');
      if (this.login) throw new DeliveryError(this.login.revoked ? 'oauth_restart_required' : 'login_pending', this.login.revoked ? 'Restart the native service before starting another OAuth handoff; native notifications have no login identity' : 'Finish or cancel the existing gateway authorization first');
      const providerId = string(params.providerId, 'providerId', 1024);
      const status = checked('GatewayOAuthReadResponse', await this.host.native('account/gatewayOAuth/read', { modelProvider: providerId }));
      if (status.required !== true || status.providerId !== string(params.providerId, 'providerId', 1024)) throw new DeliveryError('gateway_changed', 'Current provider does not match the reviewed OAuth gateway');
      const timer = setTimeout(() => { void this.disconnect().catch(() => {}); }, 10 * 60000); timer.unref();
      const login: Login = { handoffId: randomUUID(), clientId: context.clientId, channel: context.eventChannelId, providerId: String(status.providerId), status: 'started', revoked: false, dispatched: false, observed: false, expiresAt: Date.now() + 10 * 60000, timer }; this.login = login;
      try {
        const response = checked('GatewayOAuthLoginResponse', await write(method, { modelProvider: providerId }, { beforeWrite: () => { if (this.login !== login || login.revoked) throw new DeliveryError('client_disconnected', 'OAuth owner disconnected before login'); login.dispatched = true; } }));
        if (response.prompt !== null) {
          const prompt = object(response.prompt), authUrl = string(prompt.verificationUrl, 'gateway verification URL', 8192), userCode = string(prompt.userCode, 'gateway user code', 256), id = string(prompt.loginId, 'gateway login id', 256);
          this.host.redactor.addSecret(authUrl, login.expiresAt); this.host.redactor.addSecret(userCode, login.expiresAt);
          const url = new URL(authUrl); if (url.protocol !== 'https:' || url.username || url.password) throw new DeliveryError('invalid_native_response', 'Gateway authorization requires an HTTPS URL without embedded credentials', 'unknown');
          if (!login.revoked && this.login === login && login.status !== 'failed' && login.status !== 'succeeded') { if (login.nativeLoginId && login.nativeLoginId !== id) throw new DeliveryError('invalid_native_response', 'Gateway login identity changed', 'unknown'); login.nativeLoginId = id; login.authUrl = authUrl; login.userCode = userCode; }
        }
        return { handoffId: login.handoffId, providerId: login.providerId, started: true };
      } catch (e) {
        if (!login.dispatched && !login.observed && e instanceof DeliveryError && e.delivery === 'not_sent') this.clear(login);
        else if (e instanceof DeliveryError && e.delivery === 'not_sent') throw new DeliveryError('oauth_outcome_unknown', 'OAuth dispatch or notification was observed; read the original receipt and restart the native service before another attempt', 'unknown');
        throw e;
      }
    }
    if (method === 'account/gatewayOAuth/cancel') {
      onlyKeys(params, ['handoffId']); const login = this.login;
      if (!login || login.handoffId !== params.handoffId || !owns(login, context)) throw new DeliveryError('not_found', 'Only this connection can cancel its gateway authorization');
      // Revocation is immediate even if native cancellation becomes uncertain.
      this.revoke(login);
      checked('GatewayOAuthCancelResponse', await write(method, null)); return { handoffId: login.handoffId, cancelled: true };
    }
    throw new DeliveryError('method_not_found', 'Unsupported account change');
  }
  notification(method: string, params: JsonObject): boolean {
    if (method !== 'account/gatewayOAuth/changed') return false;
    checked('GatewayOAuthChangedNotification', params); const login = this.login;
    if (typeof params.authUrl === 'string') this.host.redactor.addSecret(params.authUrl, Date.now() + 600000);
    if (login && !login.revoked && params.providerId === login.providerId && (!login.nativeLoginId || params.loginId === login.nativeLoginId)) {
      if (typeof params.loginId === 'string') login.nativeLoginId = params.loginId;
      login.observed = true;
      login.status = String(params.status); login.error = params.error === null ? undefined : String(this.host.redactor.value(params.error!));
      if (typeof params.authUrl === 'string') {
        let url: URL; try { url = new URL(params.authUrl); } catch { throw new DeliveryError('invalid_native_response', 'Invalid gateway authorization URL', 'unknown'); }
        if (url.protocol !== 'https:' || url.username || url.password) throw new DeliveryError('invalid_native_response', 'Gateway authorization requires an HTTPS URL without embedded credentials', 'unknown');
        this.host.redactor.addSecret(params.authUrl, Date.now() + 600000); login.authUrl = params.authUrl;
      }
      if (login.status === 'failed' || login.status === 'succeeded') { delete login.authUrl; delete login.userCode; }
    }
    // A late native event is never forwarded with its sensitive authorization URL.
    this.host.notify?.(method, { providerId: params.providerId!, status: params.status!, error: params.error === null ? null : this.host.redactor.value(params.error!) });
    return true;
  }
  private clear(login: Login): void { clearTimeout(login.timer); login.revoked = true; delete login.authUrl; delete login.userCode; if (this.login === login) this.login = undefined; }
  private revoke(login: Login): void { clearTimeout(login.timer); login.revoked = true; delete login.authUrl; delete login.userCode; }
  async disconnect(clientId?: string, channel?: string): Promise<void> {
    const login = this.login; if (!login || clientId !== undefined && login.clientId !== clientId || channel !== undefined && login.channel !== channel) return;
    if (login.revoked) return;
    this.revoke(login);
    if (!login.dispatched && !login.observed) { this.clear(login); return; }
    // Browser OAuth can still omit native login IDs. Retain the epoch tombstone
    // after cancellation rather than assigning an uncorrelated late event to a fresh owner.
    try { checked('GatewayOAuthCancelResponse', await this.host.native('account/gatewayOAuth/cancel', null)); }
    catch { /* Runtime restart is required before a new handoff. */ }
  }
  close(): void { if (this.login) this.clear(this.login); }
}
