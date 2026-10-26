import { expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WorkspaceWitness } from '../../src/runtime/workspace-witness.js';
import { canonical, object } from '../../src/runtime/types.js';

function fixture() {
  const root = path.resolve('.work/workspace-witness-tests'); mkdirSync(root, { recursive: true }); const home = mkdtempSync(path.join(root, 'case-'));
  const operationId = randomUUID(), projectId = randomUUID(); const context = { clientId: 'c', operationId, projectId, gatewayRequestDigest: 'a'.repeat(64) };
  const request = { version: 1, root: '/project', action: 'write', params: { path: 'file.txt', text: 'private file contents', expectedRevision: null }, operationId };
  const result = { path: 'file.txt', revision: 'b'.repeat(64), bytes: Buffer.byteLength(request.params.text), recoveryOperationId: operationId };
  return { home, context, request, result };
}
test('workspace witness persists a positive acknowledgement across restart without storing file contents', () => {
  const { home, context, request, result } = fixture(); let witness = new WorkspaceWitness(home);
  witness.reserve('workspace/write', request, context); expect(witness.read({ operationId: context.operationId })).toMatchObject({ state: 'unknown' });
  expect(witness.complete('workspace/write', request, { ...result, secret: 'never-persist' }, context)).toEqual(result); witness.close();
  witness = new WorkspaceWitness(home);
  try {
    const proof = witness.read({ operationId: context.operationId }); expect(proof).toMatchObject({ state: 'completed', gatewayRequestDigest: context.gatewayRequestDigest, projectId: context.projectId, method: 'workspace/write', root: '/project', result });
    const { operationId: _id, ...body } = request; expect(object(proof).helperRequestDigest).toBe(createHash('sha256').update(canonical(body)).digest('hex'));
    expect(JSON.stringify(proof)).not.toContain('private file contents'); expect(JSON.stringify(proof)).not.toContain('never-persist');
  } finally { witness.close(); }
  expect(readFileSync(path.join(home, 'workspace-witness', 'witness.sqlite')).includes(Buffer.from('private file contents'))).toBe(false);
});

test('accepted proofs recycle only after matching gateway acknowledgement and successful native cleanup', async () => {
  const { home, context, request, result } = fixture(); const witness = new WorkspaceWitness(home);
  try {
    witness.reserve('workspace/write', request, context); witness.complete('workspace/write', request, result, context);
    const ack = object((witness.pending({}).data as import('../../src/runtime/types.js').JsonValue[])[0]);
    expect(ack).toMatchObject({ operationId: context.operationId, projectId: context.projectId, gatewayRequestDigest: context.gatewayRequestDigest });
    expect(JSON.stringify(ack)).not.toContain('file.txt');
    for (const change of [{ method: 'workspace/remove' }, { projectId: randomUUID() }, { gatewayRequestDigest: 'f'.repeat(64) }, { resultDigest: 'f'.repeat(64) }]) {
      await expect(witness.acknowledge({ ...ack, ...change }, async () => { throw new Error('must not run'); })).rejects.toMatchObject({ code: 'operation_conflict' });
    }
    await expect(witness.acknowledge(ack, async () => { throw new Error('helper unavailable'); })).rejects.toThrow('helper unavailable');
    expect(witness.usage().total).toBe(1);
    const cleaned: string[][] = [];
    expect(await witness.acknowledge(ack, async (...args) => { cleaned.push(args); })).toMatchObject({ acknowledged: true, removed: true });
    const { operationId: _id, ...body } = request;
    expect(cleaned).toEqual([['/project', context.operationId, createHash('sha256').update(canonical(body)).digest('hex')]]);
    expect(witness.usage()).toEqual({ total: 0, unresolved: 0, limit: 2000 });
    expect(await witness.acknowledge(ack, async () => { throw new Error('already cleaned'); })).toMatchObject({ acknowledged: true, removed: false });
  } finally { witness.close(); }
});

test('unknown proofs cannot be acknowledged or omitted from unresolved capacity accounting', async () => {
  const { home, context, request } = fixture(); const witness = new WorkspaceWitness(home);
  try {
    witness.reserve('workspace/write', request, context);
    expect(witness.pending({})).toEqual({ data: [], nextCursor: null });
    await expect(witness.acknowledge({ operationId: context.operationId, method: 'workspace/write', projectId: context.projectId, gatewayRequestDigest: context.gatewayRequestDigest, resultDigest: 'a'.repeat(64) }, async () => {})).rejects.toMatchObject({ code: 'operation_conflict' });
    expect(witness.usage()).toEqual({ total: 1, unresolved: 1, limit: 2000 });
  } finally { witness.close(); }
});

test('completed witness pagination remains complete while earlier pages are acknowledged', async () => {
  const first = fixture(), witness = new WorkspaceWitness(first.home);
  try {
    for (let index = 0; index < 70; index++) {
      const operationId = randomUUID(), context = { ...first.context, operationId }, request = { ...first.request, operationId };
      witness.reserve('workspace/write', request, context); witness.complete('workspace/write', request, { ...first.result, recoveryOperationId: operationId }, context);
    }
    let after: string | null = null, total = 0;
    do {
      const page = witness.pending(after ? { after, limit: 8 } : { limit: 8 });
      for (const ack of page.data as import('../../src/runtime/types.js').JsonValue[]) { await witness.acknowledge(object(ack), async () => {}); total++; }
      after = page.nextCursor as string | null;
    } while (after);
    expect(total).toBe(70); expect(witness.usage().total).toBe(0);
  } finally { witness.close(); }
});

test('definitive native not_sent reclaims only its own unresolved reservation', () => {
  const { home, context, request, result } = fixture(); const witness = new WorkspaceWitness(home);
  try {
    witness.reserve('workspace/write', request, context);
    witness.discardNotSent('workspace/write', request, { ...context, projectId: randomUUID() });
    expect(witness.usage().total).toBe(1);
    witness.discardNotSent('workspace/write', request, context); expect(witness.usage().total).toBe(0);
    witness.reserve('workspace/write', request, context); witness.complete('workspace/write', request, result, context);
    witness.discardNotSent('workspace/write', request, context); expect(witness.read({ operationId: context.operationId })).toMatchObject({ state: 'completed' });
  } finally { witness.close(); }
});

test('acknowledged ordinary operations can exceed the lifetime witness capacity', async () => {
  const first = fixture(), witness = new WorkspaceWitness(first.home);
  try {
    for (let index = 0; index < 2005; index++) {
      const operationId = randomUUID(), context = { ...first.context, operationId }, request = { ...first.request, operationId };
      witness.reserve('workspace/write', request, context); witness.complete('workspace/write', request, { ...first.result, recoveryOperationId: operationId }, context);
      const ack = object((witness.pending({}).data as import('../../src/runtime/types.js').JsonValue[])[0]);
      await witness.acknowledge(ack, async () => {});
    }
    expect(witness.usage().total).toBe(0);
  } finally { witness.close(); }
}, 30000);
test('missing or incomplete witnesses never adopt a native recovery record or authorize a replay', () => {
  const { home, context, request } = fixture(); const witness = new WorkspaceWitness(home);
  try {
    expect(witness.read({ operationId: context.operationId })).toEqual({ operationId: context.operationId, state: 'not_received' });
    witness.reserve('workspace/write', request, context);
    expect(() => witness.reserve('workspace/write', request, context)).toThrow(expect.objectContaining({ code: 'operation_unknown', delivery: 'unknown' }));
    expect(witness.read({ operationId: context.operationId })).toMatchObject({ state: 'unknown' });
    expect(() => witness.reserve('workspace/write', request, { ...context, gatewayRequestDigest: 'c'.repeat(64) })).toThrow(expect.objectContaining({ code: 'operation_conflict' }));
  } finally { witness.close(); }
});
test('workspace success must match the path, operation and written byte count', () => {
  for (const changed of [{ path: 'other.txt' }, { recoveryOperationId: randomUUID() }, { bytes: 1 }]) {
    const { home, context, request, result } = fixture(); const witness = new WorkspaceWitness(home);
    try { witness.reserve('workspace/write', request, context); expect(() => witness.complete('workspace/write', request, { ...result, ...changed }, context)).toThrow(expect.objectContaining({ delivery: 'unknown' })); expect(witness.read({ operationId: context.operationId })).toMatchObject({ state: 'unknown' }); }
    finally { witness.close(); }
  }
});
test('completion cannot change the reserved project, root, helper request or gateway identity', () => {
  for (const change of ['project', 'root', 'params', 'operation', 'method', 'gateway']) {
    const { home, context, request, result } = fixture(); const witness = new WorkspaceWitness(home);
    try {
      witness.reserve('workspace/write', request, context);
      const changedRequest = { ...request, ...(change === 'root' ? { root: '/other' } : {}), ...(change === 'params' ? { params: { ...request.params, expectedRevision: 'c'.repeat(64) } } : {}), ...(change === 'operation' ? { operationId: randomUUID() } : {}) };
      const changedContext = { ...context, ...(change === 'project' ? { projectId: randomUUID() } : {}), ...(change === 'gateway' ? { gatewayRequestDigest: 'c'.repeat(64) } : {}) };
      expect(() => witness.complete(change === 'method' ? 'workspace/copy' : 'workspace/write', changedRequest, result, changedContext)).toThrow(expect.objectContaining({ delivery: 'unknown' }));
      expect(witness.read({ operationId: context.operationId })).toMatchObject({ state: 'unknown' });
    } finally { witness.close(); }
  }
});
test('restore proof binds both the source operation and the new mutation identity', () => {
  for (const changed of [{}, { path: 'other' }, { restoredFromOperationId: randomUUID() }, { recoveryOperationId: randomUUID() }]) {
    const { home, context } = fixture(); const witness = new WorkspaceWitness(home); const source = randomUUID();
    const request = { version: 1, root: '/project', action: 'recovery/restore', params: { recoveryOperationId: source, slot: 'before', path: 'restored', sourceRevision: 'a'.repeat(64), expectedRevision: null }, operationId: context.operationId };
    const result = { path: 'restored', kind: 'file', revision: 'b'.repeat(64), bytes: 1, restoredFromOperationId: source, recoveryOperationId: context.operationId };
    try {
      witness.reserve('workspace/recovery/restore', request, context);
      if (!Object.keys(changed).length) expect(witness.complete('workspace/recovery/restore', request, result, context)).toEqual(result);
      else expect(() => witness.complete('workspace/recovery/restore', request, { ...result, ...changed }, context)).toThrow(expect.objectContaining({ delivery: 'unknown' }));
    } finally { witness.close(); }
  }
});
test('discard proof matches the source operation and persists no path or payload', () => {
  const { home, context } = fixture(); const witness = new WorkspaceWitness(home); const source = randomUUID();
  const request = { version: 1, root: '/project', action: 'recovery/discard', params: { recoveryOperationId: source, expectedManifest: 'a'.repeat(64), confirm: true }, operationId: context.operationId };
  try {
    witness.reserve('workspace/recovery/discard', request, context);
    expect(() => witness.complete('workspace/recovery/discard', request, { recoveryOperationId: context.operationId, discarded: true, receiptRetained: true }, context)).toThrow(expect.objectContaining({ delivery: 'unknown' }));
    expect(witness.complete('workspace/recovery/discard', request, { recoveryOperationId: source, discarded: true, receiptRetained: true, path: 'private', contents: 'private' }, context)).toEqual({ recoveryOperationId: source, discarded: true, receiptRetained: true });
  } finally { witness.close(); }
});
test('Git commit proof binds the original HEAD, index version and durable operation without retaining its message', () => {
  const { home, context } = fixture(); const witness = new WorkspaceWitness(home);
  const request = { version: 1, root: '/project', action: 'git/commit', params: { expectedHead: null, expectedHeadRevision: 'a'.repeat(64), expectedIndexRevision: 'b'.repeat(64), author: { name: 'Fixture', email: 'fixture@example.test' }, message: 'private commit body' }, operationId: context.operationId };
  const result = { commitId: 'c'.repeat(40), previousHead: null, indexRevision: 'b'.repeat(64), recoveryOperationId: context.operationId };
  try {
    witness.reserve('workspace/git/commit', request, context);
    for (const changed of [{ previousHead: 'e'.repeat(40) }, { indexRevision: 'f'.repeat(64) }, { recoveryOperationId: randomUUID() }, { commitId: 'invalid' }]) expect(() => witness.complete('workspace/git/commit', request, { ...result, ...changed }, context)).toThrow();
    expect(witness.complete('workspace/git/commit', request, { ...result, message: 'private commit body' }, context)).toEqual(result);
    expect(JSON.stringify(witness.read({ operationId: context.operationId }))).not.toContain('private commit body');
  } finally { witness.close(); }
});
test('index changes require the exact path ordering and both original index and HEAD identity', () => {
  for (const action of ['git/stage', 'git/unstage']) {
    const { home, context } = fixture(); const witness = new WorkspaceWitness(home), paths = ['private-a', 'private-b'];
    const request = { version: 1, root: '/project', action, params: { expectedHead: null, expectedHeadRevision: 'a'.repeat(64), expectedIndexRevision: 'b'.repeat(64), ...(action === 'git/stage' ? { files: paths.map(path => ({ path, expectedRevision: 'c'.repeat(64), deleted: false })) } : { paths }) }, operationId: context.operationId };
    const result = { head: null, indexRevision: 'd'.repeat(64), previousIndexRevision: 'b'.repeat(64), recoveryOperationId: context.operationId, pathsDigest: createHash('sha256').update(canonical(paths)).digest('hex'), selectedCount: 2 };
    try {
      witness.reserve('workspace/' + action, request, context);
      for (const changed of [{ head: 'e'.repeat(40) }, { previousIndexRevision: 'f'.repeat(64) }, { recoveryOperationId: randomUUID() }, { pathsDigest: createHash('sha256').update(canonical([...paths].reverse())).digest('hex') }, { selectedCount: 1 }]) expect(() => witness.complete('workspace/' + action, request, { ...result, ...changed }, context)).toThrow();
      expect(witness.complete('workspace/' + action, request, { ...result, paths }, context)).toEqual(result); expect(JSON.stringify(witness.read({ operationId: context.operationId }))).not.toContain('private-a');
    } finally { witness.close(); }
  }
});
test('index restore and discard retain exact recovery source without trusting its filesystem journal', () => {
  for (const action of ['git/index/recovery/restore', 'git/index/recovery/discard']) {
    const { home, context } = fixture(); const witness = new WorkspaceWitness(home), source = randomUUID();
    const request = { version: 1, root: '/project', action, params: { recoveryOperationId: source, expectedHead: null, expectedHeadRevision: 'a'.repeat(64), expectedIndexRevision: 'b'.repeat(64), slot: 'before', sourceRevision: 'c'.repeat(64), expectedManifest: 'd'.repeat(64), confirm: true }, operationId: context.operationId };
    const result = action.endsWith('/restore') ? { head: null, indexRevision: 'd'.repeat(64), previousIndexRevision: 'b'.repeat(64), recoveryOperationId: context.operationId, restoredFromOperationId: source } : { recoveryOperationId: source, discarded: true, receiptRetained: true };
    try {
      witness.reserve('workspace/' + action, request, context);
      expect(() => witness.complete('workspace/' + action, request, { ...result, ...(action.endsWith('/restore') ? { restoredFromOperationId: randomUUID() } : { recoveryOperationId: randomUUID() }) }, context)).toThrow();
      expect(witness.complete('workspace/' + action, request, result, context)).toEqual(result);
    } finally { witness.close(); }
  }
});
