// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { OrganizationPanel } from '../components/OrganizationPanel';
import { NativeProjects } from '../components/NativeProjects';
import { SectionSettings, ThreadOrganization } from '../components/ThreadOrganization';
import { sameRoot } from '../lib/organization';
import { enabledButton } from './enabled-button';
type Call = { method: string; params: Record<string, unknown> };
const project = { id: 'registered-root', name: 'Work directory', cwd: '/work/project' },
  native = {
    id: 'native-folder',
    name: 'Product',
    roots: [{ path: project.cwd }],
    metadata: { category: 'demo' },
  },
  section = { id: 'section-one', name: 'Planning', appearance: null };
const read = {
  thread: {
    id: 'thread-one',
    name: 'Current task',
    cwd: project.cwd,
    projectId: 'native-folder',
    section,
    status: { type: 'idle' },
  },
  readState: { firstUnread: null, revision: 'read-v1' },
};
const defaults = (call: Call): unknown =>
  call.method === 'nativeProject/read'
    ? { project: native }
    : call.method === 'nativeProject/list'
      ? {
          data: [
            native,
            { ...native, id: 'foreign-folder', name: 'Other path', roots: [{ path: '/foreign' }] },
          ],
          nextCursor: null,
        }
      : call.method === 'threadSection/list'
        ? { data: [section], nextCursor: null }
        : call.method === 'thread/read'
          ? read
          : { data: [], nextCursor: null };
function setup(handler: (call: Call) => unknown = defaults) {
  const api = new Api(),
    calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const call = JSON.parse(String(init.body));
      calls.push(call);
      const result = await handler(call);
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
const projectProps = (api: Api) => ({
  api,
  epoch: 'one',
  projects: [project],
  threadId: 'thread-one',
  threadEnabled: true,
  idle: true,
  enabled: true,
  onChanged: vi.fn(),
});
const threadProps = (api: Api) => ({
  api,
  epoch: 'one',
  threadId: 'thread-one',
  project,
  enabled: true,
  ready: true,
  idle: true,
  onChanged: vi.fn(),
  onDeleted: vi.fn(),
  onOpenThread: vi.fn(),
});
let settleMutations = async () => {};
beforeEach(() => {
  const mutations = vi.spyOn(Api.prototype, 'beginMutation');
  settleMutations = async () => {
    await Promise.allSettled(mutations.mock.results.flatMap(result =>
      result.type === 'return' ? [result.value.result] : []));
  };
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(async () => {
  await act(settleMutations);
  cleanup();
  vi.unstubAllGlobals();
});
it('creates native project metadata from registered IDs, never browser-supplied root paths', async () => {
  const { api, calls } = setup();
  render(<NativeProjects {...projectProps(api)} />);
  fireEvent.click(screen.getByRole('button', { name: '新建项目归类' }));
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), {
    target: { value: 'New organization' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /Work directory/ }));
  fireEvent.click(screen.getByRole('button', { name: '创建项目归类' }));
  await waitFor(() =>
    expect(calls.some((call) => call.method === 'nativeProject/create')).toBe(true),
  );
  const params = calls.find((call) => call.method === 'nativeProject/create')!.params;
  expect(params.projectIds).toEqual(['registered-root']);
  expect(params.idempotencyKey).toEqual(expect.any(String));
  expect(params).not.toHaveProperty('roots');
  expect(params).not.toHaveProperty('cwd');
});
it('renames a native project without replacing inaccessible roots or unedited metadata', async () => {
  const { api, calls } = setup((call) =>
    call.method === 'nativeProject/read'
      ? { project: { ...native, roots: [{ path: '/unregistered/path' }] } }
      : defaults(call),
  );
  render(<NativeProjects {...projectProps(api)} />);
  fireEvent.click(await screen.findByRole('button', { name: /Product.*1 个工作目录/ }));
  fireEvent.click(await screen.findByRole('button', { name: '编辑项目名称与范围' }));
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), {
    target: { value: 'Renamed' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存项目变更' }));
  await waitFor(() =>
    expect(calls.some((call) => call.method === 'nativeProject/update')).toBe(true),
  );
  expect(calls.find((call) => call.method === 'nativeProject/update')?.params).toEqual({
    nativeProjectId: 'native-folder',
    name: 'Renamed',
  });
});
it('disables import of current thread without global idle and full history readiness', () => {
  const { api } = setup();
  render(<NativeProjects {...projectProps(api)} idle={false} threadEnabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: '新建项目归类' }));
  expect(
    (screen.getByRole('checkbox', { name: /将当前已加载会话导入/ }) as HTMLInputElement).disabled,
  ).toBe(true);
});
it('requires explicit project and section deletion intents and sends only native identity', async () => {
  const { api, calls } = setup();
  const view = render(<NativeProjects {...projectProps(api)} />);
  fireEvent.click(await screen.findByRole('button', { name: /Product.*1 个工作目录/ }));
  await screen.findByRole('button', { name: '编辑项目名称与范围' });
  fireEvent.click(screen.getByText('删除项目组织', { selector: 'summary' }));
  const remove = screen.getByRole('button', { name: '删除项目组织' });
  expect((remove as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: /确认删除项目/ }));
  fireEvent.click(remove);
  await waitFor(() =>
    expect(calls.some((call) => call.method === 'nativeProject/delete')).toBe(true),
  );
  expect(calls.find((call) => call.method === 'nativeProject/delete')?.params).toEqual({
    nativeProjectId: 'native-folder',
  });
  view.unmount();
  render(<SectionSettings api={api} epoch="one" enabled onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '删除分组' }));
  expect(calls.some((call) => call.method === 'threadSection/delete')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '确认删除分组组织' }));
  await waitFor(() =>
    expect(calls.some((call) => call.method === 'threadSection/delete')).toBe(true),
  );
  expect(calls.find((call) => call.method === 'threadSection/delete')?.params).toEqual({
    sectionId: 'section-one',
  });
});
it('offers only native projects that include current cwd and never changes the thread working directory', async () => {
  const { api, calls } = setup();
  render(<ThreadOrganization {...threadProps(api)} />);
  await screen.findByRole('option', { name: 'Product' });
  expect(screen.queryByRole('option', { name: 'Other path' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '保存项目归属' }));
  await waitFor(() =>
    expect(calls.some((call) => call.method === 'thread/project/set')).toBe(true),
  );
  expect(calls.find((call) => call.method === 'thread/project/set')?.params).toEqual({
    threadId: 'thread-one',
    nativeProjectId: 'native-folder',
  });
  expect(sameRoot('D:\\work\\project', 'd:/work/project/')).toBe(true);
  expect(sameRoot('/work/Project', '/work/project')).toBe(false);
});
it.each([
  ['/srv/alpha\\beta', '/srv/alpha/beta', false],
  ['/srv/alpha\\beta/', '/srv/alpha\\beta', true],
  ['/srv/alpha\\', '/srv/alpha', false],
  ['/srv/Project', '/srv/project', false],
  ['/', '', false],
  ['/', '///', true],
  ['D:\\', 'd:/', true],
  ['D:/', 'D:', false],
  ['D:\\work\\project', 'd:/WORK/project/', true],
  ['\\\\Server\\Share\\Work', '\\\\server/share/work/', true],
  ['\\\\Server\\Share', '\\\\server/share/', true],
  ['\\\\server\\share\\work', '//server/share/work', false],
])('compares explicit path identities %s and %s as %s', (left, right, equal) => {
  expect(sameRoot(left as string, right as string)).toBe(equal);
  expect(sameRoot(right as string, left as string)).toBe(equal);
});

const rootCases = [
  ['POSIX literal backslash', '/srv/alpha\\beta', '/srv/alpha\\beta/', '/srv/alpha/beta'],
  ['POSIX root', '/', '///', '/srv'],
  ['Windows drive', 'D:\\work\\project', 'd:/WORK/project/', 'd:/work/other'],
  ['Windows UNC', '\\\\Server\\Share\\Work', '\\\\server/share/work/', '//server/share/work'],
] as const;
it.each(rootCases)('replacing %s directory scope submits only its matching registered project ID', async (_kind, rootPath, matchingPath, unrelatedPath) => {
  const matching = { id: 'matching', name: 'Matching directory', cwd: matchingPath };
  const unrelated = { id: 'unrelated', name: 'Unrelated directory', cwd: unrelatedPath };
  const category = { id: 'category', name: 'Category', roots: [{ path: rootPath }], metadata: {} };
  const { api, calls } = setup(call => call.method === 'nativeProject/list'
    ? { data: [category], nextCursor: null } : { project: category });
  render(<NativeProjects {...projectProps(api)} projects={[matching, unrelated]} />);
  fireEvent.click(await screen.findByRole('button', { name: /Category.*1 个工作目录/ }));
  fireEvent.click(await screen.findByRole('button', { name: '编辑项目名称与范围' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /替换项目目录范围/ }));
  expect(screen.getByRole('checkbox', { name: /Matching directory/ })).toHaveProperty('checked', true);
  expect(screen.getByRole('checkbox', { name: /Unrelated directory/ })).toHaveProperty('checked', false);
  fireEvent.click(screen.getByRole('button', { name: '保存项目变更' }));
  await waitFor(() => expect(calls.filter(call => call.method === 'nativeProject/update')).toHaveLength(1));
  expect(calls.find(call => call.method === 'nativeProject/update')?.params).toEqual({
    nativeProjectId: 'category', name: 'Category', projectIds: ['matching'],
  });
});

it('does not label a literal POSIX backslash root registered merely because its nested lookalike exists', async () => {
  const category = { id: 'category', name: 'Category', roots: [{ path: '/srv/alpha\\beta' }], metadata: {} };
  const { api, calls } = setup(call => call.method === 'nativeProject/list'
    ? { data: [category], nextCursor: null } : { project: category });
  render(<NativeProjects {...projectProps(api)} projects={[{ id: 'nested', name: 'Nested directory', cwd: '/srv/alpha/beta' }]} />);
  fireEvent.click(await screen.findByRole('button', { name: /Category.*1 个工作目录/ }));
  expect(await screen.findByText(/未注册，仅显示元数据/)).toBeTruthy();
  expect(calls.some(call => call.method === 'nativeProject/update')).toBe(false);
});

it.each(rootCases)('thread association for %s excludes a distinct root and preserves the correct project identity', async (_kind, rootPath, matchingPath, unrelatedPath) => {
  const matching = { ...native, id: 'matching-category', name: 'Matching category', roots: [{ path: rootPath }] };
  const unrelated = { ...native, id: 'unrelated-category', name: 'Unrelated category', roots: [{ path: unrelatedPath }] };
  const currentProject = { ...project, cwd: matchingPath };
  const { api, calls } = setup(call => call.method === 'nativeProject/list'
    ? { data: [matching, unrelated], nextCursor: null }
    : call.method === 'thread/read'
      ? { ...read, thread: { ...read.thread, cwd: matchingPath, projectId: matching.id } }
      : defaults(call));
  render(<ThreadOrganization {...threadProps(api)} project={currentProject} />);
  await screen.findByRole('option', { name: 'Matching category' });
  expect(screen.queryByRole('option', { name: 'Unrelated category' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '保存项目归属' }));
  await waitFor(() => expect(calls.filter(call => call.method === 'thread/project/set')).toHaveLength(1));
  expect(calls.find(call => call.method === 'thread/project/set')?.params).toEqual({
    threadId: 'thread-one', nativeProjectId: 'matching-category',
  });
});
it('preserves the read section when saving without editing its selection', async () => {
  const { api, calls } = setup();
  render(<ThreadOrganization {...threadProps(api)} />);
  await screen.findByRole('option', { name: 'Planning' });
  fireEvent.click(screen.getByRole('button', { name: '保存分组与顺序' }));
  await waitFor(() =>
    expect(calls.some((call) => call.method === 'thread/section/move')).toBe(true),
  );
  expect(calls.find((call) => call.method === 'thread/section/move')?.params).toEqual({
    threadId: 'thread-one',
    sectionId: 'section-one',
    beforeThreadId: null,
  });
});
it('sends explicit empty project and section choices instead of restoring their read defaults', async () => {
  const { api, calls } = setup(),
    props = threadProps(api);
  render(<ThreadOrganization {...props} />);
  await screen.findByRole('option', { name: 'Product' });
  fireEvent.change(screen.getByRole('combobox', { name: '所属原生项目归类' }), {
    target: { value: '' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存项目归属' }));
  await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
  expect(calls.find((call) => call.method === 'thread/project/set')?.params).toEqual({
    threadId: 'thread-one',
    nativeProjectId: null,
  });
  await screen.findByRole('option', { name: 'Planning' });
  fireEvent.change(screen.getByRole('combobox', { name: '所属分组' }), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '保存分组与顺序' }));
  await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(2));
  expect(calls.find((call) => call.method === 'thread/section/move')?.params).toEqual({
    threadId: 'thread-one',
    sectionId: null,
    beforeThreadId: null,
  });
});
it('does not retry a stale read-state update and uses a freshly read revision only on another user action', async () => {
  let version = 'read-v1';
  const { api, calls } = setup((call) =>
    call.method === 'thread/read'
      ? { ...read, readState: { firstUnread: null, revision: version } }
      : call.method === 'thread/readState/update'
        ? { fault: { message: 'read state changed', code: 'conflict', delivery: 'not_sent' } }
        : defaults(call),
  );
  render(<ThreadOrganization {...threadProps(api)} />);
  fireEvent.click(await screen.findByRole('button', { name: '标记未读' }));
  await screen.findByText('read state changed');
  expect(calls.filter((call) => call.method === 'thread/readState/update')).toHaveLength(1);
  version = 'read-v2';
  fireEvent.click(screen.getByRole('button', { name: '重新读取会话分组' }));
  await screen.findByRole('button', { name: '标记未读' });
  fireEvent.click(screen.getByRole('button', { name: '标记未读' }));
  await waitFor(() =>
    expect(calls.filter((call) => call.method === 'thread/readState/update')).toHaveLength(2),
  );
  expect(
    calls.filter((call) => call.method === 'thread/readState/update')[1]?.params.expectedRevision,
  ).toBe('read-v2');
});
it('preserves read-only browsing and requires readiness plus explicit permanent deletion confirmation', async () => {
  const { api, calls } = setup(),
    props = threadProps(api);
  const view = render(<ThreadOrganization {...props} ready={false} />);
  await screen.findByRole('button', { name: '停止订阅此会话' });
  fireEvent.click(screen.getByRole('button', { name: '停止订阅此会话' }));
  await waitFor(() =>
    expect(calls.some((call) => call.method === 'thread/unsubscribe')).toBe(true),
  );
  await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
  expect(calls.some((call) => call.method === 'thread/resume')).toBe(false);
  await screen.findByText('永久删除此会话历史');
  fireEvent.click(screen.getByText('永久删除此会话历史'));
  fireEvent.click(screen.getByRole('checkbox', { name: /确认永久删除当前会话/ }));
  expect(
    (screen.getByRole('button', { name: '永久删除会话历史' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  view.rerender(<ThreadOrganization {...props} ready />);
  fireEvent.click(await enabledButton({ name: '永久删除会话历史' }));
  await waitFor(() => expect(props.onDeleted).toHaveBeenCalledOnce());
  expect(calls.find((call) => call.method === 'thread/delete')?.params).toEqual({
    threadId: 'thread-one',
  });
});
it('saves explicit association metadata and keeps empty filtered owner pages navigable', async () => {
  const attachment = {
    id: 'attachment',
    attachmentType: 'pull_request',
    identityKey: 'https://example.invalid/pull/1',
    payload: { url: 'https://example.invalid/pull/1' },
  };
  let added = false;
  const { api, calls } = setup((call) =>
    call.method === 'thread/attachment/list'
      ? { data: added ? [attachment] : [], nextCursor: null }
      : call.method === 'thread/attachment/add'
        ? ((added = true), { outcome: 'created', attachment })
        : call.method === 'thread/attachmentOwner/list'
          ? call.params.cursor
            ? { data: [{ threadId: 'other-thread', archived: false }], nextCursor: null }
            : { data: [], nextCursor: 'next' }
          : defaults(call),
  );
  const props = threadProps(api);
  render(<ThreadOrganization {...props} />);
  fireEvent.change(await screen.findByRole('combobox', { name: '关联类型' }), {
    target: { value: 'pull_request' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'HTTP(S) 地址' }), {
    target: { value: attachment.identityKey },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存关联描述' }));
  fireEvent.click(await screen.findByRole('button', { name: '查找同项目关联会话' }));
  fireEvent.click(await screen.findByRole('button', { name: '继续查找关联会话' }));
  fireEvent.click(await screen.findByRole('button', { name: 'other-thread' }));
  expect(props.onOpenThread).toHaveBeenCalledWith('other-thread');
  expect(calls.find((call) => call.method === 'thread/attachment/add')?.params).toMatchObject({
    threadId: 'thread-one',
    attachmentType: 'pull_request',
    identityKey: attachment.identityKey,
  });
  expect(
    calls
      .filter((call) => call.method === 'thread/attachmentOwner/list')
      .every((call) => call.params.projectId === 'registered-root'),
  ).toBe(true);
});

const organizationProps = (api: Api) => ({
  api, epoch: 'one', projects: [project], projectId: project.id, threadId: 'thread-one',
  enabled: true, threadReady: true, threadIdle: true, globalIdle: true,
  onChanged: vi.fn(), onDeleted: vi.fn(), onOpenThread: vi.fn(), onClose: vi.fn(),
});
const organizationTab = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
async function newOrganizationDraft() {
  organizationTab('项目归类');
  fireEvent.click(screen.getByRole('button', { name: '新建项目归类' }));
  const input = screen.getByRole('textbox', { name: '项目名称' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'Unsent project name' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /Work directory/ }));
  return input;
}

it('retains project, section and thread association drafts across category switches without submitting them', async () => {
  const { api, calls } = setup();
  render(<OrganizationPanel {...organizationProps(api)} />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'HTTP(S) 地址' }), { target: { value: 'https://example.invalid/unsent' } });
  fireEvent.change(screen.getByRole('textbox', { name: '关联说明（可选）' }), { target: { value: 'Unsent association' } });
  const projectInput = await newOrganizationDraft();
  const form = projectInput.closest('form')!;
  organizationTab('分组标签');
  expect(projectInput.isConnected).toBe(true);
  expect(projectInput.closest('[hidden][inert]')).toBeTruthy();
  fireEvent.submit(form);
  expect(calls.some(call => call.method === 'nativeProject/create')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '新增分组' }));
  const sectionInput = screen.getByRole('textbox', { name: '分组名称' }) as HTMLInputElement;
  fireEvent.change(sectionInput, { target: { value: 'Unsent section name' } });
  organizationTab('当前会话');
  expect((await screen.findByRole('textbox', { name: 'HTTP(S) 地址' }) as HTMLInputElement).value).toBe('https://example.invalid/unsent');
  expect((screen.getByRole('textbox', { name: '关联说明（可选）' }) as HTMLInputElement).value).toBe('Unsent association');
  organizationTab('项目归类');
  expect(screen.getByRole('textbox', { name: '项目名称' })).toBe(projectInput);
  expect(projectInput.value).toBe('Unsent project name');
  organizationTab('分组标签');
  expect(screen.getByRole('textbox', { name: '分组名称' })).toBe(sectionInput);
  expect(sectionInput.value).toBe('Unsent section name');
  expect(calls.some(call => /create|update|attachment\/add/.test(call.method))).toBe(false);
});

it.each(['accepted', 'unknown'] as const)('keeps the original project operation %s while another category is edited', async outcome => {
  let finish!: (result: unknown) => void, reject!: (error: Error) => void;
  const pending = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
  const { api, calls } = setup(call => call.method === 'nativeProject/create' ? pending : defaults(call));
  const props = organizationProps(api);
  render(<OrganizationPanel {...props} />);
  organizationTab('分组标签');
  fireEvent.click(screen.getByRole('button', { name: '新增分组' }));
  fireEvent.change(screen.getByRole('textbox', { name: '分组名称' }), { target: { value: 'Independent section draft' } });
  await newOrganizationDraft();
  fireEvent.click(screen.getByRole('button', { name: '创建项目归类' }));
  await waitFor(() => expect(calls.filter(call => call.method === 'nativeProject/create')).toHaveLength(1));
  organizationTab('分组标签');
  expect((screen.getByRole('textbox', { name: '分组名称' }) as HTMLInputElement).value).toBe('Independent section draft');
  await act(async () => { if (outcome === 'accepted') finish({ project: native }); else reject(new Error('response lost')); });
  if (outcome === 'accepted') {
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByRole('textbox', { name: '分组名称' }), { target: { value: 'New section after accepted project' } });
    organizationTab('项目归类');
    expect(screen.queryByRole('textbox', { name: '项目名称' })).toBeNull();
    organizationTab('分组标签');
    expect((screen.getByRole('textbox', { name: '分组名称' }) as HTMLInputElement).value).toBe('New section after accepted project');
    expect(props.onChanged).toHaveBeenCalled();
  } else {
    organizationTab('项目归类');
    expect(await screen.findByRole('button', { name: '查询原项目操作回执' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: '项目名称' }) as HTMLInputElement).value).toBe('Unsent project name');
    expect(screen.getByRole('button', { name: '创建项目归类' }).matches(':disabled')).toBe(true);
  }
  expect(calls.filter(call => call.method === 'nativeProject/create')).toHaveLength(1);
});

it.each(['api', 'epoch', 'thread', 'project'] as const)('does not revive organization drafts across %s owner A-to-B-to-A', async kind => {
  const { api } = setup(), props = organizationProps(api);
  const view = render(<OrganizationPanel {...props} />);
  const input = await newOrganizationDraft();
  const other = { ...props, ...(kind === 'api' ? { api: new Api() } : kind === 'epoch' ? { epoch: 'two' } : kind === 'thread' ? { threadId: 'thread-two' } : { projectId: 'other-project' }) };
  view.rerender(<OrganizationPanel {...other} />);
  view.rerender(<OrganizationPanel {...props} />);
  expect(input.isConnected).toBe(false);
  organizationTab('项目归类');
  expect(screen.queryByRole('textbox', { name: '项目名称' })).toBeNull();
});
