// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { deferPanel } from '../components/DeferredPanel';

afterEach(cleanup);
test('optional panels fetch on first open, isolate a failed load and retry without losing the current draft', async () => {
  const loaded = vi.fn(), load = vi.fn().mockRejectedValueOnce(Error('chunk unavailable')).mockResolvedValue(() => { loaded(); return <p>Settings ready</p>; });
  const Panel = deferPanel(load);
  function Workspace() {
    const [open, setOpen] = useState(false), [draft, setDraft] = useState('');
    return <><textarea aria-label="Draft" value={draft} onChange={event => setDraft(event.target.value)} />
      <button onClick={() => setOpen(true)}>Open</button>
      {open && <Panel loadingFallback={(failed, retry) => <div role="dialog">
        <p>{failed ? 'Load failed' : 'Loading'}</p><button onClick={() => setOpen(false)}>Close</button>
        {failed && <button onClick={retry}>Retry</button>}
      </div>} />}</>;
  }
  render(<Workspace />); expect(load).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Keep this draft' } });
  fireEvent.click(screen.getByText('Open')); await screen.findByText('Load failed');
  expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('Keep this draft');
  fireEvent.click(screen.getByText('Retry')); await screen.findByText('Settings ready');
  expect(load).toHaveBeenCalledTimes(2); expect(loaded).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('Keep this draft');
});

test('closing a pending panel cancels its render and reopening retries rejected imports', async () => {
  let reject!: (error: Error) => void;
  const visible = vi.fn(), load = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValue(() => { visible(); return <p>Ready</p>; });
  const Panel = deferPanel(load), fallback = (failed: boolean) => <p>{failed ? 'Failed' : 'Pending'}</p>;
  const view = render(<Panel loadingFallback={fallback} />);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1)); view.unmount();
  await act(async () => reject(Error('offline'))); expect(visible).not.toHaveBeenCalled();
  render(<Panel loadingFallback={fallback} />); await screen.findByText('Ready'); expect(load).toHaveBeenCalledTimes(2);
});

test('a loaded terminal stays mounted while hidden and receives current project props', async () => {
  const mounted = vi.fn(), closed = vi.fn();
  function Terminal({ project }: { project: string }) { useEffect(() => { mounted(); return closed; }, []); return <p>{project}</p>; }
  const load = vi.fn(async () => Terminal), Panel = deferPanel(load), fallback = () => <p>Loading</p>;
  const view = render(<div hidden={false}><Panel project="first" loadingFallback={fallback} /></div>);
  await screen.findByText('first'); view.rerender(<div hidden><Panel project="second" loadingFallback={fallback} /></div>);
  expect(screen.getByText('second')).toBeTruthy(); expect(mounted).toHaveBeenCalledTimes(1); expect(closed).not.toHaveBeenCalled();
  view.rerender(<div hidden={false}><Panel project="second" loadingFallback={fallback} /></div>);
  expect(load).toHaveBeenCalledTimes(1); expect(closed).not.toHaveBeenCalled();
  view.unmount(); expect(closed).toHaveBeenCalledTimes(1);
});
