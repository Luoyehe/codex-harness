// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { UsagePopover } from '../components/UsagePopover';

afterEach(cleanup);
it('separates recent and cumulative token counts without exposing a raw JSON block in the header', () => {
  const view = render(<UsagePopover usage={{ total: { inputTokens: 12000, totalTokens: 14000 }, last: { inputTokens: 2000, totalTokens: 2500 }, modelContextWindow: 200000 }} />);
  fireEvent.click(screen.getByText('用量', { selector: 'summary' }));
  const panel = screen.getByRole('region', { name: 'Token 用量' });
  const input = within(panel).getByRole('rowheader', { name: '输入' }).closest('tr')!;
  expect(within(input).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['2,000', '12,000']);
  expect(within(panel).getByText('上下文窗口：200,000')).toBeTruthy();
  expect(view.container.querySelector('pre')).toBeNull();
});
it('closes on Escape and outside clicks without affecting other header actions', () => {
  const view = render(<><UsagePopover usage={{}} /><button>文件</button></>);
  const summary = screen.getByText('用量', { selector: 'summary' });
  fireEvent.click(summary);
  expect(view.container.querySelector('details')?.open).toBe(true);
  fireEvent.keyDown(summary, { key: 'Escape' });
  expect(view.container.querySelector('details')?.open).toBe(false);
  expect(document.activeElement).toBe(summary);
  fireEvent.click(summary);
  fireEvent.pointerDown(screen.getByRole('button', { name: '文件' }));
  expect(view.container.querySelector('details')?.open).toBe(false);
});
it('handles incomplete and invalid usage values instead of rendering NaN or object dumps', () => {
  const view = render(<UsagePopover usage={{ last: { inputTokens: -1, outputTokens: Infinity }, total: null }} />);
  fireEvent.click(screen.getByText('用量', { selector: 'summary' }));
  expect(screen.getAllByRole('cell').every(cell => cell.textContent === '—')).toBe(true);
  expect(view.container.textContent).not.toMatch(/NaN|Infinity|\[object/);
});
