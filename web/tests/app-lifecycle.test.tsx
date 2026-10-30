import { IDBObjectStore } from 'fake-indexeddb';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enabledButton } from './enabled-button';
import { Api } from '../lib/api';
import * as operationStorage from '../lib/operations';
import { App } from '../App';
import { createOperation, listOperations, updateOperation } from '../lib/operations';
import { emptyDraft, readDraft, writeDraft } from '../lib/drafts';
const terminalLifecycle = vi.hoisted(() => ({ opens: 0, disposals: 0 }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    rows = 24;
    cols = 80;
    loadAddon() {}
    open() {
      terminalLifecycle.opens++;
    }
    clear() {}
    dispose() {
      terminalLifecycle.disposals++;
    }
    resize() {}
    write() {}
    writeln() {}
    focus() {}
    onData() {
      return { dispose() {} };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions() {
      return { rows: 24, cols: 80 };
    }
  },
}));

type Socket = {
  onopen: () => void;
  onclose: () => void;
  onmessage: (event: { data: string }) => void;
  close: () => void;
};
let settleMutations = async () => {};
async function loadedModelPicker() {
  const trigger = await screen.findByLabelText('选择模型与思考强度');
  // The summary derives from the loaded thread settings, not just catalog
  // arrival. Keep the original fixture's session-readiness synchronization.
  await waitFor(() => expect(trigger.textContent).toContain('fixture-model'), { timeout: 5000 });
  fireEvent.click(trigger);
  await screen.findByRole('option', { name: 'fixture-model' });
  await screen.findByRole('option', { name: '沿用会话模型' });
  await waitFor(() => expect((screen.getByRole('combobox', { name: '思考强度' }) as HTMLSelectElement).disabled).toBe(false));
  fireEvent.click(trigger);
}
beforeEach(() => {
  const mutations = vi.spyOn(Api.prototype, 'beginMutation');
  settleMutations = async () => {
    await Promise.allSettled(mutations.mock.results.flatMap(result =>
      result.type === 'return' ? [result.value.result] : []));
  };
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState({}, '', '/?thread=t');
  sessionStorage.setItem('harness.project', 'p');
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  terminalLifecycle.opens = 0;
  terminalLifecycle.disposals = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(async () => {
  await act(settleMutations);
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(
  initialArchived = false,
  requiresResume = false,
  attachmentRead = async (): Promise<unknown> => ({
    attachmentId: 'a',
    size: 5,
    base64: 'aGVsbG8=',
    mimeType: 'text/plain',
    name: 'fixture.txt',
  }),
  initialAuthenticated = true,
  override?: (call: { method: string; params: Record<string, unknown>; operationId?: string }) => unknown,
) {
  const sockets: Socket[] = [],
    calls: { method: string; params: Record<string, unknown>; operationId?: string }[] = [];
  let valid = initialAuthenticated,
    access = true,
    archived = initialArchived,
    sequence = 1,
    loaded = !requiresResume;
  vi.stubGlobal(
    'WebSocket',
    class {
      onopen = () => {};
      onclose = () => {};
      onmessage = (_e: { data: string }) => {};
      close() {}
      constructor() {
        sockets.push(this);
      }
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const ok = (value: unknown) => ({
        ok: true,
        status: 200,
        json: async () => (url === '/api/session' ? value : { ok: true, result: value }),
      });
      if (!access)
        return { ok: false, status: 401, json: async () => ({ message: 'Unauthorized' }) };
      if (url === '/api/session') {
        if (init?.method === 'POST') {
          valid = true;
          sequence++;
        }
        return ok({ authenticated: valid, operationRecoveryProtocol: 2, ...(valid ? { csrf: `session-${sequence}` } : {}) });
      }
      if (!valid)
        return {
          ok: false,
          status: 401,
          json: async () => ({ ok: false, error: { code: 'unauthorized' } }),
        };
      const request = JSON.parse(String(init?.body));
      calls.push(request);
      const overridden = await override?.(request);
      if (overridden !== undefined) return ok(overridden);
      const thread = { id: 't', name: 'Current thread', cwd: '/p', status: { type: 'idle' } };
      switch (request.method) {
        case 'project/list':
          return ok({ data: [{ id: 'p', name: 'Project', path: '/p' }] });
        case 'thread/list':
          return ok({
            data: request.params.archived === archived ? [thread] : [],
            nextCursor: null,
          });
        case 'model/list':
          return ok({ data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'fixture-model',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium' }], nextCursor: null });
        case 'system/provider/read':
          return ok({ revision: 'provider-fixture', defaultProviderId: 'fixture-provider', profiles: [], connections: [{
            id: 'fixture-provider', name: 'Fixture', kind: 'chatgpt-gateway', enabled: true,
            modelProvider: 'harness_fixture', model: 'fixture-model', baseUrl: 'https://example.invalid/codex',
            gatewayOAuth: { authorizationUrl: 'https://example.invalid/authorize', tokenUrl: 'https://example.invalid/token',
              clientId: 'fixture-public-client', cookieName: 'fixture-cookie' },
          }] });
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
        case 'thread/session':
          return ok(
            loaded
              ? { requiresResume: false, thread, model: 'fixture-model' }
              : { requiresResume: true },
          );
        case 'thread/resume':
          loaded = true;
          return ok({ thread, model: 'fixture-model' });
        case 'collaborationMode/list':
          return ok({ data: [] });
        case 'thread/realtime/listVoices':
          return ok({ voices: { v1: [], v2: [], v3: [] } });
        case 'process/list':
        case 'environment/list':
          return ok({ data: [] });
        case 'thread/backgroundTerminals/list':
          return ok({ data: [], nextCursor: null });
        case 'workspace/list':
          return ok({ path: '', entries: [], truncated: false });
        case 'remoteControl/status/read':
          return ok({
            status: 'connected',
            serverName: 'fixture',
            installationId: 'fixture',
            environmentId: 'native-env',
          });
        case 'remoteControl/client/list':
          return ok({ data: [], nextCursor: null });
        case 'remoteControl/pairing/start':
          return ok({
            pairingId: 'fixture-pair',
            environmentId: 'native-env',
            expiresAt: Date.now() + 10000,
          });
        case 'remoteControl/pairing/read':
          return ok({
            pairingId: 'fixture-pair',
            environmentId: 'native-env',
            pairingCode: 'owner-only-fixture-code',
            manualPairingCode: null,
            expiresAt: Date.now() + 10000,
          });
        case 'account/read':
          return ok({ account: null });
        case 'account/rateLimits':
          return ok({});
        case 'account/resetCredit/preview':
          return ok({ previewHash: 'fixture', accountId: null, redeemable: false, summary: null });
        case 'account/gatewayOAuth/read':
          return ok({
            providerId: 'fixture-provider',
            providerName: 'Fixture',
            required: true,
            status: 'notReady',
            error: null,
          });
        case 'account/gatewayOAuth/login':
          return ok({ handoffId: 'fixture-handoff' });
        case 'account/gatewayOAuth/handoff':
          return ok({
            status: 'pending',
            authUrl: 'https://example.invalid/fixture-authorization',
            expiresAt: Date.now() + 10000,
          });
        case 'prompt/list':
          return ok({ prompts: [] });
        case 'operation/read':
          return ok({ operationId: request.params.operationId, state: 'unknown' });
        case 'thread/archive':
          archived = true;
          return ok({});
        case 'thread/unarchive':
          archived = false;
          return ok({});
        case 'defaults/read':
          return ok({});
        case 'attachment/read':
          return ok(await attachmentRead());
        default:
          throw new Error(`Unexpected fixture RPC ${request.method}`);
      }
    }),
  );
  render(<App />);
  if (!initialAuthenticated) {
    fireEvent.change(await screen.findByLabelText('用户名'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'storage-fixture-only' } });
    fireEvent.click(screen.getByRole('button', { name: '进入工作台 →' }));
  }
  await waitFor(() => expect(sockets.length).toBe(1));
  const state = (connected: boolean, socket = sockets.at(-1)!) =>
    socket.onmessage({
      data: JSON.stringify({
        type: 'state',
        data: {
          connected,
          epoch: 'same-worker',
          activity: { unknown: !connected, activeThreads: [], pendingStarts: 0, terminals: 0 },
          maintenance: false,
        },
      }),
    });
  await act(async () => {
    sockets[0]!.onopen();
    state(true);
  });
  if (requiresResume)
    await screen.findByRole('button', { name: '加载并继续（可能恢复待执行任务）' });
  else await loadedModelPicker();
  return {
    sockets,
    calls,
    state,
    expire: () => {
      valid = false;
    },
    expireAccess: () => {
      access = false;
    },
    restoreAccess: () => {
      access = true;
    },
    count: (method: string) => calls.filter((call) => call.method === method).length,
  };
}
it.each([
  ['sessionStorage', 'getter'],
  ['sessionStorage', 'read'],
  ['sessionStorage', 'write'],
  ['localStorage', 'getter'],
  ['localStorage', 'read'],
  ['localStorage', 'write'],
] as const)('keeps real App login and read-only navigation available when %s %s fails', async (name, failure) => {
  const storage = window[name];
  if (failure === 'getter') {
    vi.spyOn(window, name, 'get').mockImplementation(() => {
      throw new DOMException(`${name} unavailable`, 'SecurityError');
    });
  } else if (failure === 'read') {
    const original = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (this === storage) throw new DOMException(`${name} unreadable`, 'SecurityError');
      return original.call(this, key);
    });
  } else {
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (this === storage) throw new DOMException(`${name} unwritable`, 'QuotaExceededError');
      return original.call(this, key, value);
    });
  }
  const f = await fixture(false, false, undefined, false);
  expect(screen.queryByText('工作台暂时无法打开')).toBeNull();
  expect(screen.queryByLabelText('密码')).toBeNull();
  const before = f.count('thread/list');
  fireEvent.click(screen.getByRole('button', { name: '刷新会话列表' }));
  await waitFor(() => expect(f.count('thread/list')).toBeGreaterThan(before));
  expect(f.calls.some((call) => call.method === 'thread/read')).toBe(true);
  expect(f.calls.some((call) => call.operationId)).toBe(false);
  expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => url === '/api/session' && init?.method === 'POST')).toHaveLength(1);
});
it('keeps the real App readable but sends no mutation when operation intent persistence fails', async () => {
  const f = await fixture(false, false, undefined, false), failedIntent = vi.fn();
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(() => {
    failedIntent(); throw new DOMException('operation intent unavailable', 'QuotaExceededError');
  });
  fireEvent.change(screen.getByRole('textbox', { name: '给 Codex 的消息' }), {
    target: { value: 'retain this unsent draft' },
  });
  const send = screen.getByRole('button', { name: '发送消息' });
  await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
  const before = vi.mocked(fetch).mock.calls.length;
  fireEvent.click(send);
  await waitFor(() => expect(failedIntent).toHaveBeenCalledOnce());
  expect(screen.getByText(/operation intent unavailable|请求未完成，请重试读取状态。/)).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls).toHaveLength(before);
  expect(f.count('turn/start')).toBe(0);
  expect(readDraft('t').text).toBe('retain this unsent draft');
  vi.restoreAllMocks();
  await act(async () => {});
  expect(f.count('turn/start')).toBe(0);
  const reads = f.count('thread/list');
  fireEvent.click(screen.getByRole('button', { name: '刷新会话列表' }));
  await waitFor(() => expect(f.count('thread/list')).toBeGreaterThan(reads));
  expect(f.count('turn/start')).toBe(0);
});
it('requires explicit continuation before loading a stored thread that may resume native queued work', async () => {
  const f = await fixture(false, true);
  await waitFor(() =>
    expect(
      (
        screen.getByRole('button', {
          name: '加载并继续（可能恢复待执行任务）',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(f.count('thread/resume')).toBe(0);
  fireEvent.change(screen.getByRole('textbox', { name: '给 Codex 的消息' }), {
    target: { value: 'Waiting draft' },
  });
  expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: '加载并继续（可能恢复待执行任务）' }));
  await loadedModelPicker();
  expect(f.count('thread/resume')).toBe(1);
  expect(f.count('turn/start')).toBe(0);
  expect(
    (screen.getByRole('textbox', { name: '给 Codex 的消息' }) as HTMLTextAreaElement).value,
  ).toBe('Waiting draft');
});
it('closes the action menu and gives each tool the main region while retaining pending answers', async () => {
  const f = await fixture();
  await act(async () =>
    f.sockets[0]!.onmessage({
      data: JSON.stringify({
        type: 'prompt',
        data: {
          promptId: 'question',
          threadId: 't',
          method: 'item/tool/requestUserInput',
          params: {
            threadId: 't',
            questions: [{ id: 'q', header: 'Context', question: 'Keep this answer' }],
          },
        },
      }),
    }),
  );
  const answer = await screen.findByLabelText('Context：答案');
  fireEvent.change(answer, { target: { value: 'Unsubmitted human answer' } });
  const menu = screen.getByLabelText('会话操作').closest('details')!;
  fireEvent.click(screen.getByLabelText('会话操作'));
  fireEvent.click(screen.getByRole('button', { name: '下一步建议' }));
  const heading = await screen.findByRole('heading', { name: '下一步建议' });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(menu.open).toBe(false);
  expect(document.querySelector('.conversation-scroll')).toBeNull();
  expect(screen.queryByRole('textbox', { name: '给 Codex 的消息' })).toBeNull();
  expect(screen.getByText('1 项请求等待你的决定')).toBeTruthy();
  expect(screen.queryByLabelText('Context：答案')?.closest('[hidden]')).toBeTruthy();
  expect((answer as HTMLInputElement).value).toBe('Unsubmitted human answer');
  fireEvent.click(screen.getByRole('button', { name: '处理待答请求' }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '给 Codex 的消息' })),
  );
  expect((screen.getByLabelText('Context：答案') as HTMLInputElement).value).toBe(
    'Unsubmitted human answer',
  );
  fireEvent.click(screen.getByLabelText('会话操作'));
  fireEvent.click(screen.getByRole('button', { name: '查看修改 diff' }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '当前回合修改' })),
  );
  expect(menu.open).toBe(false);
  expect(document.querySelector('.conversation-scroll')).toBeNull();
  fireEvent.click(screen.getByLabelText('会话操作'));
  fireEvent.keyDown(menu, { key: 'Escape' });
  expect(menu.open).toBe(false);
  expect(document.activeElement).toBe(screen.getByLabelText('会话操作'));
  expect(f.count('thread/prediction/request')).toBe(0);
  expect(f.count('prompt/answer')).toBe(0);
});
it('provides one common return without pending approvals and preserves owned tool mounts', async () => {
  const f = await fixture();
  const back = () => screen.getByRole('button', { name: '← 返回聊天' });
  expect(screen.queryByRole('navigation', { name: '工具视图导航' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '打开命令进程' }));
  await screen.findByRole('heading', { name: '直接执行命令' });
  fireEvent.click(screen.getByText('启动命令', { selector: 'summary' }));
  const command = screen.getByRole('textbox', { name: /命令参数/ });
  fireEvent.change(command, { target: { value: 'example\n--inspect' } });
  expect(screen.getAllByRole('button', { name: /返回聊天|返回会话/ })).toHaveLength(1);
  fireEvent.click(back());
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '给 Codex 的消息' })),
  );
  expect(command.isConnected).toBe(true);
  expect(command.closest('[hidden]')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '打开命令进程' }));
  expect(screen.getByRole('textbox', { name: /命令参数/ })).toBe(command);
  expect((command as HTMLTextAreaElement).value).toBe('example\n--inspect');
  fireEvent.click(back());
  fireEvent.click(screen.getByLabelText('会话操作'));
  fireEvent.click(screen.getByRole('button', { name: '实时语音与文字' }));
  const voice = await screen.findByRole('heading', { name: '实时语音' });
  fireEvent.click(back());
  expect(voice.isConnected).toBe(true);
  expect(voice.closest('[hidden]')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('打开官方云任务界面'));
  const terminal = await screen.findByLabelText('交互终端');
  expect(terminalLifecycle.opens).toBe(1);
  expect(screen.getAllByRole('button', { name: /返回聊天|返回会话/ })).toHaveLength(1);
  fireEvent.click(back());
  expect(terminal.isConnected).toBe(true);
  expect(terminalLifecycle.disposals).toBe(0);
  fireEvent.click(screen.getByLabelText('打开官方云任务界面'));
  expect(screen.getByLabelText('交互终端')).toBe(terminal);
  expect(terminalLifecycle.opens).toBe(1);
  fireEvent.click(back());
  for (const action of ['下一步建议', '会话命令与后台终端', '查看修改 diff']) {
    fireEvent.click(screen.getByLabelText('会话操作'));
    fireEvent.click(screen.getByRole('button', { name: action }));
    expect(screen.getAllByRole('button', { name: /返回聊天|返回会话/ })).toHaveLength(1);
    fireEvent.click(back());
  }
  fireEvent.click(screen.getByRole('button', { name: '打开项目文件' }));
  expect(back()).toBeTruthy();
  fireEvent.click(back());
  expect(f.count('process/kill')).toBe(0);
  expect(f.count('thread/realtime/stop')).toBe(0);
  expect(f.count('terminal/close')).toBe(0);
  expect(f.count('terminal/open')).toBe(0);
  expect(f.count('process/spawn')).toBe(0);
});
it('recovers outer access authentication explicitly without losing a memory-only draft or replaying writes', async () => {
  const f = await fixture(),
    original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.startsWith('harness.draft.')) throw new DOMException('quota');
    return original.call(this, key, value);
  });
  fireEvent.change(screen.getByRole('textbox', { name: '给 Codex 的消息' }), {
    target: { value: 'preserve this page in memory' },
  });
  f.expireAccess();
  fireEvent.click(screen.getByRole('button', { name: '刷新会话列表' }));
  const link = await screen.findByRole('link', { name: '在新标签页完成访问认证 ↗' });
  expect(link.getAttribute('href')).toBe(location.href);
  expect(link.getAttribute('target')).toBe('_blank');
  expect(screen.queryByLabelText('密码')).toBeNull();
  f.restoreAccess();
  fireEvent.click(screen.getByRole('button', { name: '重新检查登录' }));
  await waitFor(() => expect(f.sockets).toHaveLength(2));
  await act(async () => {
    f.sockets[1]!.onopen();
    f.state(true);
  });
  expect(
    (screen.getByRole('textbox', { name: '给 Codex 的消息' }) as HTMLTextAreaElement).value,
  ).toBe('preserve this page in memory');
  expect(f.count('turn/start')).toBe(0);
  expect(f.count('conversation/start')).toBe(0);
});
it('unmounts modal ownership on access expiry and does not reopen it after renewal', async () => {
  const op = (await createOperation('turn/start', { threadId: 'other' }));
  (await updateOperation(op.id, 'unknown'));
  const f = await fixture();
  fireEvent.change(screen.getByRole('textbox', { name: '给 Codex 的消息' }), {
    target: { value: 'draft under settings' },
  });
  fireEvent.click(screen.getByRole('button', { name: '打开设置' }));
  expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy();
  f.expireAccess();
  fireEvent.click(screen.getByRole('button', { name: '服务管理' }));
  await screen.findByRole('button', { name: '重新检查登录' });
  expect(document.querySelector('dialog')).toBeNull();
  f.restoreAccess();
  fireEvent.click(screen.getByRole('button', { name: '重新检查登录' }));
  await waitFor(() => expect(f.sockets).toHaveLength(2));
  await act(async () => {
    f.sockets[1]!.onopen();
    f.state(true);
  });
  expect(document.querySelector('dialog')).toBeNull();
  expect(
    (screen.getByRole('textbox', { name: '给 Codex 的消息' }) as HTMLTextAreaElement).value,
  ).toBe('draft under settings');
  expect((await listOperations()).find((saved) => saved.id === op.id)?.state).toBe('unknown');
  expect(f.count('turn/start')).toBe(0);
  expect(f.count('conversation/start')).toBe(0);
});
it('renews authentication without losing a draft or replaying an unresolved write', async () => {
  const op = (await createOperation('turn/start', { threadId: 'other' }));
  (await updateOperation(op.id, 'unknown'));
  const f = await fixture();
  fireEvent.change(screen.getByRole('textbox', { name: '给 Codex 的消息' }), {
    target: { value: 'draft survives login' },
  });
  f.expire();
  await act(async () => f.sockets[0]!.onclose());
  expect(await screen.findByLabelText('密码')).toBeTruthy();
  expect(readDraft('t').text).toBe('draft survives login');
  fireEvent.change(screen.getByLabelText('密码'), {
    target: { value: 'local-fixture-only' },
  });
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'admin' } });
  fireEvent.click(screen.getByRole('button', { name: '进入工作台 →' }));
  await waitFor(() => expect(f.sockets).toHaveLength(2));
  await act(async () => {
    f.sockets[1]!.onopen();
    f.state(true);
  });
  expect(
    (screen.getByRole('textbox', { name: '给 Codex 的消息' }) as HTMLTextAreaElement).value,
  ).toBe('draft survives login');
  expect((await listOperations()).find((saved) => saved.id === op.id)?.state).toBe('unknown');
  expect(f.count('turn/start')).toBe(0);
  expect(f.count('conversation/start')).toBe(0);
});
it.each(['open', 'pending'])(
  'suspends a %s attachment preview across authentication loss without losing its draft or receipt',
  async (state) => {
    URL.createObjectURL = vi.fn(() => 'blob:attachment');
    URL.revokeObjectURL = vi.fn();
    writeDraft({
      ...emptyDraft('t'),
      text: 'draft beneath preview',
      attachments: [{ attachmentId: 'a', name: 'fixture.txt', size: 5, mimeType: 'text/plain' }],
    });
    const op = (await createOperation('turn/start', { threadId: 'other' }));
    (await updateOperation(op.id, 'unknown'));
    let resolve!: (result: unknown) => void;
    const response = {
      attachmentId: 'a',
      size: 5,
      base64: 'aGVsbG8=',
      mimeType: 'text/plain',
      name: 'fixture.txt',
    };
    const read =
      state === 'open'
        ? Promise.resolve(response)
        : new Promise((done) => {
            resolve = done;
          });
    const f = await fixture(false, false, () => read);
    fireEvent.click(screen.getByRole('button', { name: '▧ fixture.txt' }));
    if (state === 'open')
      expect(
        ((await screen.findByRole('dialog', { name: 'fixture.txt' })) as HTMLDialogElement).open,
      ).toBe(true);
    else await waitFor(() => expect(f.count('attachment/read')).toBe(1));
    f.expire();
    await act(async () => f.sockets[0]!.onclose());
    const password = await screen.findByLabelText('密码');
    if (state === 'pending') await act(async () => resolve(response));
    expect(document.querySelector('dialog')?.open).toBe(false);
    password.focus();
    expect(document.activeElement).toBe(password);
    expect(fireEvent.keyDown(password, { key: 'Tab' })).toBe(true);
    fireEvent.change(password, { target: { value: 'local-fixture-only' } });
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'admin' } });
  fireEvent.click(screen.getByRole('button', { name: '进入工作台 →' }));
    await waitFor(() => expect(f.sockets).toHaveLength(2));
    await act(async () => {
      f.sockets[1]!.onopen();
      f.state(true);
    });
    expect(
      ((await screen.findByRole('dialog', { name: 'fixture.txt' })) as HTMLDialogElement).open,
    ).toBe(true);
    expect(
      (screen.getByRole('textbox', { name: '给 Codex 的消息' }) as HTMLTextAreaElement).value,
    ).toBe('draft beneath preview');
    expect(readDraft('t').attachments).toHaveLength(1);
    expect((await listOperations()).find((saved) => saved.id === op.id)?.state).toBe('unknown');
    expect(f.count('turn/start')).toBe(0);
    expect(f.count('conversation/start')).toBe(0);
    expect(f.count('attachment/read')).toBe(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:attachment');
  },
);
it('keeps an in-memory draft visible after renewal even when browser draft storage is unavailable', async () => {
  const f = await fixture(),
    original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.startsWith('harness.draft.')) throw new DOMException('quota');
    return original.call(this, key, value);
  });
  fireEvent.change(screen.getByRole('textbox', { name: '给 Codex 的消息' }), {
    target: { value: 'memory-only draft' },
  });
  f.expire();
  await act(async () => f.sockets[0]!.onclose());
  fireEvent.change(await screen.findByLabelText('密码'), {
    target: { value: 'local-fixture-only' },
  });
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'admin' } });
  fireEvent.click(screen.getByRole('button', { name: '进入工作台 →' }));
  await waitFor(() => expect(f.sockets).toHaveLength(2));
  await act(async () => {
    f.sockets[1]!.onopen();
    f.state(true);
  });
  expect(
    (screen.getByRole('textbox', { name: '给 Codex 的消息' }) as HTMLTextAreaElement).value,
  ).toBe('memory-only draft');
  expect(f.count('turn/start')).toBe(0);
});
it('refreshes connection-sensitive resources once on same-epoch recovery without replaying writes', async () => {
  const f = await fixture();
  const methods = [
    'project/list',
    'thread/list',
    'model/list',
    'thread/read',
    'thread/history',
    'thread/session',
    'prompt/list',
  ];
  const before = methods.map(f.count);
  await act(async () => f.state(false));
  await act(async () => f.state(true));
  await waitFor(() =>
    methods.forEach((method, index) => expect(f.count(method)).toBeGreaterThan(before[index]!)),
  );
  await act(async () => {});
  const after = methods.map(f.count);
  await act(async () => {
    f.state(true);
    f.state(true);
  });
  expect(methods.map(f.count)).toEqual(after);
  expect(f.count('turn/start')).toBe(0);
});
it('refreshes pure session state after native settings and unload notifications without hidden resume', async () => {
  const f = await fixture(),
    before = f.count('thread/session');
  await act(async () =>
    f.sockets.at(-1)!.onmessage({
      data: JSON.stringify({
        type: 'notification',
        data: {
          method: 'thread/settings/updated',
          params: { threadId: 't', threadSettings: {} },
        },
      }),
    }),
  );
  await waitFor(() => expect(f.count('thread/session')).toBeGreaterThan(before));
  const updated = f.count('thread/session');
  await act(async () =>
    f.sockets.at(-1)!.onmessage({
      data: JSON.stringify({
        type: 'notification',
        data: {
          method: 'thread/status/changed',
          params: { threadId: 't', status: { type: 'notLoaded' } },
        },
      }),
    }),
  );
  await waitFor(() => expect(f.count('thread/session')).toBeGreaterThan(updated));
  expect(f.count('thread/resume')).toBe(0);
});
it('keeps a selected conversation archive action independent of the sidebar filter', async () => {
  const f = await fixture();
  fireEvent.click(screen.getByRole('button', { name: '已归档' }));
  await waitFor(() =>
    expect(f.calls.filter((call) => call.method === 'thread/list').at(-1)?.params.archived).toBe(
      true,
    ),
  );
  fireEvent.click(screen.getByLabelText('会话操作'));
  expect(screen.queryByRole('button', { name: '恢复会话' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '归档会话' }));
  await waitFor(() => expect(f.count('thread/archive')).toBe(1));
  expect(f.count('thread/unarchive')).toBe(0);
});
it('uses explicit intent for an unknown deep link and invalidates selection proof after a reconnect', async () => {
  const f = await fixture(true);
  fireEvent.click(screen.getByLabelText('会话操作'));
  expect(screen.getByText('会话归档状态未同步，请明确选择目标状态。')).toBeTruthy();
  expect(screen.getByRole('button', { name: '恢复已归档会话' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '已归档' }));
  await screen.findByRole('button', { name: '恢复会话' });
  fireEvent.click(screen.getByRole('button', { name: '已归档' }));
  await waitFor(() =>
    expect(f.calls.filter((call) => call.method === 'thread/list').at(-1)?.params.archived).toBe(
      false,
    ),
  );
  expect(screen.getByRole('button', { name: '恢复会话' })).toBeTruthy();
  await act(async () => f.state(false));
  await act(async () => f.state(true));
  await screen.findByText('会话归档状态未同步，请明确选择目标状态。');
  fireEvent.click(screen.getByRole('button', { name: '恢复已归档会话' }));
  await waitFor(() => expect(f.count('thread/unarchive')).toBe(1));
});
it('opens process and remote settings read-only without starting execution or registering connections', async () => {
  const f = await fixture();
  fireEvent.click(screen.getByRole('button', { name: '打开命令进程' }));
  await screen.findByRole('heading', { name: '直接执行命令' });
  await waitFor(() => expect(f.count('process/list')).toBe(1));
  fireEvent.click(screen.getByRole('button', { name: '打开设置' }));
  fireEvent.click(screen.getByRole('button', { name: '远端环境与连接' }));
  await screen.findByRole('heading', { name: '远端执行环境' });
  await waitFor(() => expect(f.count('remoteControl/status/read')).toBe(1));
  expect(f.count('process/spawn')).toBe(0);
  expect(f.count('environment/add')).toBe(0);
  expect(f.count('environment/info')).toBe(0);
  expect(f.count('remoteControl/enable')).toBe(0);
});
it('keeps the voice panel mounted when returning to chat and does not implicitly start it', async () => {
  const f = await fixture();
  fireEvent.click(screen.getByLabelText('会话操作'));
  fireEvent.click(screen.getByRole('button', { name: '实时语音与文字' }));
  await screen.findByRole('heading', { name: '实时语音' });
  await waitFor(() => expect(f.count('thread/realtime/listVoices')).toBe(1));
  fireEvent.click(screen.getByRole('button', { name: '← 返回聊天' }));
  expect(document.querySelector('.realtime-panel')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: '实时语音' })).toBeNull();
  expect(f.count('thread/realtime/start')).toBe(0);
  expect(f.count('thread/realtime/stop')).toBe(0);
});
it('retains owner-only OAuth handoff after configuration refresh without starting it on open', async () => {
  const f = await fixture();
  fireEvent.click(screen.getByRole('button', { name: '打开设置' }));
  fireEvent.click(screen.getByRole('button', { name: '模型供应商' }));
  fireEvent.click(await screen.findByText('供应商网关 OAuth', { selector: 'summary' }));
  await screen.findByText('当前供应商：Fixture');
  expect(f.count('account/gatewayOAuth/login')).toBe(0);
  fireEvent.click(screen.getByRole('checkbox', { name: '确认开始当前供应商的网关授权流程' }));
  fireEvent.click(screen.getByRole('button', { name: '开始网关授权' }));
  const link = await screen.findByRole('link', { name: '打开此连接的网关授权链接 ↗' });
  expect(link.getAttribute('href')).toBe('https://example.invalid/fixture-authorization');
  await waitFor(() => expect(f.count('account/gatewayOAuth/read')).toBeGreaterThan(1));
  expect(screen.getByRole('link', { name: '打开此连接的网关授权链接 ↗' })).toBe(link);
  expect(f.count('account/gatewayOAuth/login')).toBe(1);
});
it('retains an accepted owner pairing through ordinary configuration revision changes', async () => {
  const f = await fixture();
  fireEvent.click(screen.getByRole('button', { name: '打开设置' }));
  fireEvent.click(screen.getByRole('button', { name: '远端环境与连接' }));
  await screen.findByText('状态：connected · fixture');
  await waitFor(() => expect(f.count('remoteControl/client/list')).toBe(1));
  fireEvent.click(screen.getByText('配对新的客户端', { selector: 'summary' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '确认创建用于授权新客户端的配对码' }));
  fireEvent.click(await enabledButton({ name: '创建一次配对' }));
  const code = await screen.findByRole('textbox', { name: '配对码' });
  expect((code as HTMLTextAreaElement).value).toBe('owner-only-fixture-code');
  await waitFor(() => expect(f.count('remoteControl/status/read')).toBeGreaterThan(1));
  expect((screen.getByRole('textbox', { name: '配对码' }) as HTMLTextAreaElement).value).toBe(
    'owner-only-fixture-code',
  );
  expect(f.count('remoteControl/pairing/start')).toBe(1);
});

it('keeps the workspace closed after authentication is lost while the initial session waits for recovery storage', async () => {
  let release!: () => void;
  const initialize = vi.spyOn(operationStorage, 'initializeOperations').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const session = vi.spyOn(Api.prototype, 'session');
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => url === '/api/session'
    ? { ok: true, status: 200, json: async () => ({ authenticated: true, operationRecoveryProtocol: 2, csrf: 'old' }) }
    : { ok: false, status: 401, json: async () => ({ ok: false, error: { code: 'unauthorized' } }) }));
  render(<App />);
  await waitFor(() => expect(initialize).toHaveBeenCalledOnce());
  const api = session.mock.contexts[0] as Api;
  await act(async () => { await expect(api.call('project/list')).rejects.toMatchObject({ code: 'unauthorized' }); release(); });
  expect(await screen.findByRole('button', { name: '进入工作台 →' })).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: '消息' })).toBeNull();
  expect(api.csrf).toBe('');
  expect(screen.getByRole('alert').textContent).toContain('登录状态已变化');
});

it('manages an unselected sidebar conversation without opening or resuming that conversation', async () => {
  const other = { id: 'other-row', name: 'Other row', cwd: '/p' };
  const f = await fixture(false, false, undefined, true, call => {
    if (call.method === 'thread/list') return { data: [{ id: 't', name: 'Current thread', cwd: '/p' }, other], nextCursor: null };
    if (call.method === 'thread/name/set') return {};
    return undefined;
  });
  fireEvent.change(screen.getByRole('textbox', { name: '给 Codex 的消息' }), { target: { value: 'keep current draft' } });
  const before = f.calls.length;
  fireEvent.click(await screen.findByRole('button', { name: '管理会话：Other row' }));
  fireEvent.click(within(screen.getByRole('group', { name: '管理会话：Other row' })).getByRole('button', { name: '重命名会话' }));
  fireEvent.change(screen.getByRole('textbox', { name: '会话名称' }), { target: { value: 'Changed other row' } });
  fireEvent.click(await enabledButton({ name: '保存名称' }));
  await waitFor(() => expect(f.count('thread/name/set')).toBe(1));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '重命名会话' })).toBeNull());
  expect(f.calls.find(call => call.method === 'thread/name/set')?.params).toEqual({ threadId: 'other-row', name: 'Changed other row' });
  expect(f.calls.slice(before).some(call => call.method === 'thread/resume' || (call.method === 'thread/read' && call.params.threadId === 'other-row'))).toBe(false);
  expect(new URL(location.href).searchParams.get('thread')).toBe('t');
  expect((screen.getByRole('textbox', { name: '给 Codex 的消息' }) as HTMLTextAreaElement).value).toBe('keep current draft');
});

it.each(['sidebar', 'settings'])('refuses removing the current project from %s while its draft cannot be saved', async source => {
  const f = await fixture();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('storage full', 'QuotaExceededError'); });
  fireEvent.change(screen.getByRole('textbox', { name: '给 Codex 的消息' }), { target: { value: 'unsaved current draft' } });
  if (source === 'sidebar') {
    fireEvent.click(screen.getByRole('button', { name: '管理项目：Project' }));
    fireEvent.click(screen.getByRole('button', { name: '移除项目（保留目录）' }));
  } else {
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }));
    fireEvent.click(screen.getByRole('button', { name: '项目目录' }));
    fireEvent.click(screen.getByRole('button', { name: '移除项目' }));
  }
  fireEvent.click(await enabledButton({ name: '移除项目' }));
  await screen.findByText(/当前草稿尚未安全保存。请先关闭此窗口/);
  expect(f.count('project/remove')).toBe(0);
  expect(new URL(location.href).searchParams.get('thread')).toBe('t');
  expect((screen.getByRole('textbox', { name: '给 Codex 的消息' }) as HTMLTextAreaElement).value).toBe('unsaved current draft');
});
