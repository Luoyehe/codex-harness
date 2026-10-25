import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Ledger } from '../../src/core/ledger.js';
import { canonical } from '../../src/core/validation.js';
import { Budget } from '../../src/core/budget.js';

describe('durable operation invariants', () => {
  it('durably fences a not-yet-registered request without changing any existing operation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'harness-fence-')); const file = join(directory, 'journal.sqlite');
    let ledger = new Ledger(file); const absent = randomUUID(), pending = randomUUID(), unknown = randomUUID();
    try {
      expect(ledger.retire(absent).state).toBe('not_sent');
      ledger.reserve(pending, 'turn/start', {}, 't'); expect(ledger.retire(pending).state).toBe('pending');
      ledger.reserve(unknown, 'turn/start', {}, 'other'); ledger.dispatch(unknown);
      ledger.settle(unknown, { ok: false, error: { code: 'lost', message: 'lost', delivery: 'unknown' } });
      expect(ledger.retire(unknown).state).toBe('unknown');
      ledger.close(); ledger = new Ledger(file); ledger.recover();
      expect(ledger.read(absent)).toMatchObject({ state: 'not_sent', error: { code: 'operation_retired' } });
      expect(() => ledger.reserve(absent, 'turn/start', { text: 'late' }, 't')).toThrow(expect.objectContaining({ code: 'operation_retired', delivery: 'not_sent' }));
    } finally { ledger.close(); rmSync(directory, { recursive: true }); }
  });
  it('distinguishes never dispatched from uncertain dispatch after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'harness-ledger-'));
    const path = join(directory, 'journal.sqlite');
    let ledger = new Ledger(path); const before = randomUUID(); const after = randomUUID();
    try {
      ledger.reserve(before, 'turn/start', { text: 'one' }, 'a');
      ledger.reserve(after, 'turn/start', { text: 'two' }, 'b'); ledger.dispatch(after);
      ledger.close(); ledger = new Ledger(path);
      expect(ledger.recover()).toEqual({ unknown: 1, notSent: 1 });
      expect(ledger.read(before)?.state).toBe('not_sent'); expect(ledger.read(after)?.state).toBe('unknown');
      expect(ledger.getMeta('activityUncertain')).toBe('true');
      expect(ledger.reserve(after, 'turn/start', { text: 'two' }, 'b').created).toBe(false);
    } finally { ledger.close(); rmSync(directory, { recursive: true }); }
  });
  it('rejects changed content, but recognizes reordered object keys', () => {
    const ledger = new Ledger(':memory:'); const id = randomUUID();
    try {
      ledger.reserve(id, 'turn/start', { a: 1, b: 2 }, 't');
      expect(ledger.reserve(id, 'turn/start', { b: 2, a: 1 }, 't').created).toBe(false);
      expect(() => ledger.reserve(id, 'turn/start', { a: 2, b: 1 }, 't')).toThrow('不同内容');
      expect(() => ledger.reserve(id, 'turn/start', { a: 1, b: 2 }, 'other')).toThrow('不同内容');
    } finally { ledger.close(); }
  });
  it('replays accepted results without resetting them, including after restart', () => {
    const ledger = new Ledger(':memory:'); const id = randomUUID();
    try {
      ledger.reserve(id, 'thread/start', {}, 'project'); ledger.dispatch(id);
      ledger.settle(id, { ok: true, value: { thread: { id: 'saved-thread' } } });
      ledger.recover();
      expect(ledger.reserve(id, 'thread/start', {}, 'project').receipt.result).toEqual({ thread: { id: 'saved-thread' } });
      expect(() => ledger.settle(id, { ok: false, error: { code: 'late', message: 'late', delivery: 'not_sent' } })).toThrow();
    } finally { ledger.close(); }
  });
  it('not_received observations create no tombstone or permission to replay', () => {
    const ledger = new Ledger(':memory:'); const id = randomUUID();
    try { expect(ledger.read(id)).toBe(null); ledger.reserve(id, 'turn/start', {}, 't'); expect(ledger.read(id)?.state).toBe('pending'); }
    finally { ledger.close(); }
  });
  it('maps an excessive post-dispatch result to unknown instead of not_sent', () => {
    const ledger = new Ledger(':memory:'); const id = randomUUID();
    try {
      ledger.reserve(id, 'thread/start', {}, 'p'); ledger.dispatch(id);
      expect(ledger.settle(id, { ok: true, value: 'x'.repeat(2 * 1024 * 1024) }).state).toBe('unknown');
    } finally { ledger.close(); }
  });
  it('retains own __proto__ keys and array order; rejects invalid Unicode', () => {
    expect(canonical(JSON.parse('{"__proto__":{"a":1},"b":2}'))).toContain('"__proto__"');
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
    expect(() => canonical({ text: '\ud800' })).toThrow();
  });
  it('charges retained bytes until settlement and releases only once', () => {
    const budget = new Budget(2, 10); const first = budget.acquire(8);
    expect(() => budget.acquire(3)).toThrow(); const second = budget.acquire(2);
    expect(() => budget.acquire(0)).toThrow(); first(); first();
    expect(budget.usage).toEqual({ count: 1, bytes: 2 }); second();
    expect(budget.usage).toEqual({ count: 0, bytes: 0 });
  });
  it('charges incremental bodies without reserving the maximum size for every small request', () => {
    const budget = new Budget(3, 10); const first = budget.reserve(), second = budget.reserve();
    first.add(3); second.add(4); expect(budget.usage).toEqual({ count: 2, bytes: 7 });
    expect(() => first.add(4)).toThrow(); expect(budget.usage.bytes).toBe(7);
    first.release(); first.release(); second.add(6);
    expect(budget.usage).toEqual({ count: 1, bytes: 10 }); second.release();
    expect(budget.usage).toEqual({ count: 0, bytes: 0 }); expect(() => first.add(1)).toThrow();
  });
});
