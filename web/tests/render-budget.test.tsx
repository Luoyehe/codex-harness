// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useLayoutEffect } from 'react';
import {
  SafeMarkdown,
  Diff,
  PlainText,
  RENDER_LIMITS,
  markdownWithinBudget,
} from '../components/SafeMarkdown';
import { Messages } from '../components/Messages';
import { MessageItem } from '../components/MessageItem';
import type { Turn } from '../lib/types';
import { applyNotification, mergeHistory } from '../lib/history';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('commits focus together with an initially mounted search target before the result is published', () => {
  Element.prototype.scrollIntoView = vi.fn();
  const committed: (string | null | undefined)[] = [];
  function ResultWindow() {
    useLayoutEffect(() => {
      committed.push(document.activeElement?.getAttribute('class'));
    }, []);
    return (
      <Messages
        turns={[
          {
            id: 't',
            status: 'completed',
            items: [{ id: 'match', type: 'agentMessage', text: 'search result' }],
          },
        ]}
        loading={false}
        complete
        onMore={vi.fn()}
        focusTarget={{ turnId: 't', itemId: 'match' }}
      />
    );
  }
  render(<ResultWindow />);
  expect(committed).toHaveLength(1);
  expect(committed[0]).toContain('search-selected');
  expect(document.activeElement?.textContent).toContain('search result');
});
it('never splits a Unicode surrogate pair across plain-text pages', () => {
  const source = 'x'.repeat(23999) + '😀end';
  const { container } = render(<PlainText text={source} />);
  const first = container.querySelector('pre')!.textContent!;
  fireEvent.click(screen.getByRole('button', { name: '下一页文本' }));
  const second = container.querySelector('pre')!.textContent!;
  expect(first).toBe('x'.repeat(23999));
  expect(second).toBe('😀end');
  expect(first + second).toBe(source);
});
it('also bounds diff pages by characters when individual lines are long', () => {
  const { container } = render(
    <Diff text={Array.from({ length: 120 }, () => '+' + 'x'.repeat(12000)).join('\n')} />,
  );
  expect(container.querySelector('.diff')!.textContent!.length).toBeLessThanOrEqual(
    RENDER_LIMITS.textPage,
  );
  expect(screen.getByRole('button', { name: '下载完整 Diff' })).toBeTruthy();
});
it('limits parsing before expansion and keeps the complete long source available by pages', () => {
  const text = 'first' + 'x'.repeat(85000) + 'last';
  const { container } = render(<SafeMarkdown text={text} />);
  expect(container.querySelector('pre')!.textContent!.length).toBe(RENDER_LIMITS.textPage);
  expect(screen.getByText(/完整内容共 4 页/)).toBeTruthy();
  for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: '下一页文本' }));
  expect(container.querySelector('pre')!.textContent).toBe(text.slice(72000));
  expect(screen.getByRole('button', { name: '下载完整文本' })).toBeTruthy();
  expect(markdownWithinBudget('>'.repeat(40) + 'deep')).toBe(false);
  expect(markdownWithinBudget('['.repeat(40) + 'deep' + ']'.repeat(40))).toBe(false);
});
it('isolates an oversized Markdown syntax tree without hiding a sibling message', () => {
  const noise = vi.spyOn(console, 'error').mockImplementation(() => {});
  const source = '*a*\n\n'.repeat(2700);
  expect(markdownWithinBudget(source)).toBe(true);
  const { container, rerender } = render(
    <>
      <SafeMarkdown text={source} />
      <SafeMarkdown text="**healthy reply**" />
    </>,
  );
  expect(screen.getByText(/此条内容无法安全排版/)).toBeTruthy();
  expect(container.querySelector('strong')?.textContent).toBe('healthy reply');
  expect(container.querySelector('pre')?.textContent).toBe(source);
  rerender(
    <>
      <SafeMarkdown text="**recovered**" />
      <SafeMarkdown text="**healthy reply**" />
    </>,
  );
  expect(screen.getByText('recovered', { selector: 'strong' })).toBeTruthy();
  noise.mockRestore();
});
it('renders bounded diff pages and never fetches Markdown remote images', () => {
  const source = Array.from({ length: 450 }, (_, i) => `+line${i}`).join('\n');
  const { container } = render(
    <>
      <Diff text={source} />
      <SafeMarkdown text="![untrusted](https://host.invalid/tracker.png)" />
    </>,
  );
  expect(container.querySelectorAll('.diff > span')).toHaveLength(200);
  fireEvent.click(screen.getByRole('button', { name: '下一页 Diff' }));
  fireEvent.click(screen.getByRole('button', { name: '下一页 Diff' }));
  expect(container.querySelectorAll('.diff > span')).toHaveLength(50);
  expect(container.querySelector('.diff')?.textContent).toContain('+line449');
  expect(container.querySelector('img')).toBeNull();
});
it('bounds message DOM while preserving page access and off-window search navigation', () => {
  Element.prototype.scrollIntoView = vi.fn();
  const turns: Turn[] = [
    {
      id: 't',
      status: 'completed',
      items: Array.from({ length: 400 }, (_, i) => ({
        id: `i${i}`,
        type: 'agentMessage',
        text: `message ${i}`,
      })),
    },
  ];
  const props = { turns, loading: false, complete: true, onMore: vi.fn(), threadId: 'thread' };
  const { container, rerender } = render(<Messages {...props} />);
  expect(container.querySelectorAll('.message-anchor').length).toBeLessThanOrEqual(150);
  expect(screen.queryByText('message 0')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '显示较早内容' }));
  fireEvent.click(screen.getByRole('button', { name: '显示较早内容' }));
  expect(screen.getByText('message 0')).toBeTruthy();
  rerender(<Messages {...props} focusTarget={{ turnId: 't', itemId: 'i350' }} />);
  expect(screen.getByText('message 350')).toBeTruthy();
  expect(document.activeElement?.textContent).toContain('message 350');
  expect(container.querySelectorAll('.message-anchor').length).toBeLessThanOrEqual(150);
});
it('shows readable reasoning and explicit command failure exit codes', () => {
  render(
    <>
      <MessageItem
        item={{ id: 'r', type: 'reasoning', summary: ['**Inspect branch**'], content: ['details'] }}
      />
      <MessageItem
        item={{
          id: 'cmd',
          type: 'commandExecution',
          command: 'check',
          exitCode: 7,
          status: 'completed',
        }}
      />
    </>,
  );
  expect(screen.getByText('Inspect branch', { selector: 'strong' })).toBeTruthy();
  expect(screen.getByText('Inspect branch').closest('details')?.open).toBe(true);
  expect(screen.queryByText('details')).toBeNull();
  expect(screen.queryByText('详细思考内容')).toBeNull();
  expect(screen.getByText('退出码 7')).toBeTruthy();
});

it('shows only public summaries through live updates, overlap recovery and final replacement', () => {
  let turns = applyNotification([], 'item/reasoning/summaryTextDelta', {
    turnId: 't', itemId: 'r', summaryIndex: 0, delta: 'public live',
  }).turns;
  turns = applyNotification(turns, 'item/reasoning/textDelta', {
    turnId: 't', itemId: 'r', contentIndex: 0, delta: 'private live',
  }).turns;
  const view = render(<MessageItem item={turns[0]!.items[0]!} />);
  expect(screen.getByText('public live')).toBeTruthy();
  expect(view.container.textContent).not.toContain('private live');
  turns = mergeHistory(turns, [{ id: 't', status: 'inProgress', items: [
    { id: 'r', type: 'reasoning', summary: ['public snapshot'], content: ['private snapshot'], raw_content: 'private raw' },
  ] }], new Set());
  view.rerender(<MessageItem item={turns[0]!.items[0]!} />);
  expect(screen.getByText('public snapshot')).toBeTruthy();
  expect(screen.getByText('public live')).toBeTruthy();
  expect(screen.getByText(/可能与上方摘要重叠，暂不拼接/)).toBeTruthy();
  expect(view.container.textContent).not.toContain('public snapshotpublic live');
  expect(view.container.textContent).not.toContain('private');
  expect(screen.queryByText('完整条目')).toBeNull();
  turns = applyNotification(turns, 'item/completed', { turnId: 't', item: {
    id: 'r', type: 'reasoning', summary: ['final public summary'], content: ['private final'],
  } }).turns;
  view.rerender(<MessageItem item={turns[0]!.items[0]!} />);
  expect(screen.getAllByText('final public summary')).toHaveLength(1);
  expect(screen.queryByText('public live')).toBeNull();
  expect(screen.queryByText('同步中')).toBeNull();
  expect(view.container.textContent).not.toContain('private');
});

it('never substitutes raw reasoning or mixed synchronization text when a provider supplies no public summary', () => {
  const { container } = render(<MessageItem item={{ id: 'r', type: 'reasoning', summary: [],
    content: ['private content'], text: 'private text', raw_content: 'private raw',
    historySync: { field: 'reasoning', snapshot: 'private mixed snapshot', deltas: 'private mixed delta' },
  }} />);
  expect(container.textContent).toBe('');
  expect(container.querySelector('details')).toBeNull();
});

it('preserves user, public summary, tool progress and final answer chronology without duplicate streamed items', () => {
  Element.prototype.scrollIntoView = vi.fn();
  let turns: Turn[] = [{ id: 't', status: 'inProgress', items: [
    { id: 'q', type: 'userMessage', content: [{ type: 'text', text: 'User request' }] },
    { id: 'r', type: 'reasoning', summary: ['Public plan'], content: ['private content'] },
    { id: 'cmd', type: 'commandExecution', command: 'check', status: 'inProgress', aggregatedOutput: 'partial output' },
  ] }];
  const props = { loading: false, complete: true, onMore: vi.fn() };
  const view = render(<Messages {...props} turns={turns} />);
  const rows = () => Array.from(view.container.querySelectorAll('.message-anchor')).map(row => row.textContent);
  expect(rows()).toHaveLength(3);
  expect(rows()[0]).toContain('User request');
  expect(rows()[1]).toContain('Public plan');
  expect(rows()[2]).toContain('partial output');
  expect(screen.getByText('正在工作')).toBeTruthy();
  turns = applyNotification(turns, 'item/completed', { turnId: 't', item: {
    id: 'cmd', type: 'commandExecution', command: 'check', status: 'completed', exitCode: 0, aggregatedOutput: 'complete output',
  } }).turns;
  turns = applyNotification(turns, 'item/completed', { turnId: 't', item: {
    id: 'a', type: 'agentMessage', phase: 'final_answer', text: 'Final answer',
  } }).turns;
  turns = applyNotification(turns, 'turn/completed', { turnId: 't', turn: { id: 't', status: 'completed' } }).turns;
  view.rerender(<Messages {...props} turns={turns} />);
  expect(rows()).toHaveLength(4);
  expect(rows()[2]).toContain('complete output');
  expect(rows()[3]).toContain('Final answer');
  expect(screen.getByText('最终回答')).toBeTruthy();
  expect(screen.queryByText('正在工作')).toBeNull();
  expect(view.container.textContent).not.toContain('private content');
});

it('makes latest MCP progress readable outside the collapsed tool card and clears it on completion', () => {
  let turns = applyNotification([], 'item/started', { turnId: 't', item: {
    id: 'tool', type: 'mcpToolCall', server: 'local', tool: 'inspect', status: 'inProgress',
  } }).turns;
  const view = render(<MessageItem item={turns[0]!.items[0]!} />);
  expect(screen.getByText('进行中')).toBeTruthy();
  expect(view.container.querySelector('details')?.open).toBe(false);
  turns = applyNotification(turns, 'item/mcpToolCall/progress', { turnId: 't', itemId: 'tool', message: 'Inspecting local output' }).turns;
  view.rerender(<MessageItem item={turns[0]!.items[0]!} />);
  expect(screen.getByRole('status').textContent).toBe('Inspecting local output');
  expect(screen.getByRole('status').closest('details')).toBeNull();
  turns = applyNotification(turns, 'item/completed', { turnId: 't', item: {
    id: 'tool', type: 'mcpToolCall', server: 'local', tool: 'inspect', status: 'completed', result: { content: [] },
  } }).turns;
  view.rerender(<MessageItem item={turns[0]!.items[0]!} />);
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByText('已完成')).toBeTruthy();
});
