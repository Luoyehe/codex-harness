// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeOperation,
  createOperation,
  listOperations,
  reconcileOperation,
  stopUnknownRecovery,
  updateOperation,
} from '../lib/operations';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { initializeOperations } from '../lib/operations';
import { Api } from '../lib/api';
import { emptyDraft, readDraft, writeDraft } from '../lib/drafts';
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
describe('independent operation recovery', () => {
  it('keeps two independent intents and treats missing receipts as uncertainty', async () => {
    const a = (await createOperation('turn/start', { threadId: 'a' })),
      b = (await createOperation('turn/start', { threadId: 'b' }));
    (await reconcileOperation(a.id, { state: 'not_received' }));
    const records = await listOperations();
    // Millisecond timestamps can tie; both independent identities and their states must survive.
    expect(new Set(records.map((o) => o.id))).toEqual(new Set([a.id, b.id]));
    expect(records.find((record) => record.id === a.id)?.state).toBe('unknown');
    await expect(createOperation('turn/start', { threadId: 'a' })).rejects.toThrow('待确认');
    await expect(acknowledgeOperation(a.id)).rejects.toThrow('未知');
  });
  it('does not undo accepted facts with late errors or resurrect acknowledgements', async () => {
    const a = (await createOperation('conversation/start', { projectId: 'p' }));
    (await updateOperation(a.id, 'accepted', 'thread-1'));
    (await reconcileOperation(a.id, { state: 'not_received' }));
    (await updateOperation(a.id, 'not_sent'));
    expect((await listOperations())[0]).toMatchObject({ state: 'accepted', resolvedThreadId: 'thread-1' });
    (await acknowledgeOperation(a.id));
    (await updateOperation(a.id, 'unknown'));
    expect((await listOperations())).toEqual([]);
  });
  it('survives a second tab writing a previously read record after acceptance or acknowledgement', async () => {
    const a = (await createOperation('turn/start', { threadId: 'a' }));
    const stale = JSON.stringify({ ...a, state: 'unknown' });
    (await updateOperation(a.id, 'accepted'));
    localStorage.setItem(`harness.operation.v1.${a.id}`, stale);
    expect((await listOperations())[0]?.state).toBe('accepted');
    (await acknowledgeOperation(a.id));
    localStorage.setItem(`harness.operation.v1.${a.id}`, stale);
    expect((await listOperations())).toEqual([]);
  });
  it('fails closed on corrupt storage and never sends the new request', async () => {
    localStorage.setItem('harness.operation.v1.broken', '{');
    globalThis.indexedDB = new IDBFactory();
    await expect(initializeOperations(2)).rejects.toThrow();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      new Api().mutate('turn/start', { threadId: 'a', text: 'private' }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves only recovery metadata when transport outcome is unknown', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetch);
    await expect(
      new Api().mutate('turn/start', {
        threadId: 'a',
        text: 'secret prompt',
        attachmentIds: ['private-file'],
      }),
    ).rejects.toThrow('offline');
    expect(fetch).toHaveBeenCalledOnce();
    expect((await listOperations())[0]?.state).toBe('unknown');
    expect(JSON.stringify((await listOperations()))).not.toMatch(/secret prompt|private-file/);
  });
  it('allows a fresh intent only after an authoritative not-sent result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          ok: false,
          error: { code: 'busy', message: 'busy', delivery: 'not_sent' },
        }),
      }),
    );
    await expect(
      new Api().mutate('turn/start', { threadId: 'a', text: 'keep draft' }),
    ).rejects.toThrow('busy');
    expect((await listOperations())[0]?.state).toBe('not_sent');
    await expect(createOperation('turn/start', { threadId: 'a' })).resolves.toBeDefined();
  });
  it.each(['available', 'getter', 'read', 'write'] as const)('gives duplicated documents independent client identities when sessionStorage is %s', (failure) => {
    sessionStorage.setItem('harness.client', 'copied-document-client');
    if (failure === 'getter') {
      vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
        throw new DOMException('storage unavailable', 'SecurityError');
      });
    } else if (failure === 'read') {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('storage unreadable', 'SecurityError');
      });
    } else if (failure === 'write') {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('storage unwritable', 'QuotaExceededError');
      });
    }
    const a = new Api(),
      b = new Api();
    expect(a.clientId).not.toBe('copied-document-client');
    expect(b.clientId).not.toBe('copied-document-client');
    expect(a.clientId).not.toBe(b.clientId);
    expect(a.headers()['X-Harness-Client']).toBe(a.clientId);
    expect(b.headers()['X-Harness-Client']).toBe(b.clientId);
  });
  it.each(['getter', 'read', 'write', 'abort', 'discarded-write'] as const)('sends neither a business mutation nor a terminal open when operation storage has a %s failure', async (failure) => {
    const fetch = vi.fn(), api = new Api();
    vi.stubGlobal('fetch', fetch);
    if (failure === 'getter') vi.stubGlobal('indexedDB', undefined);
    else if (failure === 'read') vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(() => {
      throw new DOMException('database unreadable', 'SecurityError');
    });
    else if (failure === 'write') vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(() => {
      throw new DOMException('database full', 'QuotaExceededError');
    });
    else {
      const original = IDBObjectStore.prototype.add;
      vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
        if (failure === 'discarded-write') return this.get('absent') as IDBRequest<IDBValidKey>;
        const request = original.call(this, value, key); this.transaction.abort(); return request;
      });
    }
    await expect(api.mutate('workspace/write', { projectId: 'p', path: 'file.txt' })).rejects.toMatchObject({ delivery: 'not_sent' });
    await expect(api.openTerminal({ projectId: 'p', rows: 24, cols: 80 }, 'lease').result).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('submits the first conversation input as one intent and preserves a partial unknown thread', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({
        ok: false,
        error: {
          code: 'first_turn_unknown',
          message: 'unknown first input',
          delivery: 'unknown',
          data: { phase: 'first_turn', threadId: 'partial-thread' },
        },
      }),
    });
    vi.stubGlobal('fetch', fetch);
    await expect(
      new Api().mutate('conversation/start', { projectId: 'p', text: 'first input' }),
    ).rejects.toThrow('unknown first input');
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0]![1].body).method).toBe('conversation/start');
    expect((await listOperations())[0]).toMatchObject({
      state: 'unknown',
      resolvedThreadId: 'partial-thread',
    });
    await expect(createOperation('conversation/start', { projectId: 'p' })).rejects.toThrow('待确认');
  });
  it('does not clear retained drafts if a stopped unknown operation later receives an HTTP success', async () => {
    const draft = { ...emptyDraft('a'), text: 'retain for review' };
    writeDraft(draft);
    let finish!: (v: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const pending = new Api().mutate('turn/start', { threadId: 'a', text: draft.text });
    const op = (await listOperations())[0]!;
    (await reconcileOperation(op.id, { operationId: op.id, state: 'unknown' }));
    (await stopUnknownRecovery(op.id, { operationId: op.id, state: 'unknown' }));
    finish({
      ok: true,
      json: async () => ({ ok: true, result: { turn: { id: 'accepted-late' } } }),
    });
    await pending;
    expect((await listOperations())).toEqual([]);
    expect(readDraft('a')).toEqual(draft);
  });
});

it('retains only typed terminal identity, keeps accepted proof monotonic and rejects conflicting identities', async () => {
  const terminalOwner = { clientId: 'document', connectionId: 'lease' };
  const op = (await createOperation('terminal/open', { projectId: 'project', terminalOwner }));
  (await reconcileOperation(op.id, {
    operationId: op.id,
    state: 'accepted',
    result: { terminalId: 'terminal', output: 'do not retain' },
  }));
  (await reconcileOperation(op.id, { operationId: op.id, state: 'not_received' }));
  expect((await listOperations())[0]).toMatchObject({
    state: 'accepted',
    terminalOwner,
    terminalResult: { terminalId: 'terminal' },
  });
  expect(JSON.stringify((await listOperations()))).not.toContain('do not retain');
  await expect(reconcileOperation(op.id, { state: 'accepted', result: { terminalId: 'different' } })).rejects.toThrow('不同的终端');
  expect((await listOperations())[0]?.terminalResult).toEqual({ terminalId: 'terminal' });
});
it('binds terminal recovery to the creating document and connection before making a read request', async () => {
  const api = new Api(),
    fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const operation = {
    operationId: crypto.randomUUID(),
    projectId: 'p',
    clientId: api.clientId,
    connectionId: 'lease-a',
  };
  await expect(api.recoverTerminal(operation, 'lease-b')).rejects.toThrow('已结束的连接');
  await expect(
    api.recoverTerminal({ ...operation, clientId: 'another-document' }, 'lease-a'),
  ).rejects.toThrow('已结束的连接');
  expect(fetch).not.toHaveBeenCalled();
});
it('requires the exact operation identity and a usable accepted terminal result', async () => {
  const api = new Api(),
    op = (await createOperation('terminal/open', {
      projectId: 'p',
      terminalOwner: { clientId: api.clientId, connectionId: 'lease' },
    }));
  const operation = {
    operationId: op.id,
    projectId: 'p',
    clientId: api.clientId,
    connectionId: 'lease',
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        ok: true,
        result: {
          operationId: 'other',
          method: 'terminal/open',
          state: 'accepted',
          result: { terminalId: 'wrong' },
        },
      }),
    })
    .mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        ok: true,
        result: { operationId: op.id, method: 'terminal/open', state: 'accepted', result: {} },
      }),
    });
  vi.stubGlobal('fetch', fetch);
  await expect(api.recoverTerminal(operation, 'lease')).rejects.toThrow('身份不匹配');
  await expect(api.recoverTerminal(operation, 'lease')).rejects.toThrow('有效终端标识');
  expect((await listOperations())[0]?.state).toBe('pending');
});
it('keeps unresolved opens exclusive within their lease while allowing a replacement lease to create its own terminal', async () => {
  (await createOperation('terminal/open', {
    projectId: 'p',
    terminalOwner: { clientId: 'doc', connectionId: 'old' },
  }));
  await expect(createOperation('terminal/open', {
      projectId: 'p',
      terminalOwner: { clientId: 'doc', connectionId: 'old' },
    })).rejects.toThrow('待确认');
  await expect(createOperation('terminal/open', {
      projectId: 'p',
      terminalOwner: { clientId: 'doc', connectionId: 'new' },
    })).resolves.toBeDefined();
});
