// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { SkillSettings } from '../components/SkillSettings';
import { PluginSettings } from '../components/PluginSettings';
import { ConfigSettings } from '../components/ConfigSettings';
import { AppCatalog, RuntimeInsights } from '../components/RuntimeInsights';
const project = { id: 'extension-project', name: 'Extensions', cwd: '/registered/project' },
  hash = 'a'.repeat(64);
const props = (api: Api) => ({ api, project, epoch: 'first', enabled: true, onChanged: vi.fn() });
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
function routed(handler: (call: Call) => unknown) {
  const calls: Call[] = [],
    api = new Api();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const call: Call = JSON.parse(String(init.body));
      calls.push(call);
      const result = await handler(call);
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    }),
  );
  return { api, calls };
}
it('uses project and discovered skill identity rather than arbitrary native paths', async () => {
  let enabled = true;
  const { api, calls } = routed((call) =>
    call.method === 'skills/list'
      ? {
          data: [
            {
              cwd: project.cwd,
              errors: [],
              skills: [
                {
                  skillId: hash,
                  name: 'review',
                  description: 'Review changes',
                  path: '/native/skills/review/SKILL.md',
                  scope: 'user',
                  enabled,
                  pluginId: null,
                  dependencies: { tools: [{ type: 'mcp', value: 'local-tools' }] },
                },
              ],
            },
          ],
        }
      : call.method === 'hooks/list'
        ? {
            data: [
              {
                cwd: project.cwd,
                warnings: [],
                errors: [],
                hooks: [
                  {
                    key: 'hook',
                    eventName: 'Stop',
                    handlerType: 'command',
                    command: 'local-hook',
                    timeoutSec: 10,
                    sourcePath: '/native/hooks.toml',
                    trustStatus: 'untrusted',
                    enabled: false,
                    isManaged: false,
                    currentHash: hash,
                  },
                ],
              },
            ],
          }
        : ((enabled = false), {}),
  );
  render(<SkillSettings {...props(api)} />);
  fireEvent.click(await screen.findByRole('button', { name: '停用技能' }));
  await screen.findByRole('button', { name: '启用技能' });
  expect(calls.find((call) => call.method === 'skills/config/write')?.params).toEqual({
    projectId: project.id,
    skillId: hash,
    enabled: false,
  });
  expect(screen.getByText('local-hook')).toBeTruthy();
  expect(calls.some((call) => /hook.*(run|trust|write)/.test(call.method))).toBe(false);
});
const plugin = (extra = {}) => ({
  id: 'plugin-one',
  name: 'One',
  installed: false,
  enabled: false,
  availability: 'AVAILABLE',
  installPolicy: 'AVAILABLE',
  authPolicy: 'ON_INSTALL',
  keywords: ['design'],
  interface: { displayName: 'Design Tools', shortDescription: 'Design support' },
  ...extra,
});
const detail = (extra = {}) => ({
  plugin: {
    summary: plugin(extra),
    description: 'Tools for design',
    marketplaceName: 'local-market',
    skills: [],
    hooks: [],
    apps: [{ id: 'app', name: 'Design App' }],
    appTemplates: [],
    mcpServers: ['design-server'],
    scheduledTasks: null,
  },
  previewHash: hash,
});
function catalogResult(call: Call, extra = {}) {
  return call.method === 'plugin/read'
    ? detail(extra)
    : {
        marketplaces: [
          {
            name: 'local-market',
            path: '/native/catalog',
            interface: null,
            plugins: [plugin(extra)],
          },
        ],
        marketplaceLoadErrors: [],
      };
}
it('requires reviewing the selected plugin and submits the exact preview hash', async () => {
  const { api, calls } = routed((call) => catalogResult(call));
  render(<PluginSettings {...props(api)} />);
  fireEvent.click(await screen.findByRole('button', { name: /Design Tools.*Design support/ }));
  const install = await screen.findByRole('button', { name: '安装此插件' });
  expect((install as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: /我已查看插件内容/ }));
  fireEvent.click(install);
  await waitFor(() => expect(calls.some((call) => call.method === 'plugin/install')).toBe(true));
  expect(calls.find((call) => call.method === 'plugin/install')?.params).toEqual({
    projectId: project.id,
    pluginId: 'plugin-one',
    previewHash: hash,
  });
});
it('does not offer installation when catalog policy restricts it', async () => {
  const { api, calls } = routed((call) => catalogResult(call, { installPolicy: 'NOT_AVAILABLE' }));
  render(<PluginSettings {...props(api)} />);
  fireEvent.click(await screen.findByRole('button', { name: /Design Tools.*Design support/ }));
  await screen.findByRole('button', { name: '安装此插件' });
  fireEvent.click(screen.getByRole('checkbox', { name: /我已查看插件内容/ }));
  fireEvent.click(screen.getByRole('button', { name: '安装此插件' }));
  expect((screen.getByRole('button', { name: '安装此插件' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(calls.some((call) => call.method === 'plugin/install')).toBe(false);
});
it('recovers an unknown plugin install by its original receipt without repeating install', async () => {
  let id = '';
  const { api, calls } = routed((call) => {
    if (call.method === 'plugin/install') {
      id = call.operationId!;
      throw new Error('response lost');
    }
    if (call.method === 'operation/read')
      return {
        operationId: id,
        method: 'plugin/install',
        state: 'accepted',
        result: { pluginId: 'plugin-one' },
      };
    return catalogResult(call);
  });
  render(<PluginSettings {...props(api)} />);
  fireEvent.click(await screen.findByRole('button', { name: /Design Tools.*Design support/ }));
  await screen.findByRole('button', { name: '安装此插件' });
  fireEvent.click(screen.getByRole('checkbox', { name: /我已查看插件内容/ }));
  fireEvent.click(screen.getByRole('button', { name: '安装此插件' }));
  fireEvent.click(await screen.findByRole('button', { name: '查询原扩展操作回执' }));
  await waitFor(() => expect(calls.some((call) => call.method === 'operation/read')).toBe(true));
  expect(calls.filter((call) => call.method === 'plugin/install')).toHaveLength(1);
  expect(calls.find((call) => call.method === 'operation/read')?.params).toEqual({
    operationId: id,
  });
});
const settings = (version = 'v1', model = 'native-model') => ({
  userVersion: version,
  config: {
    model,
    web_search: 'cached',
    developer_instructions: '[redacted]',
    mcp_servers: { private: { env: '[redacted]' } },
  },
  editableKeys: ['model', 'web_search', 'developer_instructions', 'model_context_window'],
  origins: { model: { name: { type: 'project' } } },
  layers: [],
});
const configRoute = (call: Call, version = 'v1', model = 'native-model') =>
  call.method === 'settings/read'
    ? settings(version, model)
    : call.method === 'configRequirements/read'
      ? {
          requirements: {
            allowedWebSearchModes: ['disabled', 'cached'],
            featureRequirements: { locked: true },
          },
        }
      : call.method === 'experimentalFeature/list'
        ? {
            data: [
              {
                name: 'locked',
                displayName: 'Managed feature',
                stage: 'stable',
                enabled: true,
                defaultEnabled: false,
              },
            ],
            nextCursor: null,
          }
        : { data: [], nextCursor: null };
it('writes only explicitly changed settings with the captured version and no masked values', async () => {
  const { api, calls } = routed((call) => configRoute(call));
  render(<ConfigSettings {...props(api)} project={{ ...project, id: 'config-change' }} />);
  const model = await screen.findByRole('textbox', { name: /默认模型/ });
  await waitFor(() => expect((model as HTMLInputElement).value).toBe('native-model'));
  fireEvent.change(model, { target: { value: 'new-model' } });
  fireEvent.click(screen.getByRole('button', { name: '保存 1 项配置' }));
  await waitFor(() => expect(calls.some((call) => call.method === 'settings/write')).toBe(true));
  expect(calls.find((call) => call.method === 'settings/write')?.params).toEqual({
    expectedVersion: 'v1',
    changes: [{ key: 'model', value: 'new-model' }],
  });
  expect((screen.getByRole('button', { name: '停用功能' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});
it.each(['settings-first', 'requirements-first'])(
  'preserves config edits through a version change and requires explicit comparison before rebase (%s)',
  async (order) => {
    let version = 'v1';
    let resolveSettings!: (value: unknown) => void;
    let resolveRequirements!: (value: unknown) => void;
    const refreshedSettings = new Promise((resolve) => {
      resolveSettings = resolve;
    });
    const refreshedRequirements = new Promise((resolve) => {
      resolveRequirements = resolve;
    });
    const requirements = configRoute({ method: 'configRequirements/read', params: {} });
    const { api, calls } = routed((call) => {
      if (version === 'v2' && call.method === 'settings/read') return refreshedSettings;
      if (version === 'v2' && call.method === 'configRequirements/read')
        return refreshedRequirements;
      return configRoute(call);
    });
    render(
      <ConfigSettings {...props(api)} project={{ ...project, id: `config-conflict-${order}` }} />,
    );
    const model = await screen.findByRole('textbox', { name: /默认模型/ });
    await waitFor(() => expect((model as HTMLInputElement).value).toBe('native-model'));
    fireEvent.change(model, { target: { value: 'mine' } });
    version = 'v2';
    fireEvent.click(screen.getByRole('button', { name: '重新读取配置' }));
    if (order === 'requirements-first') {
      await act(async () => {
        resolveRequirements(requirements);
      });
    }
    await act(async () => {
      resolveSettings(settings('v2', 'server-model'));
    });
    await screen.findByText('配置版本已变化');
    const save = screen.getByRole('button', { name: '保存 1 项配置' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect((model as HTMLInputElement).value).toBe('mine');
    expect(
      (screen.getByRole('button', { name: '采用当前配置版本' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /我已核对变化/ }));
    fireEvent.click(screen.getByRole('button', { name: '采用当前配置版本' }));
    expect(screen.queryByText('配置版本已变化')).toBeNull();
    if (order === 'settings-first') {
      // Adopting the new version does not complete the independent policy read.
      expect(save.disabled).toBe(true);
      fireEvent.click(save);
      expect(calls.filter((call) => call.method === 'settings/write')).toHaveLength(0);
      await act(async () => {
        resolveRequirements(requirements);
      });
    }
    await waitFor(() => expect(save.disabled).toBe(false));
    expect((model as HTMLInputElement).value).toBe('mine');
    // Finishing either read must not replay the earlier click or save automatically.
    expect(calls.filter((call) => call.method === 'settings/write')).toHaveLength(0);
    fireEvent.click(save);
    await waitFor(() =>
      expect(calls.filter((call) => call.method === 'settings/write')).toHaveLength(1),
    );
    expect(calls.find((call) => call.method === 'settings/write')?.params).toEqual({
      expectedVersion: 'v2',
      changes: [{ key: 'model', value: 'mine' }],
    });
  },
);
it('keeps unsent config drafts through modal unmount and refuses masked writeback', async () => {
  const { api, calls } = routed((call) => configRoute(call)),
    p = { ...props(api), project: { ...project, id: 'config-draft' } };
  const view = render(<ConfigSettings {...p} />);
  const model = await screen.findByRole('textbox', { name: /默认模型/ });
  await waitFor(() => expect((model as HTMLInputElement).value).toBe('native-model'));
  fireEvent.change(model, { target: { value: 'keep draft' } });
  view.unmount();
  render(<ConfigSettings {...p} />);
  expect(
    ((await screen.findByRole('textbox', { name: /默认模型/ })) as HTMLInputElement).value,
  ).toBe('keep draft');
  const instructions = screen.getByRole('textbox', { name: /开发者指令/ });
  fireEvent.change(instructions, { target: { value: '[redacted] changed' } });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: '保存 2 项配置' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: '保存 2 项配置' }));
  await screen.findByText(/遮蔽后的配置不能写回/);
  expect(calls.some((call) => call.method === 'settings/write')).toBe(false);
});
it('shows app callability independently from configured enablement and rejects unsafe links', async () => {
  const { api } = routed((call) =>
    call.method === 'app/list'
      ? {
          data: [
            {
              id: 'app',
              name: 'App One',
              description: 'External app',
              isAccessible: true,
              isEnabled: true,
              installUrl: 'javascript:alert(1)',
              pluginDisplayNames: [],
            },
          ],
          nextCursor: null,
        }
      : call.method === 'app/installed'
        ? { apps: [{ id: 'app', enabled: true, callable: false }] }
        : {
            apps: [
              {
                id: 'app',
                name: 'App One',
                description: 'External app',
                toolSummaries: [
                  {
                    name: 'change',
                    title: 'Change record',
                    description: 'Writes data',
                    isEnabled: false,
                    isReadOnly: false,
                    disabledReason: 'policy',
                  },
                ],
              },
            ],
            missingAppIds: [],
          },
  );
  render(<AppCatalog api={api} epoch="one" />);
  await screen.findByText(/已连接，工具暂不可调用/);
  expect(screen.queryByRole('link', { name: /打开连接页面/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '工具与权限详情' }));
  await screen.findByText(/可能更改外部数据/);
  expect(screen.getByText(/已停用.*policy/)).toBeTruthy();
});
it('requires explicit reset confirmation and keeps unavailable usage distinct from zero', async () => {
  const { api, calls } = routed((call) =>
    call.method === 'memory/status'
      ? { v2ConsolidatedThreads: 3, v2Ready: true }
      : call.method === 'account/usage/read'
        ? { summary: { lifetimeTokens: null, peakDailyTokens: 0 }, dailyUsageBuckets: [] }
        : call.method === 'account/workspaceMessages/read'
          ? { featureEnabled: false, messages: [] }
          : call.method === 'server/diagnostics'
            ? { process: { id: 123, residentMemoryBytes: null }, gauges: [] }
            : {},
  );
  render(<RuntimeInsights api={api} epoch="one" enabled onChanged={vi.fn()} />);
  await screen.findByText(/已整合 3 个会话/);
  fireEvent.click(screen.getByText('重置全局记忆', { selector: 'summary' }));
  const reset = screen.getByRole('button', { name: '确认重置全局记忆' });
  expect((reset as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: /输入“重置全局记忆”/ }), {
    target: { value: '重置全局记忆' },
  });
  fireEvent.click(reset);
  await waitFor(() => expect(calls.some((call) => call.method === 'memory/reset')).toBe(true));
  expect(calls.find((call) => call.method === 'memory/reset')?.params).toEqual({ confirm: true });
  expect((await screen.findAllByText('未提供')).length).toBeGreaterThan(0);
});
