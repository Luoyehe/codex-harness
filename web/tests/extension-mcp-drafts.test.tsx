// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { Events } from '../lib/events';
import { ExtensionsPanel } from '../components/ExtensionsPanel';
import { McpPanel } from '../components/McpPanel';
import { mcpSession } from '../lib/mcp-session';

const project = { id: 'draft-project', name: 'Draft project', cwd: '/draft-project' };
const hash = 'a'.repeat(64);
const plugin = { id: 'plugin', name: 'Plugin', source: { type: 'local', path: '/draft-project/plugin' }, remotePluginId: 'remote', shareContext: { remotePluginId: 'remote', discoverability: 'PRIVATE', sharePrincipals: [] } };
const server = { name: 'local', runtimeStatus: 'connected', authStatus: 'notLoggedIn', httpOrigin: null, pluginId: null, serverInfo: { name: 'Local' }, toolsError: null, tools: { echo: { name: 'echo', title: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string', title: 'Text' } }, required: ['text'], additionalProperties: false } } }, resources: [], resourceTemplates: [] };
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
function fallback(call: Call): unknown {
  if (call.method === 'mcp/list') return { data: [server], nextCursor: null };
  if (call.method === 'mcp/config/read') return { userVersion: 'v1', servers: [], inheritedServers: [] };
  if (call.method === 'plugin/share/list') return { data: [{ plugin, previewHash: hash, localPluginPath: '/draft-project/plugin' }] };
  if (call.method === 'plugin/list') return { marketplaces: [{ name: 'local', plugins: [plugin] }], marketplaceLoadErrors: [] };
  return { data: [], nextCursor: null };
}
function setup(route = fallback) {
  const api = new Api(), events = new Events(), calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    const call = JSON.parse(String(init.body)) as Call;
    calls.push(call);
    const result = await route(call);
    return { ok: true, status: 200, json: async () => result && typeof result === 'object' && 'error' in result ? { ok: false, ...result } : { ok: true, result } };
  }));
  return { api, events, calls };
}
const extensionProps = (api: Api) => ({ api, projects: [project], initialProjectId: project.id, epoch: 'one', enabled: true, onChanged: vi.fn() });
const mcpProps = (api: Api, events: Events) => ({ api, events, projectId: project.id, epoch: 'one', runtimeEpoch: 'runtime-one', lease: 'lease-one', connected: true, threadId: 'thread-one', threadReady: true, threadIdle: true, configurationReady: true });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function selectTool() {
  await screen.findByRole('option', { name: /local · connected/ });
  fireEvent.change(screen.getByRole('combobox', { name: '选择 MCP 服务' }), { target: { value: 'local' } });
  fireEvent.change(screen.getByRole('combobox', { name: '选择工具' }), { target: { value: 'echo' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /提供 Text/ }));
  fireEvent.change(screen.getByRole('textbox', { name: /Text/ }), { target: { value: 'draft text' } });
}
it('keeps unprepared skill text and market source across extension tabs, without retaining confirmation or persisting drafts', async () => {
  const { api, calls } = setup();
  render(<ExtensionsPanel {...extensionProps(api)} />);
  fireEvent.click(screen.getByText('在项目中新建或导入 SKILL.md', { selector: 'summary' }));
  fireEvent.change(screen.getByRole('textbox', { name: '技能目录名称' }), { target: { value: 'draft-skill' } });
  fireEvent.change(screen.getByRole('textbox', { name: '技能说明' }), { target: { value: 'draft\nbody' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /已查看内容/ }));
  fireEvent.click(screen.getByRole('button', { name: '插件与市场' }));
  fireEvent.click(screen.getByRole('button', { name: '添加市场' }));
  fireEvent.change(screen.getByRole('combobox', { name: '市场类型' }), { target: { value: 'git' } });
  fireEvent.change(screen.getByRole('textbox', { name: '不含凭据的 HTTPS 仓库地址' }), { target: { value: 'https://example.test/catalog.git' } });
  fireEvent.change(screen.getByRole('textbox', { name: '分支或标签（可选）' }), { target: { value: 'draft-ref' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /确认添加所选来源/ }));
  fireEvent.click(screen.getByRole('button', { name: '技能与 Hooks' }));
  expect(screen.getByRole('textbox', { name: '技能目录名称' })).toHaveProperty('value', 'draft-skill');
  expect(screen.getByRole('textbox', { name: '技能说明' })).toHaveProperty('value', 'draft\nbody');
  expect(screen.getByRole('checkbox', { name: /已查看内容/ })).toHaveProperty('checked', false);
  fireEvent.click(screen.getByRole('button', { name: '插件与市场' }));
  expect(screen.getByRole('textbox', { name: '不含凭据的 HTTPS 仓库地址' })).toHaveProperty('value', 'https://example.test/catalog.git');
  expect(screen.getByRole('textbox', { name: '分支或标签（可选）' })).toHaveProperty('value', 'draft-ref');
  expect(screen.getByRole('checkbox', { name: /确认添加所选来源/ })).toHaveProperty('checked', false);
  expect(calls.some(call => call.operationId)).toBe(false);
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});
it('keeps remote recipient edits through hidden and refreshed loading states while clearing approval', async () => {
  let hold = false, finish!: (value: unknown) => void;
  const { api, calls } = setup(call => hold && call.method === 'plugin/share/list' ? new Promise(resolve => { finish = resolve; }) : fallback(call));
  render(<ExtensionsPanel {...extensionProps(api)} />);
  fireEvent.click(screen.getByRole('button', { name: '插件共享' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Plugin · PRIVATE' }));
  fireEvent.click(screen.getByText('修改共享范围', { selector: 'summary' }));
  fireEvent.click(screen.getByRole('button', { name: '添加明确接收者' }));
  fireEvent.change(screen.getByRole('textbox', { name: '接收者 ID' }), { target: { value: 'draft-recipient' } });
  fireEvent.click(screen.getByRole('checkbox', { name: '确认使用上述范围与完整接收者列表' }));
  fireEvent.click(screen.getByRole('button', { name: '技能与 Hooks' }));
  hold = true;
  fireEvent.click(screen.getByRole('button', { name: '插件共享' }));
  expect(screen.getByRole('textbox', { name: '接收者 ID' })).toHaveProperty('value', 'draft-recipient');
  expect(screen.getByRole('checkbox', { name: '确认使用上述范围与完整接收者列表' })).toHaveProperty('checked', false);
  expect(screen.getByRole('button', { name: '保存共享范围' })).toHaveProperty('disabled', true);
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  await act(async () => finish(fallback({ method: 'plugin/share/list', params: {} })));
  expect(screen.getByRole('textbox', { name: '接收者 ID' })).toHaveProperty('value', 'draft-recipient');
  expect(calls.some(call => call.operationId)).toBe(false);
});
it('keeps both MCP argument modes across internal tabs and directory reload but invalidates confirmation', async () => {
  const { api, events, calls } = setup();
  render(<McpPanel {...mcpProps(api, events)} />);
  await selectTool();
  fireEvent.click(screen.getByRole('checkbox', { name: '确认向此服务调用所选工具与上述参数' }));
  fireEvent.click(screen.getByRole('button', { name: '资源' }));
  fireEvent.click(screen.getByRole('button', { name: '工具' }));
  expect(screen.getByRole('textbox', { name: /Text/ })).toHaveProperty('value', 'draft text');
  expect(screen.getByRole('checkbox', { name: '确认向此服务调用所选工具与上述参数' })).toHaveProperty('checked', false);
  fireEvent.click(screen.getByRole('checkbox', { name: '使用此工具的 JSON 参数编辑器' }));
  fireEvent.change(screen.getByRole('textbox', { name: '工具参数 JSON' }), { target: { value: '{"text":"json draft"}' } });
  fireEvent.click(screen.getByRole('button', { name: '事件订阅' }));
  fireEvent.click(screen.getByRole('button', { name: '工具' }));
  fireEvent.click(screen.getByRole('button', { name: '重新读取目录与订阅' }));
  await waitFor(() => expect(calls.filter(call => call.method === 'mcp/list')).toHaveLength(2));
  expect(screen.getByRole('textbox', { name: '工具参数 JSON' })).toHaveProperty('value', '{"text":"json draft"}');
  expect(calls.some(call => call.operationId)).toBe(false);
});

it('pauses extension reads while hidden and preserves only the same owner draft', async () => {
  const { api, calls } = setup(), props = extensionProps(api);
  const view = render(<ExtensionsPanel {...props} />);
  fireEvent.click(screen.getByText('在项目中新建或导入 SKILL.md', { selector: 'summary' }));
  fireEvent.change(screen.getByRole('textbox', { name: '技能说明' }), { target: { value: 'same-owner text' } });
  await act(async () => {});
  view.rerender(<ExtensionsPanel {...props} visible={false} />);
  const count = calls.length;
  fireEvent.click(screen.getAllByRole('button', { hidden: true }).find(button => button.textContent === '重新读取')!);
  await act(async () => {});
  expect(calls).toHaveLength(count);
  view.rerender(<ExtensionsPanel {...props} />);
  expect(screen.getByRole('textbox', { name: '技能说明' })).toHaveProperty('value', 'same-owner text');
  view.rerender(<ExtensionsPanel {...props} api={new Api()} />);
  view.rerender(<ExtensionsPanel {...props} />);
  expect(screen.getByLabelText('技能说明')).toHaveProperty('value', '');
});

it('drops extension drafts when their explicit project selection changes away and back', async () => {
  const { api } = setup(), other = { ...project, id: 'other-project', cwd: '/other' };
  render(<ExtensionsPanel {...extensionProps(api)} projects={[project, other]} />);
  fireEvent.click(screen.getByText('在项目中新建或导入 SKILL.md', { selector: 'summary' }));
  fireEvent.change(screen.getByRole('textbox', { name: '技能说明' }), { target: { value: 'old-project text' } });
  fireEvent.change(screen.getByRole('combobox', { name: '扩展与配置的项目范围' }), { target: { value: other.id } });
  fireEvent.change(screen.getByRole('combobox', { name: '扩展与配置的项目范围' }), { target: { value: project.id } });
  expect(screen.getByLabelText('技能说明')).toHaveProperty('value', '');
});

it('pauses hidden MCP reads, keeps arguments through returning loading, and rejects hidden submission', async () => {
  let hold = false, finish!: (value: unknown) => void;
  const { api, events, calls } = setup(call => hold && call.method === 'mcp/list' ? new Promise(resolve => { finish = resolve; }) : fallback(call));
  const props = mcpProps(api, events), view = render(<McpPanel {...props} />);
  await selectTool();
  fireEvent.click(screen.getByRole('checkbox', { name: '确认向此服务调用所选工具与上述参数' }));
  const form = screen.getByRole('button', { name: '调用 Echo' }).closest('form')!;
  view.rerender(<McpPanel {...props} visible={false} />);
  const count = calls.length;
  fireEvent.submit(form);
  act(() => events.publish({ type: 'mcp', data: { owned: true, type: 'closed' } }));
  await act(async () => {});
  expect(calls).toHaveLength(count);
  hold = true;
  view.rerender(<McpPanel {...props} />);
  expect(screen.getByRole('textbox', { name: /Text/ })).toHaveProperty('value', 'draft text');
  expect(screen.getByRole('button', { name: '调用 Echo' })).toHaveProperty('disabled', true);
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  await act(async () => finish(fallback({ method: 'mcp/list', params: {} })));
  expect(screen.getByRole('textbox', { name: /Text/ })).toHaveProperty('value', 'draft text');
  expect(screen.getByRole('checkbox', { name: '确认向此服务调用所选工具与上述参数' })).toHaveProperty('checked', false);
  expect(calls.some(call => call.operationId)).toBe(false);
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

it.each(['api', 'projectId', 'threadId', 'epoch', 'runtimeEpoch', 'lease'] as const)(
  'isolates MCP arguments when %s changes away and back', async field => {
    const { api, events } = setup(), props = mcpProps(api, events);
    const view = render(<McpPanel {...props} />);
    await selectTool();
    view.rerender(<McpPanel {...props} {...(field === 'api' ? { api: new Api() } : { [field]: 'other-owner' })} />);
    view.rerender(<McpPanel {...props} />);
    await screen.findByRole('option', { name: /local · connected/ });
    expect(screen.getByRole('combobox', { name: '选择 MCP 服务' })).toHaveProperty('value', '');
    fireEvent.change(screen.getByRole('combobox', { name: '选择 MCP 服务' }), { target: { value: 'local' } });
    fireEvent.change(screen.getByRole('combobox', { name: '选择工具' }), { target: { value: 'echo' } });
    expect(screen.getByRole('textbox', { name: /Text/ })).toHaveProperty('value', '');
  },
);

it.each(['accepted', 'unknown'] as const)('retains the original %s MCP receipt after hiding without reading or replaying', async outcome => {
  let finish!: (value: unknown) => void, fail!: (error: Error) => void;
  const { api, events, calls } = setup(call => call.method === 'mcp/tool/call' ? new Promise((resolve, reject) => { finish = resolve; fail = reject; }) : fallback(call));
  const props = mcpProps(api, events), view = render(<McpPanel {...props} />);
  await selectTool();
  fireEvent.click(screen.getByRole('checkbox', { name: '确认向此服务调用所选工具与上述参数' }));
  fireEvent.click(screen.getByRole('button', { name: '调用 Echo' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.rerender(<McpPanel {...props} visible={false} />);
  await act(async () => outcome === 'accepted' ? finish({ resultId: 'original-result', threadId: props.threadId, server: 'local', tool: 'echo', isError: false }) : fail(new Error('original unknown')));
  await waitFor(() => expect(mcpSession(api, props.lease).attempts[0]).toMatchObject({ state: outcome, threadId: props.threadId, name: 'echo' }));
  view.rerender(<McpPanel {...props} />);
  await screen.findByRole('option', { name: /local · connected/ });
  expect(calls.filter(call => call.method === 'mcp/tool/call')).toHaveLength(1);
  expect(calls.some(call => call.method === 'mcp/result/read')).toBe(false);
  expect(screen.getByRole('textbox', { name: /Text/ })).toHaveProperty('value', 'draft text');
});

it.each(['accepted', 'unknown'] as const)('retains a late %s OAuth receipt while hidden without fetching its handoff', async outcome => {
  let finish!: (value: unknown) => void, fail!: (error: Error) => void;
  const { api, events, calls } = setup(call => call.method === 'mcp/oauth' ? new Promise((resolve, reject) => { finish = resolve; fail = reject; }) : fallback(call));
  const props = mcpProps(api, events), view = render(<McpPanel {...props} />);
  await selectTool();
  fireEvent.click(screen.getByRole('button', { name: '请求此服务授权' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.rerender(<McpPanel {...props} visible={false} />);
  await act(async () => outcome === 'accepted' ? finish({ handoffId: 'original-handoff', epoch: props.runtimeEpoch, name: 'local', threadId: props.threadId }) : fail(new Error('oauth response lost')));
  await waitFor(() => expect(mcpSession(api, props.lease).oauth[0]).toMatchObject({ state: outcome, name: 'local' }));
  view.rerender(<McpPanel {...props} />);
  await screen.findByRole('option', { name: /local · connected/ });
  expect(screen.getByRole('button', { name: '查询原 MCP 授权回执' })).toHaveProperty('disabled', false);
  expect(calls.filter(call => call.method === 'mcp/oauth')).toHaveLength(1);
  expect(calls.some(call => call.method === 'mcp/oauth/handoff')).toBe(false);
  expect(screen.queryByRole('link', { name: /打开 MCP 授权页面/ })).toBeNull();
});

it('does not restore an old OAuth handoff link after hiding and returning', async () => {
  let finish!: (value: unknown) => void;
  const identity = { handoffId: 'old-handoff', epoch: 'runtime-one', name: 'local', threadId: 'thread-one' };
  const { api, events, calls } = setup(call => call.method === 'mcp/oauth' ? identity : call.method === 'mcp/oauth/handoff' ? new Promise(resolve => { finish = resolve; }) : fallback(call));
  const props = mcpProps(api, events), view = render(<McpPanel {...props} />);
  await selectTool();
  fireEvent.click(screen.getByRole('button', { name: '请求此服务授权' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.rerender(<McpPanel {...props} visible={false} />);
  view.rerender(<McpPanel {...props} />);
  await act(async () => finish({ ...identity, status: 'pending', authorizationUrl: 'https://example.test/authorize?secret=old', expiresAt: Date.now() + 60000 }));
  expect(screen.queryByRole('link', { name: /打开 MCP 授权页面/ })).toBeNull();
  await waitFor(() => expect(mcpSession(api, props.lease).oauth[0]).toMatchObject({ state: 'accepted', identity }));
  expect(calls.filter(call => call.method === 'mcp/oauth')).toHaveLength(1);
  expect(calls.filter(call => call.method === 'mcp/oauth/handoff')).toHaveLength(1);
});

it('keeps a prepared skill file editor mounted while directory metadata is reloaded', async () => {
  let hold = false, finish!: (value: unknown) => void;
  const { api } = setup(call => {
    if (call.method !== 'workspace/metadata') return fallback(call);
    if (hold && call.params.path === '.agents') return new Promise(resolve => { finish = resolve; });
    return String(call.params.path).endsWith('SKILL.md')
      ? { error: { code: 'not_found', message: 'Missing', delivery: 'not_sent' } }
      : { path: call.params.path, kind: 'directory', revision: hash };
  });
  render(<ExtensionsPanel {...extensionProps(api)} />);
  fireEvent.click(screen.getByText('在项目中新建或导入 SKILL.md', { selector: 'summary' }));
  fireEvent.change(screen.getByRole('textbox', { name: '技能目录名称' }), { target: { value: 'draft-skill' } });
  fireEvent.change(screen.getByRole('textbox', { name: '技能说明' }), { target: { value: 'prepared body' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /已查看内容/ }));
  fireEvent.click(screen.getByRole('button', { name: '保存本地草稿并检查目录' }));
  const editor = await screen.findByRole('textbox', { name: '文件内容' });
  fireEvent.change(editor, { target: { value: 'new prepared edit' } });
  hold = true;
  fireEvent.click(screen.getByRole('button', { name: '重新检查目录与文件' }));
  expect(screen.getByRole('textbox', { name: '文件内容' })).toBe(editor);
  expect(screen.getByRole('button', { name: '创建文件' })).toHaveProperty('disabled', true);
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  await act(async () => finish({ path: '.agents', kind: 'directory', revision: hash }));
  expect(screen.getByRole('textbox', { name: '文件内容' })).toBe(editor);
  expect(editor).toHaveProperty('value', 'new prepared edit');
});
