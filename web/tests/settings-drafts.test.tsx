// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Api } from '../lib/api';
import { Events } from '../lib/events';
import { Settings } from '../components/Settings';
import { ProviderSettings } from '../components/ProviderSettings';
import { McpConfiguration } from '../components/McpConfiguration';
import { RemoteSettings } from '../components/RemoteSettings';
import { emptyDraft, writeDraft } from '../lib/drafts';
import { createOperation, updateOperation } from '../lib/operations';

const provider = {
  revision: 'provider-1', kind: 'responses', baseUrl: 'https://saved.example/v1',
  model: 'saved-model', effort: 'low', profiles: [],
};
const config = { userVersion: 'config-1', servers: [], inheritedServers: [] };
function deferred() {
  let resolve!: (value: Record<string, unknown>) => void;
  const promise = new Promise<Record<string, unknown>>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(savedProvider = provider) {
  const call = vi.fn().mockImplementation(async (method: string) => {
    if (method === 'system/provider/read') return savedProvider;
    if (method === 'mcp/config/read') return config;
    if (method === 'remoteControl/status/read') return { status: 'disabled', serverName: 'local', environmentId: null };
    return { data: [], nextCursor: null };
  });
  const api = {
    csrf: 'account-a', call, mutate: vi.fn().mockResolvedValue({}),
    onAuthenticationLost: vi.fn(() => () => {}),
  } as unknown as Api;
  const props = {
    api, events: new Events(), epoch: 'epoch', runtimeEpoch: 'runtime', connectionId: 'connection',
    projects: [{ id: 'project', name: 'Project', cwd: '/project' }], projectId: 'project',
    theme: 'system', onTheme: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(),
    onProjectAction: vi.fn(), onLogout: vi.fn(), onOpenDraft: vi.fn(), onOpenThread: vi.fn(), onOpenNativeTerminal: vi.fn(),
  };
  return { api, call, props };
}
const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;
const change = (label: string, text: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
const tab = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(cleanup);

it('retains provider and profile text through settings navigation and the returning read, clearing secret intent', async () => {
  const f = fixture(), nextRead = deferred();
  render(<Settings {...f.props} />);
  tab('模型供应商');
  await waitFor(() => expect(value('默认模型 ID')).toBe('saved-model'));
  change('API Base URL', 'http://private.example/v1');
  change('默认模型 ID', 'draft-model');
  change('默认推理强度', 'high');
  change('新配置档名称', 'unsaved profile');
  change('手动添加模型 ID', 'unsaved catalog model');
  change('API Key', 'ephemeral-secret');
  fireEvent.click(screen.getByLabelText('允许向私有 HTTP 地址发送 API Key（连接未加密）'));
  const form = screen.getByLabelText('API Base URL').closest('form')!;
  const callsBeforeHide = f.call.mock.calls.length;
  tab('通用');
  expect(form.closest('[hidden]')?.hasAttribute('inert')).toBe(true);
  fireEvent.submit(form);
  expect(f.api.mutate).not.toHaveBeenCalled();
  expect(f.call.mock.calls.length).toBe(callsBeforeHide);
  f.call.mockImplementation(() => nextRead.promise);
  tab('模型供应商');
  expect(value('API Base URL')).toBe('http://private.example/v1');
  expect(value('默认模型 ID')).toBe('draft-model');
  expect(value('默认推理强度')).toBe('high');
  expect(value('新配置档名称')).toBe('unsaved profile');
  expect(value('手动添加模型 ID')).toBe('unsaved catalog model');
  expect(value('API Key')).toBe('');
  expect((screen.getByLabelText('允许向私有 HTTP 地址发送 API Key（连接未加密）') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('button', { name: '保存配置' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => nextRead.resolve(provider));
  expect(value('新配置档名称')).toBe('unsaved profile');
  expect(value('手动添加模型 ID')).toBe('unsaved catalog model');
  expect(value('默认模型 ID')).toBe('draft-model');
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

it('retains remote registration text while clearing token and consent and stopping hidden reads', async () => {
  const f = fixture();
  render(<Settings {...f.props} />);
  tab('远端环境与连接');
  await screen.findByText('状态：disabled · local');
  fireEvent.click(screen.getByText('登记新的远端环境'));
  change('环境名称', 'draft executor');
  change('Exec-server WebSocket 地址', 'wss://draft.example/');
  change('Bearer token（按需填写，仅保留在本次运行内存）', 'ephemeral-token');
  fireEvent.click(screen.getByLabelText('确认连接此执行服务，并授权后续明确选中的会话在远端执行'));
  tab('通用');
  const count = f.call.mock.calls.length;
  await act(async () => f.props.events.publish({ type: 'notification', data: { method: 'remoteControl/status/changed' } } as never));
  expect(f.call.mock.calls.length).toBe(count);
  tab('远端环境与连接');
  expect(value('环境名称')).toBe('draft executor');
  expect(value('Exec-server WebSocket 地址')).toBe('wss://draft.example/');
  expect(value('Bearer token（按需填写，仅保留在本次运行内存）')).toBe('');
  expect((screen.getByLabelText('确认连接此执行服务，并授权后续明确选中的会话在远端执行') as HTMLInputElement).checked).toBe(false);
  expect(f.api.mutate).not.toHaveBeenCalled();
});

it('retains public gateway OAuth fields across settings tabs without keeping credential consent', async () => {
  const f = fixture({ ...provider, kind: 'chatgpt-gateway' });
  render(<Settings {...f.props} />);
  tab('模型供应商');
  await waitFor(() => expect(value('默认模型 ID')).toBe('saved-model'));
  expect(screen.getByLabelText('供应商')).toHaveProperty('disabled', true);
  change('网关 Codex Base URL', 'https://gateway.example/codex');
  change('OAuth 授权 URL', 'https://gateway.example/authorize');
  change('OAuth Token URL', 'https://gateway.example/token');
  change('OAuth 公共 Client ID', 'draft-public-client');
  change('网关认证 Cookie 名称', 'gateway-session');
  change('服务器回调端口（可选）', '23456');
  fireEvent.click(screen.getByLabelText('我已核对以上目标；此网关会收到 ChatGPT 凭据与模型请求内容'));
  tab('通用');
  tab('模型供应商');
  expect(value('网关 Codex Base URL')).toBe('https://gateway.example/codex');
  expect(value('OAuth 授权 URL')).toBe('https://gateway.example/authorize');
  expect(value('OAuth Token URL')).toBe('https://gateway.example/token');
  expect(value('OAuth 公共 Client ID')).toBe('draft-public-client');
  expect(value('网关认证 Cookie 名称')).toBe('gateway-session');
  expect(value('服务器回调端口（可选）')).toBe('23456');
  expect((screen.getByLabelText('我已核对以上目标；此网关会收到 ChatGPT 凭据与模型请求内容') as HTMLInputElement).checked).toBe(false);
});

it.each(['api', 'csrf', 'runtime'])('does not restore remote drafts after a different %s owner and return', async (transition) => {
  const f = fixture();
  const props = { ...f.props, epoch: 'runtime-a', enabled: true, connected: true };
  const view = render(<RemoteSettings {...props} />);
  await screen.findByText('状态：disabled · local');
  change('环境名称', 'old-owner');
  change('Exec-server WebSocket 地址', 'wss://old-owner.example/');
  if (transition === 'csrf') f.api.csrf = 'account-b';
  view.rerender(<RemoteSettings {...props}
    {...(transition === 'api' ? { api: { ...f.api } as Api } : transition === 'runtime' ? { epoch: 'runtime-b' } : {})}
  />);
  expect(value('环境名称')).toBe('');
  f.api.csrf = 'account-a';
  view.rerender(<RemoteSettings {...props} />);
  expect(value('环境名称')).toBe('');
  expect(value('Exec-server WebSocket 地址')).toBe('');
});

it('retains MCP configuration text across settings tabs but requires new sensitive values and consent', async () => {
  const f = fixture();
  render(<Settings {...f.props} />);
  tab('MCP');
  fireEvent.click(screen.getByText('查看或编辑 MCP 服务配置'));
  fireEvent.click(await screen.findByRole('button', { name: '新增 MCP 服务' }));
  change('服务名称', 'draft-server');
  change('程序名或路径', 'draft-command');
  fireEvent.click(screen.getByRole('button', { name: '添加参数' }));
  change('命令参数 1', 'draft argument');
  fireEvent.click(screen.getByLabelText('替换此组值（不勾选保留原值，勾选且无行表示清空此组）'));
  fireEvent.click(screen.getByRole('button', { name: '添加环境变量' }));
  change('环境变量名称 1', 'SECRET');
  change('环境变量值 1', 'ephemeral-secret');
  fireEvent.click(screen.getByLabelText('确认保存此服务配置；重载或加载会话时可能启动配置的进程或建立网络连接'));
  tab('通用');
  tab('MCP');
  expect(value('服务名称')).toBe('draft-server');
  expect(value('程序名或路径')).toBe('draft-command');
  expect(value('命令参数 1')).toBe('draft argument');
  expect(value('环境变量名称 1')).toBe('SECRET');
  expect(value('环境变量值 1')).toBe('');
  expect((screen.getByLabelText('环境变量值 1') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('替换此组值（不勾选保留原值，勾选且无行表示清空此组）') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText('确认保存此服务配置；重载或加载会话时可能启动配置的进程或建立网络连接') as HTMLInputElement).checked).toBe(false);
  expect(f.api.mutate).not.toHaveBeenCalled();
});

it.each(['visibility', 'epoch'])('preserves an authenticated in-flight provider save across %s changes', async (transition) => {
  const f = fixture(), pending = deferred();
  vi.mocked(f.api.mutate).mockImplementation(() => pending.promise);
  const props = { api: f.api, epoch: 'a', visible: true, onChanged: f.props.onChanged };
  const view = render(<ProviderSettings {...props} />);
  await waitFor(() => expect(value('默认模型 ID')).toBe('saved-model'));
  change('默认模型 ID', 'draft-model');
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  view.rerender(<ProviderSettings {...props} {...(transition === 'epoch' ? { epoch: 'b' } : { visible: false })} />);
  view.rerender(<ProviderSettings {...props} />);
  expect(screen.getByLabelText('默认模型 ID').matches(':disabled')).toBe(true);
  expect(screen.getByRole('button', { name: '正在保存…' }).matches(':disabled')).toBe(true);
  f.call.mockResolvedValue({ ...provider, revision: 'accepted-revision', model: 'draft-model' });
  await act(async () => pending.resolve({}));
  await screen.findByText('配置已保存。');
  expect(f.props.onChanged).toHaveBeenCalledOnce();
  expect(value('默认模型 ID')).toBe('draft-model');
  expect(f.api.mutate).toHaveBeenCalledOnce();
});

it.each(['api', 'csrf'])('isolates provider drafts and delayed reads across %s owners including ABA', async (transition) => {
  const f = fixture(), oldRead = deferred();
  let reads = 0;
  f.call.mockImplementation(() => ++reads === 1 ? Promise.resolve(provider) : oldRead.promise);
  const props = { api: f.api, epoch: 'a', onChanged: vi.fn() };
  const view = render(<ProviderSettings {...props} />);
  await waitFor(() => expect(value('默认模型 ID')).toBe('saved-model'));
  change('默认模型 ID', 'old owner draft');
  view.rerender(<ProviderSettings {...props} epoch="refresh" />);
  const other = { ...f.api, csrf: 'account-b', call: vi.fn().mockResolvedValue({ ...provider, model: 'new-owner' }) } as unknown as Api;
  if (transition === 'api') view.rerender(<ProviderSettings {...props} api={other} />);
  else {
    f.api.csrf = 'account-b';
    f.call.mockResolvedValue({ ...provider, model: 'new-owner' });
    view.rerender(<ProviderSettings {...props} />);
  }
  await waitFor(() => expect(value('默认模型 ID')).toBe('new-owner'));
  f.api.csrf = 'account-a';
  f.call.mockResolvedValue({ ...provider, model: 'returning-owner' });
  view.rerender(<ProviderSettings {...props} />);
  await waitFor(() => expect(value('默认模型 ID')).toBe('returning-owner'));
  await act(async () => oldRead.resolve({ ...provider, model: 'stale completion' }));
  expect(value('默认模型 ID')).toBe('returning-owner');
});

it('does not close a retained MCP draft when a prior visibility owner save finishes', async () => {
  const f = fixture(), pending = deferred();
  vi.mocked(f.api.mutate).mockImplementation(() => pending.promise);
  const props = { api: f.api, projectId: 'project', epoch: 'a', enabled: true, visible: true, onChanged: vi.fn() };
  const view = render(<McpConfiguration {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: '新增 MCP 服务' }));
  change('服务名称', 'retained');
  change('程序名或路径', 'node');
  fireEvent.click(screen.getByLabelText('确认保存此服务配置；重载或加载会话时可能启动配置的进程或建立网络连接'));
  fireEvent.click(screen.getByRole('button', { name: '保存此服务配置' }));
  view.rerender(<McpConfiguration {...props} visible={false} />);
  view.rerender(<McpConfiguration {...props} />);
  await act(async () => pending.resolve({}));
  expect(value('服务名称')).toBe('retained');
  expect(props.onChanged).not.toHaveBeenCalled();
});

it('asks before discarding an edited provider when settings closes and permits continued editing', async () => {
  const f = fixture(); render(<Settings {...f.props} />); tab('模型供应商');
  await waitFor(() => expect(value('默认模型 ID')).toBe('saved-model'));
  change('默认模型 ID', 'pending model');
  fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  expect(screen.getByRole('dialog', { name: '放弃未保存的设置？' })).toBeTruthy();
  expect(f.props.onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  expect(value('默认模型 ID')).toBe('pending model');
  fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  fireEvent.click(screen.getByRole('button', { name: '放弃编辑并关闭' }));
  expect(f.props.onClose).toHaveBeenCalledOnce(); expect(f.api.mutate).not.toHaveBeenCalled();
});

it.each([
  ['rename', '项目目录', '重命名项目', '放弃编辑并重命名项目'],
  ['remove', '项目目录', '移除项目', '放弃编辑并移除项目'],
  ['draft', '本地草稿', '打开草稿', '放弃编辑并打开草稿'],
  ['thread', '操作记录', '打开', '放弃编辑并打开会话'],
  ['terminal', '扩展与配置', '打开原生 Hooks 管理终端', '放弃编辑并打开终端'],
  ['logout', '账号与安全', '退出工作台登录', '放弃编辑并退出登录'],
])('guards %s internal navigation and confirms only its exact destination once', async (kind, category, button, confirm) => {
  const f = fixture();
  writeDraft({ ...emptyDraft('new:project'), text: 'Retained conversation draft' });
  const operation = await createOperation('conversation/start', { projectId: 'project' });
  await updateOperation(operation.id, 'accepted', 'exact-history-thread');
  render(<Settings {...f.props} />); tab('模型供应商');
  await waitFor(() => expect(value('默认模型 ID')).toBe('saved-model'));
  change('默认模型 ID', 'pending settings model');
  tab(category);
  fireEvent.click(await screen.findByRole('button', { name: button }));
  const callbacks = [f.props.onClose, f.props.onProjectAction, f.props.onOpenDraft, f.props.onOpenThread, f.props.onOpenNativeTerminal, f.props.onLogout];
  for (const callback of callbacks) expect(callback).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: '放弃未保存的设置？' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  tab('模型供应商'); expect(value('默认模型 ID')).toBe('pending settings model');
  tab(category); fireEvent.click(await screen.findByRole('button', { name: button }));
  const proceed = screen.getByRole('button', { name: confirm });
  fireEvent.click(proceed); fireEvent.click(proceed);
  if (kind === 'rename' || kind === 'remove') expect(f.props.onProjectAction).toHaveBeenCalledExactlyOnceWith(f.props.projects[0], kind);
  else if (kind === 'draft') expect(f.props.onOpenDraft).toHaveBeenCalledExactlyOnceWith('new:project');
  else if (kind === 'thread') expect(f.props.onOpenThread).toHaveBeenCalledExactlyOnceWith('exact-history-thread');
  else if (kind === 'terminal') expect(f.props.onOpenNativeTerminal).toHaveBeenCalledExactlyOnceWith('project');
  else await waitFor(() => expect(f.props.onLogout).toHaveBeenCalledOnce());
  expect(callbacks.reduce((count, callback) => count + callback.mock.calls.length, 0)).toBe(1);
  expect(f.api.mutate).not.toHaveBeenCalled();
});

it('propagates nested unprepared skill edits to the settings exit guard', async () => {
  const f = fixture(); render(<Settings {...f.props} />); tab('扩展与配置');
  fireEvent.click(screen.getByText('在项目中新建或导入 SKILL.md', { selector: 'summary' }));
  change('技能说明', 'Unsaved skill body'); tab('项目目录');
  fireEvent.click(screen.getByRole('button', { name: '重命名项目' }));
  expect(f.props.onProjectAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  tab('扩展与配置'); expect(value('技能说明')).toBe('Unsaved skill body');
});

it.each(['csrf', 'runtime', 'project'])('invalidates a pending settings destination after %s changes', async transition => {
  const f = fixture(), view = render(<Settings {...f.props} />); tab('模型供应商');
  await waitFor(() => expect(value('默认模型 ID')).toBe('saved-model'));
  change('默认模型 ID', 'pending'); tab('项目目录');
  fireEvent.click(screen.getByRole('button', { name: '重命名项目' }));
  const staleConfirm = screen.getByRole('button', { name: '放弃编辑并重命名项目' });
  if (transition === 'csrf') f.api.csrf = 'other-account';
  view.rerender(<Settings {...f.props} {...(transition === 'runtime' ? { runtimeEpoch: 'other' } : transition === 'project' ? { projects: [] } : {})} />);
  expect(screen.queryByRole('dialog', { name: '放弃未保存的设置？' })).toBeNull();
  fireEvent.click(staleConfirm); expect(f.props.onProjectAction).not.toHaveBeenCalled();
});
