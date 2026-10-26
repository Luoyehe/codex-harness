import { describe, expect, test } from 'vitest';
import { ThreadActivity } from '../../src/runtime/thread-activity.js';

describe('thread activity lifetime', () => {
  test('historical metadata is bounded and evicts the least recently used idle entry', () => {
    const removed: string[] = [];
    const registry = new ThreadActivity(() => false, id => removed.push(id), 2);
    registry.track('a').status = 'idle'; registry.track('b').status = 'idle';
    registry.track('a'); registry.track('c');
    expect([...registry].map(([id]) => id)).toEqual(['a', 'c']);
    expect(removed).toEqual(['b']);
  });

  test.each(['pending', 'unknown', 'goalActive', 'queued', 'checkingContinuation', 'subscribed'] as const)(
    'never evicts a thread protected by %s', flag => {
      const registry = new ThreadActivity(() => false, () => {}, 1);
      registry.track('active')[flag] = true;
      expect(() => registry.track('other')).toThrow(expect.objectContaining({ code: 'activity_capacity', delivery: 'not_sent' }));
      expect(registry.track('active')[flag]).toBe(true);
    },
  );

  test('an accepted turn stays protected even when idle metadata arrives before its completion', () => {
    const registry = new ThreadActivity(() => false, () => {}, 1);
    const state = registry.track('active'); state.turnId = 'turn'; state.status = 'idle';
    expect(() => registry.track('other')).toThrow(expect.objectContaining({ code: 'activity_capacity' }));
    state.turnId = null;
    expect(() => registry.track('other')).not.toThrow();
  });

  test('read leases prevent an ABA replacement while a native response is pending', async () => {
    const registry = new ThreadActivity(() => false, () => {}, 1);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reading = registry.read('a', async state => {
      await gate;
      expect(registry.track('a')).toBe(state);
      expect(state.revision).toBe(1);
      state.status = 'idle';
    });
    registry.track('a').revision++;
    expect(() => registry.track('b')).toThrow(expect.objectContaining({ code: 'activity_capacity' }));
    release(); await reading;
    expect(() => registry.track('b')).not.toThrow();
  });

  test('a failed absent-thread read releases its slot and never makes other work unknown', async () => {
    const registry = new ThreadActivity(() => false, () => {}, 1);
    await expect(registry.read('missing', async () => { throw Error('missing'); })).rejects.toThrow('missing');
    expect(registry.size).toBe(0);
    expect(registry.track('other').unknown).toBe(false);
  });
  test('successful notLoaded reads retain their state until ordinary capacity eviction', async () => {
    const removed: string[] = [], registry = new ThreadActivity(() => false, id => removed.push(id), 1);
    const state = await registry.read('cold', async current => current);
    expect(state.status).toBe('notLoaded'); expect(registry.track('cold')).toBe(state); expect(removed).toEqual([]);
    registry.track('next'); expect(removed).toEqual(['cold']);
  });
  test('a failed concurrent cold read cannot revoke the state of a successful read', async () => {
    const removed: string[] = [], registry = new ThreadActivity(() => false, id => removed.push(id), 1);
    let reject!: (error: Error) => void;
    const failing = registry.read('cold', async () => new Promise((_resolve, failed) => { reject = failed; }));
    const failure = expect(failing).rejects.toThrow('transient');
    const state = await registry.read('cold', async current => current);
    reject(Error('transient')); await failure;
    expect(registry.track('cold')).toBe(state); expect(removed).toEqual([]);
  });
});
