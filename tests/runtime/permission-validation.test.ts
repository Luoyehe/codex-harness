import { describe, expect, test } from 'vitest';
import { validatePrompt } from '../../src/runtime/validation.js';
import { DeliveryError, type JsonObject, type JsonValue } from '../../src/runtime/types.js';

const literal = (path: string): JsonObject => ({ type: 'path', path });
const glob = (pattern: string): JsonObject => ({ type: 'glob_pattern', pattern });
const special = (kind: string): JsonObject => ({ type: 'special', value: { kind } });
const rule = (path: JsonObject, access: string): JsonObject => ({ path, access });
const fs = (entries: JsonValue[], extra: JsonObject = {}): JsonObject => ({ entries, ...extra });
const profile = (fileSystem: JsonValue): JsonObject => ({ fileSystem });
const check = (requested: JsonObject, granted: JsonObject): void => validatePrompt('item/permissions/requestApproval', { permissions: requested }, { permissions: granted, scope: 'turn' });
const checkFs = (requested: JsonObject, granted: JsonObject): void => check(profile(requested), profile(granted));

describe('permission grant validation over JSON only', () => {
  test.each([literal('/project/private'), glob('/project/**/private'), special('tmpdir')])('retains each deny restriction while any positive grant remains: %j', deniedPath => {
    const allow = rule(literal('/project'), 'write'), deny = rule(deniedPath, 'deny');
    const requested = fs([allow, deny]);
    expect(() => checkFs(requested, fs([allow]))).toThrow(DeliveryError);
    expect(() => checkFs(requested, requested)).not.toThrow();
    expect(() => checkFs(requested, fs([rule(literal('/project'), 'read'), deny]))).not.toThrow();
  });

  test('retains read restrictions whenever any write remains, including unrelated-looking selectors', () => {
    const parent = rule(literal('/project'), 'write'), child = rule(literal('/project/reference'), 'read');
    const requested = fs([parent, child]);
    expect(() => checkFs(requested, fs([parent]))).toThrow(DeliveryError);
    expect(() => checkFs(requested, fs([parent, rule(child.path as JsonObject, 'deny')]))).not.toThrow();
    expect(() => checkFs(requested, fs([rule(parent.path as JsonObject, 'read')]))).not.toThrow();
    expect(() => checkFs(fs([parent, rule(special('project_roots'), 'read')]), fs([parent]))).toThrow(DeliveryError);
  });

  test('legacy read lists also constrain retained legacy writes', () => {
    const requested = { read: ['/project/reference'], write: ['/project'] };
    expect(() => checkFs(requested, { write: ['/project'] })).toThrow(DeliveryError);
    expect(() => checkFs(requested, requested)).not.toThrow();
    expect(() => checkFs({ write: ['/project'] }, { read: ['/project'] })).not.toThrow();
    expect(() => checkFs({ read: ['/project'] }, { write: ['/project'] })).toThrow(DeliveryError);
  });

  test.each([{}, { fileSystem: null }, profile({}), profile({ read: [], write: [] }), profile({ entries: [] })])('allows refusing all filesystem access: %j', granted => {
    check(profile(fs([rule(literal('/project'), 'write'), rule(literal('/project/private'), 'deny')], { globScanMaxDepth: 5 })), granted);
  });

  test('deny-only and depth-bearing responses still validate selectors, restrictions and depth', () => {
    const allow = rule(literal('/project'), 'write'), deny = rule(literal('/project/private'), 'deny');
    const requested = fs([allow, deny], { globScanMaxDepth: 5 });
    for (const granted of [fs([], { globScanMaxDepth: 1 }), fs([deny]), fs([deny], { globScanMaxDepth: 1 }), fs([rule(glob('/project/**'), 'deny')], { globScanMaxDepth: 5 })]) {
      expect(() => checkFs(requested, granted)).toThrow(DeliveryError);
    }
    expect(() => checkFs(requested, fs([deny], { globScanMaxDepth: 5 }))).not.toThrow();
    expect(() => checkFs(requested, fs([rule(literal('/project'), 'deny'), deny], { globScanMaxDepth: 5 }))).not.toThrow();
    expect(() => checkFs(fs([allow], { globScanMaxDepth: 5 }), fs([], { globScanMaxDepth: 5 }))).not.toThrow();
  });

  test('entries arrays override legacy projections on both sides, including empty arrays', () => {
    const allow = rule(literal('/project'), 'read');
    const requested = fs([allow], { read: ['/ignored'], write: ['/also-ignored'] });
    expect(() => checkFs(requested, fs([allow], { write: ['/ignored-projection'] }))).not.toThrow();
    expect(() => checkFs(requested, { read: ['/ignored'] })).toThrow(DeliveryError);
    expect(() => checkFs({ entries: [], read: ['/project'], write: ['/project'] }, { read: ['/project'] })).toThrow(DeliveryError);
    expect(() => checkFs({ read: ['/project'] }, { entries: [], write: ['/not-granted'] })).not.toThrow();
    expect(() => checkFs(requested, { entries: null, read: ['/project'] })).not.toThrow();
    expect(() => checkFs({ entries: null, read: ['/project'] }, fs([allow]))).not.toThrow();
  });

  test('matches selectors structurally without alias, case, traversal, or glob equivalence guesses', () => {
    const requested = fs([rule(literal('/project'), 'write')]);
    for (const path of [literal('/project/child'), literal('/project/../project'), literal('/PROJECT'), glob('/project'), special('project_roots')]) {
      expect(() => checkFs(requested, fs([rule(path, 'read')]))).toThrow(DeliveryError);
    }
    expect(() => checkFs(fs([rule(glob('/project/**'), 'write')]), fs([rule(glob('/project/*'), 'read')]))).toThrow(DeliveryError);
    expect(() => checkFs(fs([rule(special('tmpdir'), 'write')]), fs([rule(special('slash_tmp'), 'read')]))).toThrow(DeliveryError);
  });

  test('same-selector restrictions cannot be removed or replaced by a weaker mode', () => {
    const path = literal('/project'), write = rule(path, 'write'), read = rule(path, 'read'), deny = rule(path, 'deny');
    expect(() => checkFs(fs([write, deny]), fs([write]))).toThrow(DeliveryError);
    expect(() => checkFs(fs([write, deny]), fs([write, read]))).toThrow(DeliveryError);
    expect(() => checkFs(fs([write, read]), fs([write]))).toThrow(DeliveryError);
    expect(() => checkFs(fs([write, deny]), fs([read, deny]))).not.toThrow();
  });

  test('compares duplicate and reordered rules by selector and mode without losing restrictions', () => {
    const allow = rule(literal('/project'), 'write'), deny = rule(literal('/project/private'), 'deny');
    expect(() => checkFs(fs([allow, deny, deny]), fs([allow, deny]))).not.toThrow();
    expect(() => checkFs(fs([allow, deny, deny]), fs([allow, deny, deny]))).not.toThrow();
    expect(() => checkFs(fs([allow, deny]), fs([deny, allow]))).not.toThrow();
    expect(() => checkFs(fs([allow]), fs([allow, allow]))).not.toThrow();
    expect(() => checkFs(fs([allow, deny, deny]), fs([allow, allow]))).toThrow(DeliveryError);
  });

  test.each([literal('/project'), glob('/project/**'), special('project_roots')])('preserves any requested finite scan depth: %j', path => {
    const entries = [rule(path, 'read')];
    for (const depth of [undefined, null, 1, 4]) {
      expect(() => checkFs(fs(entries, { globScanMaxDepth: 3 }), fs(entries, depth === undefined ? {} : { globScanMaxDepth: depth }))).toThrow(DeliveryError);
    }
    expect(() => checkFs(fs(entries, { globScanMaxDepth: 3 }), fs(entries, { globScanMaxDepth: 3 }))).not.toThrow();
  });

  test.each([glob('/project/**'), special('project_roots')])('does not infer depth narrowing for nonliteral selectors: %j', path => {
    const entries = [rule(path, 'read')];
    expect(() => checkFs(fs(entries), fs(entries, { globScanMaxDepth: 1 }))).toThrow(DeliveryError);
    expect(() => checkFs(fs(entries, { globScanMaxDepth: null }), fs(entries))).not.toThrow();
  });

  test('does not add an unrequested scan depth even to literal legacy reads', () => {
    expect(() => checkFs({ read: ['/project'] }, { read: ['/project'], globScanMaxDepth: 1 })).toThrow(DeliveryError);
    expect(() => checkFs({ read: ['/project'], globScanMaxDepth: null }, { read: ['/project'], globScanMaxDepth: 1 })).toThrow(DeliveryError);
    expect(() => checkFs({ read: ['/project'], globScanMaxDepth: 1 }, { read: ['/project'], globScanMaxDepth: 1 })).not.toThrow();
    expect(() => checkFs({ read: ['/project'], globScanMaxDepth: null }, { read: ['/project'] })).not.toThrow();
    expect(() => checkFs({ read: ['/project'] }, { read: ['/project'], globScanMaxDepth: null })).not.toThrow();
    expect(() => checkFs({ read: ['/project'] }, { read: ['/project'], globScanMaxDepth: 0 })).toThrow(DeliveryError);
  });

  test('network grants are explicit and cannot borrow filesystem authorization', () => {
    for (const requested of [{}, { network: null }, { network: {} }, { network: { enabled: null } }, { network: { enabled: false } }]) {
      expect(() => check(requested, { network: { enabled: true } })).toThrow(DeliveryError);
      expect(() => check(requested, { network: { enabled: false } })).not.toThrow();
    }
    expect(() => check({ network: { enabled: true } }, { network: { enabled: true } })).not.toThrow();
    expect(() => check({}, { fileSystem: { read: ['/project'] } })).toThrow(DeliveryError);
  });

  test('validates request shape and refuses unrecognized permission fields at every known layer', () => {
    const malformed: JsonObject[] = [
      { fileSystem: { read: ['/project'], entries: 'bad' } },
      { fileSystem: { entries: [rule(literal('/project'), 'execute')] } },
      { fileSystem: { read: ['/project'], globScanMaxDepth: 0 } },
      { fileSystem: { read: [17] } },
      { network: { enabled: 'true' } },
    ];
    for (const requested of malformed) expect(() => check(requested, {})).toThrow(DeliveryError);
    const unknown: JsonObject[] = [
      { extra: true }, { network: { enabled: true, extra: true } },
      { fileSystem: { read: ['/project'], extra: true } },
      profile(fs([{ ...rule(literal('/project'), 'read'), extra: true }])),
      profile(fs([rule({ ...literal('/project'), extra: true }, 'read')])),
      profile(fs([rule({ type: 'special', value: { kind: 'tmpdir', extra: true } }, 'read')])),
    ];
    for (const requested of unknown) expect(() => check(requested, requested)).toThrow(DeliveryError);
  });

  test('comparison does not rewrite the response or its legacy projections', () => {
    const requested = profile(fs([rule(literal('/project'), 'read')], { read: ['/old-projection'] }));
    const granted = profile(fs([rule({ path: '/project', type: 'path' }, 'read')], { read: ['/different-projection'] }));
    const response = { permissions: granted, scope: 'turn' }, before = JSON.stringify(response);
    expect(() => validatePrompt('item/permissions/requestApproval', { permissions: requested }, response)).not.toThrow();
    expect(JSON.stringify(response)).toBe(before);
  });

  test('schema-valid unknown request details do not prevent a complete empty refusal', () => {
    const requested = { network: { enabled: true, futureNetworkField: true }, fileSystem: { entries: [{ ...rule(literal('/project'), 'write'), futureRuleField: true }], futureFileSystemField: true } };
    expect(() => check(requested, {})).not.toThrow();
    expect(() => check(requested, { network: { enabled: false }, fileSystem: { entries: [] } })).not.toThrow();
    expect(() => check(requested, { network: { enabled: true } })).toThrow(DeliveryError);
    expect(() => check(requested, { fileSystem: { entries: [], futureFileSystemField: true } })).toThrow(DeliveryError);
  });

  test('only interprets requested categories actually selected while rejecting every unknown response field', () => {
    const knownFileSystem = { read: ['/project'] }, knownNetwork = { enabled: true };
    const unknownNetwork = { enabled: true, futureNetworkField: true }, unknownFileSystem = { read: ['/project'], futureFileSystemField: true };
    expect(() => check({ network: unknownNetwork, fileSystem: knownFileSystem }, { fileSystem: knownFileSystem })).not.toThrow();
    expect(() => check({ network: knownNetwork, fileSystem: unknownFileSystem }, { network: knownNetwork })).not.toThrow();
    expect(() => check({ network: unknownNetwork, fileSystem: knownFileSystem }, { network: { enabled: false }, fileSystem: knownFileSystem })).not.toThrow();
    expect(() => check({ network: knownNetwork, fileSystem: unknownFileSystem }, { network: knownNetwork, fileSystem: { entries: [] } })).not.toThrow();
    expect(() => check({ fileSystem: knownFileSystem }, { network: { enabled: false, futureNetworkField: true }, fileSystem: knownFileSystem })).toThrow(DeliveryError);
    expect(() => check({ network: knownNetwork }, { network: knownNetwork, fileSystem: { entries: [], futureFileSystemField: true } })).toThrow(DeliveryError);
  });

  test.each([{}, { scope: 'session' }, { strictAutoReview: true }, { strictAutoReview: false }, { strictAutoReview: null }])('retains official response metadata compatibility: %j', metadata => {
    const permissions = { fileSystem: { read: ['/project'] } };
    expect(() => validatePrompt('item/permissions/requestApproval', { permissions }, { permissions, ...metadata })).not.toThrow();
  });
});
