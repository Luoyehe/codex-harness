// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { SkillCreator, SkillDocument, SkillRoots } from '../components/SkillLibraryTools';
import { readFileDraft } from '../lib/file-drafts';
const project = { id: 'project', name: 'Project', cwd: '/project' },
  hash = 'a'.repeat(64),
  source = '---\nname: review\ndescription: Review changes\n---\n\nInspect changes.';
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const props = (api: Api) => ({ api, project, epoch: 'epoch', enabled: true, onChanged: vi.fn() });
function route(handler: (call: Call) => unknown) {
  const calls: Call[] = [],
    api = new Api();
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
afterEach(() => {
  cleanup();
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
  fireEvent.click(screen.getByRole('button', { name: '查询原技能目录操作回执' }));
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
