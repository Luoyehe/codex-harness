// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { Composer } from '../components/Composer';
import { InputContextPicker } from '../components/InputContextPicker';
import { FileEditor } from '../components/FileEditor';
import { TaskPanel } from '../components/TaskPanel';
import { App } from '../App';
import { contextPayload, parseOutputSchema, referenceInput, selectedLines, type DraftReference } from '../lib/input-context';
import { emptyDraft, readDraft, writeDraft } from '../lib/drafts';
import { useDraft } from '../hooks/useDraft';
import { Events } from '../lib/events';
const reference: DraftReference = { type: 'file', projectId: 'p', label: 'README.md:2-3', path: 'README.md', revision: 'a'.repeat(64), startLine: 2, endLine: 3 };
type Call = { method: string; params: Record<string, unknown> };
function setup(handler: (call: Call) => unknown = () => ({})) { const api = new Api(), calls: Call[] = []; vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init: RequestInit) => { const call = JSON.parse(String(init.body)); calls.push(call); return { ok: true, status: 200, json: async () => ({ ok: true, result: await handler(call) }) }; })); return { api, calls }; }
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); HTMLDialogElement.prototype.showModal = function () { this.open = true; }; HTMLDialogElement.prototype.close = function () { this.open = false; }; Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('keeps project ownership, validates bounded local schema and excludes display metadata from RPC inputs', () => {
  expect(contextPayload('p', [reference], [{ label: 'spec', text: 'hello' }])).toEqual({ references: [{ type: 'file', path: 'README.md', revision: 'a'.repeat(64), startLine: 2, endLine: 3 }], extraContext: [{ label: 'spec', text: 'hello' }] });
  expect(() => contextPayload('other', [reference], [])).toThrow(/其他项目/); expect(() => contextPayload('p', [reference, reference], [])).toThrow(/重复/); expect(() => contextPayload('p', [], [{ label: '', text: '' }])).toThrow(/填写/);
  expect(parseOutputSchema('{"type":"object","$ref":"#/$defs/result"}')).toMatchObject({ type: 'object' }); expect(() => parseOutputSchema('{"$ref":"https://example.invalid/schema"}')).toThrow(/内部/); expect(() => parseOutputSchema('[]')).toThrow(/对象/); expect(() => parseOutputSchema('{')).toThrow(/JSON/);
  expect(selectedLines('one\ntwo\nthree\nfour', 4, 14)).toEqual({ startLine: 2, endLine: 3 });
});
it('preserves context and schema per draft and does not let an old receipt clear newer references', async () => {
  writeDraft({ ...emptyDraft('thread'), text: 'same', references: [reference], extraContext: [{ label: 'spec', text: 'note' }], outputSchema: '{"type":"object"}' });
  let resolve!: (value: unknown) => void; const { api } = setup(() => new Promise(done => { resolve = done; })); const { result } = renderHook(() => useDraft('thread'));
  const pending = api.mutate('turn/start', { threadId: 'thread', text: 'same', references: [referenceInput(reference)], extraContext: result.current.extraContext, options: { outputSchema: { type: 'object' } } });
  act(() => result.current.setReferences([{ ...reference, label: 'README.md:4', startLine: 4, endLine: 4 }])); await waitFor(() => expect(resolve).toBeTypeOf('function')); await act(async () => { resolve({ turn: { id: 'accepted' } }); await pending; });
  expect(readDraft('thread').references).toMatchObject([{ startLine: 4 }]); expect(readDraft('thread').outputSchema).toBe('{"type":"object"}'); expect(readDraft('new:other').references).toEqual([]);
});
it('does not clear a draft when another write has the same text but different context', async () => {
  const draft = { ...emptyDraft('thread'), text: 'same', references: [reference] }; writeDraft(draft); const { api } = setup(); await api.mutate('turn/start', { threadId: 'thread', text: 'same', references: [] }); expect(readDraft('thread')).toEqual(draft);
  await api.mutate('turn/start', { threadId: 'thread', text: 'same', references: [referenceInput(reference)] }); expect(readDraft('thread').references).toEqual([]);
});
it('only offers enabled discovered skills and callable installed Apps, while preserving selected identities', async () => {
  const enabledSkill = { name: 'review', skillId: 'a'.repeat(64), path: '/project/skills/review', description: 'Review code', enabled: true };
  const { api, calls } = setup(call => call.method === 'skills/list' ? { data: [{ skills: [enabledSkill, { ...enabledSkill, name: 'disabled', skillId: 'b'.repeat(64), enabled: false }], errors: [] }] } : call.method === 'app/list' ? { data: [{ id: 'ready', name: 'Ready App', isEnabled: true, isAccessible: true }, { id: 'blocked', name: 'Blocked App', isEnabled: true, isAccessible: true }], nextCursor: null } : { apps: [{ id: 'ready', enabled: true, callable: true }, { id: 'blocked', enabled: true, callable: false }] });
  const onReferences = vi.fn(); render(<InputContextPicker api={api} projectId="p" references={[]} notes={[]} schema="" onReferences={onReferences} onNotes={vi.fn()} onSchema={vi.fn()} normalTurn/>); fireEvent.click(screen.getByRole('button', { name: '引用与输出格式' })); fireEvent.click(await screen.findByRole('button', { name: '引用此技能' })); expect(onReferences).toHaveBeenLastCalledWith([{ type: 'skill', skillId: enabledSkill.skillId, projectId: 'p', label: 'review' }]); expect((screen.getByRole('button', { name: '技能未启用' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Apps' })); fireEvent.click(await screen.findByRole('button', { name: '引用此 App' })); expect(onReferences).toHaveBeenLastCalledWith([{ type: 'app', appId: 'ready', projectId: 'p', label: 'Ready App' }]); expect((screen.getByRole('button', { name: '尚不可调用' }) as HTMLButtonElement).disabled).toBe(true); expect(calls.find(call => call.method === 'skills/list')?.params).toEqual({ projectId: 'p', forceReload: true });
});
it('allows reference-only messages but blocks wrong-project references and schema on queued input', () => {
  const send = vi.fn().mockResolvedValue(false), props = { api: {} as Api, value: '', onChange: vi.fn(), onSend: send, onStop: vi.fn(), busy: false, disabled: false, active: false, options: {}, onOptions: vi.fn(), models: [], defaults: undefined, defaultsLoading: false, notice: '', contextKey: 'thread', projectId: 'p', references: [reference], existingThread: true };
  const view = render(<Composer {...props}/>); fireEvent.click(screen.getByRole('button', { name: '发送消息' })); expect(send).toHaveBeenCalledOnce(); view.rerender(<Composer {...props} projectId="foreign"/>); expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<Composer {...props} outputSchema='{"type":"object"}'/>); fireEvent.change(screen.getByRole('combobox', { name: '发送方式' }), { target: { value: 'queue' } }); expect((screen.getByRole('button', { name: '加入队列' }) as HTMLButtonElement).disabled).toBe(true); expect(send).toHaveBeenCalledOnce();
});
it('references only selected saved lines at the displayed revision and refuses dirty content', async () => {
  const text = 'one\ntwo\nthree\nfour', props = { api: {} as Api, projectId: 'p', path: 'README.md', remote: { path: 'README.md', kind: 'file' as const, text, bytes: text.length, revision: 'a'.repeat(64), binary: false, editable: true }, creating: false, loading: false, readError: '', enabled: true, cache: new Map(), onChanged: vi.fn(), onReference: vi.fn() };
  render(<FileEditor {...props}/>); const editor = await screen.findByRole('textbox', { name: '文件内容' }) as HTMLTextAreaElement; editor.setSelectionRange(4, 14); fireEvent.select(editor); fireEvent.click(screen.getByRole('button', { name: '引用选中行（2–3）' })); expect(props.onReference).toHaveBeenCalledWith(reference);
  fireEvent.change(editor, { target: { value: text + '\nnew text' } }); editor.setSelectionRange(4, 14); fireEvent.select(editor); expect((screen.getByRole('button', { name: /^引用选中行/ }) as HTMLButtonElement).disabled).toBe(true);
});
it('edits reference-only queued messages without sending clear-reference fields', async () => {
  const { api, calls } = setup(call => call.method === 'thread/queue/list' ? { data: [{ id: 'queued', text: '', hasOpaqueInput: true, input: [{ type: 'text', text: 'Untrusted context', text_elements: [{ placeholder: 'harness-context:' + 'a'.repeat(64), byteRange: { start: 0, end: 17 } }] }] }], nextCursor: null } : {});
  render(<TaskPanel api={api} threadId="thread" epoch="one" enabled active events={new Events()} onChanged={vi.fn()} onOpenThread={vi.fn()} onClose={vi.fn()}/>); fireEvent.click(await screen.findByRole('button', { name: '编辑' })); expect(screen.getByText('保留此条已有引用与补充上下文；本次只修改消息正文。')).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: '保存修改' })); await waitFor(() => expect(calls.find(call => call.method === 'thread/queue/update')?.params).toEqual({ threadId: 'thread', queuedSubmissionId: 'queued', text: '' }));
});
it('sends the full context through the actual App new-conversation path and clears only its accepted snapshot', async () => {
  history.replaceState({}, '', '/'); sessionStorage.setItem('harness.project', 'p'); writeDraft({ ...emptyDraft('new:p'), references: [reference], extraContext: [{ label: 'Spec', text: 'Only inspect' }], outputSchema: '{"type":"object"}' });
  let socket!: { onopen: () => void; onmessage: (event: { data: string }) => void }; vi.stubGlobal('WebSocket', class { onopen = () => {}; onmessage = (_event: { data: string }) => {}; close() {} constructor() { socket = this; } });
  const calls: Call[] = []; vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url, init) => { const ok = (result: unknown) => ({ ok: true, status: 200, json: async () => url === '/api/session' ? result : { ok: true, result } }); if (url === '/api/session') return ok({ authenticated: true, csrf: 'test' }); const call: Call = JSON.parse(init.body); calls.push(call); const data: Record<string, unknown> = { 'project/list': { data: [{ id: 'p', name: 'Project', cwd: '/p' }] }, 'thread/list': { data: [], nextCursor: null }, 'model/list': { data: [], nextCursor: null }, 'collaborationMode/list': { data: [] }, 'prompt/list': { prompts: [] }, 'defaults/read': { model: 'model' }, 'conversation/start': { thread: { id: 'new-thread' }, turn: { id: 'new-turn' } }, 'thread/read': { thread: { id: 'new-thread', cwd: '/p', status: { type: 'idle' } } }, 'thread/session': { requiresResume: false, thread: { id: 'new-thread' }, model: 'model' }, 'thread/history': { turns: [], timeline: [], turnsComplete: true, timelineComplete: true, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: true, nextCursor: null } }; return ok(data[call.method] ?? {}); }));
  render(<App/>); await waitFor(() => expect(socket).toBeTruthy()); await act(async () => { socket.onopen(); socket.onmessage({ data: JSON.stringify({ type: 'state', data: { connected: true, epoch: 'one', activity: { unknown: false } } }) }); }); await waitFor(() => expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(screen.getByRole('button', { name: '发送消息' })); await waitFor(() => expect(calls.find(call => call.method === 'conversation/start')?.params).toMatchObject({ projectId: 'p', text: '', references: [referenceInput(reference)], extraContext: [{ label: 'Spec', text: 'Only inspect' }], options: { outputSchema: { type: 'object' } } })); await waitFor(() => expect(readDraft('new:p').references).toEqual([]));
});
