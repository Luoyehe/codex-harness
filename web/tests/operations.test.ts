// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeOperation, createOperation, listOperations, reconcileOperation, stopUnknownRecovery, updateOperation } from '../lib/operations';
import { Api } from '../lib/api';
import { emptyDraft, readDraft, writeDraft } from '../lib/drafts';
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); });
describe('independent operation recovery', () => {
  it('keeps two independent intents and treats missing receipts as uncertainty', () => {
    const a = createOperation('turn/start', { threadId: 'a' }), b = createOperation('turn/start', { threadId: 'b' });
    reconcileOperation(a.id, { state: 'not_received' });
    expect(listOperations().map(o => o.id)).toEqual([a.id, b.id]);
    expect(listOperations()[0]?.state).toBe('unknown');
    expect(() => createOperation('turn/start', { threadId: 'a' })).toThrow('待确认');
    expect(() => acknowledgeOperation(a.id)).toThrow('未知');
  });
  it('does not undo accepted facts with late errors or resurrect acknowledgements', () => {
    const a = createOperation('conversation/start', { projectId: 'p' });
    updateOperation(a.id, 'accepted', 'thread-1');
    reconcileOperation(a.id, { state: 'not_received' });
    updateOperation(a.id, 'not_sent');
    expect(listOperations()[0]).toMatchObject({ state: 'accepted', resolvedThreadId: 'thread-1' });
    acknowledgeOperation(a.id); updateOperation(a.id, 'unknown');
    expect(listOperations()).toEqual([]);
  });
  it('survives a second tab writing a previously read record after acceptance or acknowledgement', () => {
    const a = createOperation('turn/start', { threadId: 'a' });
    const stale = JSON.stringify({ ...a, state: 'unknown' });
    updateOperation(a.id, 'accepted');
    localStorage.setItem(`harness.operation.v1.${a.id}`, stale);
    expect(listOperations()[0]?.state).toBe('accepted');
    acknowledgeOperation(a.id);
    localStorage.setItem(`harness.operation.v1.${a.id}`, stale);
    expect(listOperations()).toEqual([]);
  });
  it('fails closed on corrupt storage and never sends the new request', async () => {
    localStorage.setItem('harness.operation.v1.broken', '{');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(new Api().mutate('turn/start', { threadId: 'a', text: 'private' })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves only recovery metadata when transport outcome is unknown', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('offline')); vi.stubGlobal('fetch', fetch);
    await expect(new Api().mutate('turn/start', { threadId: 'a', text: 'secret prompt', attachmentIds: ['private-file'] })).rejects.toThrow('offline');
    expect(fetch).toHaveBeenCalledOnce();
    expect(listOperations()[0]?.state).toBe('unknown');
    expect(JSON.stringify(listOperations())).not.toMatch(/secret prompt|private-file/);
  });
  it('allows a fresh intent only after an authoritative not-sent result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'busy', message: 'busy', delivery: 'not_sent' } }) }));
    await expect(new Api().mutate('turn/start', { threadId: 'a', text: 'keep draft' })).rejects.toThrow('busy');
    expect(listOperations()[0]?.state).toBe('not_sent');
    expect(() => createOperation('turn/start', { threadId: 'a' })).not.toThrow();
  });
  it('gives duplicated documents independent client identities', () => { const a = new Api(), b = new Api(); expect(a.clientId).not.toBe(b.clientId); });
  it('submits the first conversation input as one intent and preserves a partial unknown thread', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({ ok: false, error: { code: 'first_turn_unknown', message: 'unknown first input', delivery: 'unknown', data: { phase: 'first_turn', threadId: 'partial-thread' } } }) });
    vi.stubGlobal('fetch', fetch);
    await expect(new Api().mutate('conversation/start', { projectId: 'p', text: 'first input' })).rejects.toThrow('unknown first input');
    expect(fetch).toHaveBeenCalledOnce(); expect(JSON.parse(fetch.mock.calls[0]![1].body).method).toBe('conversation/start');
    expect(listOperations()[0]).toMatchObject({ state: 'unknown', resolvedThreadId: 'partial-thread' });
    expect(() => createOperation('conversation/start', { projectId: 'p' })).toThrow('待确认');
  });
  it('does not clear retained drafts if a stopped unknown operation later receives an HTTP success', async () => {
    const draft = { ...emptyDraft('a'), text: 'retain for review' }; writeDraft(draft);
    let finish!: (v: unknown) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })));
    const pending = new Api().mutate('turn/start', { threadId: 'a', text: draft.text });
    const op = listOperations()[0]!; reconcileOperation(op.id, { operationId: op.id, state: 'unknown' });
    stopUnknownRecovery(op.id, { operationId: op.id, state: 'unknown' });
    finish({ ok: true, json: async () => ({ ok: true, result: { turn: { id: 'accepted-late' } } }) }); await pending;
    expect(listOperations()).toEqual([]); expect(readDraft('a')).toEqual(draft);
  });
});

it('retains only typed terminal identity, keeps accepted proof monotonic and rejects conflicting identities', () => {
  const terminalOwner = { clientId: 'document', connectionId: 'lease' };
  const op = createOperation('terminal/open', { projectId: 'project', terminalOwner });
  reconcileOperation(op.id, { operationId: op.id, state: 'accepted', result: { terminalId: 'terminal', output: 'do not retain' } });
  reconcileOperation(op.id, { operationId: op.id, state: 'not_received' });
  expect(listOperations()[0]).toMatchObject({ state: 'accepted', terminalOwner, terminalResult: { terminalId: 'terminal' } });
  expect(JSON.stringify(listOperations())).not.toContain('do not retain');
  expect(() => reconcileOperation(op.id, { state: 'accepted', result: { terminalId: 'different' } })).toThrow('不同的终端');
  expect(listOperations()[0]?.terminalResult).toEqual({ terminalId: 'terminal' });
});
it('binds terminal recovery to the creating document and connection before making a read request', async () => {
  const api = new Api(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const operation = { operationId: crypto.randomUUID(), projectId: 'p', clientId: api.clientId, connectionId: 'lease-a' };
  await expect(api.recoverTerminal(operation, 'lease-b')).rejects.toThrow('已结束的连接');
  await expect(api.recoverTerminal({ ...operation, clientId: 'another-document' }, 'lease-a')).rejects.toThrow('已结束的连接');
  expect(fetch).not.toHaveBeenCalled();
});
it('requires the exact operation identity and a usable accepted terminal result', async () => {
  const api = new Api(), op = createOperation('terminal/open', { projectId: 'p', terminalOwner: { clientId: api.clientId, connectionId: 'lease' } });
  const operation = { operationId: op.id, projectId: 'p', clientId: api.clientId, connectionId: 'lease' };
  const fetch = vi.fn().mockResolvedValueOnce({ status: 200, json: async () => ({ ok: true, result: { operationId: 'other', method: 'terminal/open', state: 'accepted', result: { terminalId: 'wrong' } } }) }).mockResolvedValueOnce({ status: 200, json: async () => ({ ok: true, result: { operationId: op.id, method: 'terminal/open', state: 'accepted', result: {} } }) });
  vi.stubGlobal('fetch', fetch);
  await expect(api.recoverTerminal(operation, 'lease')).rejects.toThrow('身份不匹配');
  await expect(api.recoverTerminal(operation, 'lease')).rejects.toThrow('有效终端标识');
  expect(listOperations()[0]?.state).toBe('pending');
});
it('keeps unresolved opens exclusive within their lease while allowing a replacement lease to create its own terminal', () => {
  createOperation('terminal/open', { projectId: 'p', terminalOwner: { clientId: 'doc', connectionId: 'old' } });
  expect(() => createOperation('terminal/open', { projectId: 'p', terminalOwner: { clientId: 'doc', connectionId: 'old' } })).toThrow('待确认');
  expect(() => createOperation('terminal/open', { projectId: 'p', terminalOwner: { clientId: 'doc', connectionId: 'new' } })).not.toThrow();
});
