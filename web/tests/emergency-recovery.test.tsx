// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { createOperation, listOperations, updateOperation } from '../lib/operations';
import { EmergencyRecovery } from '../components/EmergencyRecovery';
import { AdminSettings } from '../components/AdminSettings';

type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const success = { restarted: true, release: 'a'.repeat(64) };
function setup(handle: (call: Call) => unknown = () => success) {
  const api = new Api(); api.csrf = 'fixture-session';
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init) => {
    const call = JSON.parse(init.body) as Call; calls.push(call);
    const value = await handle(call);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: value }) };
  }));
  return { api, calls };
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('requires explicit confirmation but is available with an unrelated unknown MCP request', async () => {
  const old = await createOperation('mcp/oauth', {}); await updateOperation(old.id, 'unknown');
  const s = setup(call => call.method === 'system/recover' ? success
    : { operationId: old.id, method: 'mcp/oauth', state: 'unknown' });
  const close = vi.fn(); render(<EmergencyRecovery api={s.api} onClose={close} />);
  expect(s.calls).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: '确认强制停止并恢复' }));
  await screen.findByText(/旧执行阻塞已解除/);
  expect(s.calls).toHaveLength(2);
  expect(s.calls[0]).toMatchObject({ method: 'system/recover', params: { confirmStop: true } });
  expect((await listOperations()).find(row => row.id === old.id)).toBeUndefined();
  expect(screen.queryByRole('button', { name: '确认强制停止并恢复' })).toBeNull();
});

it('retains a lost recovery response and only queries that original identity after reopening', async () => {
  const old = await createOperation('mcp/oauth', {}); await updateOperation(old.id, 'unknown');
  let id = '';
  const s = setup(call => {
    if (call.method === 'system/recover') { id = call.operationId!; throw new Error('lost response'); }
    return call.params.operationId === old.id
      ? { operationId: old.id, method: old.method, state: 'unknown' }
      : { operationId: id, method: 'system/recover', state: 'accepted', result: success };
  });
  const view = render(<EmergencyRecovery api={s.api} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '确认强制停止并恢复' }));
  await screen.findByText(/连接可能因恢复操作断开/);
  expect((await listOperations()).find(row => row.id === id)?.state).toBe('unknown');
  // A replacement Api simulates a reload: only the durable operation journal survives.
  view.unmount(); const reloaded = new Api(); reloaded.csrf = 'fixture-session';
  render(<EmergencyRecovery api={reloaded} onClose={vi.fn()} />);
  const read = await screen.findByRole('button', { name: '查询原恢复回执' });
  expect(screen.queryByRole('button', { name: '确认强制停止并恢复' })).toBeNull();
  fireEvent.click(read); await screen.findByText(/旧执行阻塞已解除/);
  expect(s.calls.filter(call => call.method === 'system/recover')).toHaveLength(1);
  expect(s.calls.filter(call => call.method === 'operation/read').map(call => call.params.operationId)).toEqual([id, old.id]);
  expect(await listOperations()).toEqual([]);
});

it('does not infer failure or resubmit when the recovery receipt is temporarily absent', async () => {
  const old = await createOperation('system/recover', {}); await updateOperation(old.id, 'unknown');
  const s = setup(() => ({ operationId: old.id, state: 'not_received' }));
  render(<EmergencyRecovery api={s.api} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '查询原恢复回执' }));
  await screen.findByText(/恢复结果尚未确认/);
  expect(screen.queryByRole('button', { name: '确认强制停止并恢复' })).toBeNull();
  expect(s.calls.map(call => call.method)).toEqual(['operation/read']);
});

it.each(['response', 'receipt'] as const)('frees the reserved slot only after explicit not_sent from %s at full ordinary capacity', async mode => {
  for (let i = 0; i < 200; i++) await createOperation('turn/start', { threadId: `held-${i}` });
  const old = mode === 'receipt' ? await createOperation('system/recover', {}) : undefined;
  if (old) await updateOperation(old.id, 'unknown');
  const api = new Api(); api.csrf = 'fixture-session';
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const call = JSON.parse(init.body) as Call; calls.push(call);
    return call.method === 'operation/read'
      ? { ok: true, status: 200, json: async () => ({ ok: true, result: { operationId: old!.id, method: 'system/recover', state: 'not_sent' } }) }
      : { ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'busy', message: 'fixture busy before dispatch', delivery: 'not_sent' } }) };
  }));
  render(<EmergencyRecovery api={api} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: mode === 'receipt' ? '查询原恢复回执' : '确认强制停止并恢复' }));
  await waitFor(async () => expect(await listOperations()).toHaveLength(200));
  fireEvent.click(await screen.findByRole('button', { name: '确认强制停止并恢复' }));
  await waitFor(() => expect(calls.filter(call => call.method === 'system/recover')).toHaveLength(mode === 'response' ? 2 : 1));
  await waitFor(async () => expect(await listOperations()).toHaveLength(200));
  expect(screen.queryByText(/恢复记录已达到 200 条上限/)).toBeNull();
});

it('closing during durable admission prevents the unsent recovery from dispatching', async () => {
  const s = setup();
  // Unmount before the awaited local operation read returns to the event handler.
  const view = render(<EmergencyRecovery api={s.api} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '确认强制停止并恢复' }));
  view.unmount();
  await act(async () => { await listOperations(); });
  expect(s.calls).toEqual([]);
});

it('closes a durable local pre-dispatch not_sent after reopening without requiring a server receipt', async () => {
  for (let i = 0; i < 200; i++) await createOperation('turn/start', { threadId: `unsent-${i}` });
  const s = setup();
  const attempt = s.api.beginMutation('system/recover', { confirmStop: true }, () => { throw new Error('owner closed before dispatch'); });
  await expect(attempt.result).rejects.toMatchObject({ delivery: 'not_sent' });
  expect(await listOperations()).toHaveLength(201); expect(s.calls).toEqual([]);
  const reloaded = new Api(); reloaded.csrf = 'fixture-session';
  render(<EmergencyRecovery api={reloaded} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '关闭未发送记录' }));
  await screen.findByText(/已关闭本地记录/);
  expect(await listOperations()).toHaveLength(200);
  expect(s.calls).toEqual([]);
  expect(screen.getByRole('button', { name: '确认强制停止并恢复' }).hasAttribute('disabled')).toBe(false);
});

it('offers emergency recovery in service settings even while the normal activity gate is closed', async () => {
  const onRecover = vi.fn();
  const api = { call: vi.fn().mockResolvedValue({}) } as unknown as Api;
  render(<AdminSettings api={api} epoch="blocked" configurationReady={false} onRecover={onRecover} />);
  const button = screen.getByRole('button', { name: '强制停止并恢复' });
  expect(button.hasAttribute('disabled')).toBe(false);
  fireEvent.click(button); expect(onRecover).toHaveBeenCalledOnce();
  await waitFor(() => expect(api.call).toHaveBeenCalled());
});
