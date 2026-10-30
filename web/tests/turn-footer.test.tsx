// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Messages } from '../components/Messages';
import type { Turn } from '../lib/types';

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const props = { loading: false, complete: true, onMore: vi.fn(), threadId: 'thread' };
const final = (text = '**Public final**') => ({ id: 'final', type: 'agentMessage', phase: 'final_answer', text });
const turn = (status = 'completed'): Turn => ({ id: 't', status, items: [
  { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Question' }] },
  { id: 'reason', type: 'reasoning', summary: ['Public summary'], raw_content: 'private reasoning' },
  { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Working commentary' },
  { id: 'tool', type: 'mcpToolCall', status: 'completed', result: 'Tool output' }, final(),
] });
function clipboard(writeText = vi.fn(async (_text: string) => {})) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return writeText;
}

it('places completion actions after the answer and copies only explicit public final parts', async () => {
  const writeText = clipboard();
  const value = turn(); value.items.push({ ...final('Second final part'), id: 'final-2' });
  const view = render(<Messages {...props} turns={[value]} onAction={vi.fn()} />);
  const footer = view.container.querySelector('.turn-footer')!;
  expect(footer.textContent).toContain('已完成');
  expect(screen.getByText('Second final part').compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  fireEvent.click(within(footer as HTMLElement).getByRole('button', { name: '复制最终回答' }));
  await screen.findByText('已复制最终回答');
  expect(writeText).toHaveBeenCalledExactlyOnceWith('**Public final**\n\nSecond final part');
  expect(footer.textContent).not.toContain('Working commentary');
  expect(view.container.textContent).not.toContain('private reasoning');
});

it.each(['inProgress', 'failed', 'interrupted'])('does not present a successful completion or copy a final answer while turn is %s', status => {
  const value = turn(status), view = render(<Messages {...props} turns={[value]} onAction={vi.fn()} />);
  expect(view.container.querySelector('.turn-completed')).toBeNull();
  expect(screen.queryByRole('button', { name: '复制最终回答' })).toBeNull();
  if (status === 'inProgress') expect(screen.queryByRole('button', { name: '回合操作' })).toBeNull();
});

it('does not claim success for a completed status carrying an error or copy unresolved overlapping text', async () => {
  const value = turn(); value.error = { message: 'Late provider error' };
  const view = render(<Messages {...props} turns={[value]} />);
  expect(view.container.querySelector('.turn-completed')).toBeNull();
  expect(screen.queryByRole('button', { name: '复制最终回答' })).toBeNull();
  view.rerender(<Messages {...props} turns={[{ ...turn(), items: [{ ...final(), historySync: { field: 'text', snapshot: 'Snapshot', deltas: 'Overlapping delta' } }] }]} />);
  expect(view.container.querySelector('.turn-completed')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '复制最终回答' })).toBeNull();
  const writeText = clipboard();
  view.rerender(<Messages {...props} turns={[turn()]} />);
  fireEvent.click(screen.getByRole('button', { name: '复制最终回答' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('**Public final**'));
});

it('uses only the last unphased legacy assistant answer and never substitutes commentary or tool text', async () => {
  const writeText = clipboard();
  const value: Turn = { id: 'legacy', status: 'completed', items: [
    { id: 'earlier', type: 'agentMessage', text: 'Earlier assistant' },
    { id: 'tool', type: 'commandExecution', aggregatedOutput: 'Command output' },
    { id: 'answer', type: 'agentMessage', content: [{ type: 'text', text: 'Legacy public answer' }, { type: 'reasoning', text: 'Not public response text' }] },
  ] };
  const view = render(<Messages {...props} turns={[value]} />);
  fireEvent.click(screen.getByRole('button', { name: '复制最终回答' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('Legacy public answer'));
  view.rerender(<Messages {...props} turns={[{ ...value, items: [...value.items, { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Only commentary' }] }]} />);
  expect(screen.queryByRole('button', { name: '复制最终回答' })).toBeNull();
});

it('reports clipboard failure, blocks double copy and ignores stale completion feedback', async () => {
  const writeText = clipboard(vi.fn(async () => { throw new Error('Clipboard denied'); }));
  const view = render(<Messages {...props} turns={[turn()]} />);
  fireEvent.click(screen.getByRole('button', { name: '复制最终回答' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('手动复制');
  let finish!: () => void;
  writeText.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: '复制最终回答' }));
  fireEvent.click(screen.getByRole('button', { name: '复制最终回答' }));
  expect(writeText).toHaveBeenCalledTimes(2);
  view.rerender(<Messages {...props} turns={[{ ...turn(), items: [final('New authoritative answer')] }]} />);
  expect(screen.getByRole('button', { name: '复制最终回答' }).matches(':disabled')).toBe(true);
  await act(async () => finish());
  expect(screen.queryByText('已复制最终回答')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: '复制最终回答' }).matches(':disabled')).toBe(false);
});

it('opens ellipsis actions without writes, closes with Escape/outside selection, and keeps existing action guards', () => {
  const onAction = vi.fn(), value = turn();
  const view = render(<Messages {...props} turns={[value]} onAction={onAction} />);
  const button = screen.getByRole('button', { name: '回合操作' });
  expect(button.querySelector('svg')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '从此处分支' })).toBeNull();
  fireEvent.click(button);
  const group = screen.getByRole('group', { name: '回合操作选项' });
  expect(onAction).not.toHaveBeenCalled();
  within(group).getByRole('button', { name: '从此处分支' }).focus();
  fireEvent.keyDown(group, { key: 'Escape' });
  expect(document.activeElement).toBe(button);
  expect(screen.queryByRole('group', { name: '回合操作选项' })).toBeNull();
  fireEvent.click(button); fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('group', { name: '回合操作选项' })).toBeNull();
  fireEvent.click(button); fireEvent.click(screen.getByRole('button', { name: '从此处分支' }));
  expect(onAction).toHaveBeenCalledExactlyOnceWith(value, 'fork');
  expect(screen.queryByRole('group', { name: '回合操作选项' })).toBeNull();
  view.rerender(<Messages {...props} turns={[value]} onAction={onAction} active actionsDisabled />);
  fireEvent.click(button);
  for (const name of ['从此处分支', '从此前编辑消息', '回退至此前']) expect(screen.getByRole('button', { name }).matches(':disabled')).toBe(true);
});

it('reveals the complete menu only on explicit expansion, not answer updates or copy feedback', async () => {
  const reveals: { target: Element; options: unknown }[] = [];
  Element.prototype.scrollIntoView = vi.fn(function(this: Element, options) {
    if (this.classList.contains('turn-menu-row')) reveals.push({ target: this, options });
  });
  clipboard();
  const value = turn(), onAction = vi.fn();
  const view = render(<Messages {...props} turns={[value]} onAction={onAction} />);
  expect(reveals).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '回合操作' }));
  expect(reveals).toHaveLength(1);
  expect(reveals[0]!.options).toEqual({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  expect(within(reveals[0]!.target as HTMLElement).getAllByRole('button')).toHaveLength(3);
  view.rerender(<Messages {...props} turns={[{ ...value, items: [...value.items] }]} onAction={onAction} />);
  expect(reveals).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '复制最终回答' }));
  await screen.findByText('已复制最终回答');
  expect(reveals).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '回合操作' }));
  expect(reveals).toHaveLength(2);
});
