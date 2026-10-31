// @vitest-environment jsdom
import { enabledButton } from './enabled-button';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { Events } from '../lib/events';
import { McpPanel, McpEventBridge } from '../components/McpPanel';
import { McpConfiguration } from '../components/McpConfiguration';
import { McpContent } from '../components/McpContent';
import { acceptMcpIdentity, appendMcpLog, mcpSession, type McpAttempt } from '../lib/mcp-session';
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
  await screen.findByRole('option', { name: /local · connected/ });
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
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:raw-result');
  } finally {
    vi.useRealTimers();
    click.mockRestore();
  }
});
it('merges only one service and preserves omitted secrets without storing configuration in receipts', async () => {
  const existing = {
    ...config,
    servers: [
      {
        name: 'http-server',
        transport: 'http',
        enabled: true,
        effectiveEnabled: true,
        url: 'https://example.invalid/mcp',
        hasEnv: false,
        hasHttpHeaders: true,
        hasBearerTokenEnvVar: true,
        hasEnvHttpHeaders: false,
      },
    ],
  };
  const { api, calls } = setup((call) => (call.method === 'mcp/config/read' ? existing : {}));
  render(
    <McpConfiguration api={api} projectId="project" epoch="one" enabled onChanged={vi.fn()} />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '编辑 http-server' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '启用用户配置中的此服务' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存此服务配置/ }));
  fireEvent.click(screen.getByRole('button', { name: '保存此服务配置' }));
  await waitFor(() => expect(calls.some((call) => call.method === 'mcp/config/write')).toBe(true));
  const sent = calls.find((call) => call.method === 'mcp/config/write')!;
  expect(sent.params).toEqual({
    projectId: 'project',
    expectedVersion: 'v1',
    name: 'http-server',
    change: {
      type: 'upsert',
      transport: 'http',
      url: 'https://example.invalid/mcp',
      enabled: false,
    },
  });
  expect(JSON.stringify(localStorage)).not.toContain('example.invalid');
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
  await screen.findByRole('option', { name: /local · connected/ });
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
    await screen.findByRole('option', { name: /local · connected/ });
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
      ...(outcome === 'accepted' ? { resultId: 'old-result' } : { error: 'OLD_MUTATION_UNKNOWN' }),
    }));
    expect(calls.filter((call) => call.method === 'mcp/tool/call')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'mcp/result/read')).toHaveLength(0);
    if (outcome === 'unknown') expect(screen.getAllByText('OLD_MUTATION_UNKNOWN')).toHaveLength(1); // Original record only, not the new request's alert.
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
    if (outcome === 'failure') expect(screen.getByText('DIRECTORY_UNAVAILABLE')).toBeTruthy();
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
      await screen.findByRole('option', { name: /local · connected/ });
      fireEvent.change(screen.getByRole('combobox', { name: '选择 MCP 服务' }), {
        target: { value: 'local' },
      });
    }
    expect(signals[0].aborted).toBe(true);
    fireEvent.click(read());
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(signals[1].aborted).toBe(false);
    await act(async () => pending[0].reject(new Error('OBSOLETE_READ_ERROR')));
    expect(read().disabled).toBe(true);
    expect(screen.queryByText('OBSOLETE_READ_ERROR')).toBeNull();
    fireEvent.click(read());
    expect(calls.filter((call) => call.method === 'mcp/resource/read')).toHaveLength(2);
    await act(async () =>
      pending[1].resolve({ contents: [{ uri: 'file:///discovered', text: 'CURRENT_VISIT' }] }),
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
  expect(mcpSession(api, 'lease').attempts[0].state).toBe('accepted');
  await act(async () => finishResource({ contents: [] }));
});
