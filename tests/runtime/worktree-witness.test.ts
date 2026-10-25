import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { WorkspaceWitness } from '../../src/runtime/workspace-witness.js';
import { object } from '../../src/runtime/types.js';
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
