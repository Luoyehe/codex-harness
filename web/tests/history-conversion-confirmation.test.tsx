// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workspace } from '../Workspace';
import { Api } from '../lib/api';
import { emptyDraft, readDraft, writeDraft } from '../lib/drafts';
import { createOperation, listOperations, updateOperation } from '../lib/operations';
import type { Composer } from '../components/Composer';
import type { Sidebar } from '../components/Sidebar';
import type { Options } from '../lib/types';

const controls = vi.hoisted(() => ({
  composer: undefined as ComponentProps<typeof Composer> | undefined,
  sent: undefined as Promise<boolean> | undefined,
  source: 'provider-a', loaded: true, epoch: 'one', active: false, ready: false, realConversation: false,
  refresh: vi.fn(), empty: [],
  data: { projects: [{ id: 'p', name: 'Project', cwd: '/project' }], data: [], modelProvider: 'provider-a' },
  models: [
    { id: 'a', modelProvider: 'provider-a', displayName: 'A', providerName: 'Alpha' },
    { id: 'a2', modelProvider: 'provider-a', displayName: 'A2', providerName: 'Alpha' },
    { id: 'b', modelProvider: 'provider-b', displayName: 'B', providerName: 'Beta' },
    { id: 'c', modelProvider: 'provider-c', displayName: 'C', providerName: 'Gamma' },
    { id: 'gpt-fixture', modelProvider: 'harness_chatgpt', displayName: 'ChatGPT fixture', providerName: 'ChatGPT', providerAliases: ['openai'] },
  ],
}));
vi.mock('../hooks/useEvents', () => ({ useEvents: () => ({ connection: 'connected', runtimeConnected: true,
  activityReady: true, configurationReady: true, epoch: controls.epoch, revision: 1, connectionId: 'local' }) }));
vi.mock('../hooks/useResource', () => ({ useResource: () => ({ data: controls.data, loading: false, error: '', refresh: controls.refresh }) }));
vi.mock('../hooks/usePaged', () => ({ usePaged: (_api: unknown, method: string, _params: unknown, key: string) => ({
  items: method === 'model/list' ? controls.models : controls.empty, snapshotKey: key,
  loading: false, hasMore: false, refresh: controls.refresh,
}) }));
vi.mock('../hooks/useModelCatalogRefresh', () => ({ useModelCatalogRefresh: () => ({ refreshing: false }) }));
vi.mock('../hooks/useConversation', async original => {
  const actual = await original<typeof import('../hooks/useConversation')>();
  return { useConversation: (...args: Parameters<typeof actual.useConversation>) => controls.realConversation
    ? actual.useConversation(...args) : {
      thread: args[2] ? { id: args[2], cwd: '/project', modelProvider: controls.source } : undefined,
      ready: controls.ready, turns: controls.empty, active: controls.active, refresh: controls.refresh,
    } };
});
vi.mock('../hooks/useResume', () => ({ useResume: (_api: unknown, thread: string) => ({
  resumedThread: controls.loaded ? thread : '',
  threadDefaults: controls.loaded ? { modelProvider: controls.source, model: 'a' } : undefined,
  requiresResume: !controls.loaded, requiresContinuationConfirmation: controls.realConversation,
  requireContinuationConfirmation: vi.fn(),
}) }));
vi.mock('../hooks/usePrompts', () => ({ usePrompts: () => ({ prompts: controls.empty }) }));
vi.mock('../components/HookEventsPanel', () => ({ HookEventsProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('../components/McpPanel', () => ({ McpEventBridge: () => null }));
vi.mock('../components/Welcome', () => ({ Welcome: () => null }));
vi.mock('../components/Messages', () => ({ Messages: () => null, Diff: () => null }));
vi.mock('../components/Sidebar', () => ({ Sidebar: (props: ComponentProps<typeof Sidebar>) => <>
  <button onClick={() => props.onThread('other')}>Other thread</button>
  <button onClick={props.onNew}>New chat</button>
</> }));
vi.mock('../components/Composer', async () => {
  const { ModelPicker } = await import('../components/ModelPicker');
  return { Composer: (props: ComponentProps<typeof Composer>) => {
    controls.composer = props;
    return <>
      <textarea aria-label="Draft" value={props.value} onChange={event => props.onChange(event.target.value)} />
      <ModelPicker models={props.models} options={props.options} onOptions={props.onOptions}
        defaults={props.defaults} existingThread={Boolean(props.existingThread)} />
      <button onClick={() => { controls.sent = props.onSend([], 'send'); }}>Send fixture</button>
    </>;
  } };
});
beforeEach(() => {
  sessionStorage.clear(); sessionStorage.setItem('harness.project', 'p');
  history.replaceState({}, '', '/?thread=t');
  controls.source = 'provider-a'; controls.loaded = true; controls.epoch = 'one'; controls.active = false;
  controls.ready = false; controls.realConversation = false;
  controls.composer = undefined; controls.sent = undefined;
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(async () => { cleanup(); if (controls.sent) await controls.sent; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Request = { method: string; params: Record<string, unknown>; operationId: string };
const required = (source = 'provider-a', target = source, delivery = 'not_sent') => ({
  code: 'history_conversion_confirmation_required', message: 'Confirm conversion', delivery,
  data: { threadId: 't', sourceProvider: source, targetProvider: target, conversionRequired: true },
});
type Reply = { error?: unknown; result?: unknown };
async function fixture(reply?: (request: Request) => Reply | Promise<Reply>, options: Options = {}) {
  writeDraft({ ...emptyDraft('t'), text: 'message one', options });
  const calls: Request[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as Request;
    calls.push(request);
    const response = await reply?.(request) ?? { result: {} };
    return { ok: true, status: 200, json: async () => response.error
      ? { ok: false, error: response.error } : { ok: true, result: response.result ?? {} } };
  }));
  const api = new Api();
  const view = render(<Workspace api={api} active logout={async () => {}} />);
  await waitFor(() => expect(controls.composer?.value).toBe('message one'));
  // Complete the initial read after the draft has hydrated, as the real HTTP/history reader does.
  controls.ready = true; view.rerender(<Workspace api={api} active logout={async () => {}} />);
  return { calls, view, api, mutations: () => calls.filter(row => row.operationId) };
}
const choose = (provider: string, model: string) => {
  fireEvent.click(screen.getByLabelText('选择模型与思考强度'));
  fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: JSON.stringify([provider, model]) } });
};
const dialog = () => screen.findByRole('dialog', { name: '确认供应商历史转换' });
async function confirmSelection() {
  await dialog(); fireEvent.click(screen.getByRole('button', { name: '确认选择' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认供应商历史转换' })).toBeNull());
}
async function send() {
  fireEvent.click(screen.getByRole('button', { name: 'Send fixture' }));
  await act(async () => { await controls.sent; });
}

it('confirms on provider selection, keeps the original selection on cancel, then sends a later draft with consent without asking twice', async () => {
  const f = await fixture();
  choose('provider-b', 'b'); await dialog();
  expect(controls.composer!.options).toEqual({});
  expect(f.mutations()).toEqual([]);
  expect(screen.getByText(/历史转换将在下次发送时执行/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(readDraft('t').options).toEqual({}); expect(readDraft('t').text).toBe('message one');
  choose('provider-b', 'b'); await confirmSelection();
  fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: 'typed after choosing' } });
  await send();
  expect(f.mutations()).toHaveLength(1);
  expect(f.mutations()[0]).toMatchObject({ method: 'turn/start', params: { text: 'typed after choosing', threadId: 't',
    options: { modelProvider: 'provider-b', model: 'b' }, historyConversionConsent: { sourceProvider: 'provider-a', targetProvider: 'provider-b' } } });
  expect(screen.queryByRole('dialog', { name: '确认供应商历史转换' })).toBeNull();
});

it('does not prompt for a same-provider model and uses the actual thread provider for B to C or back to A', async () => {
  const f = await fixture();
  choose('provider-a', 'a2');
  expect(screen.queryByRole('dialog', { name: '确认供应商历史转换' })).toBeNull();
  choose('provider-b', 'b'); await confirmSelection();
  choose('provider-c', 'c'); await dialog();
  expect(screen.getByText('将此会话从 Alpha 切换到 Gamma。')).toBeTruthy();
  await confirmSelection();
  choose('provider-a', 'a2');
  expect(screen.queryByRole('dialog', { name: '确认供应商历史转换' })).toBeNull();
  await send();
  expect(f.mutations()[0]!.params).not.toHaveProperty('historyConversionConsent');
});

it('invalidates a model-selection confirmation after navigation without changing either draft', async () => {
  const f = await fixture();
  choose('provider-b', 'b'); await dialog();
  fireEvent.click(screen.getByRole('button', { name: 'Other thread' }));
  expect(screen.getByRole('button', { name: '确认选择' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: '确认选择' }));
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(readDraft('t').options).toEqual({}); expect(readDraft('other').options).toEqual({});
  expect(f.mutations()).toEqual([]);
});

it('reconfirms a restored selection after the runtime generation changes and never sends a newer draft from that dialog', async () => {
  const f = await fixture();
  choose('provider-b', 'b'); await confirmSelection();
  controls.epoch = 'two'; f.view.rerender(<Workspace api={f.api} active logout={async () => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Send fixture' })); await dialog();
  fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: 'newer draft' } });
  expect(screen.getByRole('button', { name: '转换并发送当前消息' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await act(async () => { expect(await controls.sent).toBe(false); });
  expect(f.mutations()).toEqual([]); expect(readDraft('t').text).toBe('newer draft');
});

it('acknowledges only the exact expected not-sent repair and creates a new explicit operation after confirmation', async () => {
  await createOperation('turn/start', { threadId: 'other' }, 0, 'other-rejection');
  await updateOperation('other-rejection', 'not_sent');
  let writes = 0;
  const f = await fixture(request => request.method === 'turn/start' && ++writes === 1 ? { error: required() } : { result: {} });
  fireEvent.click(screen.getByRole('button', { name: 'Send fixture' })); await dialog();
  const records = await listOperations();
  expect(records.some(record => record.id === f.mutations()[0]!.operationId)).toBe(false);
  expect(records.some(record => record.id === 'other-rejection')).toBe(true);
  expect(readDraft('t').text).toBe('message one');
  fireEvent.click(screen.getByRole('button', { name: '转换并发送当前消息' }));
  await act(async () => { expect(await controls.sent).toBe(true); });
  expect(f.mutations()).toHaveLength(2);
  expect(f.mutations()[1]!.operationId).not.toBe(f.mutations()[0]!.operationId);
  expect(f.mutations()[1]!.params.historyConversionConsent).toEqual({ sourceProvider: 'provider-a', targetProvider: 'provider-a' });
});

it.each(['unknown', 'wrong-thread', 'stale'] as const)('does not acknowledge or replay a %s response', async kind => {
  const failure = required('provider-a', 'provider-a', kind === 'unknown' ? 'unknown' : 'not_sent');
  if (kind === 'wrong-thread') failure.data.threadId = 'other';
  if (kind === 'stale') failure.code = 'history_conversion_consent_stale';
  const f = await fixture(() => ({ error: failure }));
  await send();
  expect(f.mutations()).toHaveLength(1);
  expect(screen.queryByRole('dialog', { name: '确认供应商历史转换' })).toBeNull();
  expect((await listOperations()).find(record => record.id === f.mutations()[0]!.operationId)?.state)
    .toBe(kind === 'unknown' ? 'unknown' : 'not_sent');
  expect(readDraft('t').text).toBe('message one');
});

it('confirms cold repair without sending input or removing the automatic continuation guard', async () => {
  controls.loaded = false;
  const f = await fixture(request => request.method === 'thread/resume' && !request.params.historyConversionConsent
    ? { error: required() } : { result: {} });
  await dialog();
  fireEvent.click(screen.getByRole('button', { name: '转换并加载会话' }));
  await waitFor(() => expect(f.mutations()).toHaveLength(2));
  expect(f.mutations()[1]).toMatchObject({ method: 'thread/resume', params: { threadId: 't', automatic: true,
    historyConversionConsent: { sourceProvider: 'provider-a', targetProvider: 'provider-a' } } });
  expect(f.calls.some(call => ['conversation/start', 'turn/start'].includes(call.method))).toBe(false);
  expect(readDraft('t').text).toBe('message one');
});

it('does not warn for a new conversation with no existing history', async () => {
  const f = await fixture();
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  choose('provider-b', 'b');
  expect(screen.queryByRole('dialog', { name: '确认供应商历史转换' })).toBeNull();
  expect(controls.composer!.options).toMatchObject({ modelProvider: 'provider-b', model: 'b' });
  expect(f.mutations()).toEqual([]);
});

it('checks the confirmed draft again at actual dispatch after recording the operation intent', async () => {
  const f = await fixture();
  choose('provider-b', 'b'); await confirmSelection();
  const original = f.api.beginMutation.bind(f.api);
  vi.spyOn(f.api, 'beginMutation').mockImplementation((method, params, prepare, mode) =>
    original(method, params, operation => {
      // Intent is already durably recorded, but no HTTP write has happened.
      controls.composer!.onChange('edited during intent persistence');
      prepare?.(operation);
    }, mode));
  await send();
  expect(f.mutations()).toEqual([]);
  expect(readDraft('t').text).toBe('edited during intent persistence');
  expect((await listOperations()).filter(row => row.method === 'turn/start')).toEqual([
    expect.objectContaining({ state: 'not_sent' }),
  ]);
});

it('cancels cold repair without an automatic retry or draft changes', async () => {
  controls.loaded = false;
  const f = await fixture(() => ({ error: required() }));
  await dialog(); fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await waitFor(() => expect(controls.composer!.busy).toBe(false));
  // Re-render at the same runtime/selection generation; cancellation is not an error retry trigger.
  f.view.rerender(<Workspace api={f.api} active logout={async () => {}} />);
  expect(f.mutations()).toHaveLength(1);
  expect(screen.queryByRole('dialog', { name: '确认供应商历史转换' })).toBeNull();
  expect(readDraft('t').text).toBe('message one');
  expect(await listOperations()).toEqual([]);
});

it('expires an open confirmation when a live turn starts', async () => {
  const f = await fixture(undefined, { model: 'b', modelProvider: 'provider-b' });
  fireEvent.click(screen.getByRole('button', { name: 'Send fixture' })); await dialog();
  controls.active = true; f.view.rerender(<Workspace api={f.api} active logout={async () => {}} />);
  expect(screen.getByRole('button', { name: '转换并发送当前消息' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await act(async () => { expect(await controls.sent).toBe(false); });
  expect(f.mutations()).toEqual([]);
});

it('treats a catalog alias as the same warm provider, including exact same-provider repair consent', async () => {
  controls.source = 'openai';
  let writes = 0;
  const f = await fixture(request => request.method === 'turn/start' && ++writes === 1
    ? { error: required('openai', 'openai') } : { result: {} });
  choose('harness_chatgpt', 'gpt-fixture');
  expect(screen.queryByRole('dialog', { name: '确认供应商历史转换' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Send fixture' })); await dialog();
  expect(f.mutations()[0]!.params).not.toHaveProperty('historyConversionConsent');
  fireEvent.click(screen.getByRole('button', { name: '转换并发送当前消息' }));
  await act(async () => { expect(await controls.sent).toBe(true); });
  expect(f.mutations()[1]!.params.historyConversionConsent).toEqual({ sourceProvider: 'openai', targetProvider: 'openai' });
});

it('does not prompt for cold loading the same provider alias, but preserves the backend exact pair when repair is needed', async () => {
  controls.source = 'openai'; controls.loaded = false;
  const f = await fixture(request => request.method === 'thread/resume' && !request.params.historyConversionConsent
    ? { error: required('openai', 'harness_chatgpt') } : { result: {} }, { model: 'gpt-fixture', modelProvider: 'harness_chatgpt' });
  // This is a repair prompt from a proven not-sent result, not a cross-provider warning before loading.
  await dialog();
  expect(f.mutations()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '转换并加载会话' }));
  await waitFor(() => expect(f.mutations()).toHaveLength(2));
  expect(f.mutations()[1]!.params.historyConversionConsent).toEqual({ sourceProvider: 'openai', targetProvider: 'harness_chatgpt' });
});

it('waits for the actual delayed thread read before adopting a provider selection while allowing other draft options', async () => {
  controls.loaded = false; controls.realConversation = true;
  let release!: (reply: Reply) => void;
  const delayed = new Promise<Reply>(resolve => { release = resolve; });
  const f = await fixture(request => request.method === 'thread/read' ? delayed : request.method === 'thread/history'
    ? { result: { turns: [], timeline: [], turnsComplete: true, timelineComplete: true, historyVersion: 0,
      activeRealtimeSessionAtPageStart: null, complete: true, nextCursor: null } } : { result: {} });
  await waitFor(() => expect(f.calls.some(call => call.method === 'thread/read')).toBe(true));
  choose('provider-b', 'b');
  expect(screen.getByText(/会话原供应商尚未读取/)).toBeTruthy();
  expect(readDraft('t').options).toEqual({});
  expect(screen.queryByRole('dialog', { name: '确认供应商历史转换' })).toBeNull();
  act(() => controls.composer!.onOptions({ ...controls.composer!.options, sandbox: 'workspace-write' }));
  expect(readDraft('t').options).toEqual({ sandbox: 'workspace-write' });
  expect(f.mutations()).toEqual([]);
  await act(async () => release({ result: { thread: { id: 't', name: 'Delayed thread', cwd: '/project', modelProvider: 'provider-a', status: { type: 'notLoaded' } } } }));
  await screen.findByText('Delayed thread');
  choose('provider-b', 'b'); await dialog();
  expect(readDraft('t').options).toEqual({ sandbox: 'workspace-write' });
  await confirmSelection();
  expect(readDraft('t').options).toMatchObject({ model: 'b', modelProvider: 'provider-b', sandbox: 'workspace-write' });
  expect(f.mutations()).toEqual([]);
  expect(readDraft('t').text).toBe('message one');
});
