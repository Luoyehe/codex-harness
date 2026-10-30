// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../App';
import { Api } from '../lib/api';
import { branchDraftKey, branchDraftSource, emptyDraft, executionDraftContext, executionDraftKey, readDraft, writeDraft } from '../lib/drafts';
import { listOperations } from '../lib/operations';
import { DraftsSettings } from '../components/DraftsSettings';
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); history.replaceState({}, '', '/');
  HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  HTMLDialogElement.prototype.close = function() { this.open = false; };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('native draft keys remain compatible and root branch/thread keys stay a separate local namespace', () => {
  expect(executionDraftKey('new:p')).toBe('new:p'); expect(executionDraftKey('thread', 'root')).toBe('root:thread');
  expect(executionDraftContext('root:new:p')).toEqual({ mode: 'root', key: 'new:p' });
  const rootBranch = branchDraftKey('thread', 'turn', 'root');
  expect(rootBranch).toBe('root:' + branchDraftKey('thread', 'turn'));
  expect(branchDraftSource(executionDraftContext(rootBranch).key)).toEqual({ threadId: 'thread', turnId: 'turn' });
});

test('accepted root input clears only the operation-time root snapshot, without sending its local prefix', async () => {
  writeDraft({ ...emptyDraft('thread'), text: 'same input' });
  writeDraft({ ...emptyDraft('root:thread'), text: 'same input' });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => { const call = JSON.parse(init.body); calls.push(call); await gate; return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }; }));
  const api = new Api();
  const pending = api.mutate('turn/start', { threadId: 'thread', text: 'same input' }, 'root');
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].params).toEqual({ threadId: 'thread', text: 'same input' });
  expect((await listOperations())[0]).toMatchObject({ draftKey: 'root:thread', threadId: 'thread', state: 'pending' });
  sessionStorage.setItem('harness.execution-mode', 'native');
  release(); await pending;
  expect(readDraft('root:thread').text).toBe(''); expect(readDraft('thread').text).toBe('same input');
});

test('draft management shows both modes but cannot open a draft under another identity', async () => {
  writeDraft({ ...emptyDraft('new:p'), text: 'normal saved input' });
  writeDraft({ ...emptyDraft('root:new:p'), text: 'root saved input' });
  const onOpen = vi.fn();
  render(<DraftsSettings projects={[{ id: 'p', name: 'Project', cwd: '/project' }]} draftMode="root" onOpen={onOpen} />);
  const normal = (await screen.findByText('普通 · Project')).closest('.info-card')!, root = screen.getByText('ROOT · Project').closest('.info-card')!;
  expect(within(normal as HTMLElement).getByRole('button', { name: '打开草稿' }).matches(':disabled')).toBe(true);
  fireEvent.click(within(root as HTMLElement).getByRole('button', { name: '打开草稿' })); expect(onOpen).toHaveBeenCalledExactlyOnceWith('root:new:p');
});

async function workspace(thread = '') {
  sessionStorage.setItem('harness.project', 'p');
  if (thread) history.replaceState({}, '', `/?thread=${thread}`);
  const sockets: any[] = [], calls: any[] = [];
  vi.stubGlobal('WebSocket', class { onopen = () => {}; onclose = () => {}; onmessage = (_: any) => {}; close() {} constructor() { sockets.push(this); } });
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (url === '/api/session') return { status: 200, ok: true, json: async () => ({ authenticated: true, csrf: 'fixture-csrf', operationRecoveryProtocol: 2 }) };
    const call = JSON.parse(init.body); calls.push(call); let result: any = {};
    switch (call.method) {
      case 'project/list': result = { projects: [{ id: 'p', name: 'Project', path: '/project' }] }; break;
      case 'thread/list': result = { data: [{ id: 'old-thread', name: 'Old thread', cwd: '/project' }], nextCursor: null }; break;
      case 'model/list': case 'collaborationMode/list': case 'environment/list': result = { data: [], nextCursor: null }; break;
      case 'prompt/list': result = { prompts: [] }; break;
      case 'defaults/read': result = { model: 'fixture' }; break;
      case 'thread/read': result = { thread: { id: call.params.threadId, name: 'Old thread', cwd: '/project' } }; break;
      case 'thread/session': result = { requiresResume: true }; break;
      case 'thread/history': result = { turns: [], timeline: [], turnsComplete: true, timelineComplete: true, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: true, nextCursor: null }; break;
    }
    return { status: 200, ok: true, json: async () => ({ ok: true, result }) };
  }));
  render(<App />); await screen.findByRole('button', { name: 'Project' }); await waitFor(() => expect(sockets).toHaveLength(1));
  const state = async (mode: 'native' | 'root', epoch: string) => act(async () => {
    sockets[0].onopen(); sockets[0].onmessage({ data: JSON.stringify({ type: 'state', data: { connected: true, runtime: { connected: true, epoch, executionMode: { mode, effectiveUid: mode === 'root' ? 0 : 123 }, activity: { unknown: false, activeThreads: [], pendingStarts: 0, terminals: 0, processes: 0, subscriptions: 0 } } } }) });
  });
  await state('native', 'native-1');
  const input = () => screen.getByRole('textbox', { name: '给 Codex 的消息' });
  return { calls, state, input, sockets };
}

test('confirmed mode changes leave the old thread, preserve both drafts, and never resume or send automatically', async () => {
  writeDraft({ ...emptyDraft('old-thread'), text: 'private normal draft', options: { model: 'native-model' } });
  writeDraft({ ...emptyDraft('root:new:p'), text: 'root saved draft' });
  const f = await workspace('old-thread');
  await waitFor(() => expect(f.input()).toHaveProperty('value', 'private normal draft'));
  await waitFor(() => expect(f.calls.some(call => call.method === 'thread/history')).toBe(true));
  const start = f.calls.length;
  await f.state('root', 'root-2');
  await waitFor(() => expect(f.input()).toHaveProperty('value', 'root saved draft'));
  expect(new URL(location.href).searchParams.get('thread')).toBeNull();
  expect(new URL(location.href).searchParams.get('executionMode')).toBe('root');
  expect(readDraft('old-thread')).toMatchObject({ text: 'private normal draft', options: { model: 'native-model' } });
  expect(f.calls.slice(start).some(call => call.params.threadId === 'old-thread')).toBe(false);
  expect(f.calls.some(call => ['thread/resume', 'conversation/start', 'turn/start'].includes(call.method))).toBe(false);
  fireEvent.change(f.input(), { target: { value: 'edited root draft' } });
  await f.state('native', 'native-3');
  await waitFor(() => expect(f.input()).toHaveProperty('value', ''));
  expect(readDraft('root:new:p').text).toBe('edited root draft');
  expect(new URL(location.href).searchParams.get('executionMode')).toBeNull();
});

test('storage failure keeps the old draft and closes execution until its original namespace is saved', async () => {
  const f = await workspace();
  const original = Storage.prototype.setItem; let fail = true;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key, value) {
    if (fail && key.startsWith('harness.draft.v1.')) throw new Error('Fixture storage unavailable');
    original.call(this, key, value);
  });
  fireEvent.change(f.input(), { target: { value: 'only copy in old mode' } });
  await f.state('root', 'root-2');
  expect(f.input()).toHaveProperty('value', 'only copy in old mode');
  expect(screen.getByRole('button', { name: '发送消息' }).matches(':disabled')).toBe(true);
  expect(readDraft('root:new:p').text).toBe('');
  fireEvent.click(screen.getByRole('button', { name: '保存原模式草稿并继续' }));
  expect(f.input()).toHaveProperty('value', 'only copy in old mode');
  fail = false; fireEvent.click(screen.getByRole('button', { name: '保存原模式草稿并继续' }));
  await waitFor(() => expect(f.input()).toHaveProperty('value', ''));
  expect(readDraft('new:p').text).toBe('only copy in old mode');
  expect(readDraft('root:new:p').text).toBe('');
  expect(f.calls.some(call => ['thread/resume', 'conversation/start', 'turn/start'].includes(call.method))).toBe(false);
});

test('missing actual identity cannot silently downgrade a root view or authorize sending its saved draft', async () => {
  const f = await workspace(); await f.state('root', 'root-2');
  fireEvent.change(f.input(), { target: { value: 'saved root-only input' } });
  await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' }).matches(':disabled')).toBe(false));
  await act(async () => f.sockets[0].onmessage({ data: JSON.stringify({ type: 'state', data: { connected: true, runtime: { connected: true, epoch: 'root-2', activity: { unknown: false, activeThreads: [], pendingStarts: 0, terminals: 0, processes: 0, subscriptions: 0 } } } }) }));
  expect(f.input()).toHaveProperty('value', 'saved root-only input');
  expect(screen.getByRole('button', { name: '发送消息' }).matches(':disabled')).toBe(true);
  expect(readDraft('new:p').text).toBe(''); expect(readDraft('root:new:p').text).toBe('saved root-only input');
  expect(screen.getByText(/正在确认实际执行身份/)).toBeTruthy();
  fireEvent.keyDown(f.input(), { key: 'Enter', code: 'Enter', ctrlKey: true });
  expect(f.calls.some(call => ['thread/resume', 'conversation/start', 'turn/start'].includes(call.method))).toBe(false);
});
