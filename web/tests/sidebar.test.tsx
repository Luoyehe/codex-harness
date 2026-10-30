// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Sidebar } from '../components/Sidebar';
import { Dialog } from '../components/Dialog';
import type { Project, Thread } from '../lib/types';

const originalDialogMethods = ['showModal', 'close'].map(name =>
  [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)] as const);
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  for (const [name, descriptor] of originalDialogMethods) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});
const projects: Project[] = [
  { id: 'a', name: 'Project A', cwd: '/a' },
  { id: 'b', name: 'Project B', cwd: '/b' },
];
const threads: Thread[] = [
  { id: 'first', name: 'First thread', cwd: '/a', archived: false },
  { id: 'archived', name: 'Archived thread', cwd: '/a', archived: true },
];
function props() {
  return {
    projects, projectId: 'a', threads, threadsProjectId: 'a', threadId: 'first',
    archived: false, query: '', loading: false, error: '', more: false,
    onProject: vi.fn(), onThread: vi.fn(), onNew: vi.fn(), onQuery: vi.fn(),
    onArchived: vi.fn(), onAddProject: vi.fn(), onSettings: vi.fn(), onMore: vi.fn(),
    onRefresh: vi.fn(), onThreadOrder: vi.fn(), onProjectAction: vi.fn(), onThreadAction: vi.fn(),
  };
}
test('nests the supplied page and its search/sort/pagination controls only under its selected project', () => {
  const handlers = props();
  render(<Sidebar {...handlers} query="needle" snippets={{ first: 'matched text' }} more />);
  const a = screen.getByRole('region', { name: '项目：Project A' });
  const b = screen.getByRole('region', { name: '项目：Project B' });
  expect(within(a).getByRole('navigation', { name: 'Project A的会话' })).toBeTruthy();
  expect(within(a).getByText('matched text')).toBeTruthy();
  expect(within(b).queryByRole('navigation')).toBeNull();
  expect(within(b).queryByText('First thread')).toBeNull();
  expect(screen.getByRole('button', { name: 'Project A' }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: 'Project B' }).getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(within(a).getByRole('button', { name: '加载更多' }));
  fireEvent.click(within(a).getByRole('button', { name: '刷新会话列表' }));
  fireEvent.change(within(a).getByRole('combobox', { name: '会话排序' }), { target: { value: 'section_position' } });
  fireEvent.click(screen.getByRole('button', { name: '搜索会话' }));
  fireEvent.change(screen.getByRole('textbox', { name: '搜索会话' }), { target: { value: 'next search' } });
  fireEvent.click(screen.getByRole('button', { name: '已归档' }));
  expect(handlers.onMore).toHaveBeenCalledOnce();
  expect(handlers.onRefresh).toHaveBeenCalledOnce();
  expect(handlers.onThreadOrder).toHaveBeenCalledExactlyOnceWith('section_position');
  expect(handlers.onQuery).toHaveBeenCalledExactlyOnceWith('next search');
  expect(handlers.onArchived).toHaveBeenCalledOnce();
  expect(handlers.onProject).not.toHaveBeenCalled();
  expect(handlers.onThread).not.toHaveBeenCalled();
});
test('does not attach an old page or its cursor to the newly selected project while its snapshot loads', () => {
  const handlers = props();
  const view = render(<Sidebar {...handlers} more />);
  fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
  expect(handlers.onProject).toHaveBeenCalledExactlyOnceWith('b');
  view.rerender(<Sidebar {...handlers} projectId="b" more />);
  expect(screen.queryByText('First thread')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('正在加载会话…');
  const more = screen.getByRole('button', { name: '加载更多' });
  expect(more).toHaveProperty('disabled', true);
  fireEvent.click(more);
  expect(handlers.onMore).not.toHaveBeenCalled();
  view.rerender(<Sidebar {...handlers} projectId="b" threadsProjectId="b"
    threads={[{ id: 'next', name: 'B thread', cwd: '/b' }]} more />);
  expect(within(screen.getByRole('region', { name: '项目：Project B' })).getByText('B thread')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: '项目：Project A' })).queryByRole('navigation')).toBeNull();
  fireEvent.click(screen.getByText('B thread'));
  expect(handlers.onThread).toHaveBeenCalledExactlyOnceWith('next');
});
test('keeps unknown project selection outside project rows and rejects contradictory cwd ownership', () => {
  const handlers = props();
  const view = render(<Sidebar {...handlers} projectId="removed" />);
  for (const name of ['项目：Project A', '项目：Project B'])
    expect(within(screen.getByRole('region', { name })).queryByText('First thread')).toBeNull();
  expect(within(screen.getByRole('region', { name: '未确认归属的会话' })).getByText('First thread')).toBeTruthy();
  expect(screen.getByRole('region', { name: '未选择项目' })).toBeTruthy();
  view.rerender(<Sidebar {...handlers} threads={[
    { id: 'mismatch', name: 'Contradictory thread', cwd: '/b' },
    { id: 'owned', name: 'Scoped thread' },
  ]} />);
  const a = screen.getByRole('region', { name: '项目：Project A' });
  expect(within(a).queryByText('Contradictory thread')).toBeNull();
  expect(within(a).getByText('Scoped thread')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: '未确认归属的会话' })).getByText('Contradictory thread')).toBeTruthy();
});
test('legacy callers use exact cwd rather than native projectId and leave missing ownership explicit', () => {
  render(<Sidebar {...props()} threadsProjectId={undefined} threads={[
    { id: 'owned', name: 'Native project row', cwd: '/a', projectId: 'unrelated-native-project' },
    { id: 'other', name: 'Other project row', cwd: '/b' },
    { id: 'unknown', name: 'Unknown row' },
  ]} />);
  const a = screen.getByRole('region', { name: '项目：Project A' });
  expect(within(a).getByText('Native project row')).toBeTruthy();
  expect(screen.queryByText('Other project row')).toBeNull();
  expect(within(a).queryByText('Unknown row')).toBeNull();
  expect(within(screen.getByRole('region', { name: '未确认归属的会话' })).getByText('Unknown row')).toBeTruthy();
});
test('project row actions target the original unselected project without navigating first', () => {
  const handlers = props();
  render(<Sidebar {...handlers} />);
  const trigger = screen.getByRole('button', { name: '管理项目：Project B' });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('button', { name: '重命名项目' }));
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('button', { name: '移除项目（保留目录）' }));
  expect(handlers.onProjectAction.mock.calls).toEqual([[projects[1], 'rename'], [projects[1], 'remove']]);
  expect(handlers.onProject).not.toHaveBeenCalled();
  expect(handlers.onThread).not.toHaveBeenCalled();
  expect(handlers.onNew).not.toHaveBeenCalled();
  expect(trigger).toBe(document.activeElement);
});
test('thread actions use each row archive state and do not open or resume the thread', () => {
  const handlers = props();
  render(<Sidebar {...handlers} archived />);
  const trigger = screen.getByRole('button', { name: '管理会话：First thread' });
  for (const label of ['重命名会话', '归档会话', '删除会话']) {
    fireEvent.click(trigger); fireEvent.click(screen.getByRole('button', { name: label }));
  }
  fireEvent.click(screen.getByRole('button', { name: '管理会话：Archived thread' }));
  fireEvent.click(screen.getByRole('button', { name: '取消归档' }));
  expect(handlers.onThreadAction.mock.calls).toEqual([
    [threads[0], 'rename'], [threads[0], 'archive'], [threads[0], 'delete'], [threads[1], 'unarchive'],
  ]);
  expect(handlers.onThread).not.toHaveBeenCalled();
  expect(handlers.onProject).not.toHaveBeenCalled();
  expect(handlers.onRefresh).not.toHaveBeenCalled();
});
test('menus support keyboard focus, Escape, outside clicks and project changes without hidden actions', () => {
  const handlers = props();
  const view = render(<Sidebar {...handlers} />);
  const trigger = screen.getByRole('button', { name: '管理项目：Project A' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const rename = screen.getByRole('button', { name: '重命名项目' });
  expect(rename).toBe(document.activeElement);
  fireEvent.keyDown(rename, { key: 'End' });
  expect(screen.getByRole('button', { name: '移除项目（保留目录）' })).toBe(document.activeElement);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('button', { name: '重命名项目' })).toBeNull();
  expect(trigger).toBe(document.activeElement);
  fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByRole('button', { name: '新会话' }));
  expect(screen.queryByRole('button', { name: '重命名项目' })).toBeNull();
  fireEvent.click(trigger);
  act(() => screen.getByRole('button', { name: '新会话' }).focus());
  expect(screen.queryByRole('button', { name: '重命名项目' })).toBeNull();
  fireEvent.click(trigger);
  view.rerender(<Sidebar {...handlers} projectId="b" threadsProjectId="" />);
  expect(screen.queryByRole('button', { name: '重命名项目' })).toBeNull();
  expect(handlers.onProjectAction).not.toHaveBeenCalled();
  expect(handlers.onThreadAction).not.toHaveBeenCalled();
});
test('Escape closes the row disclosure before its real mobile navigation dialog', () => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.open = false; };
  const close = vi.fn();
  render(<Dialog title="导航" onClose={close}><Sidebar {...props()} /></Dialog>);
  const trigger = screen.getByRole('button', { name: '管理项目：Project A' });
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole('button', { name: '重命名项目' }), { key: 'Escape', isComposing: true });
  expect(screen.getByRole('button', { name: '重命名项目' })).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('button', { name: '重命名项目' }), { key: 'Escape' });
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '重命名项目' })).toBeNull();
  expect(trigger).toBe(document.activeElement);
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(close).toHaveBeenCalledOnce();
});
test('only the visible settings gear opens settings, not the workspace identity block', () => {
  const handlers = props();
  render(<Sidebar {...handlers} />);
  fireEvent.click(screen.getByText('我的工作台'));
  fireEvent.click(screen.getByText('账户与设置'));
  expect(handlers.onSettings).not.toHaveBeenCalled();
  const settings = screen.getByRole('button', { name: '打开设置' });
  expect(settings.querySelector('svg')).toBeTruthy();
  fireEvent.click(settings);
  expect(handlers.onSettings).toHaveBeenCalledOnce();
});
