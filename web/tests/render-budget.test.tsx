// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  expect(screen.getByText('退出码 7')).toBeTruthy();
});
