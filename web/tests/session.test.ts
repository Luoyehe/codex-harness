// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { listOperations } from '../lib/operations';
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());
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
  expect(listOperations()[0]?.state).toBe('not_sent');
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
        json: async () => ({ authenticated: true, csrf: 'renewed' }),
      });
    }),
  );
  const request = api.call('thread/read', {}),
    check = api.session();
  const rejected = expect(request).rejects.toMatchObject({ code: 'unauthorized' });
  await api.session('fixture-token');
  rejectOld({
    status: 401,
    ok: false,
    json: async () => ({ ok: false, error: { code: 'unauthorized' } }),
  });
  checkOld({ ok: true, json: async () => ({ authenticated: false }) });
  await rejected;
  await check;
  expect(api.csrf).toBe('renewed');
  expect(lost).not.toHaveBeenCalled();
});
it('negotiates JSON for session checks, login, logout and RPC to prevent proxy login redirects', async () => {
  const fetch = vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    json: async () => ({ authenticated: true, csrf: 'csrf', ok: true, result: {} }),
  });
  vi.stubGlobal('fetch', fetch);
  const api = new Api();
  await api.session();
  await api.session('fixture');
  await api.call('project/list');
  await api.logout();
  expect(fetch).toHaveBeenCalledTimes(4);
  for (const [, init] of fetch.mock.calls)
    expect(init.headers).toMatchObject({
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    });
});
it('recognizes an outer authentication 401 during the initial session read without blaming the admin token', async () => {
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
  'keeps a rejected administrator token distinct from outer authentication failure (status %s)',
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
    await expect(api.session('wrong-fixture-token')).rejects.toThrow('管理员密钥不正确。');
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
      json: async () => ({ authenticated: true, csrf: 'same-gateway-csrf' }),
    });
  vi.stubGlobal('fetch', fetch);
  const pending = api.call('thread/read'),
    oldRejection = expect(pending).rejects.toMatchObject({
      code: 'access_authentication_required',
    });
  await expect(api.mutate('turn/start', { threadId: 't', text: 'retained' })).rejects.toMatchObject(
    { code: 'access_authentication_required', delivery: 'not_sent' },
  );
  expect(listOperations()[0]?.state).toBe('not_sent');
  await api.session();
  old(unauthorized);
  await oldRejection;
  expect(api.csrf).toBe('same-gateway-csrf');
  expect(api.externalAuthenticationRequired).toBe(false);
  expect(lost).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledTimes(3);
});
