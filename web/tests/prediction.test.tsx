// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { Events } from '../lib/events';
import { PredictionPanel } from '../components/PredictionPanel';
import { useDraft } from '../hooks/useDraft';
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const identity = { threadId: 'thread', sourceTurnId: 'turn', predictionId: 'prediction' };
const completed = { ...identity, state: 'completed', result: { type: 'completed', text: 'Suggested next step' } };
function setup(handler: (call: Call) => unknown = () => undefined) { const calls: Call[] = [], api = new Api(), events = new Events(), insert = vi.fn().mockReturnValue(true); vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init) => { const call: Call = JSON.parse(init.body); calls.push(call); const result = await handler(call) ?? (call.method === 'thread/prediction/request' ? { ...identity, requested: true } : completed); return { ok: true, status: 200, json: async () => ({ ok: true, result }) }; })); const props = { api, events, epoch: 'epoch', threadId: 'thread', sourceTurnId: 'turn', connected: true, enabled: true, draftEmpty: true, onInsert: insert, onChat: vi.fn() }; const view = render(<PredictionPanel {...props}/>); return { calls, props, view, insert, events }; }
const generate = () => fireEvent.click(screen.getByRole('button', { name: '生成下一步建议' }));
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); }); afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('generates only on an explicit action and inserts only after a fresh read without sending a turn', async () => {
  const s = setup(); expect(s.calls).toEqual([]); generate(); await screen.findByText('Suggested next step'); expect(s.insert).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '放入空白编辑框' })); await waitFor(() => expect(s.insert).toHaveBeenCalledWith('Suggested next step', 'turn')); expect(s.calls.filter(c => c.method === 'thread/prediction/request')).toHaveLength(1); expect(s.calls.filter(c => c.method === 'thread/prediction/read')).toHaveLength(2); expect(s.calls.some(c => c.method === 'turn/start')).toBe(false); expect((screen.getByRole('button', { name: '生成下一步建议' }) as HTMLButtonElement).disabled).toBe(true);
});
it('queries the original request after a lost response without regenerating', async () => {
  let id = ''; const s = setup(c => { if (c.method === 'thread/prediction/request') { id = c.operationId!; throw new Error('lost response'); } if (c.method === 'operation/read') return { operationId: id, method: 'thread/prediction/request', state: 'accepted', result: { ...identity, requested: true } }; }); generate(); fireEvent.click(await screen.findByRole('button', { name: '查询原建议请求回执' })); await screen.findByText('Suggested next step'); expect(s.calls.filter(c => c.method === 'thread/prediction/request')).toHaveLength(1); expect(s.insert).not.toHaveBeenCalled();
});
it('uses identity-matched private events and obtains an early result through readback', async () => {
  let finish!: (value: unknown) => void; const s = setup(c => c.method === 'thread/prediction/request' ? new Promise(resolve => { finish = resolve; }) : undefined); generate(); act(() => s.events.publish({ type: 'prediction', data: { ...completed, owned: true } })); expect(screen.queryByText('Suggested next step')).toBeNull(); await act(async () => finish({ ...identity, requested: true })); await screen.findByText('Suggested next step'); act(() => s.events.publish({ type: 'prediction', data: { ...completed, sourceTurnId: 'foreign', owned: true, result: { type: 'completed', text: 'Foreign suggestion' } } })); expect(screen.queryByText('Foreign suggestion')).toBeNull();
});
it('refuses stale sources and protects a draft typed while the placement read is pending', async () => {
  let reads = 0, finish!: (value: unknown) => void; const s = setup(c => c.method === 'thread/prediction/read' && ++reads === 2 ? new Promise(resolve => { finish = resolve; }) : undefined); generate(); await screen.findByText('Suggested next step'); fireEvent.click(screen.getByRole('button', { name: '放入空白编辑框' })); s.view.rerender(<PredictionPanel {...s.props} draftEmpty={false}/>); await act(async () => finish(completed)); expect(s.insert).not.toHaveBeenCalled(); expect(screen.getByText(/未写入编辑框/)).toBeTruthy(); s.view.rerender(<PredictionPanel {...s.props} sourceTurnId="new-turn"/>); expect(screen.getByText(/此建议已过期/)).toBeTruthy(); expect((screen.getByRole('button', { name: '放入空白编辑框' }) as HTMLButtonElement).disabled).toBe(true);
});
it('clears owner results on disconnect and never retries failed or empty suggestions', async () => {
  const s = setup(c => c.method === 'thread/prediction/read' ? { ...identity, state: 'completed', result: { type: 'completed', text: null } } : undefined); generate(); await screen.findByText('原生服务没有返回下一步建议。'); expect((screen.getByRole('button', { name: '生成下一步建议' }) as HTMLButtonElement).disabled).toBe(true); s.view.rerender(<PredictionPanel {...s.props} connected={false}/>); expect(screen.queryByText('原生服务没有返回下一步建议。')).toBeNull(); expect(s.calls.filter(c => c.method === 'thread/prediction/request')).toHaveLength(1);
});
it('preserves per-thread identities across navigation without implicit requests', async () => {
  const s = setup(); generate(); await screen.findByText('Suggested next step'); s.view.rerender(<PredictionPanel {...s.props} threadId="second" sourceTurnId="second-turn"/>); expect(screen.queryByText('Suggested next step')).toBeNull(); s.view.rerender(<PredictionPanel {...s.props}/>); await screen.findByText('Suggested next step'); expect(s.calls.filter(c => c.method === 'thread/prediction/request')).toHaveLength(1);
});
it('does not let an older read downgrade a completed or stale private result', async () => {
  let finish!: (value: unknown) => void, reads = 0;
  const s = setup(c => c.method === 'thread/prediction/read' && ++reads === 1 ? new Promise(resolve => { finish = resolve; }) : undefined);
  generate(); await waitFor(() => expect(s.calls.some(c => c.method === 'thread/prediction/read')).toBe(true));
  act(() => s.events.publish({ type: 'prediction', data: { ...completed, owned: true } })); await screen.findByText('Suggested next step');
  await act(async () => finish({ ...identity, state: 'pending' })); expect(screen.getByText('Suggested next step')).toBeTruthy();
  act(() => s.events.publish({ type: 'prediction', data: { ...identity, state: 'stale', owned: true } })); fireEvent.click(screen.getByRole('button', { name: '读取原建议状态' })); await waitFor(() => expect(reads).toBe(2)); expect(screen.getByText(/此建议已过期/)).toBeTruthy(); expect(screen.queryByText('Suggested next step')).toBeNull();
});
it('atomically rejects inserting over text or context added since a prior render', () => {
  const { result } = renderHook(() => useDraft('thread')); const oldInsert = result.current.insertTextIfEmpty; act(() => result.current.setText('New human draft')); expect(oldInsert('Suggestion')).toBe(false); expect(result.current.text).toBe('New human draft'); act(() => { result.current.setText(''); result.current.setExtraContext([{ label: 'context', text: 'keep' }]); }); expect(result.current.insertTextIfEmpty('Suggestion')).toBe(false); expect(result.current.extraContext).toEqual([{ label: 'context', text: 'keep' }]);
});
