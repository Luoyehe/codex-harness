// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CliDiagnosticsPanel } from '../components/CliDiagnosticsPanel';
import { Api } from '../lib/api';
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
function routed(handler: (call: Call) => unknown) { const calls: Call[] = [], api = new Api(); vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init: RequestInit) => { const call: Call = JSON.parse(String(init.body)); calls.push(call); return { ok: true, status: 200, json: async () => ({ ok: true, result: await handler(call) }) }; })); return { api, calls }; }
const base = { epoch: 'one', connectionId: 'connection', enabled: true, connected: true };
const identity = { resultId: 'result', kind: 'doctor', status: 'completed' }, result = { ...identity, exitCode: 1, data: { overallStatus: 'fail', privateContext: 'current-connection-only' } };
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('reports actual diagnostic findings and clears private results on disconnect', async () => {
  const { api, calls } = routed(call => call.method === 'diagnostics/cli/run' ? identity : result);
  const view = render(<CliDiagnosticsPanel {...base} api={api}/>);
  expect(calls).toEqual([]); fireEvent.click(screen.getByRole('button', { name: '检查 Codex 环境' }));
  await screen.findByText(/诊断已完成，环境检查发现问题/); expect(calls[0]!.params).toEqual({ kind: 'doctor' }); expect(calls[0]!.operationId).toBeTruthy();
  expect(JSON.stringify(localStorage)).not.toContain('current-connection-only');
  view.rerender(<CliDiagnosticsPanel {...base} api={api} connected={false}/>);
  await waitFor(() => expect(screen.queryByText(/current-connection-only/)).toBeNull());
});
it('unknown diagnostic outcome is recovered from its original receipt without running again', async () => {
  let id = ''; const { api, calls } = routed(call => { if (call.method === 'diagnostics/cli/run') { id = call.operationId!; throw new Error('response lost'); } if (call.method === 'operation/read') return { operationId: id, method: 'diagnostics/cli/run', state: 'accepted', result: identity }; return result; });
  render(<CliDiagnosticsPanel {...base} api={api}/>); fireEvent.click(screen.getByRole('button', { name: '检查 Codex 环境' }));
  fireEvent.click(await screen.findByRole('button', { name: '查询原诊断操作回执' })); await screen.findByText(/诊断已完成，环境检查发现问题/);
  expect(calls.filter(call => call.method === 'diagnostics/cli/run')).toHaveLength(1);
});
it('configuration activity blocks running diagnostics and switching owner clears results', async () => {
  const { api, calls } = routed(call => call.method === 'diagnostics/cli/run' ? identity : result);
  const view = render(<CliDiagnosticsPanel {...base} api={api} enabled={false}/>);
  expect((screen.getByRole('button', { name: '检查 Codex 环境' }) as HTMLButtonElement).disabled).toBe(true); expect(calls).toEqual([]);
  view.rerender(<CliDiagnosticsPanel {...base} api={api}/>); fireEvent.click(screen.getByRole('button', { name: '读取内置模型目录' }));
  await screen.findByText(/current-connection-only/); expect(calls[0]!.params).toEqual({ kind: 'models-bundled' });
  view.rerender(<CliDiagnosticsPanel {...base} api={api} connectionId="other"/>); expect(screen.queryByText(/current-connection-only/)).toBeNull();
});
it('reports the bounded timeout without treating it as a successful environment check', async () => {
  const { api } = routed(call => call.method === 'diagnostics/cli/run' ? { ...identity, status: 'failed' } : { ...identity, status: 'failed', reason: 'timed_out', exitCode: -1 });
  render(<CliDiagnosticsPanel {...base} api={api}/>); fireEvent.click(screen.getByRole('button', { name: '检查 Codex 环境' }));
  await screen.findByText(/诊断达到 20 秒时限，已停止并确认进程清理/); expect(screen.queryByText('诊断已完成。')).toBeNull();
});
it('shows the actual Linux warning report as a completed check with reminders', async () => {
  const { api } = routed(call => call.method === 'diagnostics/cli/run' ? identity : { ...identity, exitCode: 0, data: { overallStatus: 'warning', checks: {} } });
  render(<CliDiagnosticsPanel {...base} api={api}/>); fireEvent.click(screen.getByRole('button', { name: '检查 Codex 环境' }));
  await screen.findByText(/诊断已完成，环境检查有提醒/);
  expect(screen.queryByText('诊断已完成。')).toBeNull();
  expect(screen.getByText(/"overallStatus": "warning"/)).toBeTruthy();
});
