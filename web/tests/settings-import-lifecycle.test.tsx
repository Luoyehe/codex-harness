// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { deferPanel } from '../components/DeferredPanel';
import { Dialog } from '../components/Dialog';
import { Api } from '../lib/api';
import { Events } from '../lib/events';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('a pending real Settings import remains closable and cannot reopen its old owner after completion', async () => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  const api = new Api(), events = new Events();
  const call = vi.spyOn(api, 'call'), mutate = vi.spyOn(api, 'mutate');
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  // Hold the actual loader promise without replacing Settings or its dependency
  // graph. There is no timer, DOM-query deadline or mocked import registry.
  const load = vi.fn(async () => { start(); await pending; return (await import('../components/Settings')).Settings; });
  const SettingsOnDemand = deferPanel(load);
  function Workspace() {
    const [open, setOpen] = useState(false), [draft, setDraft] = useState('');
    return <><textarea aria-label="Draft" value={draft} onChange={event => setDraft(event.target.value)} />
      <button onClick={() => setOpen(true)}>Open settings</button>
      {open && <SettingsOnDemand api={api} events={events} epoch="fixture" projects={[]} theme="system"
        onTheme={() => {}} onClose={() => setOpen(false)} onChanged={() => {}} onProjectAction={() => {}}
        onLogout={async () => {}} onOpenDraft={() => {}}
        loadingFallback={() => <Dialog title="设置" onClose={() => setOpen(false)}><p role="status">正在加载设置…</p></Dialog>} />}
    </>;
  }
  render(<Workspace />);
  expect(load).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'preserved draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
  await started;
  expect(screen.getByRole('status').textContent).toBe('正在加载设置…');
  expect(screen.queryByRole('button', { name: '服务管理' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => { release(); await load.mock.results[0]!.value; });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByLabelText('Draft')).toHaveProperty('value', 'preserved draft');
  fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
  expect(screen.getByRole('button', { name: '服务管理' })).toBeTruthy();
  expect(screen.getByRole('combobox', { name: '主题' })).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(1);
  expect(call).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
});
