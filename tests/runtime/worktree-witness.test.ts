import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { WorkspaceWitness } from '../../src/runtime/workspace-witness.js';
import { object, type JsonValue } from '../../src/runtime/types.js';
function setup() {
  const parent = path.resolve('.work/worktree-witness-tests'); mkdirSync(parent, { recursive: true }); const home = mkdtempSync(path.join(parent, 'case-'));
  const id = randomUUID(), projectId = randomUUID(), context = { clientId: 'owner', operationId: id, projectId, gatewayRequestDigest: 'c'.repeat(64) };
  const request = { version: 1, root: '/origin', action: 'worktree/create', params: { ref: 'HEAD' }, operationId: id };
  const binding = { version: 1, worktreeId: id, originRoot: '/origin', commonDir: '/origin/.git', commonDevice: 1, commonInode: 2, gitDir: '/origin/.git/worktrees/' + id, gitDirDevice: 1, gitDirInode: 3, worktreeDevice: 1, worktreeInode: 4 };
  const result = { worktreeId: id, phase: 'active', path: '/native/worktrees/' + id, head: 'a'.repeat(40), revision: 'b'.repeat(64), binding, created: true };
  return { home, id, projectId, context, request, binding, result, witness: new WorkspaceWitness(home, '/native') };
}
test('only live create proof establishes a private binding and no binding reaches public receipts', () => {
  const f = setup();
  try {
    expect(() => f.witness.worktreeBinding(f.id, '/origin')).toThrow();
    f.witness.reserve('workspace/worktree/create', f.request, f.context);
    expect(() => f.witness.worktreeBinding(f.id, '/origin')).toThrow();
    const result = f.witness.complete('workspace/worktree/create', f.request, f.result, f.context);
    expect(result).toMatchObject({ created: true, worktreeVersion: 1 }); expect(result).not.toHaveProperty('binding');
    expect(f.witness.worktreeBinding(f.id, '/origin')).toEqual(f.binding);
    expect(() => f.witness.worktreeBinding(f.id, '/other')).toThrow();
    expect(f.witness.read({ operationId: f.id })).not.toHaveProperty('binding');
  } finally { f.witness.close(); }
});
test('failed path, owner or receipt validation atomically rolls back binding and proof', () => {
  for (const change of [{ path: '/unrelated' }, { head: 'invalid' }, { binding: { commonInode: -1 } }, { worktreeId: randomUUID() }]) {
    const f = setup();
    try {
      f.witness.reserve('workspace/worktree/create', f.request, f.context);
      expect(() => f.witness.complete('workspace/worktree/create', f.request, { ...f.result, ...change }, f.context)).toThrow();
      expect(f.witness.read({ operationId: f.id })).toMatchObject({ state: 'unknown' });
      expect(() => f.witness.worktreeBinding(f.id, '/origin')).toThrow();
      expect(f.witness.complete('workspace/worktree/create', f.request, f.result, f.context)).toMatchObject({ worktreeVersion: 1 });
    } finally { f.witness.close(); }
  }
});
test('binding and increasing generations survive restart; changed inode cannot be adopted', () => {
  const f = setup(); f.witness.reserve('workspace/worktree/create', f.request, f.context); f.witness.complete('workspace/worktree/create', f.request, f.result, f.context); f.witness.close();
  const witness = new WorkspaceWitness(f.home, '/native');
  try {
    const operationId = randomUUID(), context = { ...f.context, operationId };
    const request = { ...f.request, action: 'worktree/archive', params: { worktreeId: f.id, expectedRevision: f.result.revision, confirm: true }, binding: f.binding, operationId };
    const result = { ...f.result, created: false, archived: true, phase: 'archived', path: '/native/worktree-state/' + f.id + '/checkout' };
    witness.reserve('workspace/worktree/archive', request, context);
    expect(() => witness.complete('workspace/worktree/archive', request, { ...result, binding: { ...f.binding, worktreeInode: 5 } }, context)).toThrow();
    expect(witness.complete('workspace/worktree/archive', request, result, context)).toMatchObject({ worktreeVersion: 2 });
    expect(object(witness.read({ operationId })).state).toBe('completed');
  } finally { witness.close(); }
});

test('shared worktree capacity rejects before dispatch after changing native home, even after all creation receipts are acknowledged', async () => {
  const f = setup(); let witness = f.witness;
  try {
    for (let index = 0; index < 32; index++) {
      const id = randomUUID(), context = { ...f.context, operationId: id }, request = { ...f.request, operationId: id };
      const result = { ...f.result, worktreeId: id, path: '/native/worktrees/' + id,
        binding: { ...f.binding, worktreeId: id, gitDir: '/origin/.git/worktrees/' + id } };
      witness.reserve('workspace/worktree/create', request, context);
      witness.complete('workspace/worktree/create', request, result, context);
      for (const ack of witness.pending({}).data as JsonValue[]) await witness.acknowledge(object(ack), async () => {});
    }
    expect(witness.usage().total).toBe(0);
    witness.close(); witness = new WorkspaceWitness(f.home, '/native-root');
    const id = randomUUID(), context = { ...f.context, operationId: id, projectId: randomUUID() }, request = { ...f.request, root: '/root-project', operationId: id };
    expect(() => witness.reserve('workspace/worktree/create', request, context)).toThrow(expect.objectContaining({ code: 'capacity', delivery: 'not_sent' }));
    expect(witness.read({ operationId: id })).toMatchObject({ state: 'not_received' });
    expect(witness.usage().total).toBe(0);
    // Exhausting retained worktree slots does not disable ordinary file work.
    const write = { ...request, action: 'write', params: { path: 'file.txt', text: 'content', expectedRevision: null } };
    expect(() => witness.reserve('workspace/write', write, context)).not.toThrow();
    witness.discardNotSent('workspace/write', write, context);
  } finally { witness.close(); }
});

test('unconfirmed creations reserve binding capacity; exact not_sent cleanup releases only its own slot', () => {
  const f = setup(), reservations = [];
  try {
    for (let index = 0; index < 32; index++) {
      const id = randomUUID(), context = { ...f.context, operationId: id }, request = { ...f.request, operationId: id };
      f.witness.reserve('workspace/worktree/create', request, context); reservations.push({ context, request });
    }
    const first = reservations[0]!;
    expect(() => f.witness.reserve('workspace/worktree/create', first.request, first.context)).toThrow(expect.objectContaining({ code: 'operation_unknown', delivery: 'unknown' }));
    const id = randomUUID(), context = { ...f.context, operationId: id }, request = { ...f.request, operationId: id };
    expect(() => f.witness.reserve('workspace/worktree/create', request, context)).toThrow(expect.objectContaining({ code: 'capacity', delivery: 'not_sent' }));
    f.witness.discardNotSent('workspace/worktree/create', first.request, { ...first.context, projectId: randomUUID() });
    expect(() => f.witness.reserve('workspace/worktree/create', request, context)).toThrow(expect.objectContaining({ code: 'capacity' }));
    f.witness.discardNotSent('workspace/worktree/create', first.request, first.context);
    expect(() => f.witness.reserve('workspace/worktree/create', request, context)).not.toThrow();
    expect(f.witness.usage()).toMatchObject({ total: 32, unresolved: 32 });
  } finally { f.witness.close(); }
});
