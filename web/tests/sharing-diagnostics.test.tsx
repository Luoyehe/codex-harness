// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { PluginSharing } from '../components/PluginSharing';
import { DiagnosticsPanel } from '../components/DiagnosticsPanel';
import { ProjectTrustSettings } from '../components/ProjectTrustSettings';
const project = { id: 'project', name: 'Project', cwd: '/project' },
  hash = 'a'.repeat(64);
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
function routed(handler: (call: Call) => unknown) {
  const calls: Call[] = [],
    api = new Api();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const call: Call = JSON.parse(String(init.body));
      calls.push(call);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: await handler(call) }),
      };
    }),
  );
  return { api, calls };
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  URL.createObjectURL = vi.fn().mockReturnValue('blob:fixture');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const base = { project, epoch: 'one', enabled: true, onChanged: vi.fn() };
const plugin = {
  id: 'plugin',
  name: 'Plugin',
  source: { type: 'local', path: '/project/plugin' },
  remotePluginId: 'remote',
  shareContext: { remotePluginId: 'remote', discoverability: 'PRIVATE', sharePrincipals: [] },
};
function sharingRoute(call: Call) {
  if (call.method === 'plugin/share/list')
    return { data: [{ plugin, localPluginPath: '/project/plugin', previewHash: hash }] };
  if (call.method === 'plugin/list') return { marketplaces: [{ plugins: [plugin] }] };
  if (call.method === 'plugin/share/preview')
    return {
      pluginId: 'plugin',
      pluginPath: '/project/plugin',
      previewHash: hash,
      totalBytes: 2,
      files: [{ path: '.codex-plugin/plugin.json', bytes: 2, sha256: hash }],
    };
  return {};
}
it('publishes only after reviewing a project-scoped inventory and exact audience', async () => {
  const { api, calls } = routed(sharingRoute);
  render(<PluginSharing {...base} api={api} />);
  fireEvent.click(screen.getByText('发布项目内的插件', { selector: 'summary' }));
  await screen.findByRole('option', { name: 'Plugin' });
  fireEvent.change(screen.getByRole('combobox', { name: '待共享插件' }), {
    target: { value: 'plugin' },
  });
  await screen.findByText('/project/plugin');
  const save = screen.getByRole('button', { name: '确认发送并保存共享' });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: '我已审阅目录内容、发布目标和接收范围' }));
  fireEvent.click(save);
  await waitFor(() => expect(calls.some((call) => call.method === 'plugin/share/save')).toBe(true));
  expect(calls.find((call) => call.method === 'plugin/share/save')!.params).toEqual({
    projectId: 'project',
    pluginId: 'plugin',
    previewHash: hash,
    discoverability: 'PRIVATE',
    shareTargets: [],
    confirm: true,
  });
  expect(calls.find((call) => call.method === 'plugin/share/save')!.operationId).toBeTruthy();
});
it('changing an audience invalidates confirmation and remote delete requires the exact current selection', async () => {
  const { api, calls } = routed(sharingRoute);
  render(<PluginSharing {...base} api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Plugin · PRIVATE' }));
  fireEvent.click(screen.getByText('修改共享范围', { selector: 'summary' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '确认使用上述范围与完整接收者列表' }));
  fireEvent.change(screen.getByRole('combobox', { name: '可见范围' }), {
    target: { value: 'LISTED' },
  });
  expect((screen.getByRole('button', { name: '保存共享范围' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByText('删除远程共享', { selector: 'summary' }));
  expect(
    (screen.getByRole('button', { name: '删除此远程共享' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: '输入“删除共享”以确认' }), {
    target: { value: '删除共享' },
  });
  fireEvent.click(screen.getByRole('button', { name: '删除此远程共享' }));
  await waitFor(() =>
    expect(calls.some((call) => call.method === 'plugin/share/delete')).toBe(true),
  );
  expect(calls.find((call) => call.method === 'plugin/share/delete')!.params).toEqual({
    remotePluginId: 'remote',
    previewHash: hash,
    confirm: true,
  });
});
const diagnostics = {
  process: { id: 1, residentMemoryBytes: 12, physicalFootprintBytes: null },
  gauges: [{ name: 'pending', value: 0 }],
};
it('diagnostic download remains local and never submits feedback', async () => {
  const { api, calls } = routed(() => diagnostics);
  render(<DiagnosticsPanel {...base} api={api} threadId="thread" />);
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: '下载诊断摘要 JSON' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: '下载诊断摘要 JSON' }));
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  expect(calls.map((call) => call.method)).toEqual(['server/diagnostics']);
});
it('feedback defaults to local ZIP without logs and confirmation is reset on destination changes', async () => {
  const { api, calls } = routed((call) =>
    call.method === 'server/diagnostics'
      ? diagnostics
      : { saved: true, path: '.harness-feedback-fixture.zip' },
  );
  render(<DiagnosticsPanel {...base} api={api} threadId="thread" />);
  fireEvent.click(screen.getByText('原生反馈包', { selector: 'summary' }));
  expect(
    (screen.getByRole('checkbox', { name: '包含原生运行日志' }) as HTMLInputElement).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole('checkbox', { name: '我确认上述内容与去向' }));
  fireEvent.change(screen.getByRole('combobox', { name: '反馈去向' }), {
    target: { value: 'upload' },
  });
  expect((screen.getByRole('button', { name: '确认上传反馈' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.change(screen.getByRole('combobox', { name: '反馈去向' }), {
    target: { value: 'save' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: '我确认上述内容与去向' }));
  fireEvent.click(screen.getByRole('button', { name: '生成本地反馈 ZIP' }));
  await screen.findByRole('button', { name: '下载已保存的反馈 ZIP' });
  expect(calls.find((call) => call.method === 'feedback/save')!.params).toMatchObject({
    projectId: 'project',
    threadId: 'thread',
    includeLogs: false,
    confirm: true,
  });
  expect(calls.some((call) => call.method === 'feedback/upload')).toBe(false);
});
it('unknown feedback recovers the original operation without a second upload', async () => {
  let id = '';
  const { api, calls } = routed((call) => {
    if (call.method === 'feedback/upload') {
      id = call.operationId!;
      throw new Error('lost response');
    }
    if (call.method === 'operation/read')
      return {
        operationId: id,
        state: 'accepted',
        method: 'feedback/upload',
        result: { uploaded: true },
      };
    return diagnostics;
  });
  render(<DiagnosticsPanel {...base} api={api} threadId="thread" />);
  fireEvent.click(screen.getByText('原生反馈包', { selector: 'summary' }));
  fireEvent.change(screen.getByRole('combobox', { name: '反馈去向' }), {
    target: { value: 'upload' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: '我确认上述内容与去向' }));
  fireEvent.click(screen.getByRole('button', { name: '确认上传反馈' }));
  fireEvent.click(await screen.findByRole('button', { name: '查询原维护或反馈回执' }));
  await waitFor(() => expect(calls.some((call) => call.method === 'operation/read')).toBe(true));
  expect(calls.filter((call) => call.method === 'feedback/upload')).toHaveLength(1);
});
it('storage maintenance reports only a trigger and never claims completed compression', async () => {
  const { api, calls } = routed((call) =>
    call.method === 'server/diagnostics'
      ? diagnostics
      : { triggered: true, completionConfirmed: false },
  );
  render(<DiagnosticsPanel {...base} api={api} />);
  fireEvent.click(screen.getByText('原生历史存储维护', { selector: 'summary' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '确认触发后台存储维护' }));
  fireEvent.click(screen.getByRole('button', { name: '触发存储维护' }));
  await screen.findByText('已受理维护触发；完成状态未获确认。');
  expect(calls.find((call) => call.method === 'rollout/compress')!.params).toEqual({
    confirm: true,
  });
});
it('project trust requires current version and explicit scoped confirmation', async () => {
  const { api, calls } = routed((call) =>
    call.method === 'project/trust/read'
      ? { userVersion: 'v1', configuredTrust: null, cwd: project.cwd, projectLayers: [] }
      : { status: 'ok', version: 'v2' },
  );
  render(<ProjectTrustSettings {...base} api={api} />);
  fireEvent.change(await screen.findByRole('combobox', { name: '新的项目信任选择' }), {
    target: { value: 'trusted' },
  });
  const save = screen.getByRole('button', { name: '保存项目信任' });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: '我已审阅所选项目的配置并确认此次变更' }));
  fireEvent.click(save);
  await waitFor(() =>
    expect(calls.some((call) => call.method === 'project/trust/write')).toBe(true),
  );
  expect(calls.find((call) => call.method === 'project/trust/write')!.params).toEqual({
    projectId: project.id,
    expectedVersion: 'v1',
    trustLevel: 'trusted',
    confirm: true,
  });
});
