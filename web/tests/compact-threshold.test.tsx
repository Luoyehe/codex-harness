// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CompactThreshold } from '../components/CompactThreshold';
afterEach(cleanup);
it('converts a known window percentage to a token draft without writing configuration', () => {
  const change = vi.fn();
  render(
    <CompactThreshold
      contextWindow={128000}
      threshold={64000}
      disabled={false}
      onChange={change}
    />,
  );
  expect(screen.getByText(/当前阈值约占 50.0%/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('窗口占比（%）'), { target: { value: '75' } });
  fireEvent.click(screen.getByRole('button', { name: '换算为 Token 阈值' }));
  expect(change).toHaveBeenCalledWith('96000');
  fireEvent.change(screen.getByLabelText('窗口占比（%）'), { target: { value: '101' } });
  expect(screen.getByRole('button', { name: '换算为 Token 阈值' }).hasAttribute('disabled')).toBe(
    true,
  );
});
it('does not guess model capacity when no explicit window is known', () => {
  render(
    <CompactThreshold
      contextWindow={undefined}
      threshold={10000}
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  expect(screen.getByText(/不能可靠换算百分比/)).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
