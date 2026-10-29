// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import * as operationStorage from '../lib/operations';
import { Api } from '../lib/api';
import { listOperations } from '../lib/operations';
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('reports authoritative authentication loss once and treats a rejected write as not sent', async () => {
  const api = new Api();
  api.csrf = 'old';
  const lost = vi.fn();
  api.onAuthenticationLost(lost);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
      json: async () => ({ ok: false, error: { code: 'unauthorized' } }),
    }),
  );
  await expect(api.mutate('turn/start', { threadId: 't', text: 'keep' })).rejects.toMatchObject({
    code: 'unauthorized',
    delivery: 'not_sent',
  });
  await expect(api.call('thread/read', { threadId: 't' })).rejects.toMatchObject({
    code: 'unauthorized',
  });
  expect(lost).toHaveBeenCalledOnce();
  expect(api.csrf).toBe('');
  expect((await listOperations())[0]?.state).toBe('not_sent');
  await expect(api.logout()).resolves.toBeUndefined();
});
it('does not invalidate a renewed session with an old RPC rejection or stale session check', async () => {
  const api = new Api();
  api.csrf = 'old';
  const lost = vi.fn();
  api.onAuthenticationLost(lost);
  let rejectOld!: (value: unknown) => void, checkOld!: (value: unknown) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/rpc')
        return new Promise((resolve) => {
          rejectOld = resolve;
        });
      if (init?.method === 'GET')
        return new Promise((resolve) => {
          checkOld = resolve;
        });
      return Promise.resolve({
        ok: true,
        json: async () => ({ authenticated: true, operationRecoveryProtocol: 2, csrf: 'renewed' }),
      });
    }),
  );
  const request = api.call('thread/read', {}),
    check = api.session();
  const rejected = expect(request).rejects.toMatchObject({ code: 'unauthorized' });
  const staleCheck = expect(check).rejects.toMatchObject({ code: 'stale_session' });
  await api.session({ username: 'admin', password: 'fixture-password' });
  rejectOld({
    status: 401,
    ok: false,
    json: async () => ({ ok: false, error: { code: 'unauthorized' } }),
  });
  checkOld({ ok: true, json: async () => ({ authenticated: false }) });
  await rejected;
  await staleCheck;
  expect(api.csrf).toBe('renewed');
  expect(lost).not.toHaveBeenCalled();
});
it('negotiates JSON for session checks, login, logout and RPC to prevent proxy login redirects', async () => {
  const fetch = vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    json: async () => ({ authenticated: true, operationRecoveryProtocol: 2, csrf: 'csrf', ok: true, result: {} }),
  });
  vi.stubGlobal('fetch', fetch);
  const api = new Api();
  await api.session();
  await api.session({ username: 'admin', password: 'fixture-password' });
  await api.call('project/list');
  await api.logout();
  expect(fetch).toHaveBeenCalledTimes(4);
  for (const [, init] of fetch.mock.calls)
    expect(init.headers).toMatchObject({
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    });
});
it('recognizes an outer authentication 401 during the initial session read without blaming account credentials', async () => {
  const api = new Api(),
    lost = vi.fn();
  api.onAuthenticationLost(lost);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
      headers: new Headers({ Location: 'https://untrusted.example/' }),
      json: async () => ({ status: 'KO', message: 'Unauthorized' }),
    }),
  );
  await expect(api.session()).rejects.toMatchObject({ code: 'access_authentication_required' });
  expect(api.externalAuthenticationRequired).toBe(true);
  expect(lost).toHaveBeenCalledWith(true);
  expect(fetch).toHaveBeenCalledOnce();
});
it.each([400, 401])(
  'keeps a rejected administrator credentials distinct from outer authentication failure (status %s)',
  async (status) => {
    const api = new Api();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status,
        ok: false,
        json: async () => ({ ok: false, error: { code: 'unauthorized' } }),
      }),
    );
    await expect(api.session({ username: 'admin', password: 'wrong-fixture-password' })).rejects.toThrow('登录信息不正确，请核对后重试。');
    expect(api.externalAuthenticationRequired).toBe(false);
  },
);
it('retains an edge-rejected operation and does not let a stale 401 undo renewed access with the same gateway CSRF', async () => {
  const api = new Api();
  api.csrf = 'same-gateway-csrf';
  const lost = vi.fn();
  api.onAuthenticationLost(lost);
  let old!: (value: unknown) => void;
  const unauthorized = { status: 401, ok: false, json: async () => ({ message: 'Unauthorized' }) };
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    )
    .mockResolvedValueOnce(unauthorized)
    .mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({ authenticated: true, operationRecoveryProtocol: 2, csrf: 'same-gateway-csrf' }),
    });
  vi.stubGlobal('fetch', fetch);
  const pending = api.call('thread/read'),
    oldRejection = expect(pending).rejects.toMatchObject({
      code: 'access_authentication_required',
    });
  await expect(api.mutate('turn/start', { threadId: 't', text: 'retained' })).rejects.toMatchObject(
    { code: 'access_authentication_required', delivery: 'not_sent' },
  );
  expect((await listOperations())[0]?.state).toBe('not_sent');
  await api.session();
  old(unauthorized);
  await oldRejection;
  expect(api.csrf).toBe('same-gateway-csrf');
  expect(api.externalAuthenticationRequired).toBe(false);
  expect(lost).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(['read', 'login', 'setup'] as const)('does not restore an authenticated %s result after logout during storage initialization', async (kind) => {
  let release!: () => void;
  const initialize = vi.spyOn(operationStorage, 'initializeOperations').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ authenticated: true, operationRecoveryProtocol: 2, csrf: 'old' }) }));
  const api = new Api();
  const pending = kind === 'read' ? api.session() : kind === 'login'
    ? api.session({ username: 'admin', password: 'fixture-password' })
    : api.setupAccount({ token: 'fixture-token', username: 'admin', password: 'fixture-password' });
  const assertion = expect(pending).rejects.toMatchObject({ code: 'stale_session', delivery: kind === 'read' ? undefined : 'unknown' });
  await waitFor(() => expect(initialize).toHaveBeenCalledOnce());
  await api.logout(); release(); await assertion;
  expect(api.csrf).toBe('');
});
it('retains a newer successful login when older initialization finishes later', async () => {
  let release!: () => void;
  const initialize = vi.spyOn(operationStorage, 'initializeOperations').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  let count = 0;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
    const csrf = ++count === 1 ? 'old' : 'new';
    return { ok: true, status: 200, json: async () => ({ authenticated: true, operationRecoveryProtocol: 2, csrf }) };
  }));
  const api = new Api(), credentials = { username: 'admin', password: 'fixture-password' };
  const pending = api.session(credentials), assertion = expect(pending).rejects.toMatchObject({ code: 'stale_session', delivery: 'unknown' });
  await waitFor(() => expect(initialize).toHaveBeenCalledOnce());
  expect(await api.session(credentials)).toMatchObject({ authenticated: true, csrf: 'new' });
  release(); await assertion; expect(api.csrf).toBe('new');
});
