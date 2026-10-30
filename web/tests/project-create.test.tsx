// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Api } from '../lib/api';
import { ProjectDialog } from '../components/ProjectDialog';
import { listOperations, updateOperation } from '../lib/operations';
const native = { mode: 'native' as const, effectiveUid: 1000 };
const root = { mode: 'root' as const, effectiveUid: 0 };

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('a new user creates a usable project with just its name, without knowing a server path', async () => {
  const requests: { method: string; params: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    return { status: 200, ok: true, json: async () => ({ ok: true, result: request.method === 'project/defaults' ? { directory: '/native/projects' } : { id: 'created', name: 'my-project', path: '/native/projects/my-project' } }) };
  }));
  const onAdded = vi.fn(), onClose = vi.fn(), onOpen = vi.fn();
  render(<ProjectDialog executionMode={native} executionModeConfirmed api={new Api()} onAdded={onAdded} onClose={onClose} onOpen={onOpen} />);
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'my-project' } });
  await screen.findByText('/native/projects/my-project');
  const save = screen.getByRole('button', { name: '创建项目' }); await waitFor(() => expect(save).toHaveProperty('disabled', false)); fireEvent.click(save);
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(requests.filter(item => item.method === 'project/create')).toMatchObject([{ params: { name: 'my-project', directory: 'my-project' } }]);
  expect(onAdded).toHaveBeenCalledOnce();
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('created');
});

test('existing directories remain a separate flow and show a useful permission error without losing the path', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body);
    return { status: 200, ok: true, json: async () => request.method === 'project/defaults' ? { ok: true, result: { directory: '/native/projects' } } : { ok: false, error: { code: 'project_permission_denied', message: '项目执行账号无法访问此目录。请使用“新建项目”。', delivery: 'not_sent' } } };
  }));
  render(<ProjectDialog executionMode={native} executionModeConfirmed api={new Api()} onAdded={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '添加已有目录' }));
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'Existing' } });
  fireEvent.change(screen.getByRole('textbox', { name: '项目路径' }), { target: { value: '/root/project' } });
  const save = screen.getByRole('button', { name: '添加项目' }); await waitFor(() => expect(save).toHaveProperty('disabled', false)); fireEvent.click(save);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '项目执行账号无法访问此目录。请使用“新建项目”。');
  expect(screen.getByRole('textbox', { name: '项目路径' })).toHaveProperty('value', '/root/project');
});

test('an accepted project without an ID stays visible for reconciliation and cannot be resubmitted', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request.method);
    return { status: 200, ok: true, json: async () => ({ ok: true, result: request.method === 'project/defaults' ? { directory: '/native/projects' } : {} }) };
  }));
  const onOpen = vi.fn(), onClose = vi.fn();
  render(<ProjectDialog executionMode={native} executionModeConfirmed api={new Api()} onAdded={vi.fn()} onClose={onClose} onOpen={onOpen} />);
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'new-project' } });
  const save = screen.getByRole('button', { name: '创建项目' });
  await waitFor(() => expect(save).toHaveProperty('disabled', false)); fireEvent.click(save);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '项目已受理，但未收到项目编号。请关闭窗口后在项目列表中核对，不要重复添加。');
  expect(save).toHaveProperty('disabled', true);
  fireEvent.submit(save.closest('form')!);
  expect(requests.filter(method => method === 'project/create')).toHaveLength(1);
  expect(onOpen).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
});

test('an unknown project later confirmed accepted stays frozen without a second create', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request.method);
    if (request.method === 'project/defaults') return { status: 200, ok: true, json: async () => ({ ok: true, result: { directory: '/native/projects' } }) };
    throw new Error('Fixture response lost after server acceptance');
  }));
  const api = new Api(), mutate = vi.spyOn(api, 'mutate'), onAdded = vi.fn(), onOpen = vi.fn(), onClose = vi.fn();
  render(<ProjectDialog executionMode={native} executionModeConfirmed api={api} onAdded={onAdded} onClose={onClose} onOpen={onOpen} />);
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'new-project' } });
  const save = screen.getByRole('button', { name: '创建项目' });
  await waitFor(() => expect(save).toHaveProperty('disabled', false)); fireEvent.click(save);
  await waitFor(async () => expect((await listOperations())[0]?.state).toBe('unknown'));
  expect(save).toHaveProperty('disabled', true);
  const operation = (await listOperations())[0]!;
  await act(async () => { await updateOperation(operation.id, 'accepted'); });
  await waitFor(() => expect(onAdded).toHaveBeenCalledOnce());
  expect(await screen.findByText('项目已受理。请关闭窗口后在项目列表中核对，不要重复添加。')).toBeTruthy();
  expect(save).toHaveProperty('disabled', true);
  fireEvent.click(save); fireEvent.submit(save.closest('form')!);
  expect(mutate).toHaveBeenCalledOnce();
  expect(requests.filter(method => method === 'project/create')).toHaveLength(1);
  expect(onOpen).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
});

test('project mode choices expose their selected state and retain both drafts without submitting', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request.method);
    if (request.method !== 'project/defaults') throw new Error('Mode switching must not submit');
    return { status: 200, ok: true, json: async () => ({ ok: true, result: { directory: '/native/projects' } }) };
  }));
  render(<ProjectDialog executionMode={native} executionModeConfirmed api={new Api()} onAdded={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} />);
  await screen.findByText('/native/projects');
  const create = screen.getByRole('button', { name: '新建项目' });
  const existing = screen.getByRole('button', { name: '添加已有目录' });
  expect(create.getAttribute('aria-pressed')).toBe('true');
  expect(existing.getAttribute('aria-pressed')).toBe('false');
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'Shared name' } });
  fireEvent.change(screen.getByRole('textbox', { name: '项目路径' }), { target: { value: 'new-directory' } });
  fireEvent.click(existing);
  expect(existing.getAttribute('aria-pressed')).toBe('true');
  expect(create.getAttribute('aria-pressed')).toBe('false');
  fireEvent.change(screen.getByRole('textbox', { name: '项目路径' }), { target: { value: '/existing/project' } });
  fireEvent.click(create);
  expect(screen.getByRole('textbox', { name: '项目路径' })).toHaveProperty('value', 'new-directory');
  fireEvent.click(existing);
  expect(screen.getByRole('textbox', { name: '项目路径' })).toHaveProperty('value', '/existing/project');
  expect(screen.getByRole('textbox', { name: '项目名称' })).toHaveProperty('value', 'Shared name');
  expect(requests).toEqual(['project/defaults']);
});

const paths = [
  ['create', './nested//leaf///', 'nested/leaf', '/projects/base/nested/leaf', '相对路径'],
  ['create', '../sibling//leaf', '../sibling/leaf', '/projects/sibling/leaf', '相对路径'],
  ['create', '/srv//a/../new///', '/srv/new', '/srv/new', '绝对路径'],
  ['create', 'CON:literal\\name?*', 'CON:literal\\name?*', '/projects/base/CON:literal\\name?*', '相对路径'],
  ['existing', 'relative//../found/', 'found', '/projects/base/found', '相对路径'],
  ['existing', '../existing/./', '../existing', '/projects/existing', '相对路径'],
  ['existing', '/', '/', '/', '绝对路径'],
];
test.each(['native', 'root'].flatMap(identity => paths.map(row => [identity, ...row])))('%s %s path %s uses the normalized preview and request', async (identity, kind, input, normalized, preview, label) => {
  const api = new Api();
  vi.spyOn(api, 'call').mockResolvedValue({ directory: '/projects/base///' });
  const mutate = vi.spyOn(api, 'mutate').mockResolvedValue({ id: 'created' });
  render(<ProjectDialog api={api} executionMode={identity === 'root' ? root : native} executionModeConfirmed onAdded={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} />);
  if (kind === 'existing') fireEvent.click(screen.getByRole('button', { name: '添加已有目录' }));
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'Readable name' } });
  fireEvent.change(screen.getByRole('textbox', { name: '项目路径' }), { target: { value: input } });
  await screen.findByText(preview!);
  expect(screen.getByText(label!, { selector: 'strong' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: kind === 'create' ? '创建项目' : '添加项目' }));
  await waitFor(() => expect(mutate).toHaveBeenCalledExactlyOnceWith(kind === 'create' ? 'project/create' : 'project/add',
    { name: 'Readable name', [kind === 'create' ? 'directory' : 'path']: normalized }));
});

test('root uses the same explicit relative suggestion and never replaces a manually entered absolute path', async () => {
  const api = new Api();
  vi.spyOn(api, 'call').mockResolvedValue({ directory: '/root/projects' });
  const mutate = vi.spyOn(api, 'mutate').mockResolvedValue({ id: 'created' });
  render(<ProjectDialog api={api} executionMode={root} executionModeConfirmed onAdded={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'name-derived' } });
  await screen.findByText('/root/projects/name-derived');
  expect(screen.getByText('name-derived', { selector: 'code' })).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: '项目路径' }), { target: { value: '/srv/manual/' } });
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'renamed' } });
  expect(screen.getByRole('textbox', { name: '项目路径' })).toHaveProperty('value', '/srv/manual/');
  expect(screen.getByText('/srv/manual')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
  await waitFor(() => expect(mutate).toHaveBeenCalledExactlyOnceWith('project/create', { name: 'renamed', directory: '/srv/manual' }));
});

test.each([
  ['create', 'server root', '/', '不能新建服务器根目录'],
  ['existing', 'control character', 'bad\tpath', '不能包含控制字符'],
  ['create', 'invalid Unicode', 'bad\ud800path', '无效 Unicode'],
  ['create', 'UTF8 budget', '/very/' + '目'.repeat(1400), '4096 字节'],
  ['create', 'escaped JSON budget', '/' + '\\'.repeat(2100), '4096 字节'],
])('%s rejects %s with a visible explanation', async (kind, _label, input, explanation) => {
  const api = new Api();
  vi.spyOn(api, 'call').mockResolvedValue({ directory: '/projects' });
  const mutate = vi.spyOn(api, 'mutate');
  render(<ProjectDialog api={api} onAdded={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} />);
  if (kind === 'existing') fireEvent.click(screen.getByRole('button', { name: '添加已有目录' }));
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'Project' } });
  fireEvent.change(screen.getByRole('textbox', { name: '项目路径' }), { target: { value: input } });
  await screen.findByText('/projects');
  expect(screen.getByRole('alert').textContent).toContain(explanation);
  const button = screen.getByRole('button', { name: kind === 'create' ? '创建项目' : '添加项目' });
  expect(button).toHaveProperty('disabled', true);
  fireEvent.submit(button.closest('form')!); expect(mutate).not.toHaveBeenCalled();
});

test.each(['create', 'existing'])('%s waits for valid defaults and preserves its path on read failure/retry', async kind => {
  let reject!: (error: Error) => void;
  const api = new Api(), mutate = vi.spyOn(api, 'mutate');
  const call = vi.spyOn(api, 'call').mockImplementationOnce(() => new Promise((_resolve, reject_) => { reject = reject_; }));
  render(<ProjectDialog api={api} onAdded={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} />);
  if (kind === 'existing') fireEvent.click(screen.getByRole('button', { name: '添加已有目录' }));
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'Project' } });
  fireEvent.change(screen.getByRole('textbox', { name: '项目路径' }), { target: { value: '../project' } });
  const button = screen.getByRole('button', { name: kind === 'create' ? '创建项目' : '添加项目' });
  expect(button).toHaveProperty('disabled', true);
  await act(async () => reject(new Error('Fixture defaults offline')));
  expect(screen.getByRole('alert').textContent).toContain('Fixture defaults offline');
  fireEvent.submit(button.closest('form')!); expect(mutate).not.toHaveBeenCalled();
  call.mockResolvedValue({ directory: '/projects/base' });
  fireEvent.click(screen.getByRole('button', { name: '重试读取目录' }));
  await waitFor(() => expect(button).toHaveProperty('disabled', false));
  expect(screen.getByRole('textbox', { name: '项目路径' })).toHaveProperty('value', '../project');
  expect(screen.getByText('/projects/project')).toBeTruthy();
});

test.each(['api', 'csrf', 'epoch', 'root-to-native', 'native-to-root', 'uid'])(
  '%s owner change preserves text but discards previous defaults and late responses', async change => {
    const api = new Api(), nextApi = change === 'api' ? new Api() : api;
    const resolvers: ((value: Record<string, unknown>) => void)[] = [];
    const read = () => new Promise<Record<string, unknown>>(resolve => resolvers.push(resolve));
    vi.spyOn(api, 'call').mockImplementation(read);
    if (nextApi !== api) vi.spyOn(nextApi, 'call').mockImplementation(read);
    const before = change === 'native-to-root' || change === 'uid' ? native : root;
    const after = change === 'root-to-native' ? native : change === 'native-to-root' ? root : change === 'uid' ? { ...native, effectiveUid: 1001 } : root;
    const props = { api, epoch: 'epoch-1', executionMode: before, executionModeConfirmed: true, onAdded: vi.fn(), onClose: vi.fn(), onOpen: vi.fn() };
    const ui = render(<ProjectDialog {...props} />);
    fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'Retained name' } });
    fireEvent.change(screen.getByRole('textbox', { name: '项目路径' }), { target: { value: '../retained' } });
    if (change === 'csrf') api.csrf = 'new-login';
    ui.rerender(<ProjectDialog {...props} api={nextApi} epoch={change === 'epoch' ? 'epoch-2' : props.epoch} executionMode={after} />);
    expect(screen.getByRole('textbox', { name: '项目路径' })).toHaveProperty('value', '../retained');
    expect(resolvers).toHaveLength(2);
    await act(async () => resolvers[0]!({ directory: '/obsolete/projects' }));
    expect(screen.queryByText(/obsolete/)).toBeNull();
    expect(screen.getByRole('button', { name: '创建项目' })).toHaveProperty('disabled', true);
    await act(async () => resolvers[1]!({ directory: '/current/projects/' }));
    expect(screen.getByText('/current/retained')).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建项目' })).toHaveProperty('disabled', false);
  },
);

test('an old accepted create completion cannot close or navigate the replacement runtime form', async () => {
  const api = new Api();
  vi.spyOn(api, 'call').mockResolvedValue({ directory: '/projects' });
  let complete!: (value: Record<string, unknown>) => void;
  vi.spyOn(api, 'mutate').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const props = { api, onAdded: vi.fn(), onClose: vi.fn(), onOpen: vi.fn() };
  const ui = render(<ProjectDialog {...props} epoch="old" />);
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'Old project' } });
  await waitFor(() => expect(screen.getByRole('button', { name: '创建项目' })).toHaveProperty('disabled', false));
  fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
  ui.rerender(<ProjectDialog {...props} epoch="new" />);
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'New project' } });
  await act(async () => complete({ id: 'old-created' }));
  expect(props.onClose).not.toHaveBeenCalled(); expect(props.onOpen).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: '项目名称' })).toHaveProperty('value', 'New project');
});

test('native absolute permission failures preserve the path and server ROOT instructions without switching mode', async () => {
  const api = new Api(), calls: string[] = [];
  const permission = '当前执行账号无权创建此目录。请先在服务器授权 ROOT，再到网页设置明确切换 ROOT 执行模式。';
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); calls.push(request.method);
    return { status: 200, ok: true, json: async () => request.method === 'project/defaults'
      ? { ok: true, result: { directory: '/projects' } }
      : { ok: false, error: { code: 'project_permission_denied', message: permission, delivery: 'not_sent' } } };
  }));
  render(<ProjectDialog api={api} executionMode={native} executionModeConfirmed onAdded={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'Project' } });
  fireEvent.change(screen.getByRole('textbox', { name: '项目路径' }), { target: { value: '/root/project' } });
  await waitFor(() => expect(screen.getByRole('button', { name: '创建项目' })).toHaveProperty('disabled', false));
  fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', permission);
  expect(screen.getByRole('textbox', { name: '项目路径' })).toHaveProperty('value', '/root/project');
  expect(calls).toEqual(['project/defaults', 'project/create']);
});

test.each([
  ['C:\\projects\\', 'C:\\workspace\\existing\\', 'C:/workspace/existing', 'C:/workspace/existing'],
  ['\\\\server\\share\\projects', '..\\existing\\', '../existing', '//server/share/existing'],
])('Windows development base %s retains its platform path semantics', async (base, input, normalized, preview) => {
  const api = new Api();
  vi.spyOn(api, 'call').mockResolvedValue({ directory: base });
  const mutate = vi.spyOn(api, 'mutate').mockResolvedValue({ id: 'added' });
  render(<ProjectDialog api={api} onAdded={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '添加已有目录' }));
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'Existing' } });
  fireEvent.change(screen.getByRole('textbox', { name: '项目路径' }), { target: { value: input } });
  await screen.findByText(preview);
  fireEvent.click(screen.getByRole('button', { name: '添加项目' }));
  await waitFor(() => expect(mutate).toHaveBeenCalledExactlyOnceWith('project/add', { name: 'Existing', path: normalized }));
});
