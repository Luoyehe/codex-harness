// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { McpConfiguration } from '../components/McpConfiguration';
import { PluginSharing } from '../components/PluginSharing';
import { ProviderSettings } from '../components/ProviderSettings';

type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const project = { id: 'p', name: 'Project', cwd: '/project' };
const props = { epoch: 'one', enabled: true, onChanged: vi.fn() };
const server = (name: string) => ({ name, command: name, transport: 'stdio', enabled: true,
  effectiveEnabled: true, hasEnv: false, hasHttpHeaders: false, hasBearerTokenEnvVar: false, hasEnvHttpHeaders: false });
const share = (id: string) => ({ previewHash: 'a'.repeat(64), plugin: {
  id, name: id, remotePluginId: id, shareContext: { remotePluginId: id, discoverability: 'PRIVATE', sharePrincipals: [] },
} });
const registry = (revision = 'r1') => ({ revision, kind: 'responses', defaultProviderId: 'a', profiles: [],
  connections: ['a', 'b'].map(id => ({ id, name: id, kind: 'responses', enabled: true,
    modelProvider: id, models: [], baseUrl: 'https://example.invalid/v1', hasApiKey: false })),
});
function fallback(call: Call): unknown {
  if (call.method === 'mcp/config/read') return { userVersion: 'v1', servers: [server('first'), server('second')], inheritedServers: [] };
  if (call.method === 'plugin/share/list') return { data: [share('first'), share('second')] };
  if (call.method === 'plugin/list') return { marketplaces: [] };
  if (call.method === 'system/provider/read') return registry();
  return {};
}
const settlements: (() => Promise<unknown>)[] = [];
function setup(route: (call: Call) => unknown = fallback) {
  const api = new Api(), calls: Call[] = [];
  const mutations = vi.spyOn(api, 'mutate');
  const settle = () => Promise.allSettled(mutations.mock.results.filter(row => row.type === 'return').map(row => row.value));
  settlements.push(settle);
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    const call = JSON.parse(String(init.body)) as Call; calls.push(call);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: await route(call) }) };
  }));
  return { api, calls, settle };
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(async () => {
  await act(async () => { for (const settle of settlements.splice(0)) await settle(); });
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function editMcp() {
  fireEvent.click(await screen.findByRole('button', { name: '编辑 first' }));
  fireEvent.change(screen.getByLabelText('程序名或路径'), { target: { value: 'unsaved-command' } });
}
it('changes clean MCP selection without asking and preserves a dirty editor until explicit discard', async () => {
  const { api, calls } = setup();
  render(<McpConfiguration {...props} api={api} projectId="p" />);
  fireEvent.click(await screen.findByRole('button', { name: '编辑 second' }));
  await editMcp();
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '编辑 first' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '编辑 second' }));
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  expect(screen.getByLabelText('程序名或路径')).toHaveProperty('value', 'unsaved-command');
  fireEvent.click(screen.getByRole('button', { name: '编辑 second' }));
  fireEvent.click(screen.getByRole('button', { name: '放弃编辑并切换服务' }));
  expect(screen.getByLabelText('程序名或路径')).toHaveProperty('value', 'second');
  expect(calls.some(call => call.operationId)).toBe(false);
});
it('asks before replacing MCP edits with removal and only prepares the selected removal after consent', async () => {
  const { api, calls } = setup();
  render(<McpConfiguration {...props} api={api} projectId="p" />);
  await editMcp();
  fireEvent.click(screen.getByRole('button', { name: '移除 second 用户配置' }));
  expect(screen.queryByRole('button', { name: '确认移除服务配置' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '放弃编辑并准备移除' }));
  expect(screen.getByText(/确认只移除 second/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '确认移除服务配置' })).toHaveProperty('disabled', true);
  expect(calls.some(call => call.operationId)).toBe(false);
});
it('revokes a pending MCP selection on hide and clears secrets without discarding ordinary edits', async () => {
  const { api } = setup(), view = render(<McpConfiguration {...props} api={api} projectId="p" />);
  await editMcp();
  fireEvent.click(screen.getByRole('button', { name: '编辑 second' }));
  const old = screen.getByRole('button', { name: '放弃编辑并切换服务' });
  view.rerender(<McpConfiguration {...props} api={api} projectId="p" visible={false} />);
  fireEvent.click(old);
  view.rerender(<McpConfiguration {...props} api={api} projectId="p" />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByLabelText('程序名或路径')).toHaveProperty('value', 'unsaved-command');
});
it('finishes an explicitly saved MCP edit without a redundant discard question', async () => {
  const { api, calls, settle } = setup();
  render(<McpConfiguration {...props} api={api} projectId="p" />);
  await editMcp();
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存此服务配置/ }));
  fireEvent.click(screen.getByRole('button', { name: '保存此服务配置' }));
  await waitFor(() => expect(calls.filter(call => call.method === 'mcp/config/write')).toHaveLength(1));
  await act(settle);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByLabelText('程序名或路径')).toBeNull();
});
async function editShare() {
  fireEvent.click(await screen.findByRole('button', { name: 'first · 私有' }));
  fireEvent.click(screen.getByText('修改共享范围', { selector: 'summary' }));
  fireEvent.click(screen.getByRole('button', { name: '添加明确接收者' }));
  fireEvent.change(screen.getByLabelText('接收者 ID'), { target: { value: 'unsaved-recipient' } });
}
it('guards only replaced shared-object edits, retaining cancellation and clearing after explicit selection', async () => {
  const { api, calls } = setup();
  render(<PluginSharing {...props} api={api} project={project} />);
  await editShare();
  fireEvent.click(screen.getByRole('button', { name: 'second · 私有' }));
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  expect(screen.getByLabelText('接收者 ID')).toHaveProperty('value', 'unsaved-recipient');
  fireEvent.click(screen.getByRole('button', { name: 'second · 私有' }));
  fireEvent.click(screen.getByRole('button', { name: '放弃编辑并切换共享' }));
  expect(screen.queryByLabelText('接收者 ID')).toBeNull();
  expect(screen.getByText('共享 ID：second')).toBeTruthy();
  expect(calls.some(call => call.operationId)).toBe(false);
});
it('keeps edits for a vanished remote share visible but disables stale mutation targets', async () => {
  let missing = false;
  const { api, calls } = setup(call => missing && call.method === 'plugin/share/list' ? { data: [share('second')] } : fallback(call));
  render(<PluginSharing {...props} api={api} project={project} />);
  await editShare(); missing = true;
  fireEvent.click(screen.getByRole('button', { name: '重新读取共享目录' }));
  await screen.findByText(/此共享已不在当前目录中/);
  expect(screen.getByLabelText('接收者 ID')).toHaveProperty('value', 'unsaved-recipient');
  fireEvent.click(screen.getByRole('checkbox', { name: '确认使用上述范围与完整接收者列表' }));
  expect(screen.getByRole('button', { name: '保存共享范围' })).toHaveProperty('disabled', true);
  expect(calls.some(call => call.operationId)).toBe(false);
});
it('revokes pending shared-object navigation when the selected destination disappears', async () => {
  let missing = false;
  const { api } = setup(call => missing && call.method === 'plugin/share/list' ? { data: [share('first')] } : fallback(call));
  render(<PluginSharing {...props} api={api} project={project} />);
  await editShare();
  fireEvent.click(screen.getByRole('button', { name: 'second · 私有' }));
  const stale = screen.getByRole('button', { name: '放弃编辑并切换共享' });
  missing = true;
  fireEvent.click(screen.getByRole('button', { name: '重新读取共享目录' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'second · 私有' })).toBeNull());
  fireEvent.click(stale);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByLabelText('接收者 ID')).toHaveProperty('value', 'unsaved-recipient');
});
it('does not mark newer recipient edits as saved when an earlier share update completes', async () => {
  let finish!: (value: unknown) => void;
  const { api, settle } = setup(call => call.method === 'plugin/share/updateTargets' ? new Promise(resolve => { finish = resolve; }) : fallback(call));
  render(<PluginSharing {...props} api={api} project={project} />);
  await editShare();
  fireEvent.click(screen.getByRole('checkbox', { name: '确认使用上述范围与完整接收者列表' }));
  fireEvent.click(screen.getByRole('button', { name: '保存共享范围' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  fireEvent.change(screen.getByLabelText('接收者 ID'), { target: { value: 'newer-recipient' } });
  await act(async () => { finish({}); await settle(); });
  expect(screen.getByLabelText('接收者 ID')).toHaveProperty('value', 'newer-recipient');
  fireEvent.click(await screen.findByRole('button', { name: 'second · 私有' }));
  expect(screen.getByRole('button', { name: '放弃编辑并切换共享' })).toBeTruthy();
});
it('allows changing shares immediately after the exact audience edit was saved', async () => {
  const { api, calls, settle } = setup();
  render(<PluginSharing {...props} api={api} project={project} />);
  await editShare();
  fireEvent.click(screen.getByRole('checkbox', { name: '确认使用上述范围与完整接收者列表' }));
  fireEvent.click(screen.getByRole('button', { name: '保存共享范围' }));
  await waitFor(() => expect(calls.filter(call => call.method === 'plugin/share/updateTargets')).toHaveLength(1));
  await act(settle);
  fireEvent.click(await screen.findByRole('button', { name: 'second · 私有' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('共享 ID：second')).toBeTruthy();
});
async function editCatalog() {
  const manual = await screen.findByLabelText('手动添加模型 ID');
  fireEvent.change(manual, { target: { value: 'model-x' } });
  fireEvent.click(screen.getByRole('button', { name: '添加' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'model-x' }));
  fireEvent.change(screen.getByLabelText('model-x：允许覆盖的推理强度'), { target: { value: 'high' } });
  fireEvent.change(manual, { target: { value: 'next-model' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /我已核对选中模型的能力/ }));
}
it('asks before changing provider with unsaved child catalog edits and blocks whole-registry restore', async () => {
  const { api, calls } = setup();
  render(<ProviderSettings {...props} api={api} />);
  await editCatalog();
  fireEvent.click(screen.getByRole('button', { name: 'b' }));
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  expect(screen.getByLabelText('手动添加模型 ID')).toHaveProperty('value', 'next-model');
  fireEvent.click(screen.getByText('配置备份', { selector: 'summary' }));
  expect(screen.getByText('请先保存或放弃上方编辑，再使用配置档。')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('新配置档名称'), { target: { value: 'profile' } });
  expect(screen.getByRole('button', { name: '保存当前配置为配置档' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'b' }));
  fireEvent.click(screen.getByRole('button', { name: '放弃目录编辑并切换供应商' }));
  expect(screen.getByLabelText('手动添加模型 ID')).toHaveProperty('value', '');
  expect(screen.queryByRole('checkbox', { name: 'model-x' })).toBeNull();
  expect(calls.some(call => call.operationId)).toBe(false);
});
it('retains model edits on registry refresh, clears old capability consent and revokes pending selection', async () => {
  let revision = 'r1';
  const { api } = setup(call => call.method === 'system/provider/read' ? registry(revision) : fallback(call));
  const view = render(<ProviderSettings {...props} api={api} />);
  await editCatalog();
  fireEvent.click(screen.getByRole('button', { name: 'b' }));
  const old = screen.getByRole('button', { name: '放弃目录编辑并切换供应商' });
  revision = 'r2'; view.rerender(<ProviderSettings {...props} api={api} epoch="two" />);
  await screen.findByText(/供应商配置已更新，未保存的目录编辑仍保留/);
  fireEvent.click(old);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByLabelText('显示名称')).toHaveProperty('value', 'a');
  expect(screen.getByLabelText('手动添加模型 ID')).toHaveProperty('value', 'next-model');
  expect(screen.getByLabelText('model-x：允许覆盖的推理强度')).toHaveProperty('value', 'high');
  expect(screen.getByRole('checkbox', { name: /我已核对选中模型的能力/ })).toHaveProperty('checked', false);
});
it('preserves catalog drafts through a provider save without treating its own acknowledgement as discard', async () => {
  let revision = 'r1';
  const { api, calls, settle } = setup(call => {
    if (call.method === 'system/provider/read') return registry(revision);
    if (call.method === 'system/provider/write') { revision = 'r2'; return { providerId: 'a', revision }; }
    return fallback(call);
  });
  render(<ProviderSettings {...props} api={api} />);
  await editCatalog();
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Renamed' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(calls.filter(call => call.method === 'system/provider/write')).toHaveLength(1));
  await act(settle);
  await screen.findByText(/供应商配置已更新，未保存的目录编辑仍保留/);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByLabelText('手动添加模型 ID')).toHaveProperty('value', 'next-model');
  fireEvent.click(screen.getByRole('button', { name: '放弃目录编辑' }));
  fireEvent.click(screen.getByRole('button', { name: 'b' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByLabelText('显示名称')).toHaveProperty('value', 'b');
});
