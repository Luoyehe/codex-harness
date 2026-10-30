// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ModelDirectoryContext, useModelDirectory } from '../hooks/useModelDirectory';
import { usePaged } from '../hooks/usePaged';
import { ConfigSettings } from '../components/ConfigSettings';
import { ModelCatalog } from '../components/ModelCatalog';
import type { Api } from '../lib/api';
import type { Model } from '../lib/types';
import { emptyDraft, writeDraft } from '../lib/drafts';

vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
const models: Model[] = [
  { id: 'shared', model: 'shared', modelProvider: 'alpha', displayName: 'Alpha model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
  { id: 'shared', model: 'shared', modelProvider: 'beta', displayName: 'Beta model', supportedReasoningEfforts: [{ reasoningEffort: 'max' }] },
];
const page = (data: Model[]) => ({ data, nextCursor: null });
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); history.replaceState({}, '', '/');
  HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  HTMLDialogElement.prototype.close = function() { this.open = false; };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shares a single directory across configuration and provider views, including their read-only refresh', async () => {
  let rows = models;
  const api = { csrf: 'fixture', call: vi.fn(async (method: string) => {
    if (method === 'model/list') return page(rows);
    if (method === 'settings/read') return { config: { model: 'shared', model_provider: 'beta' }, editableKeys: [], userVersion: 'v1' };
    return { data: [], requirements: {} };
  }), mutate: vi.fn() } as unknown as Api;
  function Consumer() {
    const directory = useModelDirectory(api, 'third-consumer');
    return <output aria-label="Shared directory">{directory.items.map(row => row.modelProvider).join(',')}</output>;
  }
  function Host({ projectId }: { projectId: string }) {
    const directory = usePaged<Model>(api, 'model/list', {}, 'runtime:one');
    return <ModelDirectoryContext.Provider value={{ api, csrf: api.csrf, directory }}>
      <Consumer />
      <section aria-label="Config"><ConfigSettings api={api} project={{ id: projectId, name: 'Project', cwd: '/fixture' }} epoch="one" enabled onChanged={vi.fn()} /></section>
      <section aria-label="Provider"><ModelCatalog api={api} provider={{ kind: 'chatgpt', providerId: 'beta', modelProvider: 'beta', revision: 'v1' }} onApplied={vi.fn()} /></section>
    </ModelDirectoryContext.Provider>;
  }
  const view = render(<Host projectId="p" />);
  const config = within(screen.getByRole('region', { name: 'Config' }));
  const provider = within(screen.getByRole('region', { name: 'Provider' }));
  await waitFor(() => expect(within(config.getByRole('combobox', { name: /^推理强度/ })).getByRole('option', { name: 'max' })).toBeTruthy());
  expect(provider.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByLabelText('Shared directory').textContent).toBe('alpha,beta');
  expect(vi.mocked(api.call).mock.calls.filter(call => call[0] === 'model/list')).toHaveLength(1);
  view.rerender(<Host projectId="q" />);
  await waitFor(() => expect(api.call).toHaveBeenCalledWith('settings/read', { projectId: 'q' }, expect.any(AbortSignal)));
  expect(vi.mocked(api.call).mock.calls.filter(call => call[0] === 'model/list')).toHaveLength(1);
  rows = [models[0]!];
  fireEvent.click(provider.getByRole('button', { name: '重新读取模型目录' }));
  await waitFor(() => expect(screen.getByLabelText('Shared directory').textContent).toBe('alpha'));
  expect(provider.queryAllByRole('listitem')).toHaveLength(0);
  expect(within(config.getByRole('combobox', { name: /^推理强度/ })).queryByRole('option', { name: 'max' })).toBeNull();
  expect(vi.mocked(api.call).mock.calls.filter(call => call[0] === 'model/list')).toHaveLength(2);
  expect(api.mutate).not.toHaveBeenCalled();
});

it('keeps each chat selection while switching projects and invalidates the shared catalog on account and runtime changes', async () => {
  sessionStorage.setItem('harness.project', 'p'); history.replaceState({}, '', '/?thread=ta');
  writeDraft({ ...emptyDraft('ta'), text: 'draft alpha', options: { model: 'shared', modelProvider: 'alpha', effort: 'high' } });
  writeDraft({ ...emptyDraft('tb'), text: 'draft beta', options: { model: 'shared', modelProvider: 'beta', effort: 'max' } });
  const sockets: any[] = [], calls: { method: string; params: Record<string, unknown>; operationId?: string }[] = [];
  let finishBeta!: () => void, waitBeta = true, rows = models;
  const threads = { ta: { id: 'ta', name: 'Chat Alpha', cwd: '/p' }, tb: { id: 'tb', name: 'Chat Beta', cwd: '/q' } };
  vi.stubGlobal('WebSocket', class { onopen = () => {}; onclose = () => {}; onmessage = (_: any) => {}; close() {} constructor() { sockets.push(this); } });
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (url === '/api/session') return { status: 200, ok: true, json: async () => ({ authenticated: true, csrf: 'fixture', operationRecoveryProtocol: 2 }) };
    const call = JSON.parse(init.body); calls.push(call); let result: unknown = { data: [], nextCursor: null };
    const thread = threads[call.params.threadId as keyof typeof threads];
    switch (call.method) {
      case 'project/list': result = { projects: [{ id: 'p', name: 'Project Alpha', path: '/p' }, { id: 'q', name: 'Project Beta', path: '/q' }] }; break;
      case 'thread/list': result = { data: [call.params.projectId === 'q' ? threads.tb : threads.ta], nextCursor: null }; break;
      case 'model/list': result = page(rows); break;
      case 'defaults/read': result = { model: 'shared', modelProvider: call.params.projectId === 'q' ? 'beta' : 'alpha' }; break;
      case 'prompt/list': result = { prompts: [] }; break;
      case 'thread/read': result = { thread }; break;
      case 'thread/session':
        if (call.params.threadId === 'tb' && waitBeta) await new Promise<void>(resolve => { finishBeta = resolve; });
        result = { requiresResume: false, thread, model: 'shared', modelProvider: call.params.threadId === 'tb' ? 'beta' : 'alpha', reasoningEffort: call.params.threadId === 'tb' ? 'max' : 'high' }; break;
      case 'thread/history': result = { turns: [], timeline: [], turnsComplete: true, timelineComplete: true, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: true, nextCursor: null }; break;
    }
    return { status: 200, ok: true, json: async () => ({ ok: true, result }) };
  }));
  render(<App />); await screen.findByRole('button', { name: 'Project Alpha' });
  expect(calls.filter(call => call.method === 'model/list')).toHaveLength(0);
  const state = async (mode: 'native' | 'root', epoch: string) => act(async () => {
    sockets[0].onopen(); sockets[0].onmessage({ data: JSON.stringify({ type: 'state', data: { connected: true, runtime: { connected: true, epoch, executionMode: { mode, effectiveUid: mode === 'root' ? 0 : 123 }, activity: { unknown: false, activeThreads: [], pendingStarts: 0, terminals: 0, processes: 0, subscriptions: 0 } } } }) });
  });
  await state('native', 'one');
  const input = () => screen.getByRole('textbox', { name: '给 Codex 的消息' });
  const picker = () => screen.getByLabelText('选择模型与思考强度');
  await waitFor(() => expect(picker().textContent).toContain('Alpha model'));
  expect(input()).toHaveProperty('value', 'draft alpha');
  fireEvent.click(screen.getByRole('button', { name: 'Project Beta' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Chat Beta' }));
  await waitFor(() => expect(finishBeta).toBeTypeOf('function'));
  expect(picker().textContent).toContain('读取模型设置');
  fireEvent.click(picker());
  expect(screen.getByRole('combobox', { name: '思考强度' }).matches(':disabled')).toBe(true);
  await act(async () => { waitBeta = false; finishBeta(); });
  await waitFor(() => expect(picker().textContent).toContain('Beta model'));
  expect(input()).toHaveProperty('value', 'draft beta');
  expect(screen.getByRole('combobox', { name: '思考强度' })).toHaveProperty('value', 'max');
  expect(screen.queryByRole('option', { name: '高' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Project Alpha' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Chat Alpha' }));
  await waitFor(() => expect(picker().textContent).toContain('Alpha model'));
  expect(input()).toHaveProperty('value', 'draft alpha');
  expect(calls.filter(call => call.method === 'model/list')).toHaveLength(1);
  // Login/logout notifications refresh the directory without changing saved choices.
  rows = [];
  await act(async () => sockets[0].onmessage({ data: JSON.stringify({ type: 'notification', data: { method: 'account/updated', params: {} } }) }));
  await waitFor(() => expect(calls.filter(call => call.method === 'model/list')).toHaveLength(2));
  await waitFor(() => expect(picker().textContent).not.toContain('Alpha model'));
  expect(input()).toHaveProperty('value', 'draft alpha');
  rows = [models[1]!];
  await state('root', 'two');
  await waitFor(() => expect(calls.filter(call => call.method === 'model/list')).toHaveLength(3));
  expect(new URL(location.href).searchParams.get('thread')).toBeNull();
  expect(calls.some(call => call.operationId)).toBe(false);
});
