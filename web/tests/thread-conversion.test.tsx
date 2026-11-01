// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { listOperations, updateOperation } from '../lib/operations';
import { ThreadConversionDialog } from '../components/ThreadConversionDialog';
import { enabledButton } from './enabled-button';
const models = [
  { id: 'a-model', modelProvider: 'a', providerName: 'Alpha', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
  { id: 'b-model', modelProvider: 'b', providerName: 'Beta', supportedReasoningEfforts: [{ reasoningEffort: 'max' }] },
];
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
type Call = { method: string; params: Record<string, unknown>; operationId: string };
function fixture(handler: (call: Call) => unknown = () => ({ thread: { id: 'new-chat' }, sourceThreadId: 'source', sourceProvider: 'a', targetProvider: 'b' })) {
  const api = new Api(), calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const call = JSON.parse(init.body); calls.push(call);
    const result = await handler(call);
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  }));
  const props = { api, threadId: 'source', sourceProvider: 'a', epoch: 'one', models,
    loading: false, onMore: vi.fn(), enabled: true, onBusy: vi.fn(), onCreated: vi.fn(), onClose: vi.fn() };
  const view = render(<ThreadConversionDialog {...props} />);
  return { ...view, props, calls };
}
async function next(provider = 'b', model = 'b-model') {
  fireEvent.change(screen.getByRole('combobox', { name: '目标模型' }), { target: { value: JSON.stringify([provider, model]) } });
  fireEvent.click(await enabledButton({ name: '继续（1/2）' }));
  expect(document.activeElement?.textContent).toContain('第 2/2 步');
}
it.each([1, 2])('cancels step %i without adopting options or creating anything', async step => {
  const f = fixture();
  fireEvent.change(screen.getByRole('combobox', { name: '目标模型' }), { target: { value: JSON.stringify(['b', 'b-model']) } });
  if (step === 2) await next();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(f.props.onClose).toHaveBeenCalledOnce(); expect(f.calls).toEqual([]);
  expect(f.props.onCreated).not.toHaveBeenCalled();
});
it('requires two intentional steps and creates only a new thread with exact selected settings', async () => {
  const f = fixture();
  fireEvent.change(screen.getByRole('combobox', { name: '目标模型' }), { target: { value: JSON.stringify(['b', 'b-model']) } });
  fireEvent.change(screen.getByRole('combobox', { name: '新会话思考强度' }), { target: { value: 'max' } });
  expect(screen.getByRole('option', { name: '最高' })).toBeTruthy();
  fireEvent.click(await enabledButton({ name: '继续（1/2）' }));
  const button = screen.getByRole('button', { name: '创建转换会话（2/2）' });
  expect(document.activeElement?.textContent).toContain('第 2/2 步');
  fireEvent.click(button, { detail: 2 });
  expect(fireEvent.keyDown(button, { key: 'Enter', repeat: true })).toBe(false);
  expect(f.calls).toEqual([]);
  fireEvent.click(button);
  await waitFor(() => expect(f.props.onCreated).toHaveBeenCalledExactlyOnceWith('new-chat'));
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ method: 'thread/convert', params: { threadId: 'source', sourceProvider: 'a', targetProvider: 'b', model: 'b-model', effort: 'max', confirm: true } });
  expect(Object.keys(f.calls[0]!.params).sort()).toEqual(['confirm', 'effort', 'model', 'sourceProvider', 'targetProvider', 'threadId']);
  expect(f.props.onBusy.mock.calls).toEqual([[true], [false]]);
});
it('offers current-provider explicit compatibility copying without inventing ordinary same-provider switching', async () => {
  const f = fixture(); await next('a', 'a-model');
  fireEvent.click(await enabledButton({ name: '创建转换会话（2/2）' }));
  await waitFor(() => expect(f.calls).toHaveLength(1));
  expect(f.calls[0]!.params).toMatchObject({ sourceProvider: 'a', targetProvider: 'a', model: 'a-model' });
});
it('keeps unknown delivery and queries the original receipt without repeating conversion', async () => {
  const f = fixture(call => {
    if (call.method === 'thread/convert') throw new Error('response lost');
    return { operationId: call.params.operationId, method: 'thread/convert', state: 'accepted', result: { threadId: 'confirmed-new-chat' } };
  });
  await next(); fireEvent.click(await enabledButton({ name: '创建转换会话（2/2）' }));
  const query = await screen.findByRole('button', { name: '查询原转换操作回执' });
  expect((await listOperations())[0]?.state).toBe('unknown');
  expect(screen.getByRole('button', { name: '创建转换会话（2/2）' }).matches(':disabled')).toBe(true);
  fireEvent.click(query);
  await waitFor(() => expect(f.props.onCreated).toHaveBeenCalledExactlyOnceWith('confirmed-new-chat'));
  expect(f.calls.map(call => call.method)).toEqual(['thread/convert', 'operation/read']);
  expect(f.calls[1]!.params.operationId).toBe(f.calls[0]!.operationId);
});
it('does not manufacture success from accepted proof missing the new thread identity', async () => {
  const f = fixture(async call => { await updateOperation(call.operationId, 'accepted'); throw new Error('response lost'); });
  await next(); fireEvent.click(await enabledButton({ name: '创建转换会话（2/2）' }));
  await screen.findByRole('alert');
  expect(f.props.onCreated).not.toHaveBeenCalled();
  expect(f.calls).toHaveLength(1);
});
it('rejects a lost target or unavailable source before writing', async () => {
  const f = fixture(); await next();
  f.rerender(<ThreadConversionDialog {...f.props} models={[models[0]!]} />);
  expect(screen.getByRole('button', { name: '创建转换会话（2/2）' }).matches(':disabled')).toBe(true);
  f.rerender(<ThreadConversionDialog {...f.props} enabled={false} />);
  expect(screen.getByRole('button', { name: '创建转换会话（2/2）' }).matches(':disabled')).toBe(true);
  expect(f.calls).toEqual([]);
});
it('retains the receipt but never navigates from a response belonging to the previous thread or epoch', async () => {
  let finish!: (value: unknown) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  await next(); fireEvent.click(await enabledButton({ name: '创建转换会话（2/2）' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  f.rerender(<ThreadConversionDialog {...f.props} threadId="other" epoch="two" />);
  await act(async () => finish({ thread: { id: 'late-new-chat' } }));
  await waitFor(async () => expect((await listOperations())[0]?.state).toBe('accepted'));
  expect(f.props.onCreated).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(1);
});
