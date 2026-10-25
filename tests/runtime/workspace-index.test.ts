import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { workspaceMutations, workspaceRequest } from '../../src/runtime/workspace.js';

const root = { path: '/project' };
const context = { clientId: 'fixture', operationId: randomUUID() };
const versions = { expectedHead: null, expectedHeadRevision: 'a'.repeat(64), expectedIndexRevision: 'b'.repeat(64) };

test('stage snapshots a bounded explicit file selection and requires both repository and file versions', () => {
  const files = [{ path: 'src/file', expectedRevision: 'c'.repeat(64), deleted: false }];
  const request = workspaceRequest(root, 'git/stage', { ...versions, files }, context);
  files[0]!.path = 'later';
  expect(request).toMatchObject({ params: { files: [{ path: 'src/file' }] }, operationId: context.operationId });
  for (const choices of [[], [{ path: '../escape', expectedRevision: 'c'.repeat(64), deleted: false }], [{ path: 'file', deleted: true, expectedRevision: 'c'.repeat(64) }], [{ path: 'file', deleted: false }], Array(33).fill({ path: 'file', deleted: true, expectedRevision: null })]) expect(() => workspaceRequest(root, 'git/stage', { ...versions, files: choices }, context)).toThrow();
  expect(() => workspaceRequest(root, 'git/stage', { ...versions, files: [{ path: 'file', deleted: true, expectedRevision: null }], all: true }, context)).toThrow();
});

test('unstage and index recovery never accept shell arguments, metadata paths or missing source revisions', () => {
  expect(workspaceMutations.has('git/unstage')).toBe(true);
  expect(() => workspaceRequest(root, 'git/unstage', { ...versions, paths: ['.git/index'] }, context)).toThrow();
  const source = randomUUID();
  const params = { ...versions, recoveryOperationId: source, slot: 'before', sourceRevision: 'c'.repeat(64) };
  expect(workspaceRequest(root, 'git/index/recovery/restore', params, context)).toMatchObject({ params, operationId: context.operationId });
  for (const changed of [{ sourceRevision: 'invalid' }, { slot: 'config' }, { root: '/other' }]) expect(() => workspaceRequest(root, 'git/index/recovery/restore', { ...params, ...changed }, context)).toThrow();
  expect(() => workspaceRequest(root, 'git/index/recovery/discard', { recoveryOperationId: source, expectedManifest: 'a'.repeat(64), confirm: false }, context)).toThrow();
});

test('index recovery reads never carry a mutation id and mutations require one', () => {
  const source = randomUUID();
  expect(workspaceRequest(root, 'git/index/recovery/read', { operationId: source }, context)).not.toHaveProperty('operationId');
  expect(() => workspaceRequest(root, 'git/unstage', { ...versions, paths: ['a'] }, { clientId: 'fixture' })).toThrow();
});
