import { randomUUID } from 'node:crypto';
import { DeliveryError, integer, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
import { remoteResponse, type RemoteHost } from './environments.js';
interface Pairing { pairingId: string; clientId: string; eventChannelId: string | undefined; secret: JsonObject; revoked: boolean; timer: NodeJS.Timeout }
/** Native account pairing authorizes clients independently of the browser gateway. */
export class RemoteControl {
  private pairings = new Map<string, Pairing>();
  constructor(private host: RemoteHost) {}
  private pairing(id: JsonValue | undefined, context: CallContext): Pairing { const entry = this.pairings.get(string(id, 'pairingId', 36)); if (!entry || entry.revoked || entry.clientId !== context.clientId || entry.eventChannelId !== context.eventChannelId) throw new DeliveryError('not_found', 'Pairing secret is unavailable for this connection'); return entry; }
  private remove(entry: Pairing): void { clearTimeout(entry.timer); this.pairings.delete(entry.pairingId); }
  private async status(): Promise<JsonObject> { return remoteResponse('RemoteControlStatusReadResponse', await this.host.native('remoteControl/status/read', null), 64 * 1024); }
  async assertDisabledForMaintenance(): Promise<void> {
    if ((await this.status()).status !== 'disabled') throw new DeliveryError('remote_control_active', 'Disable native remote control before journal maintenance');
  }
  private async requireEnvironment(id: JsonValue | undefined): Promise<void> { const status = await this.status(); if (typeof id !== 'string' || status.environmentId !== id) throw new DeliveryError('remote_environment_changed', 'Only the current native remote-control environment may be managed'); }
  async call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    if (method === 'remoteControl/status/read') { onlyKeys(params, []); return this.status(); }
    if (method === 'remoteControl/enable' || method === 'remoteControl/disable') {
      const enabling = method.endsWith('/enable'); onlyKeys(params, enabling ? ['ephemeral', 'confirmExternalAccess'] : ['ephemeral']);
      if (enabling && params.confirmExternalAccess !== true) throw new DeliveryError('confirmation_required', 'Explicit authorization is required for native account clients to access this runtime outside the web gateway');
      const p = { ephemeral: params.ephemeral ?? true }; validateOfficial(enabling ? 'RemoteControlEnableParams' : 'RemoteControlDisableParams', p);
      return this.host.configure(async write => { const result = remoteResponse(enabling ? 'RemoteControlEnableResponse' : 'RemoteControlDisableResponse', await write(method, p), 64 * 1024); if (!enabling) this.reset(); return result; }, context);
    }
    if (method === 'remoteControl/pairing/start') {
      onlyKeys(params, ['manualCode']); validateOfficial('RemoteControlPairingStartParams', params); if (this.pairings.size >= 16) throw new DeliveryError('capacity', 'Pairing retention budget reached');
      return this.host.configure(async write => {
        const status = await this.status(); if (!['connecting', 'connected'].includes(String(status.status))) throw new DeliveryError('remote_disabled', 'Enable remote control explicitly before pairing');
        const pairingId = randomUUID(); const secret = remoteResponse('RemoteControlPairingStartResponse', await write(method, params), 64 * 1024);
        this.host.redactor.addSecret(string(secret.pairingCode, 'pairingCode', 4096)); if (secret.manualPairingCode !== null) this.host.redactor.addSecret(string(secret.manualPairingCode, 'manualPairingCode', 256));
        const expires = integer(secret.expiresAt, 'expiresAt', 1, Number.MAX_SAFE_INTEGER); const expiry = expires < 1000000000000 ? expires * 1000 : expires;
        const timer = setTimeout(() => { this.pairings.delete(pairingId); }, Math.min(600000, Math.max(1, expiry - Date.now()))); timer.unref();
        const entry = { pairingId, secret, clientId: context.clientId, eventChannelId: context.eventChannelId, revoked: false, timer }; this.pairings.set(pairingId, entry);
        // A lease can disappear while the native account service creates the code.
        try { context.beforeWrite?.(); } catch { this.remove(entry); }
        return { pairingId, environmentId: secret.environmentId!, expiresAt: secret.expiresAt! };
      }, context);
    }
    if (method === 'remoteControl/pairing/read' || method === 'remoteControl/pairing/status') {
      onlyKeys(params, ['pairingId']); const entry = this.pairing(params.pairingId, context);
      if (method.endsWith('/read')) return { pairingId: entry.pairingId, ...entry.secret };
      const result = remoteResponse('RemoteControlPairingStatusResponse', await this.host.native(method, { pairingCode: entry.secret.pairingCode! }), 4096); this.pairing(entry.pairingId, context); return result;
    }
    if (method === 'remoteControl/client/list') {
      onlyKeys(params, ['environmentId', 'cursor', 'limit', 'order']); const p = { ...params, limit: params.limit == null ? 50 : integer(params.limit, 'limit', 1, 100) }; if (params.cursor != null) string(params.cursor, 'cursor', 4096);
      validateOfficial('RemoteControlClientsListParams', p); await this.requireEnvironment(params.environmentId); const result = remoteResponse('RemoteControlClientsListResponse', await this.host.native(method, p));
      if (!Array.isArray(result.data) || result.data.length > 100 || (result.nextCursor !== null && (typeof result.nextCursor !== 'string' || Buffer.byteLength(result.nextCursor) > 4096 || result.nextCursor === params.cursor))) throw new DeliveryError('invalid_native_response', 'Remote clients page exceeded its bounds'); return result;
    }
    if (method === 'remoteControl/client/revoke') {
      onlyKeys(params, ['environmentId', 'clientId']); validateOfficial('RemoteControlClientsRevokeParams', params);
      return this.host.configure(async write => { await this.requireEnvironment(params.environmentId); remoteResponse('RemoteControlClientsRevokeResponse', await write(method, params)); return { environmentId: params.environmentId!, clientId: params.clientId!, revoked: true }; }, context);
    }
    throw new DeliveryError('method_not_found', 'Unsupported remote-control workflow');
  }
  disconnect(clientId?: string, channel?: string): void { for (const entry of this.pairings.values()) if ((clientId === undefined || entry.clientId === clientId) && (channel === undefined || entry.eventChannelId === channel)) { entry.revoked = true; this.remove(entry); } }
  reset(): void { for (const entry of this.pairings.values()) this.remove(entry); }
}
