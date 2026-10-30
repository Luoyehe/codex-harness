// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../App';
import { Composer } from '../components/Composer';
import type { Api } from '../lib/api';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState({}, '', '/');
});
it('refreshes inherited thread settings after an accepted override and hides old values during that read', async () => {
  history.replaceState({}, '', '/?thread=t');
  Element.prototype.scrollIntoView = vi.fn();
  let socket!: { onopen: () => void; onmessage: (e: { data: string }) => void; close: () => void };
  vi.stubGlobal(
    'WebSocket',
    class {
      onopen = () => {};
      onmessage = (_e: { data: string }) => {};
      close() {}
      constructor() {
        socket = this;
      }
    },
  );
  let resumed = 0,
    finishResume!: () => void;
  const sent: Record<string, unknown>[] = [];
  const thread = { id: 't', name: 'Current', cwd: '/p', status: { type: 'idle' } };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const ok = (result: unknown) => ({
        ok: true,
        json: async () => (url === '/api/session' ? result : { ok: true, result }),
      });
      if (url === '/api/session') return ok({ authenticated: true, operationRecoveryProtocol: 2, csrf: 'fixture-only' });
      const request = JSON.parse(String(init?.body)),
        p = request.params;
      switch (request.method) {
        case 'project/list':
          return ok({ data: [{ id: 'p', name: 'Project', path: '/p' }] });
        case 'thread/list':
          return ok({ data: [thread], nextCursor: null });
        case 'model/list':
          return ok({
            data: [
              { id: 'thread-original' },
              { id: 'selected', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
            ],
            nextCursor: null,
          });
        case 'defaults/read':
          return ok({
            model: 'project-default',
            reasoningEffort: 'medium',
            approvalPolicy: 'on-request',
            sandbox: { type: 'workspaceWrite' },
          });
        case 'thread/read':
          return ok({ thread });
        case 'thread/history':
          return ok({
            turns: [],
            timeline: [],
            turnsComplete: true,
            timelineComplete: true,
            historyVersion: 0,
            activeRealtimeSessionAtPageStart: null,
            complete: true,
            nextCursor: null,
          });
        case 'prompt/list':
          return ok({ prompts: [] });
        case 'thread/session':
          if (++resumed === 1)
            return ok({
              requiresResume: false,
              thread,
              model: 'thread-original',
              reasoningEffort: 'low',
              approvalPolicy: 'on-request',
              sandbox: { type: 'workspaceWrite' },
            });
          return new Promise((resolve) => {
            finishResume = () =>
              resolve(
                ok({
                  requiresResume: false,
                  thread,
                  model: 'selected',
                  reasoningEffort: 'high',
                  approvalPolicy: 'never',
                  sandbox: { type: 'readOnly' },
                }),
              );
          });
        case 'turn/start':
          sent.push(p);
          return ok({ turn: { id: 'new-turn', status: 'completed', items: [] } });
        default:
          throw new Error(`Unexpected fixture request: ${request.method}`);
      }
    }),
  );
  render(<App />);
  await waitFor(() => expect(socket).toBeTruthy());
  act(() => {
    socket.onopen();
    socket.onmessage({
      data: JSON.stringify({
        type: 'state',
        data: {
          connected: true,
          epoch: 'one',
          activity: { unknown: false },
          activityUncertain: false,
        },
      }),
    });
  });
  // The initial connection establishes a new resource generation.
  await waitFor(() => expect(resumed).toBeGreaterThanOrEqual(1));
  if (resumed > 1) await act(async () => finishResume());
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(
      true,
    ),
  );
  fireEvent.click(screen.getByText((_, element) => element?.getAttribute('aria-label') === '选择模型与思考强度'));
  fireEvent.change(screen.getByRole('combobox', { name: '模型' }), {
    target: { value: 'selected' },
  });
  fireEvent.click(screen.getByRole('button', { name: '对话设置' }));
  fireEvent.change(screen.getByRole('combobox', { name: '思考强度' }), {
    target: { value: 'high' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: '审批策略' }), {
    target: { value: 'never' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: '文件访问' }), {
    target: { value: 'read-only' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '给 Codex 的消息' }), {
    target: { value: 'test input' },
  });
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  const before = resumed;
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(resumed).toBeGreaterThan(before));
  expect(sent[0]?.options).toEqual({
    model: 'selected',
    effort: 'high',
    approvalPolicy: 'never',
    sandbox: 'read-only',
  });
  const model = screen.getByRole('combobox', { name: '模型' }) as HTMLSelectElement;
  expect(model.value).toBe('');
  expect(model.selectedOptions[0]?.textContent).toContain('正在读取');
  expect(
    within(screen.getByRole('combobox', { name: '审批策略' })).getByRole('option', {
      name: /沿用会话设置/,
    }).textContent,
  ).toContain('正在读取');
  await act(async () => finishResume());
  await waitFor(() =>
    expect(model.selectedOptions[0]?.textContent).toBe('沿用会话模型'),
  );
  expect(
    within(screen.getByRole('combobox', { name: '思考强度' })).getByRole('option', {
      name: /模型默认/,
    }).textContent,
  ).toContain('高');
  expect(
    within(screen.getByRole('combobox', { name: '审批策略' })).getByRole('option', {
      name: /沿用会话设置/,
    }).textContent,
  ).toContain('never');
  expect(
    within(screen.getByRole('combobox', { name: '文件访问' })).getByRole('option', {
      name: /沿用会话设置/,
    }).textContent,
  ).toContain('readOnly');
});
it('labels new-thread fallback as project defaults and hides stale values while loading', () => {
  const props = {
    api: {} as Api,
    value: '',
    onChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    busy: false,
    disabled: false,
    active: false,
    options: {},
    onOptions: vi.fn(),
    models: [],
    defaults: { model: 'old-model', reasoningEffort: 'old-effort' },
    defaultsLoading: true,
    notice: '',
    contextKey: 'new:p',
  };
  render(<Composer {...props} />);
  fireEvent.click(screen.getByText((_, element) => element?.getAttribute('aria-label') === '选择模型与思考强度'));
  const model = screen.getByRole('combobox', { name: '模型' }) as HTMLSelectElement;
  expect(model.selectedOptions[0]?.textContent).toBe('正在读取默认设置…');
  expect(screen.queryByText(/old-effort/)).toBeNull();
});
it('waits for fresh defaults after resetting an explicit provider before submitting a collaboration mode', async () => {
  sessionStorage.setItem('harness.project', 'p');
  Element.prototype.scrollIntoView = vi.fn();
  let socket!: { onopen: () => void; onmessage: (e: { data: string }) => void };
  vi.stubGlobal('WebSocket', class {
    onopen = () => {};
    onmessage = (_e: { data: string }) => {};
    close() {}
    constructor() { socket = this; }
  });
  let holdDefault = false;
  let releaseDefault: (() => void) | undefined;
  const sent: Record<string, unknown>[] = [];
  const defaultModel = { model: 'default-model', modelProvider: 'first', reasoningEffort: 'low' };
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const ok = (result: unknown) => ({ ok: true, json: async () => url === '/api/session' ? result : { ok: true, result } });
    if (url === '/api/session') return ok({ authenticated: true, operationRecoveryProtocol: 2, csrf: 'fixture-only' });
    const request = JSON.parse(String(init?.body));
    switch (request.method) {
      case 'project/list': return ok({ data: [{ id: 'p', name: 'Project', path: '/p' }] });
      case 'thread/list': return ok({ data: [], nextCursor: null });
      case 'prompt/list': return ok({ prompts: [] });
      case 'model/list': return ok({ data: [
        { id: 'default-model', modelProvider: 'first', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
        { id: 'other-model', modelProvider: 'second', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
      ], nextCursor: null });
      case 'collaborationMode/list': return ok({ data: [{ name: 'Plan', mode: 'plan', model: null, reasoning_effort: null }] });
      case 'defaults/read':
        if (request.params.options.model) return ok({ model: 'other-model', modelProvider: 'second', reasoningEffort: 'high' });
        if (holdDefault) return new Promise(resolve => { releaseDefault = () => resolve(ok(defaultModel)); });
        return ok(defaultModel);
      case 'conversation/start':
        sent.push(request.params);
        return { ok: true, json: async () => ({ ok: false, error: { code: 'fixture_finished', message: 'fixture finished', delivery: 'not_sent' } }) };
      default: throw new Error(`Unexpected fixture RPC ${request.method}`);
    }
  }));
  render(<App />);
  await waitFor(() => expect(socket).toBeTruthy());
  act(() => {
    socket.onopen();
    socket.onmessage({ data: JSON.stringify({ type: 'state', data: { connected: true, epoch: 'stable',
      activity: { unknown: false, activeThreads: [], pendingStarts: 0, terminals: 0 }, activityUncertain: false } }) });
  });
  await waitFor(() => expect(screen.getByLabelText('选择模型与思考强度').textContent).toContain('default-model'));
  fireEvent.click(screen.getByLabelText('选择模型与思考强度'));
  fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: JSON.stringify(['second', 'other-model']) } });
  fireEvent.change(screen.getByRole('combobox', { name: '协作模式' }), { target: { value: 'plan' } });
  const input = screen.getByRole('textbox', { name: '给 Codex 的消息' });
  fireEvent.change(input, { target: { value: 'keep this input' } });
  await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' }).matches(':disabled')).toBe(false));
  holdDefault = true;
  fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: '' } });
  // The debounce still owns the previous explicit provider's defaults here.
  expect(screen.getByRole('button', { name: '发送消息' }).matches(':disabled')).toBe(true);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(sent).toHaveLength(0);
  await waitFor(() => expect(releaseDefault).toBeTypeOf('function'));
  // The request has started, but its response has not arrived either.
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(sent).toHaveLength(0);
  await act(async () => releaseDefault!());
  await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' }).matches(':disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]!.options).toEqual({ collaborationMode: { mode: 'plan', settings: {
    model: 'default-model', reasoning_effort: 'low', developer_instructions: null,
  } } });
  expect((input as HTMLTextAreaElement).value).toBe('keep this input');
  await screen.findByText('fixture finished');
});
