// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { Events } from '../lib/events';
import { McpPanel } from '../components/McpPanel';
import { mcpSession } from '../lib/mcp-session';
import { listOperations } from '../lib/operations';

type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const identity = { handoffId: 'handoff', epoch: 'runtime', name: 'server', threadId: 'thread' };
const url = 'https://auth.example/authorize?state=PRIVATE-STATE&code_challenge=PRIVATE-CHALLENGE';
const handoff = () => ({ ...identity, status: 'pending', authorizationUrl: url, unavailable: false, restartRequired: false, expiresAt: Date.now() + 60000 });
function setup(handler: (call: Call) => unknown = () => undefined) {
  const api = new Api(), events = new Events(), calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init) => {
    const call: Call = JSON.parse(init.body); calls.push(call);
    const result = (await handler(call)) ?? (call.method === 'mcp/list' ? { data: [{ name: 'server', authStatus: 'notLoggedIn', runtimeStatus: 'connected', tools: {}, resources: [], resourceTemplates: [] }], nextCursor: null }
      : call.method === 'mcp/oauth' ? identity : call.method === 'mcp/oauth/handoff' ? handoff() : call.method === 'mcp/config/read' ? { userVersion: 'v1', servers: [], inheritedServers: [] } : { data: [] });
    return { ok: true, status: 200, json: async () => result && typeof result === 'object' && 'fault' in result ? { ok: false, error: result.fault } : { ok: true, result } };
  }));
  return { api, events, calls };
}
const props = (s: ReturnType<typeof setup>) => ({ api: s.api, events: s.events, epoch: 'resources-1', runtimeEpoch: 'runtime', lease: 'lease', connected: true, threadId: 'thread', threadReady: true, threadIdle: true, configurationReady: true, projectId: 'project' });
async function select() {
  await screen.findByRole('option', { name: /server · connected/ });
  fireEvent.change(screen.getByRole('combobox', { name: '选择 MCP 服务' }), { target: { value: 'server' } });
}
const start = () => fireEvent.click(screen.getByRole('button', { name: '请求此服务授权' }));
const link = () => screen.queryByRole('link', { name: '打开 MCP 授权页面 ↗' });
const completion = (s: ReturnType<typeof setup>, patch = {}) => s.events.publish({ type: 'mcp', data: { type: 'oauth-completed', owned: true, ...identity, success: true, restartRequired: false, ...patch } });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('McpPanel requests a scoped login then reads the private handoff; URL never enters persistent browser records or session cache', async () => {
  const s = setup(); render(<McpPanel {...props(s)} />); await select(); start();
  await screen.findByRole('link', { name: '打开 MCP 授权页面 ↗' });
  expect(link()?.getAttribute('href')).toBe(url);
  expect(s.calls.find(call => call.method === 'mcp/oauth')?.params).toEqual({ name: 'server', threadId: 'thread' });
  expect(s.calls.find(call => call.method === 'mcp/oauth/handoff')?.params).toEqual({ handoffId: 'handoff', epoch: 'runtime' });
  expect(JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cache: mcpSession(s.api, 'lease') })).not.toContain('PRIVATE');
  expect((screen.getByRole('button', { name: '请求此服务授权' }) as HTMLButtonElement).disabled).toBe(true);
  act(() => completion(s, { handoffId: 'other' })); expect(link()).not.toBeNull();
  act(() => completion(s)); expect(link()).toBeNull();
  expect(s.calls.filter(call => call.method === 'mcp/oauth')).toHaveLength(1);
});
it('a lost mutation response is recovered by the original accepted receipt without a second login', async () => {
  let operationId = '';
  const s = setup(call => {
    if (call.method === 'mcp/oauth') { operationId = call.operationId!; throw new Error('lost'); }
    if (call.method === 'operation/read') return { operationId, method: 'mcp/oauth', state: 'accepted', result: identity };
  });
  render(<McpPanel {...props(s)} />); await select(); start();
  const recover = await screen.findByRole('button', { name: '查询原 MCP 授权回执' });
  await waitFor(() => expect((recover as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole('button', { name: '请求此服务授权' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(recover); await screen.findByRole('link', { name: '打开 MCP 授权页面 ↗' });
  expect(s.calls.filter(call => call.method === 'mcp/oauth')).toHaveLength(1); expect(listOperations()).toEqual([]);
});
it('completion while a handoff read is delayed invalidates that reply', async () => {
  let finish!: (v: unknown) => void;
  const s = setup(call => call.method === 'mcp/oauth/handoff' ? new Promise(resolve => { finish = resolve; }) : undefined);
  render(<McpPanel {...props(s)} />); await select(); start();
  await waitFor(() => expect(s.calls.some(call => call.method === 'mcp/oauth/handoff')).toBe(true));
  act(() => completion(s)); await act(async () => finish(handoff())); expect(link()).toBeNull();
});
it('completion before mutation response prevents a handoff fetch and does not revive a link', async () => {
  let finish!: (v: unknown) => void;
  const s = setup(call => call.method === 'mcp/oauth' ? new Promise(resolve => { finish = resolve; }) : undefined);
  render(<McpPanel {...props(s)} />); await select(); start();
  await waitFor(() => expect(s.calls.some(call => call.method === 'mcp/oauth')).toBe(true));
  act(() => completion(s)); await act(async () => finish(identity));
  expect(link()).toBeNull(); expect(s.calls.filter(call => call.method === 'mcp/oauth/handoff')).toHaveLength(0);
});
it('a legacy completion before mutation response keeps explicit runtime recovery required', async () => {
  let finish!: (v: unknown) => void;
  const s = setup(call => call.method === 'mcp/oauth' ? new Promise(resolve => { finish = resolve; }) : undefined);
  render(<McpPanel {...props(s)} />); await select(); start();
  await waitFor(() => expect(s.calls.some(call => call.method === 'mcp/oauth')).toBe(true));
  act(() => completion(s, { restartRequired: true })); await act(async () => finish(identity));
  expect(link()).toBeNull(); expect((screen.getByRole('button', { name: '请求此服务授权' }) as HTMLButtonElement).disabled).toBe(true);
  expect(s.calls.filter(call => call.method === 'mcp/oauth')).toHaveLength(1);
});
it.each(['disconnect', 'lease', 'runtime', 'thread', 'selection'] as const)('%s replacement ignores a late handoff reply', async change => {
  let finish!: (v: unknown) => void;
  const s = setup(call => call.method === 'mcp/oauth/handoff' ? new Promise(resolve => { finish = resolve; }) : undefined);
  const p = props(s), view = render(<McpPanel {...p} />); await select(); start();
  await waitFor(() => expect(s.calls.some(call => call.method === 'mcp/oauth/handoff')).toBe(true));
  if (change === 'selection') fireEvent.change(screen.getByRole('combobox', { name: '选择 MCP 服务' }), { target: { value: '' } });
  else view.rerender(<McpPanel {...p} {...(change === 'disconnect' ? { connected: false } : change === 'lease' ? { lease: 'new' } : change === 'runtime' ? { runtimeEpoch: 'new-runtime' } : { threadId: 'other' })} />);
  await act(async () => finish(handoff())); expect(link()).toBeNull(); expect(s.calls.filter(call => call.method === 'mcp/oauth')).toHaveLength(1);
});
it.each(['old', 'revoked', 'unknown'] as const)('%s receipt or handoff cannot automatically resubmit authorization', async kind => {
  let operationId = '';
  const s = setup(call => {
    if (call.method === 'mcp/oauth' && kind === 'unknown') { operationId = call.operationId!; throw new Error('lost'); }
    if (call.method === 'mcp/oauth' && kind === 'old') return { authorizationUrl: url, handoffUnavailable: true };
    if (call.method === 'mcp/oauth/handoff' && kind === 'revoked') return { ...identity, status: 'pending', unavailable: true, restartRequired: true, expiresAt: Date.now() - 100 };
    if (call.method === 'operation/read') return { operationId, method: 'mcp/oauth', state: 'unknown' };
  });
  render(<McpPanel {...props(s)} />); await select(); start();
  await waitFor(() => expect((screen.getByRole('button', { name: '查询原 MCP 授权回执' }) as HTMLButtonElement).disabled).toBe(false));
  if (kind === 'unknown') { fireEvent.click(screen.getByRole('button', { name: '查询原 MCP 授权回执' })); await screen.findByText(/原授权结果仍待确认/); }
  expect(link()).toBeNull(); start(); expect(s.calls.filter(call => call.method === 'mcp/oauth')).toHaveLength(1);
});
it('supports HTTP self-hosted authorization and clears the URL on TTL without automatic login', async () => {
  const s = setup(call => call.method === 'mcp/oauth/handoff' ? { ...handoff(), authorizationUrl: 'http://127.0.0.1:8888/authorize', expiresAt: Date.now() + 80 } : undefined);
  render(<McpPanel {...props(s)} />); await select(); start();
  await screen.findByRole('link', { name: '打开 MCP 授权页面 ↗' });
  expect(link()?.getAttribute('href')).toBe('http://127.0.0.1:8888/authorize');
  await waitFor(() => expect(link()).toBeNull());
  expect((screen.getByRole('button', { name: '请求此服务授权' }) as HTMLButtonElement).disabled).toBe(true);
  expect(s.calls.filter(call => call.method === 'mcp/oauth')).toHaveLength(1);
});
