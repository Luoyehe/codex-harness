import { afterEach, expect, test, vi } from 'vitest';
import { Guardian, guardianEvent } from '../../src/runtime/guardian.js';
import { DeliveryError, object, type JsonObject } from '../../src/runtime/types.js';
import type { WorkflowMutation } from '../../src/runtime/workflows.js';
import { receiptResult } from '../../src/gateway/receipt-result.js';
const event: JsonObject = { threadId: 'thread', turnId: 'turn', startedAtMs: 1, completedAtMs: 2, reviewId: 'review', targetItemId: 'item', decisionSource: 'agent', review: { status: 'denied', riskLevel: 'low', userAuthorization: 'low', rationale: 'fixture denial' }, action: { type: 'command', source: 'unifiedExec', command: 'echo fixture', cwd: '/project' } };
const owner = { clientId: 'owner', eventChannelId: 'channel', beforeWrite: () => {} };
function setup() { const sent: WorkflowMutation[] = []; let before: (() => void) | undefined, failure: DeliveryError | undefined; const guardian = new Guardian({ mutate: async (operation, context) => { before?.(); context.beforeWrite?.(); operation.beforeWrite?.(); if (failure) throw failure; sent.push(operation); return operation.project!({}); } }); return { guardian, sent, before: (fn: () => void) => { before = fn; }, fail: (e: DeliveryError) => { failure = e; } }; }
async function capture(guardian: Guardian, notification = event) { guardian.notification('item/autoApprovalReview/completed', notification); return object((object(await guardian.call('thread/guardian/list', { threadId: notification.threadId! }, owner)).data as JsonObject[]).at(-1)); }
afterEach(() => vi.useRealTimers());
test('only native captured denials produce opaque retry capabilities and browser assessments are refused', async () => {
  const { guardian, sent } = setup(); guardian.notification('item/autoApprovalReview/completed', { ...event, review: { ...object(event.review), status: 'approved' } }); expect(await guardian.call('thread/guardian/list', { threadId: 'thread' }, owner)).toEqual({ data: [], captureExhausted: false });
  const row = await capture(guardian); expect(row).toMatchObject({ action: event.action, review: event.review, state: 'available' }); expect(row).not.toHaveProperty('event');
  const params = { threadId: 'thread', approvalId: row.approvalId!, confirm: true };
  await expect(guardian.call('thread/approveGuardianDeniedAction', { ...params, event }, owner)).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(guardian.call('thread/approveGuardianDeniedAction', { ...params, threadId: 'other' }, owner)).rejects.toMatchObject({ code: 'not_found' });
  await expect(guardian.call('thread/approveGuardianDeniedAction', { ...params, confirm: false }, owner)).rejects.toMatchObject({ code: 'confirmation_required' });
  expect(await guardian.call('thread/approveGuardianDeniedAction', params, owner)).toEqual({ threadId: 'thread', approvalId: row.approvalId, registered: true });
  expect(sent[0]).toMatchObject({ mode: 'idle', history: true, directInput: true, invalidateHistory: true, params: { threadId: 'thread', event: { id: 'review', status: 'denied', action: { ...object(event.action), source: 'unified_exec' } } } });
  await expect(guardian.call('thread/approveGuardianDeniedAction', params, owner)).rejects.toMatchObject({ code: 'guardian_already_used' });
});
test('final owner validation and context invalidation occur before dispatch', async () => {
  const first = setup(), row = await capture(first.guardian), params = { threadId: 'thread', approvalId: row.approvalId!, confirm: true };
  await expect(first.guardian.call('thread/approveGuardianDeniedAction', params, { ...owner, beforeWrite: () => { throw new DeliveryError('revoked', 'Owner lost'); } })).rejects.toMatchObject({ code: 'revoked' }); expect(first.sent).toEqual([]);
  first.before(() => first.guardian.notification('turn/started', { threadId: 'thread', turn: { id: 'new-turn' } }));
  await expect(first.guardian.call('thread/approveGuardianDeniedAction', params, owner)).rejects.toMatchObject({ code: 'guardian_context_changed' }); expect(first.sent).toEqual([]);
});
test('unknown registration is never replayed and duplicate events cannot recreate consumed capabilities', async () => {
  const fixture = setup(), row = await capture(fixture.guardian); fixture.fail(new DeliveryError('lost', 'Unknown write', 'unknown'));
  const p = { threadId: 'thread', approvalId: row.approvalId!, confirm: true }; await expect(fixture.guardian.call('thread/approveGuardianDeniedAction', p, owner)).rejects.toMatchObject({ delivery: 'unknown' });
  expect(await capture(fixture.guardian)).toMatchObject({ state: 'unknown', approvalId: row.approvalId }); await expect(fixture.guardian.call('thread/approveGuardianDeniedAction', p, owner)).rejects.toMatchObject({ code: 'guardian_already_used' });
  fixture.guardian.invalidateAll(); fixture.guardian.notification('item/autoApprovalReview/completed', event); expect(object(await fixture.guardian.call('thread/guardian/list', { threadId: 'thread' }, owner)).data).toEqual([]);
});
test('expiry, per-thread retention and changed duplicate event identities fail closed', async () => {
  vi.useFakeTimers(); const { guardian } = setup(), row = await capture(guardian); vi.advanceTimersByTime(600001);
  await expect(guardian.call('thread/approveGuardianDeniedAction', { threadId: 'thread', approvalId: row.approvalId!, confirm: true }, owner)).rejects.toMatchObject({ code: 'not_found' });
  for (let index = 0; index < 12; index++) await capture(guardian, { ...event, reviewId: `review-${index}` });
  expect(object(await guardian.call('thread/guardian/list', { threadId: 'thread' }, owner)).data).toHaveLength(10);
  guardian.notification('item/autoApprovalReview/completed', { ...event, reviewId: 'review-11', action: { ...object(event.action), command: 'changed' } });
  expect(await guardian.call('thread/guardian/list', { threadId: 'thread' }, owner)).toEqual({ data: [], captureExhausted: true });
});
test('fixed action adapter rejects mixed identity keys and receipt contains no command or assessment', () => {
  expect(() => guardianEvent({ ...event, review_id: 'injected' })).toThrow(); expect(() => guardianEvent({ ...event, action: { ...object(event.action), additionalAuthorization: true } })).toThrow();
  expect(receiptResult('thread/approveGuardianDeniedAction', { threadId: 'thread', approvalId: 'approval', registered: true, event })).toEqual({ threadId: 'thread', approvalId: 'approval', registered: true });
});
test('filesystem retry preserves canonical entries and rejects conflicting legacy projections', () => {
  const entries = [{ path: { type: 'path', path: '/fixture' }, access: 'read' }, { path: { type: 'glob_pattern', pattern: '/fixture/**' }, access: 'write' }, { path: { type: 'special', value: { kind: 'tmpdir' } }, access: 'deny' }];
  const notification = { ...event, action: { type: 'requestPermissions', reason: 'fixture', permissions: { network: null, fileSystem: { read: ['/fixture'], write: null, entries, globScanMaxDepth: 2 } } } };
  expect(object(guardianEvent(notification).action).permissions).toEqual({ network: null, file_system: { entries, glob_scan_max_depth: 2 } });
  expect(() => guardianEvent({ ...notification, action: { ...notification.action, permissions: { network: null, fileSystem: { read: ['/different'], write: null, entries } } } })).toThrow('projections disagree');
});
