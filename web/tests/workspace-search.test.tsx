// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceSearch } from '../components/WorkspaceSearch';
import type { Api } from '../lib/api';
const project = { id: 'project', name: 'Project', cwd: '/project' };
const result = {
  path: '',
  query: 'needle',
  mode: 'text',
  matches: [{ path: 'src/a.ts', line: 2, preview: 'needle [literal]' }],
  complete: false,
  reasons: ['result_limit'],
  visitedEntries: 15,
  skippedEntries: 0,
  readBytes: 50,
  excludedNames: ['.git'],
};
afterEach(() => cleanup());
it('sends only explicit scoped literal search and labels incomplete results before opening a fresh file', async () => {
  const call = vi.fn().mockResolvedValue(result),
    open = vi.fn();
  render(
    <WorkspaceSearch
      api={{ call } as unknown as Api}
      project={project}
      epoch="one"
      connected
      onOpenFile={open}
    />,
  );
  fireEvent.click(screen.getByText('搜索项目文件与内容', { selector: 'summary' }));
  fireEvent.change(screen.getByRole('searchbox', { name: '查找文字' }), {
    target: { value: 'needle' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: '搜索方式' }), {
    target: { value: 'text' },
  });
  expect(call).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '搜索此范围' }));
  await screen.findByText(/搜索结果不完整：结果数上限/);
  expect(call).toHaveBeenCalledWith('workspace/search', {
    projectId: 'project',
    path: '',
    query: 'needle',
    mode: 'text',
    caseSensitive: false,
    limit: 100,
  });
  fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }));
  expect(open).toHaveBeenCalledWith('src/a.ts');
});
it('does not display results that arrive after query or project changes', async () => {
  let resolve!: (value: unknown) => void;
  const call = vi.fn(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(
    <WorkspaceSearch
      api={{ call } as unknown as Api}
      project={project}
      epoch="one"
      connected
      onOpenFile={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText('搜索项目文件与内容', { selector: 'summary' }));
  fireEvent.change(screen.getByRole('searchbox', { name: '查找文字' }), {
    target: { value: 'needle' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: '搜索方式' }), {
    target: { value: 'text' },
  });
  fireEvent.click(screen.getByRole('button', { name: '搜索此范围' }));
  await waitFor(() => expect(call).toHaveBeenCalled());
  fireEvent.change(screen.getByRole('searchbox', { name: '查找文字' }), {
    target: { value: 'changed' },
  });
  resolve(result);
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '搜索此范围' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  expect(screen.queryByText('needle [literal]')).toBeNull();
});
