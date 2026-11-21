// @vitest-environment jsdom
import { enabledButton } from './enabled-button';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { Events } from '../lib/events';
import { McpPanel, McpEventBridge } from '../components/McpPanel';
import { McpConfiguration } from '../components/McpConfiguration';
import { Settings } from '../components/Settings';
import { McpContent } from '../components/McpContent';
import { acceptMcpIdentity, appendMcpLog, mcpSession, type McpAttempt } from '../lib/mcp-session';
import { listOperations } from '../lib/operations';
const transportNotice = '连接中断或请求超时，请检查网络后重新读取状态。已提交操作的结果可能未知，请查询原回执，勿重复提交。';
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const server = {
  name: 'local',
  runtimeStatus: 'connected',
  authStatus: 'notLoggedIn',
  httpOrigin: null,
  pluginId: null,
  serverInfo: { name: 'Local service' },
  toolsError: null,
  tools: {
    echo: {
      name: 'echo',
      title: 'Echo',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', title: 'Text' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  resources: [{ name: 'Document', uri: 'file:///discovered', description: 'Known resource' }],
  resourceTemplates: [],
};
const config = { userVersion: 'v1', servers: [], inheritedServers: [] };
const fallback = (call: Call): unknown =>
  call.method === 'mcp/list'
    ? { data: [server], nextCursor: null }
    : call.method === 'mcp/config/read'
      ? config
      : { data: [] };
function setup(route: (call: Call) => unknown = fallback) {
  const api = new Api(),
    calls: Call[] = [],
    events = new Events();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const call: Call = JSON.parse(String(init.body));
      calls.push(call);
      const result = await route(call);
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    }),
  );
  return { api, calls, events };
}
const panelProps = (api: Api, events: Events) => ({
  api,
  events,
  epoch: 'epoch',
  lease: 'lease',
  connected: true,
  threadId: 'thread-one',
  threadReady: true,
  historyComplete: true,
  threadIdle: true,
  configurationReady: true,
  projectId: 'project',
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function selectTool() {
  await screen.findByRole('option', { name: /local · 已连接/ });
  fireEvent.change(screen.getByRole('combobox', { name: '选择 MCP 服务' }), {
    target: { value: 'local' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: '选择工具' }), {
    target: { value: 'echo' },
  });
}
async function invoke() {
  await selectTool();
  fireEvent.click(screen.getByRole('checkbox', { name: /提供 Text/ }));
  fireEvent.change(screen.getByRole('textbox', { name: /Text/ }), { target: { value: 'hello' } });
  fireEvent.click(screen.getByRole('checkbox', { name: '确认向此服务调用所选工具与上述参数' }));
  fireEvent.click(screen.getByRole('button', { name: '调用 Echo' }));
}
it('describes the selector as inspection/manual use and never toggles Agent configuration on selection', async () => {
  const { api, events, calls } = setup();
  render(<McpPanel {...panelProps(api, events)} />);
  expect(screen.getByText(/无需在此再次勾选/).textContent).toContain('选择只用于查看服务或手动操作');
  await screen.findByRole('option', { name: /local · 已连接/ });
  const select = screen.getByRole('combobox', { name: '选择 MCP 服务' });
  fireEvent.change(select, { target: { value: 'local' } });
  expect(screen.getByText('Local service')).toBeTruthy();
  fireEvent.change(select, { target: { value: '' } });
  expect(screen.queryByText('Local service')).toBeNull();
  expect(calls.every(call => call.operationId === undefined)).toBe(true);
  expect(calls.some(call => ['mcp/config/write', 'mcp/tool/call', 'mcp/oauth/login'].includes(call.method))).toBe(false);
});
it.each(['unknown', 'not_sent'] as const)('keeps real Api MCP %s delivery distinct without resending or losing argument edits', async state => {
  const { api, events, calls } = setup(), original = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, init: RequestInit) => {
    const call = JSON.parse(String(init.body)) as Call;
    if (call.method !== 'mcp/tool/call') return original(url, init);
    calls.push(call);
    if (state === 'unknown') throw new Error('fixture-private-transport-detail');
    return { ok: false, status: 409, json: async () => ({ ok: false,
      error: { code: 'mcp_unavailable', message: '工具尚未就绪，请重新读取状态。', delivery: 'not_sent' },
    }) } as Response;
  }));
  render(<McpPanel {...panelProps(api, events)} />);
  await invoke();
  await waitFor(() => expect(mcpSession(api, 'lease').attempts[0]).toMatchObject({
    state, server: 'local', threadId: 'thread-one',
    error: state === 'unknown' ? transportNotice : '工具尚未就绪，请重新读取状态。',
  }));
  const attempt = mcpSession(api, 'lease').attempts[0]!;
  expect((await listOperations()).find(row => row.id === attempt.operationId)?.state).toBe(state);
  expect(screen.getByRole('textbox', { name: /Text/ })).toHaveProperty('value', 'hello');
  expect(screen.queryByText(/fixture-private-transport-detail/)).toBeNull();
  expect(calls.filter(call => call.method === 'mcp/tool/call')).toHaveLength(1);
  expect(calls.some(call => call.method === 'mcp/result/read')).toBe(false);
});
it('calls only a discovered tool with explicit confirmation and renders MCP isError separately', async () => {
  const { api, events, calls } = setup((call) =>
    call.method === 'mcp/tool/call'
      ? {
          resultId: 'result-one',
          threadId: 'thread-one',
          server: 'local',
          tool: 'echo',
          isError: true,
        }
      : call.method === 'mcp/result/read'
        ? {
            resultId: 'result-one',
            threadId: 'thread-one',
            server: 'local',
            tool: 'echo',
            result: { content: [{ type: 'text', text: 'Tool rejected input' }], isError: true },
          }
        : fallback(call),
  );
  render(<McpPanel {...panelProps(api, events)} />);
  await invoke();
  await screen.findByText('Tool rejected input');
  expect(screen.getByText('工具返回错误')).toBeTruthy();
  expect(calls.find((call) => call.method === 'mcp/tool/call')?.params).toEqual({
    threadId: 'thread-one',
    server: 'local',
    tool: 'echo',
    arguments: { text: 'hello' },
  });
  expect(calls.filter((call) => call.method === 'mcp/tool/call')).toHaveLength(1);
});
it('recovers an accepted lost-response tool call by original operation identity without replay', async () => {
  let id = '';
  const result = {
    resultId: 'result-one',
    threadId: 'thread-one',
    server: 'local',
    tool: 'echo',
    isError: false,
  };
  const { api, events, calls } = setup((call) => {
    if (call.method === 'mcp/tool/call') {
      id = call.operationId!;
      throw new Error('response lost');
    }
    if (call.method === 'operation/read')
      return { operationId: id, method: 'mcp/tool/call', state: 'accepted', result };
    if (call.method === 'mcp/result/read')
      return { ...result, result: { content: [{ type: 'text', text: 'Recovered output' }] } };
    return fallback(call);
  });
  render(<McpPanel {...panelProps(api, events)} />);
  await invoke();
  fireEvent.click(await enabledButton({ name: '查询原 MCP 调用回执' }));
  await screen.findByText('Recovered output');
  expect(calls.filter((call) => call.method === 'mcp/tool/call')).toHaveLength(1);
  expect(calls.find((call) => call.method === 'operation/read')?.params).toEqual({
    operationId: id,
  });
});
it('rejects late completion and result reads after connection lease replacement', async () => {
  let finish!: (value: unknown) => void;
  const { api, events, calls } = setup((call) =>
    call.method === 'mcp/tool/call'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : fallback(call),
  );
  const props = panelProps(api, events);
  const view = render(
    <>
      <McpEventBridge api={api} events={events} lease="lease" />
      <McpPanel {...props} />
    </>,
  );
  await invoke();
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.rerender(
    <>
      <McpEventBridge api={api} events={events} lease="next" />
      <McpPanel {...props} lease="next" />
    </>,
  );
  await act(async () =>
    finish({
      resultId: 'old-result',
      threadId: 'thread-one',
      server: 'local',
      tool: 'echo',
      isError: false,
    }),
  );
  expect(calls.some((call) => call.method === 'mcp/result/read')).toBe(false);
  expect(screen.queryByRole('button', { name: '重新读取原结果' })).toBeNull();
  expect(mcpSession(api, 'next').attempts).toHaveLength(0);
});
it('does not automatically resume or call tools for an unloaded thread', async () => {
  const { api, events, calls } = setup();
  render(<McpPanel {...panelProps(api, events)} threadReady={false} />);
  await selectTool();
  fireEvent.click(screen.getByRole('checkbox', { name: '确认向此服务调用所选工具与上述参数' }));
  expect((screen.getByRole('button', { name: '调用 Echo' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(calls.some((call) => ['thread/resume', 'mcp/tool/call'].includes(call.method))).toBe(
    false,
  );
});
it('keeps an accepted tool result when closing and reopening the same connection panel', async () => {
  const identity = {
    resultId: 'persisted-result',
    threadId: 'thread-one',
    server: 'local',
    tool: 'echo',
    isError: false,
  };
  const { api, events, calls } = setup((call) =>
    call.method === 'mcp/tool/call'
      ? identity
      : call.method === 'mcp/result/read'
        ? { ...identity, result: { content: [{ type: 'text', text: 'Same connection result' }] } }
        : fallback(call),
  );
  const view = render(<McpPanel {...panelProps(api, events)} />);
  await invoke();
  await screen.findByText('Same connection result');
  view.unmount();
  render(<McpPanel {...panelProps(api, events)} />);
  expect(await screen.findByText('Same connection result')).toBeTruthy();
  expect(calls.filter((call) => call.method === 'mcp/tool/call')).toHaveLength(1);
});
it('does not accept a receipt belonging to another thread, tool or result identity', () => {
  const attempt: McpAttempt = {
    operationId: 'op',
    method: 'mcp/tool/call',
    threadId: 'a',
    server: 'server',
    name: 'tool',
    state: 'unknown',
  };
  expect(() =>
    acceptMcpIdentity(attempt, {
      resultId: 'result',
      threadId: 'b',
      server: 'server',
      tool: 'tool',
      isError: false,
    }),
  ).toThrow(/身份不匹配/);
  acceptMcpIdentity(attempt, {
    resultId: 'first',
    threadId: 'a',
    server: 'server',
    tool: 'tool',
    isError: false,
  });
  expect(() =>
    acceptMcpIdentity(attempt, {
      resultId: 'second',
      threadId: 'a',
      server: 'server',
      tool: 'tool',
      isError: false,
    }),
  ).toThrow(/身份无效/);
});
it('ignores stale resource reads after navigation to another thread', async () => {
  let finish!: (value: unknown) => void;
  const { api, events, calls } = setup((call) =>
      call.method === 'mcp/resource/read'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : fallback(call),
    ),
    props = panelProps(api, events);
  const view = render(<McpPanel {...props} />);
  await selectTool();
  fireEvent.click(screen.getByRole('button', { name: '资源' }));
  fireEvent.click(screen.getByRole('button', { name: '读取此资源' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.rerender(<McpPanel {...props} threadId="thread-two" />);
  await act(async () =>
    finish({
      contents: [{ uri: 'file:///discovered', text: 'OLD_THREAD_RESOURCE' }],
      originCallId: null,
    }),
  );
  expect(screen.queryByText('OLD_THREAD_RESOURCE')).toBeNull();
  expect(calls.find((call) => call.method === 'mcp/resource/read')?.params.threadId).toBe(
    'thread-one',
  );
});
it('lists and stops current owned subscriptions while retaining bounded event evidence', async () => {
  let stopped = false;
  const { api, events, calls } = setup((call) =>
    call.method === 'mcp/stream/list'
      ? {
          data: stopped
            ? []
            : [{ subscriptionId: 'sub', threadId: 'thread-one', server: 'local', name: 'updates' }],
        }
      : call.method === 'mcp/stream/stop'
        ? ((stopped = true), { subscriptionId: 'sub', stopped: true })
        : fallback(call),
  );
  render(
    <>
      <McpEventBridge api={api} events={events} lease="lease" />
      <McpPanel {...panelProps(api, events)} />
    </>,
  );
  await screen.findByRole('button', { name: '停止此订阅' });
  act(() =>
    events.publish({
      type: 'mcp',
      data: {
        owned: true,
        subscriptionId: 'sub',
        type: 'event',
        notification: { method: 'update', params: { text: 'owned event' } },
      },
    }),
  );
  fireEvent.click(screen.getByText('最近事件'));
  expect(await screen.findByText(/owned event/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '停止此订阅' }));
  await screen.findByText('此连接没有活动订阅。');
  expect(calls.find((call) => call.method === 'mcp/stream/stop')?.params).toEqual({
    subscriptionId: 'sub',
  });
  const state = mcpSession(api, 'lease');
  for (let i = 0; i < 200; i++) appendMcpLog(state, 'sub', { text: 'x'.repeat(10000) });
  expect(state.logs.length).toBeLessThanOrEqual(100);
  expect(state.logs.reduce((n, row) => n + row.text.length * 2, 0)).toBeLessThanOrEqual(262144);
  expect(state.dropped).toBeGreaterThan(0);
});
it('renders HTML/resource contents as text and never creates executable embeds or unsafe links', () => {
  const { container } = render(
    <McpContent
      content={[
        {
          type: 'resource',
          resource: { uri: 'ui://app', mimeType: 'text/html', text: '<script>evil()</script>' },
        },
        { type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' },
        { type: 'resource_link', uri: 'javascript:evil()' },
      ]}
    />,
  );
  expect(screen.getByText('<script>evil()</script>')).toBeTruthy();
  expect(container.querySelector('script,iframe,object,img,a')).toBeNull();
});
it('retains accepted result identity, sibling text and raw download when media preview is rejected', async () => {
  const content = [
    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAALuAAAC7g' },
    { type: 'text', text: 'Original body retained' },
  ];
  const identity = {
    resultId: 'result-media',
    threadId: 'thread-one',
    server: 'local',
    tool: 'echo',
    isError: false,
  };
  const { api, events, calls } = setup((call) =>
    call.method === 'mcp/tool/call'
      ? identity
      : call.method === 'mcp/result/read'
        ? { ...identity, result: { content } }
        : fallback(call),
  );
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:raw-result');
      static revokeObjectURL = vi.fn();
    },
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    render(<McpPanel {...panelProps(api, events)} />);
    await invoke();
    await screen.findByText('Original body retained');
    fireEvent.click(screen.getByRole('button', { name: '预览 MCP 图片 1' }));
    expect(screen.getByRole('alert').textContent).toMatch(/图片格式或尺寸/);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await waitFor(() => expect(mcpSession(api, 'lease').attempts[0]).toMatchObject({
      state: 'accepted',
      resultId: 'result-media',
      body: { content },
    }));
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '下载原结果 JSON' }));
    });
    expect(click).toHaveBeenCalledOnce();
    expect((vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob).type).toBe(
      'application/json',
    );
    expect(calls.filter((call) => call.method === 'mcp/tool/call')).toHaveLength(1);
    expect(
      calls.filter((call) => call.method === 'mcp/result/read').map((call) => call.params),
    ).toEqual([{ resultId: 'result-media' }, { resultId: 'result-media' }]);
    expect(mcpSession(api, 'lease').attempts[0]?.body?.content).toEqual(content);
    expect(screen.getByText('Original body retained')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:raw-result');
    await act(() => vi.advanceTimersByTimeAsync(59_000));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:raw-result');
  } finally {
    vi.useRealTimers();
    click.mockRestore();
  }
});
const ownedStdio = { name: 'owned', transport: 'stdio', enabled: true, effectiveEnabled: true,
  command: 'worker-[redacted]', args: ['--token', '[redacted]'],
  hasEnv: true, hasHttpHeaders: false, hasBearerTokenEnvVar: false, hasEnvHttpHeaders: false };
const ownedHttp = { ...ownedStdio, name: 'remote', transport: 'http',
  url: 'http://127.0.0.1:9/mcp?token=[redacted]', command: undefined, args: undefined };
async function openOwned(catalog = () => ({ ...config, servers: [ownedStdio, ownedHttp] }), name = 'owned') {
  const { api, calls } = setup(call => call.method === 'mcp/config/read' ? catalog() : {});
  const props = { api, projectId: 'project', epoch: 'one', enabled: true, onChanged: vi.fn() };
  const view = render(<McpConfiguration {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: '编辑 ' + name }));
  return { calls, props, view };
}
async function saveOwned(calls: Call[]) {
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存此服务配置/ }));
  fireEvent.click(screen.getByRole('button', { name: '保存此服务配置' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '保存此服务配置' })).toBeNull());
  return calls.find(call => call.method === 'mcp/config/write')!.params;
}
it.each([ownedHttp, ownedStdio])('disables $transport without submitting its redacted transport fields', async server => {
  const { calls } = await openOwned(undefined, server.name);
  const field = screen.getByLabelText(server.transport === 'http' ? 'HTTP(S) 服务地址' : '程序名或路径');
  expect(field).toHaveProperty('value', '');
  fireEvent.change(field, { target: { value: 'temporary' } });
  fireEvent.change(field, { target: { value: '' } });
  fireEvent.click(screen.getByRole('checkbox', { name: '启用用户配置中的此服务' }));
  expect(await saveOwned(calls)).toEqual({ projectId: 'project', expectedVersion: 'v1', name: server.name,
    change: { type: 'upsert', transport: server.transport, enabled: false } });
  expect(JSON.stringify(await listOperations())).not.toContain('[redacted]');
});
it.each(['clear', 'replace', 'undo'] as const)('allows explicit %s of a masked argument group independently of command', async mode => {
  const { calls } = await openOwned();
  expect(screen.getByRole('button', { name: '添加参数' })).toHaveProperty('disabled', true);
  const replace = screen.getByRole('checkbox', { name: /替换全部命令参数/ });
  fireEvent.click(replace);
  if (mode !== 'clear') {
    fireEvent.click(screen.getByRole('button', { name: '添加参数' }));
    fireEvent.change(screen.getByLabelText('命令参数 1'), { target: { value: 'fixture-argument' } });
  }
  if (mode === 'undo') fireEvent.click(replace);
  fireEvent.change(screen.getByLabelText('程序名或路径'), { target: { value: 'replacement-command' } });
  expect((await saveOwned(calls)).change).toEqual({ type: 'upsert', transport: 'stdio', enabled: true,
    command: 'replacement-command', ...(mode === 'undo' ? {} : { args: mode === 'clear' ? [] : ['fixture-argument'] }) });
  expect(JSON.stringify(await listOperations())).not.toContain('fixture-argument');
});
it('sends a new address only after deliberate replacement and rejects a display placeholder', async () => {
  const { calls } = await openOwned(undefined, 'remote');
  const url = screen.getByLabelText('HTTP(S) 服务地址');
  fireEvent.change(url, { target: { value: 'http://127.0.0.1:9/[redacted]' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存此服务配置/ }));
  fireEvent.click(screen.getByRole('button', { name: '保存此服务配置' }));
  await screen.findByText(/请填写完整的新值/);
  expect(calls.some(c => c.method === 'mcp/config/write')).toBe(false);
  fireEvent.change(url, { target: { value: 'http://127.0.0.1:9/updated' } });
  expect((await saveOwned(calls)).change).toEqual({ type: 'upsert', transport: 'http', enabled: true, url: 'http://127.0.0.1:9/updated' });
  expect(JSON.stringify(await listOperations())).not.toContain('127.0.0.1');
});
it('keeps untouched transport fields after switching back, and sends the new transport on conversion', async () => {
  const { calls } = await openOwned(undefined, 'remote');
  const transport = screen.getByLabelText('传输方式');
  fireEvent.change(transport, { target: { value: 'stdio' } });
  fireEvent.change(screen.getByLabelText('程序名或路径'), { target: { value: 'local-fixture' } });
  fireEvent.change(transport, { target: { value: 'http' } });
  expect(screen.getByLabelText('HTTP(S) 服务地址')).toHaveProperty('value', '');
  fireEvent.change(transport, { target: { value: 'stdio' } });
  expect((await saveOwned(calls)).change).toEqual({ type: 'upsert', transport: 'stdio', enabled: true, command: 'local-fixture', args: [] });
});
it('omits an ordinary field edited and restored to its original value', async () => {
  const initial = { ...ownedStdio, command: 'plain-command', args: ['first', 'second'] };
  const { calls } = await openOwned(() => ({ ...config, servers: [initial] }));
  const arg = screen.getByLabelText('命令参数 1');
  fireEvent.change(arg, { target: { value: 'draft' } });
  fireEvent.change(arg, { target: { value: 'first' } });
  fireEvent.click(screen.getByLabelText('启用用户配置中的此服务'));
  expect((await saveOwned(calls)).change).toEqual({ type: 'upsert', transport: 'stdio', enabled: false });
});
it('addresses each matching display name by its selected opaque ID for edit and removal', async () => {
  const name = 'notes-[redacted]', first = 'a'.repeat(64), second = 'b'.repeat(64);
  const servers = [first, second].map(id => ({ ...ownedStdio, name, id, command: 'local' }));
  const { calls } = await openOwned(() => ({ ...config, servers }), name + ' · ' + first.slice(0, 12));
  fireEvent.click(screen.getByRole('button', { name: '编辑 ' + name + ' · ' + second.slice(0, 12) }));
  fireEvent.change(screen.getByLabelText('程序名或路径'), { target: { value: 'second-command' } });
  expect(await saveOwned(calls)).toEqual({ projectId: 'project', expectedVersion: 'v1', id: second,
    change: { type: 'upsert', transport: 'stdio', enabled: true, command: 'second-command' } });
  fireEvent.click(await screen.findByRole('button', { name: '移除 ' + name + ' · ' + first.slice(0, 12) + ' 用户配置' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '确认移除此用户服务定义' }));
  fireEvent.click(screen.getByRole('button', { name: '确认移除服务配置' }));
  await waitFor(() => expect(calls.filter(row => row.method === 'mcp/config/write')).toHaveLength(2));
  expect(calls.filter(row => row.method === 'mcp/config/write')[1]!.params).toEqual({
    projectId: 'project', expectedVersion: 'v1', id: first, change: { type: 'remove' },
  });
});
it.each(['edit', 'remove'])('requires reselection for a pending %s when the worker rotates IDs at the same version', async mode => {
  let id = 'a'.repeat(64);
  const { api, calls } = setup(c => c.method === 'mcp/config/read' ? { ...config, servers: [{ ...ownedStdio, id }] } : {});
  const props = { api, projectId: 'project', epoch: 'one', enabled: true, onChanged: vi.fn() };
  const view = render(<McpConfiguration {...props} />);
  if (mode === 'edit') {
    fireEvent.click(await screen.findByRole('button', { name: '编辑 owned' }));
    fireEvent.change(screen.getByLabelText('程序名或路径'), { target: { value: 'preserved-draft' } });
  } else fireEvent.click(await screen.findByRole('button', { name: '移除 owned 用户配置' }));
  id = 'b'.repeat(64);
  view.rerender(<McpConfiguration {...props} epoch="restarted" />);
  if (mode === 'edit') {
    await screen.findByText(/服务标识已失效/);
    expect(screen.getByLabelText('程序名或路径')).toHaveProperty('value', 'preserved-draft');
    expect(screen.getByRole('button', { name: '采用当前服务配置版本' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox', { name: /确认保存此服务配置/ }));
    expect(screen.getByRole('button', { name: '保存此服务配置' })).toHaveProperty('disabled', true);
  } else {
    await screen.findByText(/配置版本或服务标识已变化/);
    fireEvent.click(screen.getByRole('checkbox', { name: '确认移除此用户服务定义' }));
    expect(screen.getByRole('button', { name: '确认移除服务配置' })).toHaveProperty('disabled', true);
  }
  expect(calls.some(c => c.method === 'mcp/config/write')).toBe(false);
});
it('uses distinct selection IDs for masked inherited and legacy entries', async () => {
  const first = 'a'.repeat(64), second = 'b'.repeat(64), legacy = 'c'.repeat(64);
  const inheritedDetails = [first, second].map(id => ({ name: '[redacted]', id, enabled: true, overridden: false,
    transport: 'http', overrideAllowed: true }));
  const { api, calls } = setup(c => c.method === 'mcp/config/read' ? { ...config, inheritedDetails,
    legacySwitches: [{ id: legacy, name: '[redacted]', enabled: false, targetIds: [second] }] } : {});
  render(<McpConfiguration api={api} projectId="project" epoch="one" enabled onChanged={vi.fn()} />);
  const select = await screen.findByRole('combobox', { name: '将旧开关应用到' });
  expect(Array.from((select as HTMLSelectElement).options).map(option => option.value)).toEqual(['', second]);
  fireEvent.change(select, { target: { value: second } });
  fireEvent.click(screen.getByRole('button', { name: '应用原设置' }));
  await waitFor(() => expect(calls.some(c => c.method === 'mcp/config/write')).toBe(true));
  expect(calls.find(c => c.method === 'mcp/config/write')!.params).toEqual({ projectId: 'project', expectedVersion: 'v1',
    id: second, legacyId: legacy, change: { type: 'inherit', enabled: false } });
  const toggle = await waitFor(() => {
    const current = screen.getByRole('button', { name: '停用 [redacted] · ' + first.slice(0, 12) });
    expect(current).toHaveProperty('disabled', false);
    return current;
  });
  fireEvent.click(toggle);
  await waitFor(() => expect(calls.filter(c => c.method === 'mcp/config/write')).toHaveLength(2));
  expect(calls.filter(c => c.method === 'mcp/config/write')[1]!.params).toMatchObject({ id: first, change: { type: 'inherit', enabled: false } });
});
it('clears a pending legacy target when the worker rotates IDs at the same version', async () => {
  let targetId = 'a'.repeat(64), legacyId = 'b'.repeat(64);
  const { api, calls } = setup(c => c.method === 'mcp/config/read' ? { ...config,
    inheritedDetails: [{ id: targetId, name: 'remote', enabled: true, overridden: false, transport: 'http', overrideAllowed: true }],
    legacySwitches: [{ id: legacyId, name: 'remote', enabled: false, targetIds: [targetId] }] } : {});
  const props = { api, projectId: 'project', epoch: 'one', enabled: true, onChanged: vi.fn() };
  const view = render(<McpConfiguration {...props} />);
  const choose = () => screen.findByRole('combobox', { name: '将旧开关应用到' });
  fireEvent.change(await choose(), { target: { value: targetId } });
  expect(screen.getByRole('button', { name: '应用原设置' })).toHaveProperty('disabled', false);
  targetId = 'c'.repeat(64); legacyId = 'd'.repeat(64);
  view.rerender(<McpConfiguration {...props} epoch="restarted" />);
  expect(await choose()).toHaveProperty('value', '');
  expect(screen.getByRole('button', { name: '应用原设置' })).toHaveProperty('disabled', true);
  expect(calls.some(c => c.method === 'mcp/config/write')).toBe(false);
});
it('drops masked replacements on hide and leaves the saved URL out of an unrelated change', async () => {
  const { calls, props, view } = await openOwned(undefined, 'remote');
  const url = () => screen.getByLabelText('HTTP(S) 服务地址');
  fireEvent.change(url(), { target: { value: 'http://127.0.0.1:9/replacement' } });
  view.rerender(<McpConfiguration {...props} visible={false} />);
  view.rerender(<McpConfiguration {...props} visible />);
  await screen.findByRole('button', { name: '编辑 remote' });
  expect(url()).toHaveProperty('value', '');
  fireEvent.click(screen.getByRole('checkbox', { name: /清除已保存的环境变量/ }));
  expect((await saveOwned(calls)).change).toEqual({ type: 'upsert', transport: 'http', enabled: true, clearSecrets: true });
});
it('requires a fresh comparison and carries only the edited command onto the latest same-transport version', async () => {
  let version = 'v1', server = ownedStdio;
  const { calls } = await openOwned(() => ({ ...config, userVersion: version, servers: [server] }));
  fireEvent.change(screen.getByLabelText('程序名或路径'), { target: { value: 'replacement-command' } });
  const reread = () => fireEvent.click(screen.getByRole('button', { name: '重新读取服务配置' }));
  version = 'v2'; reread();
  const compare = () => screen.getByRole('checkbox', { name: /已核对当前配置/ });
  await screen.findByText(/用户配置版本已变化/);
  fireEvent.click(compare());
  version = 'v3'; server = { ...server, enabled: false, args: ['latest-argument'] }; reread();
  await screen.findByText(/用户配置版本已变化/);
  expect(compare()).toHaveProperty('checked', false);
  fireEvent.click(compare());
  fireEvent.click(screen.getByRole('button', { name: '采用当前服务配置版本' }));
  expect(screen.getByLabelText('命令参数 1')).toHaveProperty('value', 'latest-argument');
  expect(await saveOwned(calls)).toEqual({ projectId: 'project', expectedVersion: 'v3', name: 'owned',
    change: { type: 'upsert', transport: 'stdio', enabled: false, command: 'replacement-command' } });
});
it.each(['removed', 'replaced'])('requires reselection when the original server was %s at another version', async kind => {
  let changed = false;
  const { calls } = await openOwned(() => ({ ...config, userVersion: changed ? 'v2' : 'v1',
    servers: !changed ? [ownedStdio] : kind === 'removed' ? [] : [{ ...ownedHttp, name: ownedStdio.name }] }));
  changed = true;
  fireEvent.click(screen.getByRole('button', { name: '重新读取服务配置' }));
  await screen.findByText(/原服务已移除、传输方式已变化/);
  expect(screen.getByRole('button', { name: '采用当前服务配置版本' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存此服务配置/ }));
  expect(screen.getByRole('button', { name: '保存此服务配置' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: '关闭表单并清除未保存输入' }));
  expect(calls.some(call => call.method === 'mcp/config/write')).toBe(false);
});
it('preserves MCP config input during a version change until explicit rebase', async () => {
  let version = 'v1';
  const { api, calls } = setup((call) =>
    call.method === 'mcp/config/read' ? { ...config, userVersion: version } : {},
  );
  render(
    <McpConfiguration api={api} projectId="project" epoch="one" enabled onChanged={vi.fn()} />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '新增 MCP 服务' }));
  fireEvent.change(screen.getByRole('textbox', { name: '服务名称' }), {
    target: { value: 'new-service' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '程序名或路径' }), {
    target: { value: 'local-mcp' },
  });
  version = 'v2';
  fireEvent.click(screen.getByRole('button', { name: '重新读取服务配置' }));
  await screen.findByText(/用户配置版本已变化/);
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存此服务配置/ }));
  expect(
    (screen.getByRole('button', { name: '保存此服务配置' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: '已核对当前配置，保留本表单修改' }));
  fireEvent.click(screen.getByRole('button', { name: '采用当前服务配置版本' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存此服务配置/ }));
  fireEvent.click(screen.getByRole('button', { name: '保存此服务配置' }));
  await waitFor(() => expect(calls.some((call) => call.method === 'mcp/config/write')).toBe(true));
  expect(calls.find((call) => call.method === 'mcp/config/write')?.params.expectedVersion).toBe(
    'v2',
  );
});
it('sends only explicitly replaced secret groups and never persists their entered values', async () => {
  const { api, calls } = setup((call) => (call.method === 'mcp/config/read' ? config : {}));
  render(
    <McpConfiguration api={api} projectId="project" epoch="one" enabled onChanged={vi.fn()} />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '新增 MCP 服务' }));
  fireEvent.change(screen.getByRole('textbox', { name: '服务名称' }), {
    target: { value: 'private-service' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '程序名或路径' }), {
    target: { value: 'local-mcp' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /替换此组值/ }));
  fireEvent.click(screen.getByRole('button', { name: '添加环境变量' }));
  fireEvent.change(screen.getByLabelText('环境变量名称 1'), { target: { value: 'API_KEY' } });
  fireEvent.change(screen.getByLabelText('环境变量值 1'), {
    target: { value: 'test-only-private-value' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存此服务配置/ }));
  fireEvent.click(screen.getByRole('button', { name: '保存此服务配置' }));
  await waitFor(() => expect(calls.some((call) => call.method === 'mcp/config/write')).toBe(true));
  const change = calls.find((call) => call.method === 'mcp/config/write')?.params.change as Record<
    string,
    unknown
  >;
  expect(change.env).toEqual({ API_KEY: 'test-only-private-value' });
  expect(change).not.toHaveProperty('httpHeaders');
  expect(JSON.stringify(localStorage)).not.toContain('test-only-private-value');
  expect(JSON.stringify(sessionStorage)).not.toContain('test-only-private-value');
});

async function streamDraft() {
  await screen.findByRole('option', { name: /local · 已连接/ });
  fireEvent.change(screen.getByRole('combobox', { name: '选择 MCP 服务' }), {
    target: { value: 'local' },
  });
  fireEvent.click(screen.getByRole('button', { name: '事件订阅' }));
  fireEvent.change(screen.getByRole('textbox', { name: '事件流名称' }), {
    target: { value: 'updates' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '事件流参数 JSON' }), {
    target: { value: '{"scope":"local"}' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /确认启动此服务的事件订阅/ }));
}
it('retains scoped resource access and stream cleanup in a partial conversation without starting tools or streams', async () => {
  const { api, events, calls } = setup(call => {
    if (call.method === 'mcp/stream/list') return { data: [{ subscriptionId: 'sub', threadId: 'thread-one', server: 'local', name: 'updates' }] };
    if (call.method === 'mcp/stream/stop') return { subscriptionId: 'sub', stopped: true };
    if (call.method === 'mcp/resource/read') return { contents: [{ uri: 'file:///discovered', text: 'retained resource' }], originCallId: null };
    return fallback(call);
  });
  const props = panelProps(api, events);
  const view = render(<McpPanel {...props} />);
  await selectTool();
  fireEvent.click(screen.getByRole('checkbox', { name: /提供 Text/ }));
  fireEvent.change(screen.getByRole('textbox', { name: /Text/ }), { target: { value: 'desired input' } });
  fireEvent.click(screen.getByRole('checkbox', { name: '确认向此服务调用所选工具与上述参数' }));
  await enabledButton({ name: '调用 Echo' });
  view.rerender(<McpPanel {...props} historyComplete={false} />);
  expect(screen.getByText(/手动调用工具或新建事件订阅需要完整会话历史/)).toBeTruthy();
  expect(screen.getByDisplayValue('desired input')).toBeTruthy();
  expect(screen.getByRole('button', { name: '调用 Echo' })).toHaveProperty('disabled', true);
  await streamDraft();
  expect(screen.getByRole('button', { name: '启动事件订阅' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: '资源' }));
  fireEvent.click(await enabledButton({ name: '读取此资源' }));
  await screen.findByText('retained resource');
  fireEvent.click(await enabledButton({ name: '停止此订阅' }));
  await waitFor(() => expect(calls.some(call => call.method === 'mcp/stream/stop')).toBe(true));
  expect(calls.some(call => ['mcp/stream/start', 'mcp/tool/call'].includes(call.method))).toBe(false);
  expect(calls.filter(call => call.method === 'mcp/list').every(call => call.params.threadId === 'thread-one')).toBe(true);
});

it('requires fresh stream consent after switching services and changing parameters away and back', async () => {
  const { api, events, calls } = setup((call) =>
    call.method === 'mcp/list'
      ? { data: [server, { ...server, name: 'other' }], nextCursor: null }
      : fallback(call),
  );
  render(<McpPanel {...panelProps(api, events)} />);
  await streamDraft();
  const select = screen.getByRole('combobox', { name: '选择 MCP 服务' }),
    consent = () =>
      screen.getByRole('checkbox', { name: /确认启动此服务的事件订阅/ }) as HTMLInputElement;
  fireEvent.change(select, { target: { value: 'other' } });
  expect(consent().checked).toBe(false);
  expect((screen.getByRole('button', { name: '启动事件订阅' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.change(select, { target: { value: 'local' } });
  expect(consent().checked).toBe(false);
  fireEvent.click(consent());
  const input = screen.getByRole('textbox', { name: '事件流参数 JSON' });
  fireEvent.change(input, { target: { value: '{"changed":true}' } });
  fireEvent.change(input, { target: { value: '{"scope":"local"}' } });
  expect(consent().checked).toBe(false);
  expect(calls.some((call) => call.method === 'mcp/stream/start')).toBe(false);
});
it.each(['thread', 'epoch', 'lease', 'connection'] as const)(
  'invalidates stream consent after the %s scope changes away and back',
  async (field) => {
    const { api, events, calls } = setup(),
      initial = panelProps(api, events),
      view = render(<McpPanel {...initial} />);
    await streamDraft();
    view.rerender(
      <McpPanel
        {...initial}
        {...(field === 'thread'
          ? { threadId: 'other' }
          : field === 'epoch'
            ? { epoch: 'other' }
            : field === 'lease'
              ? { lease: 'other' }
              : { connected: false })}
      />,
    );
    view.rerender(<McpPanel {...initial} />);
    await screen.findByRole('option', { name: /local · 已连接/ });
    fireEvent.change(screen.getByRole('combobox', { name: '选择 MCP 服务' }), {
      target: { value: 'local' },
    });
    expect(
      (screen.getByRole('checkbox', { name: /确认启动此服务的事件订阅/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(
      (screen.getByRole('button', { name: '启动事件订阅' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(calls.some((call) => call.method === 'mcp/stream/start')).toBe(false);
  },
);
it.each(['accepted', 'failure'] as const)(
  'preserves stream draft edits while an earlier subscription is %s',
  async (outcome) => {
    let finish!: (value: unknown) => void, fail!: (error: Error) => void;
    const { api, events, calls } = setup((call) =>
      call.method === 'mcp/stream/start'
        ? new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          })
        : fallback(call),
    );
    render(<McpPanel {...panelProps(api, events)} />);
    await streamDraft();
    fireEvent.click(screen.getByRole('button', { name: '启动事件订阅' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    const input = screen.getByRole('textbox', { name: '事件流参数 JSON' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '{"next":true}' } });
    fireEvent.change(input, { target: { value: '{"scope":"local"}' } });
    await act(async () =>
      outcome === 'accepted'
        ? finish({
            subscriptionId: 'owned',
            threadId: 'thread-one',
            server: 'local',
            name: 'updates',
          })
        : fail(new Error('response lost')),
    );
    expect(input.value).toBe('{"scope":"local"}');
    expect(
      (screen.getByRole('checkbox', { name: /确认启动此服务的事件订阅/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(calls.filter((call) => call.method === 'mcp/stream/start')).toHaveLength(1);
  },
);
it('keeps a new service draft and its consent unchanged when the old service subscription is acknowledged', async () => {
  let finish!: (value: unknown) => void;
  const { api, events } = setup((call) =>
    call.method === 'mcp/list'
      ? { data: [server, { ...server, name: 'other' }], nextCursor: null }
      : call.method === 'mcp/stream/start'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : fallback(call),
  );
  render(<McpPanel {...panelProps(api, events)} />);
  await streamDraft();
  fireEvent.click(screen.getByRole('button', { name: '启动事件订阅' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  fireEvent.change(screen.getByRole('combobox', { name: '选择 MCP 服务' }), {
    target: { value: 'other' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '事件流参数 JSON' }), {
    target: { value: '{"scope":"other"}' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /确认启动此服务的事件订阅/ }));
  await act(async () =>
    finish({ subscriptionId: 'owned', threadId: 'thread-one', server: 'local', name: 'updates' }),
  );
  expect(
    (screen.getByRole('textbox', { name: '事件流参数 JSON' }) as HTMLTextAreaElement).value,
  ).toBe('{"scope":"other"}');
  expect(
    (screen.getByRole('checkbox', { name: /确认启动此服务的事件订阅/ }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  await waitFor(() => expect(mcpSession(api, 'lease').attempts[0]).toMatchObject({
    server: 'local',
    state: 'accepted',
  }));
});

it.each([
  ['重新读取原结果', 'success'],
  ['重新读取原结果', 'failure'],
  ['下载原结果 JSON', 'success'],
  ['下载原结果 JSON', 'failure'],
] as const)('keeps the new resource read pending after a late %s %s', async (button, outcome) => {
  let finishOld!: (value: unknown) => void,
    failOld!: (error: Error) => void,
    finishResource!: (value: unknown) => void;
  const { api, events, calls } = setup((call) =>
    call.method === 'mcp/list'
      ? { data: [server, { ...server, name: 'other' }], nextCursor: null }
      : call.method === 'mcp/result/read'
        ? new Promise((resolve, reject) => {
            finishOld = resolve;
            failOld = reject;
          })
        : call.method === 'mcp/resource/read'
          ? new Promise((resolve) => {
              finishResource = resolve;
            })
          : fallback(call),
  );
  mcpSession(api, 'lease').attempts.push({
    operationId: 'retained-operation',
    method: 'mcp/tool/call',
    threadId: 'thread-one',
    server: 'local',
    name: 'echo',
    state: 'accepted',
    resultId: 'retained-result',
  });
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL() {
        return 'blob:fixture';
      }
      static revokeObjectURL() {}
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<McpPanel {...panelProps(api, events)} />);
  await selectTool();
  fireEvent.click(screen.getByRole('button', { name: button }));
  await waitFor(() => expect(finishOld).toBeTypeOf('function'));
  fireEvent.change(screen.getByRole('combobox', { name: '选择 MCP 服务' }), {
    target: { value: 'other' },
  });
  fireEvent.click(screen.getByRole('button', { name: '资源' }));
  const resourceButton = () =>
    screen.getByRole('button', { name: '读取此资源' }) as HTMLButtonElement;
  fireEvent.click(resourceButton());
  await waitFor(() => expect(finishResource).toBeTypeOf('function'));
  expect(resourceButton().disabled).toBe(true);
  await act(async () =>
    outcome === 'success'
      ? finishOld({
          resultId: 'retained-result',
          threadId: 'thread-one',
          server: 'local',
          tool: 'echo',
          result: { content: [{ type: 'text', text: 'OLD_RESULT' }] },
        })
      : failOld(new Error('OLD_READ_FAILURE')),
  );
  expect(resourceButton().disabled).toBe(true);
  fireEvent.click(resourceButton());
  expect(calls.filter((call) => call.method === 'mcp/resource/read')).toHaveLength(1);
  expect(screen.queryByText('OLD_READ_FAILURE')).toBeNull();
  await act(async () =>
    finishResource({
      contents: [{ uri: 'file:///discovered', text: 'NEW_RESOURCE' }],
      originCallId: null,
    }),
  );
  await screen.findByText('NEW_RESOURCE');
  expect(resourceButton().disabled).toBe(false);
});

it.each(['accepted', 'unknown'] as const)(
  'retains an old tool mutation as %s without releasing a newer read or replaying it',
  async (outcome) => {
    let finishOld!: (value: unknown) => void,
      failOld!: (error: Error) => void,
      finishResource!: (value: unknown) => void;
    const { api, events, calls } = setup((call) =>
      call.method === 'mcp/list'
        ? { data: [server, { ...server, name: 'other' }], nextCursor: null }
        : call.method === 'mcp/tool/call'
          ? new Promise((resolve, reject) => {
              finishOld = resolve;
              failOld = reject;
            })
          : call.method === 'mcp/resource/read'
            ? new Promise((resolve) => {
                finishResource = resolve;
              })
            : fallback(call),
    );
    render(<McpPanel {...panelProps(api, events)} />);
    await invoke();
    await waitFor(() => expect(finishOld).toBeTypeOf('function'));
    fireEvent.change(screen.getByRole('combobox', { name: '选择 MCP 服务' }), {
      target: { value: 'other' },
    });
    fireEvent.click(screen.getByRole('button', { name: '资源' }));
    fireEvent.click(screen.getByRole('button', { name: '读取此资源' }));
    await waitFor(() => expect(finishResource).toBeTypeOf('function'));
    await act(async () =>
      outcome === 'accepted'
        ? finishOld({
            resultId: 'old-result',
            threadId: 'thread-one',
            server: 'local',
            tool: 'echo',
            isError: false,
          })
        : failOld(new Error('OLD_MUTATION_UNKNOWN')),
    );
    expect((screen.getByRole('button', { name: '读取此资源' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await waitFor(() => expect(mcpSession(api, 'lease').attempts[0]).toMatchObject({
      state: outcome,
      server: 'local',
      ...(outcome === 'accepted' ? { resultId: 'old-result' } : { error: transportNotice }),
    }));
    expect(calls.filter((call) => call.method === 'mcp/tool/call')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'mcp/result/read')).toHaveLength(0);
    if (outcome === 'unknown') {
      expect(screen.getAllByText(transportNotice)).toHaveLength(1); // Original record only, not the new request's alert.
      expect(screen.queryByText('OLD_MUTATION_UNKNOWN')).toBeNull();
    }
    await act(async () =>
      finishResource({ contents: [{ uri: 'file:///discovered', text: 'CURRENT_RESOURCE' }] }),
    );
    await screen.findByText('CURRENT_RESOURCE');
  },
);

it.each(['start', 'recover'] as const)(
  'lets an accepted %s body fill its session record without clearing a newer read',
  async (origin) => {
    const identity = {
      resultId: 'owned-result',
      threadId: 'thread-one',
      server: 'local',
      tool: 'echo',
      isError: false,
    };
    let finishBody!: (value: unknown) => void, finishResource!: (value: unknown) => void;
    const { api, events, calls } = setup((call) =>
      call.method === 'mcp/list'
        ? { data: [server, { ...server, name: 'other' }], nextCursor: null }
        : call.method === 'mcp/tool/call'
          ? identity
          : call.method === 'operation/read'
            ? {
                operationId: 'original-operation',
                method: 'mcp/tool/call',
                state: 'accepted',
                result: identity,
              }
            : call.method === 'mcp/result/read'
              ? new Promise((resolve) => {
                  finishBody = resolve;
                })
              : call.method === 'mcp/resource/read'
                ? new Promise((resolve) => {
                    finishResource = resolve;
                  })
                : fallback(call),
    );
    if (origin === 'recover')
      mcpSession(api, 'lease').attempts.push({
        operationId: 'original-operation',
        method: 'mcp/tool/call',
        threadId: 'thread-one',
        server: 'local',
        name: 'echo',
        state: 'unknown',
      });
    render(<McpPanel {...panelProps(api, events)} />);
    if (origin === 'start') await invoke();
    else {
      await selectTool();
      fireEvent.click(screen.getByRole('button', { name: '查询原 MCP 调用回执' }));
    }
    await waitFor(() => expect(finishBody).toBeTypeOf('function'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '选择 MCP 服务' })).toHaveProperty('disabled', false));
    fireEvent.change(screen.getByRole('combobox', { name: '选择 MCP 服务' }), {
      target: { value: 'other' },
    });
    fireEvent.click(screen.getByRole('button', { name: '资源' }));
    fireEvent.click(screen.getByRole('button', { name: '读取此资源' }));
    await waitFor(() => expect(finishResource).toBeTypeOf('function'));
    await act(async () =>
      finishBody({ ...identity, result: { content: [{ type: 'text', text: 'RETAINED_BODY' }] } }),
    );
    await screen.findByText('RETAINED_BODY');
    await waitFor(() => expect(mcpSession(api, 'lease').attempts[0]).toMatchObject({
      state: 'accepted',
      body: { content: [{ type: 'text', text: 'RETAINED_BODY' }] },
    }));
    expect((screen.getByRole('button', { name: '读取此资源' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(calls.filter((call) => call.method === 'mcp/tool/call')).toHaveLength(
      origin === 'start' ? 1 : 0,
    );
    await act(async () => finishResource({ contents: [] }));
  },
);

it.each(['success', 'failure'] as const)(
  'keeps the selected MCP option and argument draft visible during a delayed directory refresh (%s)',
  async (outcome) => {
    let finish!: (value: unknown) => void, fail!: (error: Error) => void, reads = 0;
    const { api, events, calls } = setup(call =>
      call.method === 'mcp/list' && ++reads > 1
        ? new Promise((resolve, reject) => { finish = resolve; fail = reject; })
        : fallback(call),
    );
    render(<McpPanel {...panelProps(api, events)} />);
    await selectTool();
    fireEvent.click(screen.getByRole('checkbox', { name: /提供 Text/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /Text/ }), { target: { value: 'retained draft' } });
    fireEvent.click(screen.getByRole('button', { name: '重新读取目录与订阅' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    const selector = screen.getByRole('combobox', { name: '选择 MCP 服务' });
    expect(selector).toHaveProperty('value', 'local');
    expect(selector).toHaveProperty('disabled', true);
    expect(screen.getByRole('textbox', { name: /Text/ })).toHaveProperty('value', 'retained draft');
    expect(screen.getByRole('button', { name: '调用 Echo' })).toHaveProperty('disabled', true);
    await act(async () => outcome === 'success'
      ? finish({ data: [server], nextCursor: null })
      : fail(new Error('DIRECTORY_UNAVAILABLE')));
    expect(selector).toHaveProperty('value', 'local');
    expect(selector).toHaveProperty('disabled', outcome === 'failure');
    expect(screen.getByRole('textbox', { name: /Text/ })).toHaveProperty('value', 'retained draft');
    expect(calls.some(call => call.operationId)).toBe(false);
    if (outcome === 'failure') {
      expect(screen.getByText(transportNotice)).toBeTruthy();
      expect(screen.queryByText('DIRECTORY_UNAVAILABLE')).toBeNull();
    }
  },
);

it.each(['server', 'thread', 'epoch', 'lease', 'connection'] as const)(
  'cancels old pure reads through %s A-to-B-to-A without exposing late errors or releasing the new request',
  async (field) => {
    const pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [],
      signals: AbortSignal[] = [];
    const { api, events, calls } = setup((call) =>
      call.method === 'mcp/list'
        ? { data: [server, { ...server, name: 'other' }], nextCursor: null }
        : call.method === 'mcp/resource/read'
          ? new Promise((resolve, reject) => pending.push({ resolve, reject }))
          : fallback(call),
    );
    const raw = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((url, init: RequestInit) => {
        if (JSON.parse(String(init.body)).method === 'mcp/resource/read')
          signals.push(init.signal as AbortSignal);
        return raw(url, init);
      }),
    );
    const props = panelProps(api, events),
      view = render(<McpPanel {...props} />);
    await selectTool();
    fireEvent.click(screen.getByRole('button', { name: '资源' }));
    const read = () => screen.getByRole('button', { name: '读取此资源' }) as HTMLButtonElement;
    act(() => {
      fireEvent.click(read());
      fireEvent.click(read());
    });
    await waitFor(() => expect(pending).toHaveLength(1));
    if (field === 'server') {
      fireEvent.change(screen.getByRole('combobox', { name: '选择 MCP 服务' }), {
        target: { value: 'other' },
      });
      fireEvent.change(screen.getByRole('combobox', { name: '选择 MCP 服务' }), {
        target: { value: 'local' },
      });
    } else {
      view.rerender(
        <McpPanel
          {...props}
          {...(field === 'thread'
            ? { threadId: 'other-thread' }
            : field === 'epoch'
              ? { epoch: 'other-epoch' }
              : field === 'lease'
                ? { lease: 'other-lease' }
                : { connected: false })}
        />,
      );
      view.rerender(<McpPanel {...props} />);
      await screen.findByRole('option', { name: /local · 已连接/ });
      fireEvent.change(screen.getByRole('combobox', { name: '选择 MCP 服务' }), {
        target: { value: 'local' },
      });
    }
    expect(signals[0]!.aborted).toBe(true);
    fireEvent.click(read());
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(signals[1]!.aborted).toBe(false);
    await act(async () => pending[0]!.reject(new Error('OBSOLETE_READ_ERROR')));
    expect(read().disabled).toBe(true);
    expect(screen.queryByText('OBSOLETE_READ_ERROR')).toBeNull();
    fireEvent.click(read());
    expect(calls.filter((call) => call.method === 'mcp/resource/read')).toHaveLength(2);
    await act(async () =>
      pending[1]!.resolve({ contents: [{ uri: 'file:///discovered', text: 'CURRENT_VISIT' }] }),
    );
    await screen.findByText('CURRENT_VISIT');
    expect(read().disabled).toBe(false);
  },
);

it('aborts an unmounted download and prevents its late success from downloading or clearing the reopened panel', async () => {
  let finishBody!: (value: unknown) => void,
    finishResource!: (value: unknown) => void,
    bodySignal: AbortSignal | undefined;
  const identity = {
    resultId: 'retained-result',
    threadId: 'thread-one',
    server: 'local',
    tool: 'echo',
    isError: false,
  };
  const { api, events } = setup((call) =>
    call.method === 'mcp/result/read'
      ? new Promise((resolve) => {
          finishBody = resolve;
        })
      : call.method === 'mcp/resource/read'
        ? new Promise((resolve) => {
            finishResource = resolve;
          })
        : fallback(call),
  );
  mcpSession(api, 'lease').attempts.push({
    operationId: 'retained-operation',
    method: 'mcp/tool/call',
    threadId: 'thread-one',
    server: 'local',
    name: 'echo',
    state: 'accepted',
    resultId: identity.resultId,
  });
  const raw = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn((url, init: RequestInit) => {
      if (JSON.parse(String(init.body)).method === 'mcp/result/read')
        bodySignal = init.signal as AbortSignal;
      return raw(url, init);
    }),
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const view = render(<McpPanel {...panelProps(api, events)} />);
  await selectTool();
  fireEvent.click(screen.getByRole('button', { name: '下载原结果 JSON' }));
  await waitFor(() => expect(finishBody).toBeTypeOf('function'));
  view.unmount();
  expect(bodySignal?.aborted).toBe(true);
  render(<McpPanel {...panelProps(api, events)} />);
  await selectTool();
  fireEvent.click(screen.getByRole('button', { name: '资源' }));
  fireEvent.click(screen.getByRole('button', { name: '读取此资源' }));
  await waitFor(() => expect(finishResource).toBeTypeOf('function'));
  await act(async () =>
    finishBody({
      ...identity,
      result: { content: [{ type: 'text', text: 'RETAINED_AFTER_CLOSE' }] },
    }),
  );
  expect(click).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: '读取此资源' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(mcpSession(api, 'lease').attempts[0]?.state).toBe('accepted');
  await act(async () => finishResource({ contents: [] }));
});

it('rereads the current MCP catalog, subscriptions and effective configuration after a missed event', async () => {
  let online = false;
  const { api, calls, events } = setup(call => call.method === 'mcp/list'
    ? { data: [{ ...server, runtimeStatus: online ? 'connected' : 'failed' }], nextCursor: null } : fallback(call));
  const props = panelProps(api, events);
  render(<McpPanel {...props} />);
  await screen.findByRole('option', { name: /local · 连接失败/ });
  const count = (method: string) => calls.filter(call => call.method === method).length;
  const baseline = ['mcp/list', 'mcp/stream/list', 'mcp/config/read'].map(count);
  online = true;
  act(() => events.publish({ type: 'notification', data: { method: 'mcpServer/startupStatus/updated', params: { name: 'local', threadId: 'different' } } }));
  expect(count('mcp/list')).toBe(baseline[0]);
  act(() => events.publish({ type: 'resync', data: { reason: 'events_lost' } }));
  await screen.findByRole('option', { name: /local · 已连接/ });
  await waitFor(() => expect(['mcp/list', 'mcp/stream/list', 'mcp/config/read'].map(count)).toEqual(baseline.map(n => n + 1)));
  expect(calls.filter(c => c.method === 'mcp/list').every(c => c.params.detail === 'toolsAndAuthOnly')).toBe(true);
  online = false;
  act(() => events.publish({ type: 'notification', data: { method: 'mcpServer/startupStatus/updated', params: { name: 'local', threadId: props.threadId } } }));
  await screen.findByRole('option', { name: /local · 连接失败/ });
  fireEvent.change(screen.getByRole('combobox', { name:'选择 MCP 服务' }), { target: { value:'local' } });
  fireEvent.click(screen.getByRole('button', { name: '资源' }));
  await waitFor(() => expect(calls.filter(c => c.method === 'mcp/list').at(-1)?.params.detail).toBe('full'));
});

it('preserves in-memory MCP secret on transport reconnect and clears it on project change', async () => {
  const { api, events, calls } = setup();
  const props = { ...panelProps(api, events), runtimeEpoch: 'native' };
  const view = render(<McpPanel {...props} />);
  fireEvent.click(screen.getByText('查看或编辑 MCP 服务配置', { selector: 'summary' }));
  fireEvent.click(await screen.findByRole('button', { name: '新增 MCP 服务' }));
  const env = screen.getByRole('group', { name: '环境变量' });
  fireEvent.click(env.querySelector('input[type=checkbox]')!);
  fireEvent.click(screen.getByRole('button', { name: '添加环境变量' }));
  const field = () => screen.getByLabelText('环境变量值 1');
  fireEvent.change(field(), { target: { value: 'ephemeral-mcp-key' } });
  view.rerender(<McpPanel {...props} connected={false} lease="offline" epoch="offline" />);
  view.rerender(<McpPanel {...props} lease="new-socket" epoch="after-reconnect" />);
  await waitFor(() => expect(field()).toHaveProperty('value', 'ephemeral-mcp-key'));
  expect(calls.some(c => c.operationId)).toBe(false);
  view.rerender(<McpPanel {...props} projectId="new-project" />);
  await screen.findByRole('button', { name: '新增 MCP 服务' });
  expect(screen.queryByDisplayValue('ephemeral-mcp-key')).toBeNull();
  expect(JSON.stringify(localStorage)).not.toContain('ephemeral-mcp-key');
});

it.each(['stdio','http'])('reloads the effective %s inherited MCP setting after disable and restore', async transport => {
  let enabled = true, effectiveEnabled = true, overridden = false, version = 1;
  const openService = vi.fn();
  const { api, calls, events } = setup(c => {
    if (c.method === 'mcp/config/read') return { ...config, userVersion: 'v' + version,
      inheritedServers: ['managed', 'unchanged'], inheritedDetails: [{ name: 'managed', transport, overrideAllowed:true, enabled, effectiveEnabled, restartRequired: enabled !== effectiveEnabled, overridden },
        { name: 'unchanged', transport, overrideAllowed:true, enabled: true, effectiveEnabled:true, restartRequired:false, overridden: false }] };
    if (c.method === 'mcp/config/write') {
      expect(c.params.expectedVersion).toBe('v' + version);
      const change = c.params.change as { enabled: boolean | null };
      enabled = change.enabled ?? true; overridden = change.enabled !== null; version++;
      return { written: true };
    }
    return fallback(c);
  });
  const props = panelProps(api,events);
  const view=render(<McpPanel {...props} runtimeEpoch="original-native" onServiceSettings={openService} />);
  fireEvent.click(screen.getByText('查看或编辑 MCP 服务配置', { selector: 'summary' }));
  fireEvent.click(await screen.findByRole('button', { name: '停用 managed' }));
  expect(await screen.findByText('已保存：停用 · 当前生效：启用')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'前往服务管理'}));
  expect(openService).toHaveBeenCalledOnce();
  effectiveEnabled = false;
  view.rerender(<McpPanel {...props} epoch="after-restart" runtimeEpoch="second-native" onServiceSettings={openService} />);
  expect(await screen.findByText('已保存：停用 · 当前生效：停用')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'前往服务管理'})).toBeNull();
  fireEvent.click(await enabledButton({name:'恢复继承设置'}));
  expect(await screen.findByText('已保存：启用 · 当前生效：停用')).toBeTruthy();
  effectiveEnabled = true;
  view.rerender(<McpPanel {...props} epoch="restored" runtimeEpoch="third-native" onServiceSettings={openService} />);
  await waitFor(()=>expect(screen.getAllByText('已保存：启用 · 当前生效：启用')).toHaveLength(2));
  await screen.findByRole('button', { name: '停用 managed' });
  expect(calls.filter(c => c.method === 'mcp/config/write').map(c => c.params)).toEqual([false, null].map((value, i) =>
    ({ projectId:'project', expectedVersion:'v'+(i+1), name:'managed', change:{type:'inherit',enabled:value} })));
  expect(screen.getByRole('button', { name: '停用 unchanged' })).toBeTruthy();
});

it('navigates from a saved inherited MCP change to the actual service restart confirmation screen', async () => {
  HTMLDialogElement.prototype.showModal = function(){ this.open=true; };
  HTMLDialogElement.prototype.close = function(){ this.open=false; };
  const {api,events,calls}=setup(call=>call.method==='mcp/config/read'
    ? {...config,inheritedServers:['managed'],inheritedDetails:[{ name:'managed',transport:'stdio',overrideAllowed:true,enabled:false,effectiveEnabled:true,overridden:true,restartRequired:true }]} : fallback(call));
  render(<Settings api={api} events={events} epoch="one" runtimeEpoch="native" connectionId="c"
    projects={[{id:'project',cwd:'/project',name:'Project'}]} projectId="project" theme="system"
    connected configurationReady managementReady onChanged={vi.fn()} onClose={vi.fn()} onTheme={vi.fn()}
    onOpenDraft={vi.fn()} onProjectAction={vi.fn()} onLogout={vi.fn()} />);
  fireEvent.click(screen.getByRole('button',{name:'MCP'}));
  fireEvent.click(screen.getByText('查看或编辑 MCP 服务配置',{selector:'summary'}));
  fireEvent.click(await screen.findByRole('button',{name:'前往服务管理'}));
  expect(await screen.findByRole('heading',{name:'重启服务'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'终止任务并重启服务'})).toHaveProperty('disabled',true);
  expect(calls.some(call=>call.method==='system/restart')).toBe(false);
});

it('keeps project-controlled inherited services read-only and explains the bundled HTTP compatibility setting', async () => {
  const {api,calls,events}=setup(c=>c.method==='mcp/config/read'?{...config,inheritedDetails:[
    {name:'project-only',transport:'http',overrideAllowed:false,enabled:true,effectiveEnabled:true,overridden:false},
    {name:'zread',transport:'http',overrideAllowed:true,enabled:false,effectiveEnabled:false,overridden:false},
    {name:'zread-'+'a'.repeat(32),transport:'http',overrideAllowed:true,codingPlanHttpDefaultOff:true,enabled:false,effectiveEnabled:false,overridden:false},
  ]}:fallback(c));
  render(<McpPanel {...panelProps(api,events)} />);
  fireEvent.click(screen.getByText('查看或编辑 MCP 服务配置',{selector:'summary'}));
  const locked=await screen.findByRole('button',{name:'停用 project-only'});
  expect(locked).toHaveProperty('disabled',true);
  fireEvent.click(locked);
  expect(calls.some(c=>c.method==='mcp/config/write')).toBe(false);
  const notice = screen.getByText(/智谱 Coding Plan 集成默认关闭/);
  expect(notice.parentElement?.textContent).toContain('zread-'+'a'.repeat(32));
  expect(screen.getByRole('button',{name:'启用 zread'})).toHaveProperty('disabled',false);
});

it('restores an unassigned switch only to the selected service and allows discarding without any target', async () => {
  const named = 'web-reader-' + 'e'.repeat(32);
  const unassigned: Record<string, boolean> = {'web-reader': false, zread: true};
  let version = 0;
  const {api, calls, events} = setup(c => {
    if (c.method === 'mcp/config/read') return {...config, userVersion: 'v' + version, unassigned: {...unassigned},
      inheritedDetails: [{name: named, enabled: true, effectiveEnabled: true, transport: 'http', overridden: false,
        overrideAllowed: true, managedOwner: 'e'.repeat(32)}]};
    if (c.method === 'mcp/config/write') {
      const change = c.params.change as {legacyName?: string};
      delete unassigned[change.legacyName ?? String(c.params.name)];
      version++;
      return {written:true};
    }
    return fallback(c);
  });
  render(<McpPanel {...panelProps(api,events)} />);
  fireEvent.click(screen.getByText('查看或编辑 MCP 服务配置',{selector:'summary'}));
  await screen.findByText('待确认归属的旧开关');
  const select = screen.getAllByLabelText('将旧开关应用到')[0]!;
  expect(screen.getAllByRole('button', {name:'应用原设置'})[0]).toHaveProperty('disabled', true);
  fireEvent.change(select, {target:{value:named}});
  fireEvent.click(screen.getAllByRole('button', {name:'应用原设置'})[0]!);
  await waitFor(() => expect(calls.some(c => c.method === 'mcp/config/write' && c.params.name === named &&
    JSON.stringify(c.params.change) === JSON.stringify({type:'inherit', enabled:false, legacyName:'web-reader'}))).toBe(true));
  await waitFor(() => expect(screen.getByRole('button', {name:'放弃这条旧设置'})).toHaveProperty('disabled', false));
  fireEvent.click(screen.getByRole('button', {name:'放弃这条旧设置'}));
  await waitFor(() => expect(calls.some(c => c.method === 'mcp/config/write' && c.params.name === 'zread' &&
    JSON.stringify(c.params.change) === JSON.stringify({type:'discardLegacy', enabled:true}))).toBe(true));
});
