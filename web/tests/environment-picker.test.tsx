// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { EnvironmentPicker } from '../components/EnvironmentPicker';
import type { Api } from '../lib/api';
import { executionOptions } from '../lib/workflows';
import { readDraft, writeDraft, emptyDraft } from '../lib/drafts';
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
const rows = [
  {
    environmentId: 'ready',
    name: 'Worker',
    endpoint: 'wss://worker.example',
    selectionReady: true,
    info: { cwd: 'file:///work' },
  },
  {
    environmentId: 'pending',
    name: 'Pending',
    endpoint: 'wss://pending.example',
    selectionReady: false,
  },
];
it('requires explicit inspected selection and sends identity-only options', async () => {
  const call = vi.fn().mockResolvedValue({ data: rows }),
    api = { call } as unknown as Api,
    onProblem = vi.fn();
  let chosen: string[] | undefined;
  function Demo() {
    const [value, setValue] = useState<string[]>();
    chosen = value;
    return (
      <EnvironmentPicker
        api={api}
        epoch="one"
        value={value}
        existingThread={false}
        disabled={false}
        onProblem={onProblem}
        onChange={setValue}
      />
    );
  }
  render(<Demo />);
  expect(call).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('执行环境 · 本机项目', { selector: 'summary' }));
  const ready = await screen.findByRole('checkbox', { name: /Worker/ });
  expect((screen.getByRole('checkbox', { name: /Pending/ }) as HTMLInputElement).disabled).toBe(
    true,
  );
  expect(chosen).toBeUndefined();
  fireEvent.click(ready);
  expect(chosen).toEqual(['ready']);
  expect(executionOptions({ environments: chosen }, undefined, [])).toEqual({
    environments: ['ready'],
  });
  fireEvent.click(screen.getByRole('button', { name: '本次不使用远端环境' }));
  expect(chosen).toEqual([]);
  expect(call.mock.calls.every(([method]) => method === 'environment/list')).toBe(true);
});
it('blocks restored stale selections on a new runtime instead of switching to another remote', async () => {
  const call = vi.fn().mockResolvedValue({ data: rows }),
    api = { call } as unknown as Api,
    onProblem = vi.fn(),
    onChange = vi.fn();
  render(
    <EnvironmentPicker
      api={api}
      epoch="replacement"
      value={['old-remote']}
      existingThread
      disabled={false}
      onChange={onChange}
      onProblem={onProblem}
    />,
  );
  await waitFor(() =>
    expect(onProblem).toHaveBeenLastCalledWith(expect.stringContaining('已失效')),
  );
  expect(onChange).not.toHaveBeenCalled();
});
it('persists bounded explicit remote selections and rejects malformed draft inputs', () => {
  const draft = { ...emptyDraft('new:p'), options: { environments: ['ready'] } };
  writeDraft(draft);
  expect(readDraft('new:p').options.environments).toEqual(['ready']);
  expect(() => writeDraft({ ...draft, options: { environments: ['ready', 'ready'] } })).toThrow(
    '8',
  );
});
