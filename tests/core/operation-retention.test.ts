import { afterEach, expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../src/core/ledger.js';
import { operationId } from '../../src/core/operation-retention.js';
import type { JsonObject } from '../../src/core/contracts.js';

const opened: Ledger[] = [];
const directories: string[] = [];
function ledger(now?: () => number) { const result = new Ledger(':memory:', now); opened.push(result); return result; }
function preview(value: Ledger) { return value.maintenancePreview() as JsonObject; }
function rotate(value: Ledger, source = preview(value)) {
  return value.rotate({ digest: String(source.digest), exportedDigest: String(source.digest), nextGeneration: Number(source.nextGeneration) });
}
function accept(value: Ledger, id = value.newOperationId()) {
  value.reserve(id, 'thread/start', {}, 'project'); value.dispatch(id); value.settle(id, { ok: true, value: { threadId: 'accepted' } }); return id;
}
afterEach(() => { for (const item of opened.splice(0)) item.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test('export remains a stable complete snapshot while new receipts arrive; stale rotation changes nothing', () => {
  const value = ledger(), first = accept(value), retired = randomUUID(); value.retire(retired);
  const source = preview(value), parts: Buffer[] = []; let offset: number | null = 0;
  const second = accept(value);
  while (offset !== null) {
    const chunk = value.maintenanceChunk({ digest: String(source.digest), offset, limit: 37 }) as JsonObject;
    parts.push(Buffer.from(String(chunk.base64), 'base64')); offset = chunk.nextOffset as number | null;
  }
  const bytes = Buffer.concat(parts), archive = JSON.parse(bytes.toString());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.digest);
  expect(archive.receipts.map((row: { id: string }) => row.id)).toEqual([first]);
  expect(archive.retiredOperations.map((row: { id: string }) => row.id)).toEqual([retired]);
  expect(() => rotate(value, source)).toThrow(expect.objectContaining({ code: 'journal_changed' }));
  expect(value.read(second)?.state).toBe('accepted'); expect(value.operationGeneration()).toBe(0);
});

test('rotation fences legacy, past and future IDs and keeps project metadata', () => {
  const value = ledger(), id = accept(value), retired = randomUUID(); value.retire(retired); value.setMeta('custom', 'keep');
  const source = preview(value), result = rotate(value, source);
  expect(value.operationGeneration()).toBe(1); expect(value.getMeta('custom')).toBe('keep');
  expect(preview(value).lastRotation).toEqual(result);
  for (const stale of [id, retired, randomUUID(), operationId(2)]) {
    expect(value.read(stale)).toMatchObject({ state: 'unknown', error: { code: 'operation_archived', delivery: 'unknown' } });
    expect(value.retire(stale).state).toBe('unknown');
    expect(() => value.reserve(stale, 'thread/start', {}, 'project')).toThrow(expect.objectContaining({ code: 'operation_archived', delivery: 'unknown' }));
  }
  const current = value.newOperationId(); expect(current).toMatch(/^00000000-0001-8/); expect(value.read(current)).toBeNull(); accept(value, current);
  expect(() => rotate(value, source)).toThrow(expect.objectContaining({ code: 'journal_changed' }));
  rotate(value); expect(value.operationGeneration()).toBe(2); expect(value.read(current)?.state).toBe('unknown');
});

test.each(['pending', 'dispatching', 'unknown', 'global'] as const)('refuses rotation while %s uncertainty exists', state => {
  const value = ledger(), id = value.newOperationId();
  if (state === 'global') value.setMeta('activityUncertain', 'true');
  else {
    value.reserve(id, 'turn/start', {}, 'thread');
    if (state !== 'pending') value.dispatch(id);
    if (state === 'unknown') value.settle(id, { ok: false, error: { code: 'lost', message: 'lost', delivery: 'unknown' } });
  }
  const source = preview(value); expect(source.blocked).not.toEqual([]);
  expect(() => rotate(value, source)).toThrow(expect.objectContaining({ code: 'journal_busy' })); expect(value.operationGeneration()).toBe(0);
});

test('initial fenced prefix never collides with a previously accepted v8 generation', () => {
  const value = ledger(); accept(value, operationId(42)); expect(preview(value).nextGeneration).toBe(43); rotate(value); expect(value.newOperationId()).toMatch(/^00000000-002b-8/);
});

test('fencing and rotation success proof survive reopening the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'operation-retention-')); directories.push(directory);
  const file = join(directory, 'journal.sqlite'); let value = new Ledger(file); const id = accept(value); const result = rotate(value); value.close();
  value = new Ledger(file); opened.push(value);
  expect(value.read(id)?.state).toBe('unknown'); expect(preview(value).lastRotation).toEqual(result);
  expect(() => value.reserve(id, 'thread/start', {}, 'project')).toThrow(expect.objectContaining({ code: 'operation_archived' }));
  expect(value.newOperationId()).toMatch(/^00000000-0001-8/);
});

test('export cache expires and only retains the most recently prepared snapshot', () => {
  let now = 0; const value = ledger(() => now), source = preview(value);
  now = 600_001; expect(() => value.maintenanceChunk({ digest: String(source.digest), offset: 0 })).toThrow(expect.objectContaining({ code: 'journal_changed' }));
  const fresh = preview(value); accept(value); preview(value);
  expect(() => value.maintenanceChunk({ digest: String(fresh.digest), offset: 0 })).toThrow(expect.objectContaining({ code: 'journal_changed' }));
});

test('automation dispatch IDs follow the active generation and queued work blocks maintenance', () => {
  const value = ledger(() => 1_700_000_000_000); rotate(value);
  const job = value.automations.command('automation/create', { enabled: false, spec: { name: 'test', text: 'test', projectId: randomUUID(), options: {}, schedule: { kind: 'once', at: 1_700_000_100_000, timeZone: 'UTC' }, maxRunMinutes: 1 } }) as JsonObject;
  const run = value.automations.command('automation/run', { id: job.id!, expectedRevision: job.revision! }) as JsonObject;
  expect(run.operationId).toMatch(/^00000000-0001-8/);
  expect(preview(value).blocked).toContain('unresolved_automation_runs');
  expect(() => rotate(value)).toThrow(expect.objectContaining({ code: 'journal_busy' }));
});
