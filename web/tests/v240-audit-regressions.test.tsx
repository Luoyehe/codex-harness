// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { Events } from '../lib/events';
import { createOperation, listOperations, listOperationHistory, retireOldTerminalHandoffs, updateOperation } from '../lib/operations';
import { EmergencyRecovery } from '../components/EmergencyRecovery';
import { AccountLimits } from '../components/AccountLimits';
import { useWorkflowRevision } from '../hooks/useWorkflow';
import { usePaged } from '../hooks/usePaged';
import { validDateTime } from '../../src/shared/date-time';
import { mediaBytes, mediaMime, mediaImageInfo } from '../lib/media';
import { damagedDrafts, discardDamagedDraft, emptyDraft, listDrafts, readDraft, writeDraft } from '../lib/drafts';
import { persistFileDraft, listFileDrafts, readFileDraft } from '../lib/file-drafts';

beforeEach(() => {
  sessionStorage.clear(); localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const recovery = { restarted: true as const, release: 'a'.repeat(64) };
function apiFixture(result: (method: string, params: Record<string, unknown>) => unknown) {
  const api = new Api(); api.csrf = 'fixture-session';
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const call = JSON.parse(init.body); calls.push(call.method);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: result(call.method, call.params) }) };
  }));
  return { api, calls };
}
it('finishes a persisted successful recovery without re-reading an archived server result', async () => {
  const op = await createOperation('system/recover', {});
  await updateOperation(op.id, 'accepted', undefined, undefined, recovery);
  const s = apiFixture(() => { throw new Error('must not read archived success'); });
  render(<EmergencyRecovery api={s.api} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '查询原恢复回执' }));
  await screen.findByText(/旧执行阻塞已解除/);
  expect(s.calls).toEqual([]); expect(await listOperations()).toEqual([]);
});
it('closes only the known accepted legacy recovery and preserves unknown task records', async () => {
  const task = await createOperation('mcp/oauth', {}); await updateOperation(task.id, 'unknown');
  const op = await createOperation('system/recover', {}); await updateOperation(op.id, 'accepted');
  const s = apiFixture(() => ({ operationId: op.id, scope: `operation:${op.id}`, method: 'operation/archived', state: 'unknown', error: { code: 'operation_archived' } }));
  render(<EmergencyRecovery api={s.api} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '查询原恢复回执' }));
  await screen.findByText(/其他旧操作仍需各自核对/);
  expect((await listOperations()).map(row => row.id)).toEqual([task.id]);
  expect(s.calls).toEqual(['operation/read']);
  expect(screen.getByRole('button', { name: '确认强制停止并恢复' })).toBeTruthy();
});
it('does not use another archived operation as recovery proof', async () => {
  const op = await createOperation('system/recover', {}); await updateOperation(op.id, 'accepted');
  const s = apiFixture(() => ({ operationId: 'foreign', scope: 'operation:foreign', method: 'operation/archived', state: 'unknown', error: { code: 'operation_archived' } }));
  render(<EmergencyRecovery api={s.api} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '查询原恢复回执' }));
  await screen.findByText(/恢复回执身份不匹配/);
  expect((await listOperations()).map(row => row.id)).toEqual([op.id]);
});
it('retires only accepted terminal handoffs from a previous owner without stopping processes', async () => {
  const old = await createOperation('terminal/open', { projectId: 'p', terminalOwner: { clientId: 'c', connectionId: 'old' } });
  await updateOperation(old.id, 'accepted', undefined, { terminalId: 'old-terminal' });
  const active = await createOperation('terminal/open', { projectId: 'p', terminalOwner: { clientId: 'c', connectionId: 'new' } });
  await updateOperation(active.id, 'accepted', undefined, { terminalId: 'active-terminal' });
  const unknown = await createOperation('terminal/open', { projectId: 'p', terminalOwner: { clientId: 'c', connectionId: 'unknown' } });
  await updateOperation(unknown.id, 'unknown');
  const otherTab = await createOperation('terminal/open', { projectId: 'p', terminalOwner: { clientId: 'other-tab', connectionId: 'live' } });
  await updateOperation(otherTab.id, 'accepted', undefined, { terminalId: 'other-terminal' });
  await retireOldTerminalHandoffs({ clientId: 'c', connectionId: 'new' });
  expect((await listOperations()).map(row => row.id).sort()).toEqual([active.id, unknown.id, otherTab.id].sort());
  expect((await listOperationHistory()).history.some(row => row.id === old.id)).toBe(true);
});
it('isolates a broken event subscriber and still delivers lifecycle facts to other owners', () => {
  const events = new Events(), healthy = vi.fn(), diagnostic = vi.fn();
  window.addEventListener('harness-view-error', diagnostic);
  events.subscribe(() => { throw new Error('secret payload'); }); events.subscribe(healthy);
  const event = { type: 'notification' as const, data: { method: 'turn/completed' } };
  events.publish(event);
  expect(healthy).toHaveBeenCalledWith(event); expect(diagnostic).toHaveBeenCalledOnce();
  expect(diagnostic.mock.calls[0]![0]).not.toHaveProperty('detail');
  window.removeEventListener('harness-view-error', diagnostic);
});
it('retains all loaded directory pages through a refresh and updates them atomically', async () => {
  let finish!: (value: unknown) => void;
  const api = { call: vi.fn().mockResolvedValueOnce({ data: [{ id: 'one' }], nextCursor: 'page2' })
    .mockResolvedValueOnce({ data: [{ id: 'two' }], nextCursor: null })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ data: [{ id: 'two', name: 'updated' }], nextCursor: null }) } as unknown as Api;
  const view = renderHook(() => usePaged<{ id: string; name?: string }>(api, 'thread/list', {}, 'project'));
  await waitFor(() => expect(view.result.current.hasMore).toBe(true));
  await act(() => view.result.current.more());
  act(() => view.result.current.refresh());
  expect(view.result.current.items.map(row => row.id)).toEqual(['one', 'two']);
  await act(async () => finish({ data: [{ id: 'one' }], nextCursor: 'page2' }));
  await waitFor(() => expect(view.result.current.items[1]?.name).toBe('updated'));
  expect(api.call).toHaveBeenCalledTimes(4);
});
it('isolates malformed drafts, preserves their bytes and deletes only the reviewed record', () => {
  writeDraft({ ...emptyDraft('good'), text: 'keep' });
  sessionStorage.setItem('harness.draft.v1.bad', '{damaged');
  expect(listDrafts().map(row => row.key)).toEqual(['good']);
  const damaged = damagedDrafts()[0]!; expect(damaged.raw).toBe('{damaged');
  sessionStorage.setItem(damaged.storageKey, '{newer damaged');
  expect(() => discardDamagedDraft(damaged.storageKey, damaged.raw)).toThrow(/已变化/);
  discardDamagedDraft(damaged.storageKey, '{newer damaged');
  expect(readDraft('good').text).toBe('keep');
});
it('does not consume file-draft budget for clean snapshots but retains pending writes', () => {
  const clean = { projectId: 'p', path: 'file.txt', baseRevision: 'a'.repeat(64), baseText: 'same', text: 'same', revision: 'r', updatedAt: 1 };
  persistFileDraft(clean); expect(listFileDrafts()).toEqual([]);
  persistFileDraft({ ...clean, pending: { operationId: 'op', submittedRevision: 'r', submittedText: 'same' } });
  expect(readFileDraft('p', 'file.txt')?.pending?.operationId).toBe('op');
});
it('rejects calendar overflow while accepting leap dates and explicit timezone offsets', () => {
  expect(validDateTime('2026-02-30T12:00:00Z')).toBe(false);
  expect(validDateTime('2024-02-29T12:00:00+08:00')).toBe(true);
  expect(validDateTime('2024-02-29T12:00:00+24:00')).toBe(false);
});
it('distinguishes AAC from MP3, rejects generic video and accepts parameterized audio data', () => {
  expect(mediaMime(new Uint8Array([255, 241, 80, 128, 0, 0, 0]), 'audio')).toBe('audio/aac');
  expect(mediaMime(new Uint8Array([255, 251, 0, 0]), 'audio')).toBe('audio/mpeg');
  expect(() => mediaMime(new TextEncoder().encode('0000ftypisom000000'), 'audio')).toThrow();
  expect([...mediaBytes('data:audio/wav;codecs=pcm;base64,AA==')]).toEqual([0]);
});
it('finds JPEG dimensions past large valid metadata segments', () => {
  const bytes = new Uint8Array(3 * 65537 + 12); bytes.set([255, 216]);
  let offset = 2;
  for (let i = 0; i < 3; i++) { bytes.set([255, 225, 255, 255], offset); offset += 65537; }
  bytes.set([255, 192, 0, 8, 8, 0, 20, 0, 30, 1], offset);
  expect(mediaImageInfo(bytes)).toEqual({ mime: 'image/jpeg', width: 30, height: 20 });
});
it('summarizes available account limits without inventing missing usage or balance', () => {
  render(<AccountLimits value={{ rateLimits: { limitName: 'Plan', primary: { resetsAt: 1 }, credits: { hasCredits: false } } }} />);
  expect(screen.getByText(/用量未提供/)).toBeTruthy();
  expect(screen.queryByText(/已用 0%|点数余额/)).toBeNull();
});

it('filters known foreign workflow receipts but refreshes when receipt ownership is unknown', () => {
  const events = new Events(), view = renderHook(() => useWorkflowRevision(events, 'owned'));
  act(() => events.publish({ type: 'receipt', data: { threadId: 'foreign', state: 'accepted' } }));
  expect(view.result.current.revision).toBe(0);
  act(() => events.publish({ type: 'receipt', data: { threadId: 'owned', state: 'accepted' } }));
  expect(view.result.current.revision).toBe(1);
  act(() => events.publish({ type: 'receipt', data: { state: 'accepted' } }));
  expect(view.result.current.revision).toBe(2);
  act(() => events.publish({ type: 'resync', data: { reason: 'events_lost' } }));
  expect(view.result.current.revision).toBe(3);
});

it('accepts a matching explicit retirement as proof that the recovery was not sent', async () => {
  const op = await createOperation('system/recover', {}); await updateOperation(op.id, 'unknown');
  const s = apiFixture(() => ({ operationId: op.id, method: 'operation/retire', state: 'not_sent' }));
  render(<EmergencyRecovery api={s.api} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '查询原恢复回执' }));
  await screen.findByText(/原恢复请求确认未发送/);
  expect(await listOperations()).toEqual([]); expect(s.calls).toEqual(['operation/read']);
});

it.each([['edu','教育版'],['','未提供'],['futurePlan','未知值（futurePlan）']])('localizes %s in the quota card while preserving the raw response', (planType,label) => {
  render(<AccountLimits value={{rateLimits:{planType}}} />);
  expect(screen.getByText('套餐：'+label)).toBeTruthy();
  expect(document.querySelector('pre')?.textContent).toContain(JSON.stringify(planType));
});
