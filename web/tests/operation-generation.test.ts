// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { operationId, uuid } from '../lib/ids';
import { isArchivedReceipt } from '../lib/operations';
afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('accepts only a matching archival receipt shape without treating it as not-sent evidence', () => {
  const receipt = {
    operationId: 'id',
    scope: 'operation:id',
    method: 'operation/archived',
    state: 'unknown',
    error: { code: 'operation_archived' },
  };
  expect(isArchivedReceipt(receipt)).toBe(true);
  expect(isArchivedReceipt({ ...receipt, state: 'not_sent' })).toBe(false);
  expect(isArchivedReceipt({ ...receipt, scope: 'operation:other' })).toBe(false);
  expect(isArchivedReceipt({ ...receipt, error: { code: 'other' } })).toBe(false);
});
it('embeds all 48 generation bits only in operation UUID v8, retaining normal UUID v4 IDs', () => {
  const id = operationId(0xabcdef123456);
  expect(id).toMatch(/^abcdef12-3456-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(operationId(0)).toMatch(/^[0-9a-f-]{14}4/);
  expect(uuid()).toMatch(/^[0-9a-f-]{14}4/);
  expect(() => operationId(0x1000000000000)).toThrow('代际无效');
});
it('gets the generation on login and uses it for normal and terminal mutations', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ authenticated: true, operationRecoveryProtocol: 2, csrf: 'c', operationGeneration: 14 }), {
          status: 200,
        }),
      ),
  );
  const api = new Api();
  await api.session();
  expect(api.operationGeneration).toBe(14);
  api.observeOperationGeneration(13);
  expect(api.operationGeneration).toBe(14);
  vi.spyOn(api, 'call').mockResolvedValue({ terminalId: 'terminal' });
  const mutation = api.beginMutation('settings/write', {});
  await mutation.result;
  const terminal = api.openTerminal({ projectId: 'p', rows: 20, cols: 80 }, 'connection');
  await terminal.result;
  expect(mutation.operationId).toMatch(/^00000000-000e-8/);
  expect(terminal.operation.operationId).toMatch(/^00000000-000e-8/);
});
