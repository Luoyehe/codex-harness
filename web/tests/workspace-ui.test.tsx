// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { FileEditor } from '../components/FileEditor';
import { WorkspacePanel } from '../components/WorkspacePanel';
import { WorkspaceGit } from '../components/WorkspaceGit';
import {
  fileDraftKey,
  newFileDraft,
  persistFileDraft,
  readFileDraft,
  type FileDraft,
} from '../lib/file-drafts';
import {
  checkedDirectory,
  checkedSnapshot,
  fileTextError,
  workspacePath,
  type FileSnapshot,
} from '../lib/workspace';
import { listOperations } from '../lib/operations';

const a = 'a'.repeat(64),
  b = 'b'.repeat(64),
  c = 'c'.repeat(64);
const snapshot = (text = 'base', revision = a, path = 'file.txt'): FileSnapshot => ({
  path,
  kind: 'file',
  revision,
  text,
  bytes: text.length,
  binary: false,
  editable: true,
});
const project = { id: 'project-one', name: 'One', cwd: '/registered/one' };
const response = (result: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, result }),
});
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const editorProps = (api: Api, remote = snapshot()) => ({
  api,
  projectId: project.id,
  path: 'file.txt',
  remote,
  creating: false,
  loading: false,
  readError: '',
  enabled: true,
  cache: new Map<string, FileDraft>(),
  onChanged: vi.fn(),
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('rejects escaping paths and invalid preview identities before exposing editable content', () => {
  for (const path of [
    '/private',
    '../file',
    'a/../b',
    'a\\b',
    '.git/config',
    '.harness-workspace/state',
    'a\0b',
  ])
    expect(() => workspacePath(path)).toThrow();
  expect(workspacePath('src/AGENTS.md')).toBe('src/AGENTS.md');
  expect(() => checkedSnapshot(snapshot('base', a, 'other'), 'file.txt')).toThrow(/不匹配/);
  expect(() =>
    checkedDirectory(
      {
        path: '',
        entries: [
          { name: 'a', kind: 'file', bytes: 1, accessible: true },
          { name: 'a', kind: 'file', bytes: 1, accessible: true },
        ],
        truncated: false,
      },
      '',
    ),
  ).toThrow();
  expect(fileTextError('界'.repeat(200000))).toContain('512 KiB');
  expect(fileTextError('a\0b')).toContain('NUL');
});
it('preserves a conflicting draft and writes only after explicit rebase to the latest revision', async () => {
  const api = new Api(),
    calls: Call[] = [],
    props = editorProps(api);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url, init: RequestInit) => {
      const call = JSON.parse(String(init.body));
      calls.push(call);
      return Promise.resolve(
        response(
          call.method === 'workspace/read'
            ? snapshot('mine', c)
            : { path: 'file.txt', revision: c, bytes: 4 },
        ),
      );
    }),
  );
  const view = render(<FileEditor {...props} />);
  await screen.findByRole('textbox', { name: '文件内容' });
  fireEvent.change(screen.getByRole('textbox', { name: '文件内容' }), {
    target: { value: 'mine' },
  });
  view.rerender(<FileEditor {...props} remote={snapshot('external change', b)} />);
  await screen.findByText('文件版本已变化');
  expect((screen.getByRole('button', { name: '保存文件' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(readFileDraft(project.id, 'file.txt')?.baseRevision).toBe(a);
  expect(calls).toHaveLength(0);
  fireEvent.click(screen.getByRole('checkbox', { name: /我已比较/ }));
  fireEvent.click(screen.getByRole('button', { name: '以最新文件为基准继续编辑' }));
  fireEvent.click(screen.getByRole('button', { name: '保存文件' }));
  await screen.findByText('保存结果已读取核对。');
  expect(calls.find((call) => call.method === 'workspace/write')?.params).toEqual({
    projectId: project.id,
    path: 'file.txt',
    text: 'mine',
    expectedRevision: b,
  });
  expect(readFileDraft(project.id, 'file.txt')).toBeUndefined();
  expect(props.cache.size).toBe(0);
});
it('retains edits typed while a prior save is in flight and rebases them only on verified readback', async () => {
  const api = new Api(),
    props = editorProps(api);
  let finish!: () => void;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url, init: RequestInit) => {
      const call = JSON.parse(String(init.body));
      if (call.method === 'workspace/write')
        return new Promise((resolve) => {
          finish = () => resolve(response({ path: 'file.txt', revision: b, bytes: 6 }));
        });
      return Promise.resolve(response(snapshot('sent-v1', b)));
    }),
  );
  render(<FileEditor {...props} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '文件内容' }), {
    target: { value: 'sent-v1' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存文件' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  fireEvent.change(screen.getByRole('textbox', { name: '文件内容' }), {
    target: { value: 'newer-v2' },
  });
  await act(async () => finish());
  await screen.findByText('保存结果已读取核对。');
  expect((screen.getByRole('textbox', { name: '文件内容' }) as HTMLTextAreaElement).value).toBe(
    'newer-v2',
  );
  expect(readFileDraft(project.id, 'file.txt')).toMatchObject({
    baseRevision: b,
    baseText: 'sent-v1',
    text: 'newer-v2',
  });
  expect(readFileDraft(project.id, 'file.txt')?.pending).toBeUndefined();
});
it('queries the original uncertain save and never repeats the file write', async () => {
  const api = new Api(),
    calls: Call[] = [],
    props = editorProps(api);
  let identity = '';
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url, init: RequestInit) => {
      const call: Call = JSON.parse(String(init.body));
      calls.push(call);
      if (call.method === 'workspace/write') {
        identity = call.operationId!;
        return Promise.reject(new Error('HTTP response lost'));
      }
      if (call.method === 'operation/read')
        return Promise.resolve(
          response({
            operationId: identity,
            method: 'workspace/write',
            state: 'accepted',
            result: { path: 'file.txt', revision: b },
          }),
        );
      return Promise.resolve(response(snapshot('saved', b)));
    }),
  );
  render(<FileEditor {...props} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '文件内容' }), {
    target: { value: 'saved' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存文件' }));
  await screen.findByText('HTTP response lost');
  expect(readFileDraft(project.id, 'file.txt')?.pending?.operationId).toBe(identity);
  expect((screen.getByRole('button', { name: '保存文件' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: '查询原保存回执并核对文件' }));
  await screen.findByText('保存结果已读取核对。');
  expect(calls.filter((call) => call.method === 'workspace/write')).toHaveLength(1);
  expect(calls.find((call) => call.method === 'operation/read')?.params).toEqual({
    operationId: identity,
  });
  expect(listOperations().find((op) => op.id === identity)?.state).toBe('accepted');
});
it('does not turn an unknown native outcome or missing receipt into retry permission', async () => {
  const api = new Api(),
    props = editorProps(api);
  let identity = '';
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url, init: RequestInit) => {
      const call: Call = JSON.parse(String(init.body));
      if (call.method === 'workspace/write') {
        identity = call.operationId!;
        return Promise.reject(new Error('lost'));
      }
      return Promise.resolve(response({ operationId: identity, state: 'not_received' }));
    }),
  );
  render(<FileEditor {...props} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '文件内容' }), {
    target: { value: 'keep me' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存文件' }));
  await screen.findByText('lost');
  fireEvent.click(screen.getByRole('button', { name: '查询原保存回执并核对文件' }));
  await screen.findByText(/原保存结果仍未确认/);
  expect(readFileDraft(project.id, 'file.txt')?.text).toBe('keep me');
  expect(readFileDraft(project.id, 'file.txt')?.pending?.operationId).toBe(identity);
  expect((screen.getByRole('button', { name: '保存文件' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});
it('does not dispatch when saving the local write intent fails', async () => {
  const api = new Api(),
    fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (key.startsWith('harness.file-draft') && JSON.parse(value).pending)
      throw new DOMException('quota');
    return original.call(this, key, value);
  });
  render(<FileEditor {...editorProps(api)} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '文件内容' }), {
    target: { value: 'memory only' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存文件' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('文件尚未发送'));
  expect(fetcher).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox', { name: '文件内容' }) as HTMLTextAreaElement).value).toBe(
    'memory only',
  );
  expect(readFileDraft(project.id, 'file.txt')?.text).toBe('memory only');
  expect(listOperations()[0]?.state).toBe('not_sent');
});
it('keeps a creation revision null and preserves its draft on navigation before acceptance', async () => {
  const api = new Api(),
    cache = new Map<string, FileDraft>(),
    calls: Call[] = [];
  let finish!: () => void;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url, init: RequestInit) => {
      const call = JSON.parse(String(init.body));
      calls.push(call);
      return new Promise((resolve) => {
        finish = () => resolve(response({ path: 'new.txt', revision: a }));
      });
    }),
  );
  const view = render(
    <FileEditor {...editorProps(api)} cache={cache} path="new.txt" remote={undefined} creating />,
  );
  fireEvent.change(screen.getByRole('textbox', { name: '文件内容' }), {
    target: { value: 'new file text' },
  });
  fireEvent.click(screen.getByRole('button', { name: '创建文件' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.unmount();
  await act(async () => finish());
  expect(calls[0]?.params).toEqual({
    projectId: project.id,
    path: 'new.txt',
    text: 'new file text',
    expectedRevision: null,
  });
  expect(cache.get(fileDraftKey(project.id, 'new.txt'))?.pending).toBeTruthy();
  expect(calls).toHaveLength(1);
});

function panelApi() {
  const calls: Call[] = [],
    api = new Api();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url, init: RequestInit) => {
      const call: Call = JSON.parse(String(init.body));
      calls.push(call);
      const path = String(call.params.path ?? '');
      const result =
        call.method === 'workspace/list'
          ? {
              path,
              entries: [
                { name: 'file.txt', kind: 'file', bytes: 4, accessible: true },
                { name: 'binary', kind: 'file', bytes: 3, accessible: true },
                { name: 'large', kind: 'file', bytes: 600000, accessible: true },
                { name: 'link', kind: 'unsupported', bytes: 1, accessible: false },
              ],
              truncated: true,
            }
          : call.method === 'workspace/metadata'
            ? !path
              ? { path, kind: 'directory', revision: a }
              : path === 'large'
                ? { path, kind: 'file', bytes: 600000, editable: false, reason: 'file_too_large' }
                : { path, kind: 'file', bytes: 4, revision: a }
            : call.method === 'workspace/read'
              ? path === 'binary'
                ? { path, kind: 'file', bytes: 3, revision: a, binary: true, editable: false }
                : snapshot('base', a, path)
              : {
                  path: call.params.destination ?? path,
                  revision: b,
                  created: true,
                  removed: true,
                };
      return Promise.resolve(response(result));
    }),
  );
  return { api, calls };
}
it('shows bounded listings and binary or large previews explicitly', async () => {
  const { api } = panelApi();
  render(
    <WorkspacePanel
      api={api}
      project={project}
      epoch="one"
      connected
      ready
      onReviewBase={vi.fn()}
    />,
  );
  await screen.findByText(/目录只显示最多/);
  expect((screen.getByRole('button', { name: /link/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /binary/ }));
  await screen.findByText(/二进制或非 UTF-8/);
  expect(screen.queryByRole('textbox', { name: '文件内容' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /large/ }));
  await screen.findByText(/超过 512 KiB/);
  expect(screen.queryByRole('textbox', { name: '文件内容' })).toBeNull();
});
it('copies with the captured source revision and deletes only with explicit non-recursive intent', async () => {
  const { api, calls } = panelApi();
  render(
    <WorkspacePanel
      api={api}
      project={project}
      epoch="one"
      connected
      ready
      onReviewBase={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: /file.txt/ }));
  await screen.findByRole('button', { name: '复制' });
  fireEvent.click(screen.getByRole('button', { name: '复制' }));
  fireEvent.change(screen.getByRole('textbox', { name: /复制到项目内路径/ }), {
    target: { value: 'copy.txt' },
  });
  fireEvent.click(screen.getByRole('button', { name: '提交' }));
  await waitFor(() => expect(calls.some((call) => call.method === 'workspace/copy')).toBe(true));
  expect(calls.find((call) => call.method === 'workspace/copy')?.params).toEqual({
    projectId: project.id,
    path: 'file.txt',
    destination: 'copy.txt',
    expectedRevision: a,
  });
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  expect((screen.getByRole('button', { name: '确认删除' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.change(screen.getByRole('textbox', { name: '输入完整相对路径以确认' }), {
    target: { value: 'file.txt' },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(calls.some((call) => call.method === 'workspace/remove')).toBe(true));
  expect(calls.find((call) => call.method === 'workspace/remove')?.params).toEqual({
    projectId: project.id,
    path: 'file.txt',
    expectedRevision: a,
    confirm: true,
    recursive: false,
  });
});
it('keeps project roots out of browser requests and does not let a stale open take over the next project', async () => {
  let finish!: (value: unknown) => void;
  const call = vi.fn().mockImplementation((method: string, params: Record<string, unknown>) => {
    if (params.path === 'late.txt')
      return new Promise((resolve) => {
        finish = resolve;
      });
    return Promise.resolve(
      method === 'workspace/list'
        ? { path: '', entries: [], truncated: false }
        : { path: '', kind: 'directory', revision: a },
    );
  });
  const api = { call } as unknown as Api,
    props = { api, project, epoch: 'one', connected: true, ready: true, onReviewBase: vi.fn() };
  const view = render(<WorkspacePanel {...props} />);
  fireEvent.change(screen.getByRole('textbox', { name: '项目内路径' }), {
    target: { value: 'late.txt' },
  });
  fireEvent.click(screen.getByRole('button', { name: '打开路径' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.rerender(
    <WorkspacePanel
      {...props}
      project={{ ...project, id: 'project-two', cwd: '/registered/two' }}
    />,
  );
  await act(async () => finish(snapshot('late', a, 'late.txt')));
  expect(screen.queryByRole('heading', { name: 'late.txt' })).toBeNull();
  expect(call.mock.calls.every((args) => !('cwd' in args[1]) && !('root' in args[1]))).toBe(true);
});
it('preserves distinct drafts for the same relative path in different projects', () => {
  persistFileDraft({ ...newFileDraft('one', 'file.txt', a, 'base'), text: 'project one' });
  persistFileDraft({ ...newFileDraft('two', 'file.txt', b, 'base'), text: 'project two' });
  expect(readFileDraft('one', 'file.txt')?.text).toBe('project one');
  expect(readFileDraft('two', 'file.txt')?.text).toBe('project two');
});
it('uses real ref selection only as a review target and never sends checkout or arbitrary Git argv', async () => {
  const call = vi.fn().mockImplementation((method: string) =>
    Promise.resolve(
      method === 'workspace/git/status'
        ? { entries: [{ index: ' ', worktree: 'M', path: 'file.txt' }], complete: true }
        : method === 'workspace/git/diff'
          ? { text: '+changed', staged: false, complete: true }
          : {
              refs: [{ name: 'refs/heads/main', objectId: a, symbolicTarget: null }],
              truncated: false,
            },
    ),
  );
  const review = vi.fn();
  render(
    <WorkspaceGit
      api={{ call } as unknown as Api}
      project={project}
      epoch="one"
      connected
      onFile={vi.fn()}
      onReviewBase={review}
    />,
  );
  await screen.findByRole('option', { name: 'refs/heads/main' });
  fireEvent.change(screen.getByRole('combobox', { name: '选择引用' }), {
    target: { value: 'refs/heads/main' },
  });
  fireEvent.click(screen.getByRole('button', { name: '以此为基准发起审查' }));
  expect(review).toHaveBeenCalledWith('refs/heads/main');
  expect(
    call.mock.calls.every((args) =>
      ['workspace/git/status', 'workspace/git/diff', 'workspace/git/refs'].includes(args[0]),
    ),
  ).toBe(true);
});
