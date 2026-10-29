// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { Events } from '../lib/events';
import { GuardianReviewPanel } from '../components/GuardianReviewPanel';
import { listOperations } from '../lib/operations';
const approvalId = '11111111-1111-4111-8111-111111111111';
const denial = () => ({
  approvalId,
  threadId: 'thread',
  turnId: 'turn',
  reviewId: 'review',
  targetItemId: 'item',
  review: {
    status: 'denied',
    riskLevel: 'high',
    userAuthorization: 'low',
    rationale: 'The exact action was denied.',
  },
  action: {
    type: 'command',
    source: 'unifiedExec',
    cwd: '/project',
    command: 'echo <script>review only</script>',
  },
  createdAt: Date.now() - 1000,
  expiresAt: Date.now() + 60000,
  state: 'available',
});
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
function setup(handler: (c: Call) => unknown = () => undefined) {
  const api = new Api(),
    events = new Events(),
    calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, init) => {
      const c: Call = JSON.parse(init.body);
      calls.push(c);
      const result =
        (await handler(c)) ??
        (c.method === 'thread/guardian/list' ? { data: [denial()], captureExhausted: false } : {});
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    }),
  );
  return { api, events, calls };
}
const props = (s: ReturnType<typeof setup>) => ({
  api: s.api,
  events: s.events,
  epoch: 'one',
  threadId: 'thread',
  enabled: true,
  idle: true,
  onChanged: vi.fn(),
  onClose: vi.fn(),
  onLocate: vi.fn(),
});
const consent = () =>
  fireEvent.click(screen.getByRole('checkbox', { name: /我已核对以上具体操作/ }));
const approve = () => fireEvent.click(screen.getByRole('button', { name: '批准此操作的一次重试' }));
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('shows the full escaped denied action and rationale, then submits only its captured identity', async () => {
  let registered = false;
  const s = setup((c) => {
    if (c.method === 'thread/guardian/list')
      return {
        data: [{ ...denial(), state: registered ? 'registered' : 'available' }],
        captureExhausted: false,
      };
    if (c.method === 'thread/approveGuardianDeniedAction') {
      registered = true;
      return { threadId: 'thread', approvalId, registered: true };
    }
  });
  const onLocate = vi.fn();
  render(<GuardianReviewPanel {...props(s)} onLocate={onLocate} />);
  await screen.findByText('The exact action was denied.');
  expect(screen.getByText('echo <script>review only</script>')).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
  expect(
    (screen.getByRole('button', { name: '批准此操作的一次重试' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '查看关联历史条目' }));
  expect(onLocate).toHaveBeenCalledWith('turn', 'item');
  consent();
  approve();
  await screen.findByText(/已受理一次重试授权，不会自动启动任务/);
  expect(s.calls.find((c) => c.method === 'thread/approveGuardianDeniedAction')?.params).toEqual({
    threadId: 'thread',
    approvalId,
    confirm: true,
  });
  expect(s.calls.filter((c) => c.operationId)).toHaveLength(1);
  expect(s.calls.some((c) => c.method === 'turn/start')).toBe(false);
});
it('renders each native action shape without inventing shell commands or missing supplied fields', async () => {
  const actions = [
    {
      type: 'execve',
      source: 'unifiedExec',
      program: 'tool',
      argv: ['arg with spaces', ''],
      cwd: '/p',
    },
    { type: 'writeStdin', approvalId: 'prior', processId: 'proc', stdin: 'input\n', cwd: '/p' },
    { type: 'applyPatch', cwd: '/p', files: ['a.txt', 'b.txt'] },
    { type: 'networkAccess', target: 'api', host: 'example.invalid', protocol: 'https', port: 443 },
    {
      type: 'mcpToolCall',
      server: 'srv',
      toolName: 'call',
      connectorId: 'connector',
      connectorName: 'Name',
      toolTitle: 'Tool title',
    },
    {
      type: 'requestPermissions',
      reason: 'Read explicitly selected file',
      permissions: { network: null, fileSystem: { read: ['/p/a'], write: null } },
    },
  ];
  for (const action of actions) {
    const s = setup((c) =>
      c.method === 'thread/guardian/list'
        ? { data: [{ ...denial(), action }], captureExhausted: false }
        : undefined,
    );
    const view = render(<GuardianReviewPanel {...props(s)} />);
    await screen.findByRole('button', { name: '批准此操作的一次重试' });
    const raw = screen.getByText(JSON.stringify(action, null, 2), {
      selector: 'pre',
      normalizer: (value) => value,
    });
    expect(raw).toBeTruthy();
    expect(s.calls.some((c) => c.operationId)).toBe(false);
    view.unmount();
  }
});
it('keeps unknown authorization blocked and recovers only the original receipt', async () => {
  let id = '',
    registered = false;
  const s = setup((c) => {
    if (c.method === 'thread/approveGuardianDeniedAction') {
      id = c.operationId!;
      throw new Error('response lost');
    }
    if (c.method === 'operation/read') {
      registered = true;
      return {
        operationId: id,
        method: 'thread/approveGuardianDeniedAction',
        state: 'accepted',
        result: { threadId: 'thread', approvalId, registered: true },
      };
    }
    if (c.method === 'thread/guardian/list')
      return {
        data: [{ ...denial(), state: registered ? 'registered' : 'available' }],
        captureExhausted: false,
      };
  });
  render(<GuardianReviewPanel {...props(s)} />);
  await screen.findByText('The exact action was denied.');
  consent();
  approve();
  fireEvent.click(await screen.findByRole('button', { name: '查询原一次重试授权回执' }));
  await waitFor(async () => expect((await listOperations()).find((op) => op.id === id)?.state).toBe('accepted'));
  expect(s.calls.filter((c) => c.method === 'thread/approveGuardianDeniedAction')).toHaveLength(1);
});
it('removes a captured authorization after context changes and does not retain consent for new content', async () => {
  let row: ReturnType<typeof denial> | null = denial();
  const s = setup((c) =>
    c.method === 'thread/guardian/list'
      ? { data: row ? [row] : [], captureExhausted: false }
      : undefined,
  );
  render(<GuardianReviewPanel {...props(s)} />);
  await screen.findByText('The exact action was denied.');
  consent();
  row = { ...row!, review: { ...row!.review, rationale: 'Changed native assessment' } };
  act(() =>
    s.events.publish({
      type: 'notification',
      data: { method: 'item/autoApprovalReview/completed', params: { threadId: 'thread' } },
    }),
  );
  await screen.findByText('Changed native assessment');
  expect((screen.getByRole('checkbox', { name: /我已核对/ }) as HTMLInputElement).checked).toBe(
    false,
  );
  row = null;
  act(() =>
    s.events.publish({
      type: 'notification',
      data: { method: 'turn/started', params: { threadId: 'thread' } },
    }),
  );
  await screen.findByText(/当前没有可展示/);
  expect(screen.queryByRole('button', { name: '批准此操作的一次重试' })).toBeNull();
  expect(s.calls.some((c) => c.operationId)).toBe(false);
});
it('rejects cross-thread or malformed records and explains a bounded capture directory', async () => {
  const first = setup((c) =>
    c.method === 'thread/guardian/list'
      ? { data: [{ ...denial(), threadId: 'other' }], captureExhausted: false }
      : undefined,
  );
  const view = render(<GuardianReviewPanel {...props(first)} />);
  await screen.findByText(/Guardian 拒绝记录身份或状态无效/);
  expect(screen.queryByRole('button', { name: '批准此操作的一次重试' })).toBeNull();
  view.unmount();
  const second = setup((c) =>
    c.method === 'thread/guardian/list' ? { data: [], captureExhausted: true } : undefined,
  );
  render(<GuardianReviewPanel {...props(second)} />);
  await screen.findByText(/拒绝捕获已达到上限/);
  expect(second.calls.some((c) => c.operationId)).toBe(false);
});
it('requires loaded idle history and does not permit an expired capture', async () => {
  const s = setup();
  const view = render(<GuardianReviewPanel {...props(s)} idle={false} />);
  await screen.findByText('The exact action was denied.');
  expect((screen.getByRole('checkbox', { name: /我已核对/ }) as HTMLInputElement).disabled).toBe(
    true,
  );
  view.unmount();
  const expired = setup((c) =>
    c.method === 'thread/guardian/list'
      ? {
          data: [{ ...denial(), createdAt: Date.now() - 2000, expiresAt: Date.now() - 1 }],
          captureExhausted: false,
        }
      : undefined,
  );
  render(<GuardianReviewPanel {...props(expired)} />);
  await screen.findByText(/授权记录已过期/);
  expect(
    (screen.getByRole('button', { name: '批准此操作的一次重试' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(expired.calls.some((c) => c.operationId)).toBe(false);
});
