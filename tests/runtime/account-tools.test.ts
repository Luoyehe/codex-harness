import { expect, test } from 'vitest';
import { AccountTools } from '../../src/runtime/account-tools.js';
import { DiagnosticRedactor } from '../../src/runtime/redaction.js';
import { DeliveryError, jsonBytes, object, type JsonValue } from '../../src/runtime/types.js';
import type { NativeOptions } from '../../src/runtime/native.js';
const owner = { clientId: 'one', eventChannelId: 'channel', operationId: '00000000-0000-0000-0000-000000000001', beforeWrite: () => {} };
const limits = () => ({ accountId: 'account', ordinaryUsageAllowed: true, rateLimits: { limitId: null, limitName: null, normalModelSlug: null, primary: null, secondary: null, credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null }, rateLimitsByLimitId: null, rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'credit', resetType: 'codexRateLimits', status: 'available', grantedAt: 1, expiresAt: null, title: 'Reset', description: null }] }, rateLimitUpsell: null });
test('workspace owner email requires explicit current-account confirmation and preserves cooldown status', async () => {
  const current = limits(), tools = new AccountTools({ native: async () => current, redactor: new DiagnosticRedactor({}) }), calls: unknown[] = [];
  const preview = object(await tools.read('account/resetCredit/preview', {}, owner));
  const write = async (method: string, params: JsonValue, options?: NativeOptions) => { options?.beforeWrite?.(); calls.push({ method, params }); return { status: 'cooldown_active' }; };
  await expect(tools.mutate('account/sendAddCreditsNudgeEmail', { creditType: 'credits', previewHash: preview.previewHash! }, write, owner)).rejects.toMatchObject({ code: 'confirmation_required' });
  current.accountId = 'changed'; await expect(tools.mutate('account/sendAddCreditsNudgeEmail', { creditType: 'credits', previewHash: preview.previewHash!, confirm: true }, write, owner)).rejects.toMatchObject({ code: 'account_changed' });
  current.accountId = 'account'; expect(await tools.mutate('account/sendAddCreditsNudgeEmail', { creditType: 'usage_limit', previewHash: preview.previewHash!, confirm: true }, write, owner)).toEqual({ status: 'cooldown_active', accountId: 'account', creditType: 'usage_limit' });
  expect(calls).toEqual([{ method: 'account/sendAddCreditsNudgeEmail', params: { creditType: 'usage_limit' } }]); tools.close();
});
test('a dispatched email with an uncertain native error cannot be classified safe to send again', async () => {
  const tools = new AccountTools({ native: async () => limits(), redactor: new DiagnosticRedactor({}) }), preview = object(await tools.read('account/resetCredit/preview', {}, owner));
  await expect(tools.mutate('account/sendAddCreditsNudgeEmail', { creditType: 'credits', previewHash: preview.previewHash!, confirm: true }, async (_method, _params, options) => { options?.beforeWrite?.(); throw new DeliveryError('native_error', 'lost acknowledgement', 'not_sent'); }, owner)).rejects.toMatchObject({ code: 'email_outcome_unknown', delivery: 'unknown' }); tools.close();
});
test('credit redemption binds a fresh account and exact credit to the original durable operation identity', async () => {
  const current = limits(), writes: unknown[] = [];
  const tools = new AccountTools({ native: async () => current, redactor: new DiagnosticRedactor({}) }); const write = async (method: string, params: JsonValue) => { writes.push({ method, params }); return { outcome: 'reset' }; };
  const shown = object(await tools.read('account/resetCredit/preview', {}, owner));
  await expect(tools.mutate('account/resetCredit/consume', { previewHash: shown.previewHash!, creditId: 'credit' }, write, owner)).rejects.toMatchObject({ code: 'confirmation_required' });
  await expect(tools.mutate('account/resetCredit/consume', { previewHash: shown.previewHash!, creditId: 'invented', confirm: true }, write, owner)).rejects.toMatchObject({ code: 'credit_unavailable' });
  current.accountId = 'another'; await expect(tools.mutate('account/resetCredit/consume', { previewHash: shown.previewHash!, creditId: 'credit', confirm: true }, write, owner)).rejects.toMatchObject({ code: 'credit_preview_changed' });
  current.accountId = 'account'; expect(await tools.mutate('account/resetCredit/consume', { previewHash: shown.previewHash!, creditId: 'credit', confirm: true }, write, owner)).toEqual({ outcome: 'reset', accountId: 'account' });
  expect(writes).toEqual([{ method: 'account/rateLimitResetCredit/consume', params: { idempotencyKey: owner.operationId, creditId: 'credit' } }]);
});
test('unavailable account identity cannot authorize consuming a credit', async () => {
  const current = { ...limits(), accountId: null }, tools = new AccountTools({ native: async () => current, redactor: new DiagnosticRedactor({}) });
  const shown = object(await tools.read('account/resetCredit/preview', {}, owner)); expect(shown.redeemable).toBe(false);
  await expect(tools.mutate('account/resetCredit/consume', { previewHash: shown.previewHash!, confirm: true }, async () => { throw new Error('must not dispatch'); }, owner)).rejects.toMatchObject({ code: 'credit_preview_changed' });
});
test.each(['omitted', 'null'])('missing account credit metadata (%s) yields a serializable unavailable preview and cannot spend or email', async mode => {
  const current = { rateLimits: limits().rateLimits, ...(mode === 'null' ? { accountId: null, rateLimitResetCredits: null } : {}) };
  const tools = new AccountTools({ native: async () => current, redactor: new DiagnosticRedactor({}) });
  try {
    const shown = object(await tools.read('account/resetCredit/preview', {}, owner));
    expect(JSON.parse(jsonBytes(shown))).toMatchObject({ accountId: null, summary: null, redeemable: false });
    const write = async () => { throw new Error('Unavailable account must not dispatch'); };
    await expect(tools.mutate('account/resetCredit/consume', { previewHash: shown.previewHash!, confirm: true }, write, owner)).rejects.toMatchObject({ code: 'credit_preview_changed' });
    await expect(tools.mutate('account/sendAddCreditsNudgeEmail', { previewHash: shown.previewHash!, creditType: 'credits', confirm: true }, write, owner)).rejects.toMatchObject({ code: 'account_changed' });
  } finally { tools.close(); }
});
function gateway() {
  const notifications: unknown[] = [], calls: unknown[] = []; let failCancel = false;
  const native = async (method: string, params: JsonValue, options?: NativeOptions): Promise<JsonValue> => { options?.beforeWrite?.(); calls.push({ method, params }); if (method === 'account/gatewayOAuth/read') return { providerId: 'enterprise', providerName: 'Enterprise', required: true, status: 'notReady', error: null }; if (method.endsWith('/cancel') && failCancel) throw new DeliveryError('transport', 'lost', 'unknown'); return {}; };
  const tools = new AccountTools({ native, redactor: new DiagnosticRedactor({}), notify: (method, params) => notifications.push({ method, params }) });
  return { tools, native, notifications, calls, fail: () => { failCancel = true; } };
}
test('early OAuth links remain private to one owner and are removed from public notifications and receipts', async () => {
  const { tools, native, notifications } = gateway();
  const result = object(await tools.mutate('account/gatewayOAuth/login', { providerId: 'enterprise', confirm: true }, async (method, params, options) => { const result = await native(method, params, options); tools.notification('account/gatewayOAuth/changed', { providerId: 'enterprise', status: 'started', error: null, authUrl: 'https://auth.example/authorize?state=private' }); return result; }, owner));
  expect(JSON.stringify(result)).not.toContain('private'); expect(JSON.stringify(notifications)).not.toContain('private');
  expect(await tools.read('account/gatewayOAuth/handoff', { handoffId: result.handoffId! }, owner)).toMatchObject({ authUrl: 'https://auth.example/authorize?state=private' });
  await expect(tools.read('account/gatewayOAuth/handoff', { handoffId: result.handoffId! }, { ...owner, clientId: 'other' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(tools.read('account/gatewayOAuth/handoff', { handoffId: result.handoffId! }, { ...owner, eventChannelId: 'other' })).rejects.toMatchObject({ code: 'not_found' });
  await tools.disconnect(owner.clientId, owner.eventChannelId);
  await expect(tools.read('account/gatewayOAuth/handoff', { handoffId: result.handoffId! }, owner)).rejects.toMatchObject({ code: 'not_found' });
  tools.notification('account/gatewayOAuth/changed', { providerId: 'enterprise', status: 'started', error: null, authUrl: 'https://auth.example/late?code=private' }); expect(JSON.stringify(notifications)).not.toContain('private'); tools.close();
});
test('uncertain cancellation prevents assigning a late login to a new browser owner', async () => {
  const { tools, native, fail } = gateway(); await tools.mutate('account/gatewayOAuth/login', { providerId: 'enterprise', confirm: true }, native, owner); fail(); await tools.disconnect(owner.clientId, owner.eventChannelId);
  await expect(tools.mutate('account/gatewayOAuth/login', { providerId: 'enterprise', confirm: true }, native, { ...owner, clientId: 'other' })).rejects.toMatchObject({ code: 'oauth_restart_required' }); tools.close();
});

test('confirmed cancellation still cannot attribute an uncorrelated late native link to a fresh owner', async () => {
  const { tools, native, notifications } = gateway();
  const result = object(await tools.mutate('account/gatewayOAuth/login', { providerId: 'enterprise', confirm: true }, native, owner));
  await tools.mutate('account/gatewayOAuth/cancel', { handoffId: result.handoffId! }, native, owner);
  tools.notification('account/gatewayOAuth/changed', { providerId: 'enterprise', status: 'started', error: null, authUrl: 'https://auth.example/late?state=private' });
  expect(JSON.stringify(notifications)).not.toContain('private');
  await expect(tools.read('account/gatewayOAuth/handoff', { handoffId: result.handoffId! }, owner)).rejects.toMatchObject({ code: 'not_found' });
  expect(await tools.read('account/gatewayOAuth/read', {}, owner)).toMatchObject({ restartRequired: true });
  await expect(tools.mutate('account/gatewayOAuth/login', { providerId: 'enterprise', confirm: true }, native, { ...owner, clientId: 'other' })).rejects.toMatchObject({ code: 'oauth_restart_required' }); tools.close();
});

test('an early OAuth event followed by an RPC rejection is unknown, never a safe retry', async () => {
  const { tools, native } = gateway();
  await expect(tools.mutate('account/gatewayOAuth/login', { providerId: 'enterprise', confirm: true }, async (method, params, options) => {
    await native(method, params, options);
    tools.notification('account/gatewayOAuth/changed', { providerId: 'enterprise', status: 'started', error: null, authUrl: 'https://auth.example/authorize?state=private' });
    throw new DeliveryError('native_error', 'login rejected', 'not_sent');
  }, owner)).rejects.toMatchObject({ code: 'oauth_outcome_unknown', delivery: 'unknown' });
  await expect(tools.mutate('account/gatewayOAuth/login', { providerId: 'enterprise', confirm: true }, native, owner)).rejects.toMatchObject({ code: 'login_pending' }); tools.close();
});
test('disconnection while login is queued prevents later native dispatch', async () => {
  const { tools, native, calls } = gateway(); let release!: () => void, queued!: () => void; const ready = new Promise<void>(resolve => { queued = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const start = tools.mutate('account/gatewayOAuth/login', { providerId: 'enterprise', confirm: true }, async (method, params, options) => { queued(); await held; return native(method, params, options); }, owner);
  const outcome = expect(start).rejects.toMatchObject({ code: 'client_disconnected' }); await ready; await tools.disconnect(owner.clientId, owner.eventChannelId); release(); await outcome; expect(calls.some(value => object(value).method === 'account/gatewayOAuth/login')).toBe(false); tools.close();
});
