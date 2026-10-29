// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { SkillCreator, SkillDocument, SkillRoots } from '../components/SkillLibraryTools';
import { readFileDraft } from '../lib/file-drafts';
import { enabledButton } from './enabled-button';
import { ExtensionsPanel } from '../components/ExtensionsPanel';
import userEvent from '@testing-library/user-event';
import { listOperations } from '../lib/operations';
const project = { id: 'project', name: 'Project', cwd: '/project' },
  hash = 'a'.repeat(64),
  source = '---\nname: review\ndescription: Review changes\n---\n\nInspect changes.';
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const settleFixtures: (() => Promise<unknown>)[] = [];
const props = (api: Api) => ({ api, project, epoch: 'epoch', enabled: true, onChanged: vi.fn() });
function route(handler: (call: Call) => unknown) {
  const calls: Call[] = [],
    api = new Api();
  const mutations = vi.spyOn(api, 'beginMutation');
  settleFixtures.push(() => Promise.allSettled(
    mutations.mock.results.filter((result) => result.type === 'return').map((result) => result.value.result),
  ));
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, init) => {
      const call: Call = JSON.parse(init.body);
      calls.push(call);
      const result = await handler(call);
      return {
        ok: true,
        status: 200,
        json: async () =>
          result && typeof result === 'object' && 'error' in result
            ? { ok: false, ...result }
            : { ok: true, result },
      };
    }),
  );
  return { api, calls };
}
const missing = () => ({ error: { code: 'not_found', message: 'Missing', delivery: 'not_sent' } });
const metadata = (path: unknown) => ({ path, kind: 'directory', revision: hash });
function prepare() {
  fireEvent.click(screen.getByText('在项目中新建或导入 SKILL.md', { selector: 'summary' }));
  fireEvent.change(screen.getByRole('textbox', { name: '技能目录名称' }), {
    target: { value: 'review' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '技能说明' }), {
    target: { value: source },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /已查看内容/ }));
  fireEvent.click(screen.getByRole('button', { name: '保存本地草稿并检查目录' }));
}
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(async () => {
  await act(async () => {
    for (const settle of settleFixtures.splice(0)) await settle();
  });
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('reads skill identity only, escapes content, and rejects cross-skill results', async () => {
  const { api, calls } = route((call) => ({
    skillId: call.params.skillId,
    path: '/project/.agents/skills/review/SKILL.md',
    text: '<script>do not execute</script>',
    bytes: 32,
    revision: hash,
    name: 'review',
  }));
  const view = render(<SkillDocument api={api} project={project} epoch="epoch" skillId={hash} />);
  await screen.findByText('<script>do not execute</script>');
  expect(document.querySelector('script')).toBeNull();
  expect(calls[0]?.params).toEqual({ projectId: 'project', skillId: hash });
  view.unmount();
  const other = route(() => ({ skillId: 'b'.repeat(64), text: 'foreign', revision: hash }));
  render(<SkillDocument api={other.api} project={project} epoch="epoch" skillId={hash} />);
  await screen.findByText(/身份不匹配/);
  expect(screen.queryByText('foreign')).toBeNull();
});
it('replaces extra roots using only selected registered IDs after explicit consent', async () => {
  let roots: string[] = ['/project'];
  const { api, calls } = route((call) =>
    call.method === 'skills/extraRoots/read'
      ? { roots, persistence: 'current_runtime' }
      : ((roots = []), {}),
  );
  render(<SkillRoots {...props(api)} projects={[project]} />);
  fireEvent.click(screen.getByText('额外技能目录（当前执行服务）', { selector: 'summary' }));
  const box = await screen.findByRole('checkbox', { name: /Project/ });
  await waitFor(() => expect((box as HTMLInputElement).checked).toBe(true));
  fireEvent.click(box);
  expect(
    (screen.getByRole('button', { name: '应用本次目录选择' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: /确认替换/ }));
  fireEvent.click(screen.getByRole('button', { name: '应用本次目录选择' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'skills/extraRoots/set')).toBe(true));
  expect(calls.find((c) => c.method === 'skills/extraRoots/set')?.params).toEqual({
    projectIds: [],
    confirm: true,
  });
});
it('retains unsubmitted roots across extension categories and requires renewed confirmation', async () => {
  const { api, calls } = route((call) => call.method === 'skills/extraRoots/read'
    ? { roots: [], persistence: 'current_runtime' }
    : call.method === 'plugin/list' ? { marketplaces: [], marketplaceLoadErrors: [] }
      : { data: [], nextCursor: null });
  render(<ExtensionsPanel api={api} projects={[project]} initialProjectId={project.id}
    epoch="epoch" enabled onChanged={vi.fn()} />);
  fireEvent.click(screen.getByText('额外技能目录（当前执行服务）', { selector: 'summary' }));
  await waitFor(() => expect(calls.filter(call => call.method === 'skills/extraRoots/read')).toHaveLength(1));
  await act(async () => {});
  const checkbox = screen.getByRole('checkbox', { name: /Project/ }) as HTMLInputElement;
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole('checkbox', { name: /确认替换/ }));
  expect(checkbox.checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '插件与市场' }));
  fireEvent.click(screen.getByRole('button', { name: '技能与 Hooks' }));
  await waitFor(() => expect(calls.filter(call => call.method === 'skills/extraRoots/read')).toHaveLength(2));
  await act(async () => {});
  expect(checkbox.isConnected).toBe(true);
  expect(checkbox.checked).toBe(true);
  expect(screen.getByRole('checkbox', { name: /确认替换/ })).toHaveProperty('checked', false);
  expect(calls.some(call => call.operationId)).toBe(false);
});
const rootsResponse = (roots: string[] = []) => ({ roots, persistence: 'current_runtime' });
const rootChoice = (name = /Project/) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const rootConsent = () => screen.getByRole('checkbox', { name: /确认替换/ }) as HTMLInputElement;
const rootApply = () => screen.getByRole('button', { name: '应用本次目录选择' }) as HTMLButtonElement;
async function openRoots() {
  fireEvent.click(screen.getByText('额外技能目录（当前执行服务）', { selector: 'summary' }));
  await waitFor(() => expect(rootChoice().disabled).toBe(false));
}
it('locks the initial read and then preserves a draft through a delayed read, failure and explicit adoption', async () => {
  let finish!: (value: unknown) => void, fail!: (reason: Error) => void;
  const { api, calls } = route(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  render(<SkillRoots {...props(api)} projects={[project]} />);
  fireEvent.click(screen.getByText('额外技能目录（当前执行服务）', { selector: 'summary' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  const user = userEvent.setup();
  expect(rootChoice().disabled).toBe(true);
  await user.click(rootChoice());
  await user.click(rootConsent());
  expect(rootChoice().checked).toBe(false);
  expect(rootConsent().checked).toBe(false);
  await act(async () => finish(rootsResponse()));
  fireEvent.click(rootChoice());
  fireEvent.click(rootConsent());
  fireEvent.click(screen.getByRole('button', { name: '重新读取额外技能目录' }));
  expect(rootChoice().checked).toBe(true);
  expect(rootConsent().checked).toBe(false);
  await act(async () => fail(new Error('roots temporarily unavailable')));
  expect(rootChoice().checked).toBe(true);
  expect(rootApply().disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '重新读取额外技能目录' }));
  await act(async () => finish(rootsResponse(['/unregistered'])));
  expect(rootChoice().checked).toBe(true);
  expect(screen.getByText(/提交新选择会移除它们：\/unregistered/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '采用当前运行时目录，放弃本次选择' }));
  expect(rootChoice().checked).toBe(false);
  expect(rootConsent().checked).toBe(false);
  expect(calls.some(call => call.operationId)).toBe(false);
});
it('locks a submitted roots selection through acceptance and readback, then follows external state once applied', async () => {
  let finish!: (value: unknown) => void, finishRead!: (value: unknown) => void;
  let reads = 0, holdRead = true, roots: string[] = [];
  const { api, calls } = route(call => {
    if (call.method === 'skills/extraRoots/set') return new Promise(resolve => { finish = resolve; });
    if (++reads > 1 && holdRead) return new Promise(resolve => { finishRead = resolve; });
    return rootsResponse(roots);
  });
  const onChanged = vi.fn();
  render(<SkillRoots {...props(api)} projects={[project]} onChanged={onChanged} />);
  await openRoots();
  fireEvent.click(rootChoice());
  fireEvent.click(rootConsent());
  act(() => { fireEvent.click(rootApply()); fireEvent.click(rootApply()); });
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  const user = userEvent.setup();
  expect(rootChoice().disabled).toBe(true);
  await user.click(rootChoice());
  await user.click(rootConsent());
  expect(rootChoice().checked).toBe(true);
  expect(rootConsent().checked).toBe(false);
  await act(async () => finish(rootsResponse(['/project'])));
  await waitFor(() => expect(finishRead).toBeTypeOf('function'));
  expect(rootChoice().checked).toBe(true);
  expect(rootChoice().disabled).toBe(true);
  await act(async () => finishRead(rootsResponse(['/project'])));
  await waitFor(() => expect(rootChoice().disabled).toBe(false));
  expect(screen.queryByText(/已保留本次目录选择/)).toBeNull();
  expect(onChanged).toHaveBeenCalledOnce();
  holdRead = false;
  fireEvent.click(screen.getByRole('button', { name: '重新读取额外技能目录' }));
  await waitFor(() => expect(rootChoice().checked).toBe(false));
  expect(rootConsent().checked).toBe(false);
  expect(calls.filter(call => call.method === 'skills/extraRoots/set')).toMatchObject([
    { params: { projectIds: [project.id], confirm: true } },
  ]);
});
it.each(['accepted', 'not_sent'] as const)('recovers unknown roots as %s without replay or premature parent refresh', async outcome => {
  let operationId = '', recovered = false;
  const { api, calls } = route(call => {
    if (call.method === 'skills/extraRoots/set') { operationId = call.operationId!; throw new Error('lost roots response'); }
    if (call.method === 'operation/read') { recovered = true; return { operationId, method: 'skills/extraRoots/set', state: outcome, result: rootsResponse(['/project']) }; }
    return rootsResponse(recovered && outcome === 'accepted' ? ['/project'] : []);
  });
  const onChanged = vi.fn();
  render(<SkillRoots {...props(api)} projects={[project]} onChanged={onChanged} />);
  await openRoots();
  fireEvent.click(rootChoice()); fireEvent.click(rootConsent()); fireEvent.click(rootApply());
  const recover = await enabledButton({ name: '查询原扩展操作回执' });
  expect(rootChoice().checked).toBe(true);
  expect(rootChoice().disabled).toBe(true);
  await userEvent.setup().click(rootChoice());
  expect(rootChoice().checked).toBe(true);
  expect(onChanged).not.toHaveBeenCalled();
  fireEvent.click(recover);
  await waitFor(() => expect(rootChoice().disabled).toBe(false));
  expect(rootChoice().checked).toBe(true);
  expect(rootConsent().checked).toBe(false);
  expect(onChanged).toHaveBeenCalledTimes(outcome === 'accepted' ? 1 : 0);
  if (outcome === 'not_sent') expect(screen.getByText(/已保留本次目录选择/)).toBeTruthy();
  else await waitFor(() => expect(screen.queryByText(/已保留本次目录选择/)).toBeNull());
  expect(calls.filter(call => call.method === 'skills/extraRoots/set')).toHaveLength(1);
  expect(calls.find(call => call.method === 'operation/read')?.params).toEqual({ operationId });
});
it.each(['api', 'epoch', 'mapping'] as const)('isolates roots and consent after %s ABA and ignores a late old read', async kind => {
  let finish!: (value: unknown) => void, hold = false;
  const { api, calls } = route(call => hold && call.method === 'skills/extraRoots/read'
    ? new Promise(resolve => { finish = resolve; }) : rootsResponse());
  const initial = { ...props(api), projects: [project] }, view = render(<SkillRoots {...initial} />);
  await openRoots(); fireEvent.click(rootChoice()); fireEvent.click(rootConsent());
  hold = true;
  fireEvent.click(screen.getByRole('button', { name: '重新读取额外技能目录' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.rerender(<SkillRoots {...initial} {...(kind === 'api' ? { api: new Api() }
    : kind === 'epoch' ? { epoch: 'other' } : { projects: [{ ...project, cwd: '/other' }] })} />);
  hold = false;
  view.rerender(<SkillRoots {...initial} />);
  await openRoots();
  await act(async () => finish(rootsResponse(['/project'])));
  expect(rootChoice().checked).toBe(false);
  expect(rootConsent().checked).toBe(false);
  expect(calls.some(call => call.operationId)).toBe(false);
});
it('keeps roots drafts for equivalent project mappings but revokes scope-bound confirmation on enablement changes', async () => {
  const other = { id: 'other', name: 'Other', cwd: '/other' };
  const { api } = route(() => rootsResponse());
  const initial = { ...props(api), projects: [project, other] }, view = render(<SkillRoots {...initial} />);
  await openRoots(); fireEvent.click(rootChoice()); fireEvent.click(rootConsent());
  view.rerender(<SkillRoots {...initial} projects={[{ ...other }, { ...project, name: 'Renamed Project' }]} />);
  expect(rootChoice().checked).toBe(true);
  expect(rootConsent().checked).toBe(true);
  view.rerender(<SkillRoots {...initial} enabled={false} />);
  view.rerender(<SkillRoots {...initial} />);
  expect(rootChoice().checked).toBe(true);
  expect(rootConsent().checked).toBe(false);
});
it.each(['epoch', 'mapping'] as const)('cancels old roots before dispatch if %s changes during durable admission', async kind => {
  const { api, calls } = route(() => rootsResponse());
  const initial = { ...props(api), projects: [project] }, view = render(<SkillRoots {...initial} />);
  await openRoots(); fireEvent.click(rootChoice()); fireEvent.click(rootConsent()); fireEvent.click(rootApply());
  expect(calls.some(call => call.operationId)).toBe(false);
  view.rerender(<SkillRoots {...initial} {...(kind === 'epoch' ? { epoch: 'other' } : { projects: [{ ...project, cwd: '/other' }] })} />);
  await waitFor(async () => expect((await listOperations())[0]?.state).toBe('not_sent'));
  expect(calls.some(call => call.operationId)).toBe(false);
  await openRoots();
  expect(rootChoice().checked).toBe(false);
  expect(rootConsent().checked).toBe(false);
});
it.each(['api', 'epoch', 'mapping'] as const)('keeps a late accepted roots write out of a replacement %s form', async kind => {
  let finish!: (value: unknown) => void;
  const { api, calls } = route(call => call.method === 'skills/extraRoots/set'
    ? new Promise(resolve => { finish = resolve; }) : rootsResponse());
  const initial = { ...props(api), projects: [project] }, view = render(<SkillRoots {...initial} />);
  await openRoots(); fireEvent.click(rootChoice()); fireEvent.click(rootConsent()); fireEvent.click(rootApply());
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.rerender(<SkillRoots {...initial} {...(kind === 'api' ? { api: new Api() }
    : kind === 'epoch' ? { epoch: 'other' } : { projects: [{ ...project, cwd: '/other' }] })} />);
  await act(async () => finish(rootsResponse(['/project'])));
  await openRoots();
  expect(rootChoice().checked).toBe(false);
  expect(rootConsent().checked).toBe(false);
  expect(initial.onChanged).not.toHaveBeenCalled();
  expect(calls.filter(call => call.method === 'skills/extraRoots/set')).toHaveLength(1);
});
it('permits a newly confirmed roots intent after not-sent recovery without reusing the earlier selection', async () => {
  const other = { id: 'other', name: 'Other', cwd: '/other' };
  let operationId = '', writes = 0, roots: string[] = [];
  const { api, calls } = route(call => {
    if (call.method === 'skills/extraRoots/set') {
      if (++writes === 1) { operationId = call.operationId!; throw new Error('first response lost'); }
      roots = ['/other']; return rootsResponse(roots);
    }
    if (call.method === 'operation/read') return { operationId, method: 'skills/extraRoots/set', state: 'not_sent' };
    return rootsResponse(roots);
  });
  const initial = { ...props(api), projects: [project, other] };
  render(<SkillRoots {...initial} />);
  await openRoots(); fireEvent.click(rootChoice()); fireEvent.click(rootConsent()); fireEvent.click(rootApply());
  fireEvent.click(await enabledButton({ name: '查询原扩展操作回执' }));
  await waitFor(() => expect(rootChoice().disabled).toBe(false));
  fireEvent.click(rootChoice()); fireEvent.click(rootChoice(/Other/));
  expect(writes).toBe(1);
  expect(rootApply().disabled).toBe(true);
  fireEvent.click(rootConsent()); fireEvent.click(rootApply());
  await waitFor(() => expect(initial.onChanged).toHaveBeenCalledOnce());
  expect(rootChoice().checked).toBe(false);
  expect(rootChoice(/Other/).checked).toBe(true);
  expect(screen.queryByText(/已保留本次目录选择/)).toBeNull();
  const sent = calls.filter(call => call.method === 'skills/extraRoots/set');
  expect(sent.map(call => call.params.projectIds)).toEqual([[project.id], [other.id]]);
  expect(sent[1].operationId).not.toBe(sent[0].operationId);
});
it('creates one missing directory per explicit click then writes SKILL.md with no-replace', async () => {
  const dirs = new Set<string>(),
    path = '.agents/skills/review/SKILL.md';
  let text = '';
  const { api, calls } = route((call) => {
    if (call.method === 'workspace/metadata')
      return call.params.path === path && text
        ? { path, kind: 'file', bytes: text.length, editable: true, revision: hash }
        : dirs.has(String(call.params.path))
          ? metadata(call.params.path)
          : missing();
    if (call.method === 'workspace/mkdir') {
      dirs.add(String(call.params.path));
      return { path: call.params.path };
    }
    if (call.method === 'workspace/write') {
      text = String(call.params.text);
      return { path, revision: hash };
    }
    if (call.method === 'workspace/read')
      return {
        path,
        kind: 'file',
        revision: hash,
        bytes: text.length,
        editable: true,
        binary: false,
        text,
      };
    if (call.method === 'skills/list')
      return {
        data: [
          { errors: [], skills: [{ name: 'review', path: '/project/' + path, enabled: true }] },
        ],
      };
    return {};
  });
  render(<SkillCreator {...props(api)} />);
  prepare();
  expect(readFileDraft(project.id, path)?.text).toBe(source);
  for (const directory of ['.agents', '.agents/skills', '.agents/skills/review']) {
    fireEvent.click(await screen.findByRole('button', { name: '创建目录：' + directory }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'workspace/mkdir')).toHaveLength(dirs.size),
    );
  }
  const save = await screen.findByRole('button', { name: '创建文件' });
  expect(calls.filter((c) => c.method === 'workspace/write')).toHaveLength(0);
  fireEvent.click(save);
  await screen.findByText(/原生技能目录已发现/);
  expect(calls.find((c) => c.method === 'workspace/write')?.params).toEqual({
    projectId: 'project',
    path,
    text: source,
    expectedRevision: null,
  });
  expect(calls.filter((c) => c.method === 'workspace/mkdir')).toHaveLength(3);
  expect(calls.filter((c) => c.method === 'workspace/write')).toHaveLength(1);
  expect(calls.find((c) => c.method === 'skills/list')?.params.forceReload).toBe(true);
});
it('does not treat a generic metadata failure as an absent directory', async () => {
  const { api, calls } = route(() => ({
    error: { code: 'workspace_error', message: 'Cannot inspect', delivery: 'not_sent' },
  }));
  render(<SkillCreator {...props(api)} />);
  prepare();
  await screen.findByText('Cannot inspect');
  expect(screen.queryByRole('button', { name: /创建目录：/ })).toBeNull();
  expect(calls.some((c) => c.operationId)).toBe(false);
});
it('does not overwrite an existing target file', async () => {
  const path = '.agents/skills/review/SKILL.md';
  const { api, calls } = route((call) =>
    call.method === 'workspace/metadata'
      ? call.params.path === path
        ? { path, kind: 'file', bytes: 8, editable: true, revision: hash }
        : metadata(call.params.path)
      : call.method === 'workspace/read'
        ? {
            path,
            kind: 'file',
            bytes: 8,
            text: 'existing',
            editable: true,
            binary: false,
            revision: hash,
          }
        : call.method === 'skills/list'
          ? { data: [{ skills: [], errors: [] }] }
          : {},
  );
  render(<SkillCreator {...props(api)} />);
  prepare();
  await screen.findByText(/目标文件已存在/);
  expect(screen.queryByRole('button', { name: '创建文件' })).toBeNull();
  expect(calls.some((c) => c.operationId)).toBe(false);
});
it('keeps an unknown mkdir receipt and never replays the directory chain', async () => {
  let created = false,
    id = '',
    reads = 0;
  const { api, calls } = route((call) => {
    if (call.method === 'workspace/metadata')
      return call.params.path === '.agents' && created ? metadata('.agents') : missing();
    if (call.method === 'workspace/mkdir') {
      created = true;
      id = call.operationId!;
      throw new Error('response lost');
    }
    if (call.method === 'operation/read') {
      reads++;
      return {
        operationId: id,
        method: 'workspace/mkdir',
        state: reads === 1 ? 'unknown' : 'accepted',
        result: { path: '.agents' },
      };
    }
    return {};
  });
  render(<SkillCreator {...props(api)} />);
  prepare();
  fireEvent.click(await screen.findByRole('button', { name: '创建目录：.agents' }));
  const recover = await screen.findByRole('button', { name: '查询原技能目录操作回执' });
  fireEvent.click(recover);
  await waitFor(() => expect(reads).toBe(1));
  expect(calls.filter((c) => c.method === 'workspace/mkdir')).toHaveLength(1);
  fireEvent.click(await enabledButton({ name: '查询原技能目录操作回执' }));
  await screen.findByRole('button', { name: '创建目录：.agents/skills' });
  expect(calls.filter((c) => c.method === 'workspace/mkdir')).toHaveLength(1);
});
it('restores a prepared content draft after the panel unmounts without rerunning writes', async () => {
  const { api, calls } = route(() => missing());
  const view = render(<SkillCreator {...props(api)} />);
  prepare();
  await screen.findByRole('button', { name: '创建目录：.agents' });
  view.unmount();
  render(<SkillCreator {...props(api)} />);
  fireEvent.click(screen.getByText('在项目中新建或导入 SKILL.md', { selector: 'summary' }));
  fireEvent.click(await screen.findByRole('button', { name: '.agents/skills/review/SKILL.md' }));
  await screen.findByRole('button', { name: '创建目录：.agents' });
  expect(readFileDraft(project.id, '.agents/skills/review/SKILL.md')?.text).toBe(source);
  expect(calls.some((c) => c.operationId)).toBe(false);
});

it('keeps imported bytes local and ignores a late file read from a replaced epoch', async () => {
  let finish!: (value: ArrayBuffer) => void;
  const { api, calls } = route(() => missing());
  const view = render(<SkillCreator {...props(api)} />);
  fireEvent.click(screen.getByText('在项目中新建或导入 SKILL.md', { selector: 'summary' }));
  const file = new File(['content'], 'SKILL.md', { type: 'text/markdown' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  fireEvent.change(screen.getByLabelText('导入本地 SKILL.md'), { target: { files: [file] } });
  view.rerender(<SkillCreator {...props(api)} epoch="new-epoch" />);
  await act(async () => finish(new TextEncoder().encode(source).buffer));
  expect((screen.getByRole('textbox', { name: '技能说明' }) as HTMLTextAreaElement).value).toBe('');
  expect(calls).toHaveLength(0);
});
it('recovers an unknown file creation after remount without overwriting or replaying', async () => {
  const path = '.agents/skills/review/SKILL.md';
  let written = false,
    id = '';
  const file = () => ({
    path,
    kind: 'file',
    revision: hash,
    bytes: source.length,
    editable: true,
    binary: false,
    text: source,
  });
  const { api, calls } = route((call) => {
    if (call.method === 'workspace/metadata')
      return call.params.path === path
        ? written
          ? file()
          : missing()
        : metadata(call.params.path);
    if (call.method === 'workspace/write') {
      written = true;
      id = call.operationId!;
      throw new Error('response lost');
    }
    if (call.method === 'workspace/read') return file();
    if (call.method === 'operation/read')
      return {
        operationId: id,
        method: 'workspace/write',
        state: 'accepted',
        result: { path, revision: hash },
      };
    if (call.method === 'skills/list')
      return {
        data: [
          { errors: [], skills: [{ name: 'review', path: '/project/' + path, enabled: true }] },
        ],
      };
    return {};
  });
  const view = render(<SkillCreator {...props(api)} />);
  prepare();
  fireEvent.click(await screen.findByRole('button', { name: '创建文件' }));
  await screen.findByRole('button', { name: '查询原保存回执并核对文件' });
  view.unmount();
  render(<SkillCreator {...props(api)} />);
  fireEvent.click(screen.getByText('在项目中新建或导入 SKILL.md', { selector: 'summary' }));
  fireEvent.click(
    await screen.findByRole('button', { name: /\.agents\/skills\/review\/SKILL.md · 保存待确认/ }),
  );
  fireEvent.click(await screen.findByRole('button', { name: '查询原保存回执并核对文件' }));
  await waitFor(() => expect(readFileDraft(project.id, path)).toBeUndefined());
  expect(calls.filter((call) => call.method === 'workspace/write')).toHaveLength(1);
});

it.each(['different', 'same-again', 'failure'] as const)(
  'preserves edits made during a local import: %s',
  async (mode) => {
    let finish!: (value: ArrayBuffer) => void, fail!: (reason: Error) => void;
    const { api, calls } = route(() => missing());
    render(<SkillCreator {...props(api)} />);
    fireEvent.click(screen.getByText('在项目中新建或导入 SKILL.md', { selector: 'summary' }));
    const input = screen.getByRole('textbox', { name: '技能说明' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'original draft' } });
    const file = new File(['old'], 'SKILL.md');
    Object.defineProperty(file, 'arrayBuffer', {
      value: () =>
        new Promise<ArrayBuffer>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    });
    fireEvent.change(screen.getByLabelText('导入本地 SKILL.md'), { target: { files: [file] } });
    fireEvent.change(input, { target: { value: 'newer draft' } });
    if (mode === 'same-again') fireEvent.change(input, { target: { value: 'original draft' } });
    await act(async () =>
      mode === 'failure'
        ? fail(new Error('File read failed'))
        : finish(new TextEncoder().encode(source).buffer),
    );
    expect(input.value).toBe(mode === 'same-again' ? 'original draft' : 'newer draft');
    expect(screen.getByRole('alert').textContent).toContain(
      mode === 'failure' ? 'File read failed' : '保留当前草稿',
    );
    expect((screen.getByLabelText('导入本地 SKILL.md') as HTMLInputElement).disabled).toBe(false);
    expect(calls).toHaveLength(0);
  },
);
it.each(['epoch', 'project'] as const)(
  'does not revive an old import after %s changes away and back',
  async (field) => {
    let finish!: (value: ArrayBuffer) => void;
    const { api } = route(() => missing()),
      initial = props(api),
      view = render(<SkillCreator {...initial} />);
    fireEvent.click(screen.getByText('在项目中新建或导入 SKILL.md', { selector: 'summary' }));
    const file = new File(['old'], 'SKILL.md');
    Object.defineProperty(file, 'arrayBuffer', {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve;
        }),
    });
    fireEvent.change(screen.getByLabelText('导入本地 SKILL.md'), { target: { files: [file] } });
    view.rerender(
      <SkillCreator
        {...initial}
        {...(field === 'epoch' ? { epoch: 'other' } : { project: { ...project, id: 'other' } })}
      />,
    );
    view.rerender(<SkillCreator {...initial} />);
    fireEvent.change(screen.getByRole('textbox', { name: '技能说明' }), {
      target: { value: 'current owner draft' },
    });
    await act(async () => finish(new TextEncoder().encode(source).buffer));
    expect((screen.getByRole('textbox', { name: '技能说明' }) as HTMLTextAreaElement).value).toBe(
      'current owner draft',
    );
  },
);
