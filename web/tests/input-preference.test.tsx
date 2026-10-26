// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Composer } from '../components/Composer';
import { InputPreferences } from '../components/InputPreferences';
import { setEnterBehavior } from '../lib/input-preference';
import type { Api } from '../lib/api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setEnterBehavior('send');
});
function fixture() {
  const send = vi.fn().mockResolvedValue(false);
  render(
    <>
      <InputPreferences />
      <Composer
        api={{ call: vi.fn() } as unknown as Api}
        value="draft"
        onChange={vi.fn()}
        onSend={send}
        onStop={vi.fn()}
        busy={false}
        disabled={false}
        active={false}
        options={{}}
        onOptions={vi.fn()}
        models={[]}
        defaults={{}}
        defaultsLoading={false}
        notice=""
        contextKey="pref"
      />
    </>,
  );
  return { send, input: screen.getByRole('textbox', { name: '给 Codex 的消息' }) };
}
it('applies the browser preference immediately and preserves IME and Shift behavior', async () => {
  setEnterBehavior('send');
  const { send, input } = fixture();
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  expect(send).not.toHaveBeenCalled();
  await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
  expect(send).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('Enter 键行为'), { target: { value: 'newline' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(send).toHaveBeenCalledTimes(1);
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  expect(send).toHaveBeenCalledTimes(1);
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, keyCode: 229 });
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true }));
  expect(send).toHaveBeenCalledTimes(2);
  await act(async () => fireEvent.keyDown(input, { key: 'Enter', metaKey: true }));
  expect(send).toHaveBeenCalledTimes(3);
});
it('uses the explicitly selected preference in memory when browser persistence fails', async () => {
  setEnterBehavior('send');
  const { send, input } = fixture();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  fireEvent.change(screen.getByLabelText('Enter 键行为'), { target: { value: 'newline' } });
  expect(screen.getByText(/当前页面已采用此设置/)).toBeTruthy();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(send).not.toHaveBeenCalled();
  await act(async () => fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true }));
  expect(send).toHaveBeenCalledTimes(1);
});
