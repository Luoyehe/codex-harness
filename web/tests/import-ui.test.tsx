// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { ImportPanel } from '../components/ImportPanel';
import { ExtensionsPanel } from '../components/ExtensionsPanel';
import { importResults } from '../lib/imports';
import { listOperations } from '../lib/operations';
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const project = { id: 'registered', name: 'Work', cwd: '/work' },
  itemId = 'a'.repeat(64),
  previewHash = 'b'.repeat(64);
const preview = {
  source: 'claude-code',
  previewKind: 'fresh_native_migration_inventory',
  trustInherited: false,
  previewHash,
  items: [
    {
      itemId,
      itemType: 'AGENTS_MD',
      cwd: project.cwd,
      description: 'Import project guidance',
      details: null,
      requiresExecutionReview: false,
    },
  ],
};
const completion = {
  importId: 'native-import',
  completed: true,
  itemTypeResults: [{ itemType: 'AGENTS_MD', successCount: 1, failureCount: 0, failures: [] }],
};
function setup(handler: (call: Call) => unknown = () => undefined) {
  const api = new Api(),
    calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const call = JSON.parse(String(init.body));
      calls.push(call);
      const result =
        (await handler(call)) ??
        (call.method === 'import/preview'
          ? preview
          : call.method === 'import/history'
            ? { data: [], complete: true }
            : call.method === 'import/apply'
              ? completion
              : {});
      return {
        ok: true,
        status: 200,
        json: async () =>
          result && typeof result === 'object' && 'fault' in result
            ? { ok: false, error: (result as { fault: unknown }).fault }
            : { ok: true, result },
      };
    }),
  );
  return { api, calls };
}
const props = (api: Api) => ({ api, project, epoch: 'worker', enabled: true, onChanged: vi.fn() });
async function selectGuidance() {
  fireEvent.click(screen.getByRole('button', { name: '检测可导入内容' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: '项目指引 · 当前项目' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /确认导入所选清单/ }));
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('defaults to current registered project inventory and applies only selected opaque IDs', async () => {
  const { api, calls } = setup();
  render(<ImportPanel {...props(api)} />);
  await selectGuidance();
  fireEvent.click(screen.getByRole('button', { name: '导入所选内容' }));
  await screen.findByText('导入已完成');
  const params = calls.find((call) => call.method === 'import/apply')!.params;
  expect(params).toEqual({
    projectId: 'registered',
    includeNativeHome: false,
    maxSessionAgeDays: 30,
    maxSessions: 100,
    previewHash,
    itemIds: [itemId],
    confirm: true,
  });
  expect(params).not.toHaveProperty('cwd');
  expect(params).not.toHaveProperty('migrationItems');
  expect(screen.queryByRole('button', { name: '导入所选内容' })).toBeNull();
});
it('requires separate execution review for MCP or executable configuration and never claims imported MCP stays disabled', async () => {
  const { api, calls } = setup((call) =>
    call.method === 'import/preview'
      ? {
          ...preview,
          items: [
            { ...preview.items[0], itemType: 'MCP_SERVER_CONFIG', requiresExecutionReview: false },
          ],
        }
      : undefined,
  );
  render(<ImportPanel {...props(api)} />);
  fireEvent.click(screen.getByRole('button', { name: '检测可导入内容' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'MCP 配置 · 当前项目' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /确认导入所选清单/ }));
  expect((screen.getByRole('button', { name: '导入所选内容' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /我已核对可执行配置/ }));
  fireEvent.click(screen.getByRole('button', { name: '导入所选内容' }));
  await waitFor(() =>
    expect(calls.find((call) => call.method === 'import/apply')?.params.allowNativeExecution).toBe(
      true,
    ),
  );
});
it('invalidates scope selection and discards a late native-home preview after scope changes', async () => {
  let resolve!: (value: unknown) => void;
  const { api, calls } = setup((call) =>
    call.method === 'import/preview'
      ? new Promise((done) => {
          resolve = done;
        })
      : undefined,
  );
  render(<ImportPanel {...props(api)} />);
  fireEvent.click(screen.getByRole('button', { name: '检测可导入内容' }));
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('checkbox', { name: /同时检测运行时用户目录/ }));
  await act(async () => resolve(preview));
  expect(screen.queryByRole('checkbox', { name: '项目指引 · 当前项目' })).toBeNull();
  expect(calls.some((call) => call.method === 'import/apply')).toBe(false);
});
it('shows partial native completion and normalizes history arrays without claiming complete success', async () => {
  const { api } = setup((call) =>
    call.method === 'import/apply'
      ? {
          ...completion,
          itemTypeResults: [
            ...completion.itemTypeResults,
            {
              itemType: 'SKILLS',
              successCount: 0,
              failureCount: 1,
              failures: [{ failureStage: 'copy', message: 'Already exists' }],
            },
          ],
        }
      : call.method === 'import/history'
        ? {
            data: [
              {
                importId: 'old',
                completedAtMs: 1,
                providerId: 'claude-code',
                successes: [{ itemType: 'CONFIG', target: '/work/config' }],
                failures: [
                  {
                    itemType: 'SKILLS',
                    failureStage: 'detect',
                    message: 'Invalid skill',
                    source: '/work/skill',
                  },
                ],
              },
            ],
            complete: false,
          }
        : undefined,
  );
  render(<ImportPanel {...props(api)} />);
  await selectGuidance();
  fireEvent.click(screen.getByRole('button', { name: '导入所选内容' }));
  await screen.findByText('copy：Already exists');
  expect(screen.getAllByText('导入已完成，部分内容失败').length).toBeGreaterThan(0);
  expect(await screen.findByText('detect：Invalid skill · /work/skill')).toBeTruthy();
  expect(importResults({ successes: [{ itemType: 'CONFIG' }], failures: [] })[0]).toMatchObject({
    successCount: 1,
    failureCount: 0,
  });
});
it('recovers only the original import receipt after a lost response and waits for completed proof', async () => {
  let id = '';
  const { api, calls } = setup((call) => {
    if (call.method === 'import/apply') {
      id = call.operationId!;
      throw new TypeError('lost response');
    }
    if (call.method === 'operation/read')
      return { operationId: id, method: 'import/apply', state: 'accepted', result: completion };
  });
  render(<ImportPanel {...props(api)} />);
  await selectGuidance();
  fireEvent.click(screen.getByRole('button', { name: '导入所选内容' }));
  fireEvent.click(await screen.findByRole('button', { name: '查询原导入操作回执' }));
  await screen.findByText('导入已完成');
  expect(calls.filter((call) => call.method === 'import/apply')).toHaveLength(1);
  expect(
    calls
      .filter((call) => call.method === 'operation/read')
      .every((call) => call.params.operationId === id),
  ).toBe(true);
});
it('keeps stale inventory rejection visible and requires fresh detection instead of automatic import retry', async () => {
  const { api, calls } = setup((call) =>
    call.method === 'import/apply'
      ? { fault: { code: 'import_changed', message: '清单变化，请重新检测', delivery: 'not_sent' } }
      : undefined,
  );
  render(<ImportPanel {...props(api)} />);
  await selectGuidance();
  fireEvent.click(screen.getByRole('button', { name: '导入所选内容' }));
  await screen.findByText('清单变化，请重新检测');
  expect(calls.filter((call) => call.method === 'import/apply')).toHaveLength(1);
  expect(calls.filter((call) => call.method === 'import/preview')).toHaveLength(1);
});
it('uses 110-second timeout only for bounded long mutations and preserves unknown without replay', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout'),
    { api, calls } = setup((call) => {
      if (call.method === 'import/apply') throw new DOMException('Timed out', 'TimeoutError');
    });
  await api.call('import/preview');
  expect(timeout).toHaveBeenLastCalledWith(30_000);
  await expect(api.mutate('import/apply', { projectId: 'registered' })).rejects.toMatchObject({
    delivery: 'unknown',
    code: 'transport_error',
  });
  expect(timeout).toHaveBeenLastCalledWith(110_000);
  expect(calls.filter((call) => call.method === 'import/apply')).toHaveLength(1);
  expect(listOperations().find((operation) => operation.method === 'import/apply')?.state).toBe(
    'unknown',
  );
  await api.call('workspace/worktree/archive');
  expect(timeout).toHaveBeenLastCalledWith(110_000);
  await api.call('workspace/read');
  expect(timeout).toHaveBeenLastCalledWith(30_000);
});
it('exposes import and shared-plugin entries and prevents a foreign project from inheriting the current feedback thread', async () => {
  const { api } = setup((call) =>
    call.method === 'plugin/share/list'
      ? { data: [], nextCursor: null }
      : call.method === 'plugin/list'
        ? { marketplaces: [], marketplaceLoadErrors: [] }
        : call.method === 'memory/status'
          ? { v2ConsolidatedThreads: 0, v2Ready: false }
          : call.method === 'account/usage/read'
            ? { summary: {} }
            : call.method === 'account/workspaceMessages/read'
              ? { messages: [] }
              : call.method === 'server/diagnostics'
                ? { process: { id: 1 }, gauges: [] }
                : {},
  );
  render(
    <ExtensionsPanel
      api={api}
      projects={[project, { id: 'other', name: 'Other', cwd: '/other' }]}
      initialProjectId={project.id}
      threadId="current-thread"
      epoch="one"
      enabled
      onChanged={vi.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: '插件共享' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '导入' }));
  expect(screen.getByRole('heading', { name: '从 Claude Code 导入' })).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: '扩展与配置的项目范围' }), {
    target: { value: 'other' },
  });
  fireEvent.click(screen.getByRole('button', { name: '记忆与诊断' }));
  await screen.findByText('先打开已注册项目中的一个会话，再生成或提交原生反馈。');
  expect(screen.queryByText(/会话：current-thread/)).toBeNull();
});
