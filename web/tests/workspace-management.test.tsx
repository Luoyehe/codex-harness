// @vitest-environment jsdom
import { enabledButton } from './enabled-button';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { WorkspaceRecovery } from '../components/WorkspaceRecovery';
import { WorkspaceWorktrees } from '../components/WorkspaceWorktrees';
import { WorkspaceCommit } from '../components/WorkspaceCommit';
import { WorkspaceDownload } from '../components/WorkspaceDownload';
import { createOperation, listOperations, updateOperation } from '../lib/operations';
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const project = { id: 'registered', name: 'Project', cwd: '/work' },
  sourceId = '11111111-1111-4111-8111-111111111111',
  treeId = '22222222-2222-4222-8222-222222222222';
const record = {
  operationId: sourceId,
  state: 'completed',
  manifest: 'a'.repeat(64),
  discarded: false,
  entries: [
    {
      slot: 'before',
      kind: 'file',
      revision: 'b'.repeat(64),
      bytes: 3,
      text: 'old',
      editable: true,
      binary: false,
    },
  ],
};
const tree = {
  worktreeId: treeId,
  projectId: treeId,
  originProjectId: project.id,
  name: 'Isolated tree',
  path: '/managed/worktrees/' + treeId,
  lastConfirmedPhase: 'active',
  head: 'a'.repeat(40),
  revision: 'a'.repeat(64),
  worktreeVersion: 2,
  updatedAt: 1,
};
const commitState = {
  head: 'a'.repeat(40),
  symbolicTarget: 'refs/heads/main',
  headRevision: 'b'.repeat(64),
  indexRevision: 'c'.repeat(64),
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
        (call.method === 'workspace/recovery/list'
          ? { records: [record], complete: true, receiptLimit: 256 }
          : call.method === 'workspace/recovery/read'
            ? record
            : call.method === 'workspace/metadata'
              ? { path: call.params.path, kind: 'file', bytes: 3, revision: 'c'.repeat(64) }
              : call.method === 'workspace/worktree/list'
                ? { data: [tree] }
                : call.method === 'workspace/worktree/read'
                  ? { ...tree, phase: 'active', revision: 'd'.repeat(64) }
                  : call.method === 'workspace/git/refs'
                    ? {
                        refs: [
                          {
                            name: 'refs/heads/main',
                            objectId: 'a'.repeat(40),
                            symbolicTarget: null,
                          },
                        ],
                        truncated: false,
                      }
                    : call.method === 'workspace/git/status'
                      ? { complete: true, entries: [], commitState }
                      : call.method === 'workspace/git/diff'
                        ? {
                            text: 'diff --git a/file b/file\n-old\n+new',
                            staged: true,
                            complete: true,
                          }
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
const recoveryProps = (api: Api) => ({
  api,
  project,
  epoch: 'one',
  connected: true,
  enabled: true,
  onChanged: vi.fn(),
  onOpenFile: vi.fn(),
});
const treeProps = (api: Api) => ({
  api,
  project,
  epoch: 'one',
  connected: true,
  idle: true,
  onChanged: vi.fn(),
  onSelectProject: vi.fn(),
});
async function source() {
  await screen.findByRole('option', { name: new RegExp(sourceId) });
  fireEvent.change(screen.getByRole('combobox', { name: '选择备份记录' }), {
    target: { value: sourceId },
  });
  await screen.findByText('old');
  fireEvent.change(screen.getByRole('textbox', { name: '恢复到项目内路径' }), {
    target: { value: 'restored.txt' },
  });
}
async function selectTree() {
  await screen.findByRole('option', { name: /Isolated tree/ });
  fireEvent.change(screen.getByRole('combobox', { name: '选择受管工作树' }), {
    target: { value: treeId },
  });
  await screen.findByText(/实时状态：/);
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
it('restores to an explicitly new path with no-replace null and preserves exact source identity', async () => {
  const { api, calls } = setup();
  render(<WorkspaceRecovery {...recoveryProps(api)} />);
  await source();
  fireEvent.click(screen.getByRole('checkbox', { name: /确认将所选备份/ }));
  fireEvent.click(screen.getByRole('button', { name: '执行恢复' }));
  await waitFor(() =>
    expect(calls.find((call) => call.method === 'workspace/recovery/restore')?.params).toEqual({
      projectId: project.id,
      recoveryOperationId: sourceId,
      slot: 'before',
      path: 'restored.txt',
      sourceRevision: 'b'.repeat(64),
      expectedRevision: null,
    }),
  );
  expect(calls.some((call) => call.method === 'workspace/metadata')).toBe(false);
});
it('requires a successful target version read for overwrite and never converts a generic read error into absence', async () => {
  let reject = true;
  const { api, calls } = setup((call) =>
    call.method === 'workspace/metadata' && reject
      ? {
          fault: {
            code: 'workspace_error',
            message: 'Cannot inspect target',
            delivery: 'not_sent',
          },
        }
      : undefined,
  );
  render(<WorkspaceRecovery {...recoveryProps(api)} />);
  await source();
  fireEvent.change(screen.getByRole('combobox', { name: '目标方式' }), {
    target: { value: 'replace' },
  });
  fireEvent.click(screen.getByRole('button', { name: '读取目标当前版本' }));
  await screen.findByText('Cannot inspect target');
  fireEvent.click(screen.getByRole('checkbox', { name: /确认将所选备份/ }));
  expect((screen.getByRole('button', { name: '执行恢复' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(calls.some((call) => call.method === 'workspace/recovery/restore')).toBe(false);
  reject = false;
  fireEvent.click(screen.getByRole('button', { name: '读取目标当前版本' }));
  await screen.findByText(/将替换现有文件/);
  fireEvent.click(screen.getByRole('checkbox', { name: /确认将所选备份/ }));
  fireEvent.click(screen.getByRole('button', { name: '执行恢复' }));
  await waitFor(() =>
    expect(
      calls.find((call) => call.method === 'workspace/recovery/restore')?.params.expectedRevision,
    ).toBe('c'.repeat(64)),
  );
});
it('does not infer accepted global receipts from local completed material and restricts discard to completed sources', async () => {
  const op = (await createOperation('workspace/write', {
    projectId: project.id,
    resourceId: 'original.txt',
  }));
  (await updateOperation(op.id, 'unknown'));
  const { api, calls } = setup();
  const view = render(<WorkspaceRecovery {...recoveryProps(api)} />);
  await source();
  expect((await listOperations()).find((operation) => operation.id === op.id)?.state).toBe('unknown');
  expect(calls.some((call) => call.method === 'operation/read')).toBe(false);
  fireEvent.click(screen.getByRole('checkbox', { name: /确认永久清理/ }));
  expect((screen.getByRole('button', { name: '清理备份内容' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  view.unmount();
  localStorage.clear();
  const other = setup((call) =>
    call.method === 'workspace/recovery/read' ? { ...record, state: 'failed' } : undefined,
  );
  render(<WorkspaceRecovery {...recoveryProps(other.api)} />);
  await source();
  fireEvent.click(screen.getByRole('checkbox', { name: /确认永久清理/ }));
  expect((screen.getByRole('button', { name: '清理备份内容' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});
it('requires the displayed manifest and a separate intent to discard backup bytes', async () => {
  const { api, calls } = setup();
  render(<WorkspaceRecovery {...recoveryProps(api)} />);
  await source();
  expect((screen.getByRole('button', { name: '清理备份内容' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /确认永久清理/ }));
  fireEvent.click(screen.getByRole('button', { name: '清理备份内容' }));
  await waitFor(() =>
    expect(calls.find((call) => call.method === 'workspace/recovery/discard')?.params).toEqual({
      projectId: project.id,
      recoveryOperationId: sourceId,
      expectedManifest: record.manifest,
      confirm: true,
    }),
  );
});
it('uses live worktree phase and revision rather than the old registration proof', async () => {
  const { api, calls } = setup((call) =>
      call.method === 'workspace/worktree/read'
        ? {
            worktreeId: treeId,
            phase: 'archived',
            path: '/archive/' + treeId,
            head: tree.head,
            revision: 'd'.repeat(64),
          }
        : undefined,
    ),
    props = treeProps(api);
  render(<WorkspaceWorktrees {...props} />);
  await selectTree();
  expect(screen.queryByRole('button', { name: '归档工作树…' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '恢复工作树…' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /确认对上述工作树/ }));
  fireEvent.click(screen.getByRole('button', { name: '确认恢复工作树' }));
  await waitFor(() =>
    expect(calls.find((call) => call.method === 'workspace/worktree/restore')?.params).toEqual({
      projectId: project.id,
      worktreeId: treeId,
      expectedRevision: 'd'.repeat(64),
      confirm: true,
    }),
  );
  await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
});
it('requires global idle for worktree mutation and sends only registered origin and selected full ref', async () => {
  const { api, calls } = setup(),
    props = treeProps(api);
  const view = render(<WorkspaceWorktrees {...props} idle={false} />);
  fireEvent.click(screen.getByRole('button', { name: '从 Git 引用创建新工作树' }));
  await screen.findByRole('option', { name: 'refs/heads/main' });
  fireEvent.change(screen.getByRole('combobox', { name: '起始 Git 引用' }), {
    target: { value: 'refs/heads/main' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /确认从所选 Git/ }));
  expect((screen.getByRole('button', { name: '创建工作树' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  view.rerender(<WorkspaceWorktrees {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '创建工作树' }));
  await waitFor(() =>
    expect(calls.find((call) => call.method === 'workspace/worktree/create')?.params).toEqual({
      projectId: project.id,
      ref: 'refs/heads/main',
    }),
  );
});
it('queries the original lost worktree creation receipt without spawning another checkout', async () => {
  let id = '';
  const { api, calls } = setup((call) => {
    if (call.method === 'workspace/worktree/create') {
      id = call.operationId!;
      throw new TypeError('Lost response');
    }
    if (call.method === 'operation/read')
      return {
        operationId: id,
        method: 'workspace/worktree/create',
        state: 'accepted',
        result: { worktreeId: id },
      };
  });
  const props = treeProps(api);
  render(<WorkspaceWorktrees {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '从 Git 引用创建新工作树' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /确认从所选 Git/ }));
  fireEvent.click(screen.getByRole('button', { name: '创建工作树' }));
  fireEvent.click(await enabledButton({ name: '查询原工作树操作回执' }));
  await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
  expect(calls.filter((call) => call.method === 'workspace/worktree/create')).toHaveLength(1);
  expect(calls.find((call) => call.method === 'operation/read')?.params).toEqual({
    operationId: id,
  });
});
it('commits only the reviewed HEAD/index with explicit author and no implicit staging', async () => {
  const { api, calls } = setup();
  render(<WorkspaceCommit api={api} project={project} epoch="one" enabled onChanged={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', { name: '提交作者' }), {
    target: { value: 'Reviewer' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '提交作者邮箱' }), {
    target: { value: 'reviewer@example.invalid' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '提交说明' }), {
    target: { value: 'Document behavior' },
  });
  fireEvent.click(screen.getByRole('button', { name: '核对 HEAD 与已暂存修改' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: /确认以上暂存修改/ }));
  fireEvent.click(screen.getByRole('button', { name: '提交已暂存内容' }));
  await waitFor(() =>
    expect(calls.find((call) => call.method === 'workspace/git/commit')?.params).toEqual({
      projectId: project.id,
      expectedHead: commitState.head,
      expectedHeadRevision: commitState.headRevision,
      expectedIndexRevision: commitState.indexRevision,
      author: { name: 'Reviewer', email: 'reviewer@example.invalid' },
      message: 'Document behavior',
    }),
  );
  expect(calls.filter((call) => call.method === 'workspace/git/status')).toHaveLength(2);
  expect(calls.some((call) => call.method.includes('stage'))).toBe(false);
});
it('refuses a commit preview when the index changes during its diff read', async () => {
  let reads = 0;
  const { api, calls } = setup((call) =>
    call.method === 'workspace/git/status'
      ? {
          complete: true,
          commitState: {
            ...commitState,
            indexRevision: ++reads > 1 ? 'd'.repeat(64) : commitState.indexRevision,
          },
        }
      : undefined,
  );
  render(<WorkspaceCommit api={api} project={project} epoch="one" enabled onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '核对 HEAD 与已暂存修改' }));
  await screen.findByText('读取期间 HEAD 或暂存区发生变化，请重新核对。');
  expect(screen.queryByRole('checkbox', { name: /确认以上暂存修改/ })).toBeNull();
  expect(calls.some((call) => call.method === 'workspace/git/commit')).toBe(false);
});
it('downloads exact selected bytes and drops late responses after changing the file owner', async () => {
  let finish!: (value: unknown) => void;
  const { api, calls } = setup(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    ),
    create = vi.fn(() => 'blob:test');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const file = {
    path: 'file.txt',
    kind: 'file' as const,
    bytes: 3,
    revision: 'a'.repeat(64),
    downloadable: true,
  };
  const view = render(<WorkspaceDownload api={api} projectId="first" file={file} connected />);
  fireEvent.click(screen.getByRole('button', { name: '下载文件' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.rerender(<WorkspaceDownload api={api} projectId="second" file={file} connected />);
  await act(async () =>
    finish({ path: file.path, revision: file.revision, bytes: 3, base64: 'b2xk' }),
  );
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '下载文件' }));
  await act(async () =>
    finish({ path: file.path, revision: file.revision, bytes: 3, base64: 'b2xk' }),
  );
  expect(create).toHaveBeenCalledOnce();
  expect(calls[1]?.params.projectId).toBe('second');
});

it('keeps worktree creation and archive confirmations exclusive and requires fresh consent for each action', async () => {
  const { api, calls } = setup();
  render(<WorkspaceWorktrees {...treeProps(api)} />);
  await selectTree();
  fireEvent.click(screen.getByRole('button', { name: '从 Git 引用创建新工作树' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /确认从所选 Git/ }));
  fireEvent.click(await enabledButton({ name: '归档工作树…' }));
  expect(screen.queryByRole('checkbox', { name: /确认从所选 Git/ })).toBeNull();
  expect(
    (screen.getByRole('checkbox', { name: /确认对上述工作树/ }) as HTMLInputElement).checked,
  ).toBe(false);
  expect(
    (screen.getByRole('button', { name: '确认归档工作树' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: /确认对上述工作树/ }));
  fireEvent.click(screen.getByRole('button', { name: '从 Git 引用创建新工作树' }));
  expect(screen.queryByRole('button', { name: '确认归档工作树' })).toBeNull();
  expect(
    (screen.getByRole('checkbox', { name: /确认从所选 Git/ }) as HTMLInputElement).checked,
  ).toBe(false);
  expect(calls.some((call) => call.operationId)).toBe(false);
});
it('does not reuse worktree confirmation for another worktree with the same revision', async () => {
  const otherId = '33333333-3333-4333-8333-333333333333';
  const { api, calls } = setup((call) =>
    call.method === 'workspace/worktree/list'
      ? { data: [tree, { ...tree, worktreeId: otherId, name: 'Other tree' }] }
      : call.method === 'workspace/worktree/read'
        ? { ...tree, worktreeId: call.params.worktreeId, phase: 'active', revision: 'd'.repeat(64) }
        : undefined,
  );
  render(<WorkspaceWorktrees {...treeProps(api)} />);
  await selectTree();
  fireEvent.click(await enabledButton({ name: '归档工作树…' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /确认对上述工作树/ }));
  fireEvent.change(screen.getByRole('combobox', { name: '选择受管工作树' }), {
    target: { value: otherId },
  });
  await screen.findByText(/实时状态：/);
  fireEvent.click(await enabledButton({ name: '归档工作树…' }));
  expect(
    (screen.getByRole('button', { name: '确认归档工作树' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole('checkbox', { name: /确认对上述工作树/ }) as HTMLInputElement).checked,
  ).toBe(false);
  expect(calls.some((call) => call.operationId)).toBe(false);
});
it('invalidates worktree creation consent on ref and epoch ABA changes while retaining the entered ref', async () => {
  const { api, calls } = setup(),
    initial = treeProps(api),
    view = render(<WorkspaceWorktrees {...initial} />);
  fireEvent.click(screen.getByRole('button', { name: '从 Git 引用创建新工作树' }));
  await screen.findByRole('option', { name: 'refs/heads/main' });
  const ref = screen.getByRole('combobox', { name: '起始 Git 引用' }),
    consent = () => screen.getByRole('checkbox', { name: /确认从所选 Git/ }) as HTMLInputElement;
  fireEvent.click(consent());
  fireEvent.change(ref, { target: { value: 'refs/heads/main' } });
  fireEvent.change(ref, { target: { value: 'HEAD' } });
  expect(consent().checked).toBe(false);
  fireEvent.click(consent());
  view.rerender(<WorkspaceWorktrees {...initial} epoch="next" />);
  view.rerender(<WorkspaceWorktrees {...initial} />);
  expect(consent().checked).toBe(false);
  expect((ref as HTMLSelectElement).value).toBe('HEAD');
  expect(calls.some((call) => call.operationId)).toBe(false);
});
it('does not close or clear a new worktree form when an earlier scope creation is acknowledged', async () => {
  let finish!: (value: unknown) => void;
  const { api } = setup((call) =>
      call.method === 'workspace/worktree/create'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : undefined,
    ),
    initial = treeProps(api);
  const view = render(<WorkspaceWorktrees {...initial} />);
  fireEvent.click(screen.getByRole('button', { name: '从 Git 引用创建新工作树' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /确认从所选 Git/ }));
  fireEvent.click(screen.getByRole('button', { name: '创建工作树' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.rerender(<WorkspaceWorktrees {...initial} epoch="next" />);
  view.rerender(<WorkspaceWorktrees {...initial} />);
  await act(async () => finish({ worktreeId: treeId }));
  expect(screen.getByRole('button', { name: '创建工作树' })).toBeTruthy();
  expect(initial.onChanged).not.toHaveBeenCalled();
  expect(
    (screen.getByRole('checkbox', { name: /确认从所选 Git/ }) as HTMLInputElement).checked,
  ).toBe(false);
});
it('does not dismiss a later worktree intent when an earlier operation recovery finishes in the same scope', async () => {
  let first = '',
    second = '',
    finish!: (value: unknown) => void;
  const { api } = setup((call) => {
      if (call.method === 'workspace/worktree/create') {
        first = call.operationId!;
        throw new Error('first response lost');
      }
      if (call.method === 'workspace/worktree/archive') {
        second = call.operationId!;
        throw new Error('second response lost');
      }
      if (call.method === 'operation/read')
        return new Promise((resolve) => {
          finish = resolve;
        });
      return undefined;
    }),
    initial = treeProps(api);
  render(<WorkspaceWorktrees {...initial} />);
  fireEvent.click(screen.getByRole('button', { name: '从 Git 引用创建新工作树' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /确认从所选 Git/ }));
  fireEvent.click(screen.getByRole('button', { name: '创建工作树' }));
  fireEvent.click(await enabledButton({ name: '查询原工作树操作回执' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  await act(async () => (await updateOperation(first, 'accepted')));
  await waitFor(() => expect(initial.onChanged).toHaveBeenCalled());
  await selectTree();
  fireEvent.click(await enabledButton({ name: '归档工作树…' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /确认对上述工作树/ }));
  fireEvent.click(screen.getByRole('button', { name: '确认归档工作树' }));
  await screen.findByText('second response lost');
  const changed = initial.onChanged.mock.calls.length;
  await act(async () =>
    finish({
      operationId: first,
      method: 'workspace/worktree/create',
      state: 'accepted',
      result: { worktreeId: treeId },
    }),
  );
  expect((await listOperations()).find((operation) => operation.id === second)?.state).toBe('unknown');
  expect(screen.getByRole('button', { name: '确认归档工作树' })).toBeTruthy();
  expect(initial.onChanged).toHaveBeenCalledTimes(changed);
});
