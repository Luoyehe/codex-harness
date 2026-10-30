// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App';
import { emptyDraft, readDraft, writeDraft } from '../lib/drafts';
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
type Socket = { onopen: () => void; onmessage: (event: { data: string }) => void };
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); history.replaceState({}, '', '/');
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const editor = () => screen.getByRole('textbox', { name: '给 Codex 的消息' }) as HTMLTextAreaElement;
const guard = () => within(screen.getByRole('dialog', { name: '草稿尚未保存' }));
function failWrites() {
  const original = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (this === sessionStorage && key.startsWith('harness.draft.v1.')) throw new DOMException('quota', 'QuotaExceededError');
    return original.call(this, key, value);
  });
}
async function setup(thread = '', selectedProject = 'a') {
  if (selectedProject) sessionStorage.setItem('harness.project', selectedProject);
  if (thread) history.replaceState({}, '', `/?thread=${thread}`);
  const sockets: Socket[] = [];
  let projects = [{ id: 'a', name: 'Project A', path: '/a' }, { id: 'b', name: 'Project B', path: '/b' }];
  vi.stubGlobal('WebSocket', class {
    onopen = () => {}; onclose = () => {}; onmessage = (_event: { data: string }) => {}; close() {}
    constructor() { sockets.push(this); }
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/session') return { status: 200, ok: true, json: async () => ({ authenticated: true, csrf: 'fixture', operationRecoveryProtocol: 2 }) };
    const request = JSON.parse(String(init.body));
    let result: unknown = {};
    switch (request.method) {
      case 'project/list': result = { projects }; break;
      case 'thread/list': result = { data: [{ id: 't', name: 'Saved thread', cwd: '/a' }], nextCursor: null }; break;
      case 'model/list': case 'collaborationMode/list': case 'environment/list': result = { data: [], nextCursor: null }; break;
      case 'prompt/list': result = { prompts: [] }; break;
      case 'defaults/read': result = { model: 'fixture', modelProvider: 'openai' }; break;
      case 'thread/read': result = { thread: { id: request.params.threadId, cwd: '/a' } }; break;
      case 'thread/session': result = { requiresResume: false, thread: { id: request.params.threadId }, model: 'fixture', modelProvider: 'openai' }; break;
      case 'thread/history': result = { turns: [], timeline: [], turnsComplete: true, timelineComplete: true, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: true, nextCursor: null }; break;
    }
    return { status: 200, ok: true, json: async () => ({ ok: true, result }) };
  }));
  render(<App />);
  await screen.findByRole('button', { name: 'Project A' });
  await waitFor(() => expect(sockets).toHaveLength(1));
  const state = (epoch: string) => sockets[0]!.onmessage({ data: JSON.stringify({ type: 'state', data: { connected: true, runtime: { connected: true, epoch, activity: { unknown: false, activeThreads: [], pendingStarts: 0, terminals: 0, processes: 0, subscriptions: 0 } } } }) });
  await act(async () => { sockets[0]!.onopen(); state('one'); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Project A' }).className).toContain('selected'));
  return { removeCurrentProject: async () => { projects = projects.filter(p => p.id !== 'a'); await act(async () => state('two')); } };
}

it.each(['quota', 'capacity'])('protects the sole draft on real sidebar project selection (%s), then retries without replaying navigation', async failureKind => {
  if (failureKind === 'capacity') for (let i = 0; i < 50; i++) writeDraft({ ...emptyDraft(`filler-${i}`), text: 'saved filler' });
  await setup();
  const failure = failureKind === 'quota' ? failWrites() : undefined;
  fireEvent.change(editor(), { target: { value: 'only copy' } });
  fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
  expect(editor().value).toBe('only copy');
  expect(sessionStorage.getItem('harness.project')).toBe('a');
  expect(screen.getByRole('button', { name: 'Project A' }).className).toContain('selected');
  fireEvent.click(guard().getByRole('button', { name: '重试保存草稿' }));
  expect(editor().value).toBe('only copy');
  if (failure) failure.mockRestore();
  else sessionStorage.removeItem('harness.draft.v1.filler-0');
  fireEvent.click(guard().getByRole('button', { name: '重试保存草稿' }));
  expect(screen.queryByRole('dialog', { name: '草稿尚未保存' })).toBeNull();
  expect(readDraft('new:a').text).toBe('only copy');
  expect(screen.getByRole('button', { name: 'Project A' }).className).toContain('selected');
  fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
  fireEvent.click(screen.getByRole('button', { name: 'Project A' }));
  await waitFor(() => expect(editor().value).toBe('only copy'));
});

it.each(['new', 'thread', 'popstate'])('blocks a different draft key through %s without changing its selection or URL', async route => {
  await setup(route === 'new' ? 't' : '');
  failWrites();
  fireEvent.change(editor(), { target: { value: 'only copy' } });
  const before = location.href;
  if (route === 'new') fireEvent.click(screen.getByRole('button', { name: '新会话' }));
  else if (route === 'thread') fireEvent.click(screen.getByRole('button', { name: 'Saved thread' }));
  else await act(async () => { history.pushState({}, '', '/?thread=t'); window.dispatchEvent(new PopStateEvent('popstate')); });
  expect(screen.getByRole('dialog', { name: '草稿尚未保存' })).toBeTruthy();
  expect(editor().value).toBe('only copy');
  expect(location.href).toBe(before);
  expect(sessionStorage.getItem('harness.project')).toBe('a');
});

it('allows same-key selection and clean initial project selection without a prompt', async () => {
  await setup('', '');
  expect(screen.queryByRole('dialog', { name: '草稿尚未保存' })).toBeNull();
  failWrites();
  fireEvent.change(editor(), { target: { value: 'only copy' } });
  fireEvent.click(screen.getByRole('button', { name: 'Project A' }));
  fireEvent.click(screen.getByRole('button', { name: '新会话' }));
  expect(editor().value).toBe('only copy');
  expect(screen.queryByRole('dialog', { name: '草稿尚未保存' })).toBeNull();
});

it('blocks automatic fallback when the selected project disappears', async () => {
  const fixture = await setup();
  failWrites();
  fireEvent.change(editor(), { target: { value: 'only copy' } });
  await fixture.removeCurrentProject();
  await screen.findByRole('dialog', { name: '草稿尚未保存' });
  expect(editor().value).toBe('only copy');
  expect(sessionStorage.getItem('harness.project')).toBe('a');
});

it('keeps settings open when another saved draft cannot be opened and requires a fresh discard confirmation after edits', async () => {
  writeDraft({ ...emptyDraft('new:a'), text: 'saved A' });
  writeDraft({ ...emptyDraft('new:b'), text: 'saved B' });
  await setup();
  failWrites();
  fireEvent.change(editor(), { target: { value: 'only copy' } });
  fireEvent.click(screen.getByRole('button', { name: '打开设置' }));
  const settings = within(screen.getByRole('dialog', { name: '设置' }));
  fireEvent.click(settings.getByRole('button', { name: '本地草稿' }));
  const row = settings.getByText('Project B').closest('.info-card')!;
  fireEvent.click(within(row as HTMLElement).getByRole('button', { name: '打开草稿' }));
  expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy();
  expect(editor().value).toBe('only copy');
  fireEvent.click(guard().getByRole('button', { name: '放弃未保存的修改' }));
  fireEvent.change(editor(), { target: { value: 'newer copy' } });
  expect(guard().getByRole('button', { name: '确认放弃未保存的修改' }).matches(':disabled')).toBe(true);
  fireEvent.click(guard().getByRole('button', { name: '重新确认当前修改' }));
  fireEvent.click(guard().getByRole('button', { name: '确认放弃未保存的修改' }));
  expect(editor().value).toBe('saved A');
  expect(readDraft('new:b').text).toBe('saved B');
  expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy();
  fireEvent.click(within(row as HTMLElement).getByRole('button', { name: '打开草稿' }));
  await waitFor(() => expect(editor().value).toBe('saved B'));
});
