import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Automations } from '../../src/core/automations.js';
import type { JsonObject } from '../../src/core/contracts.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const now = 1_700_000_000_000;
  const jobs = new Automations(db, () => now);
  const spec = { name: 'Retention fixture', text: 'Local-only check', projectId: randomUUID(), options: {}, schedule: { kind: 'once', at: now + 60_000, timeZone: 'UTC' }, maxRunMinutes: 1 };
  const create = () => jobs.command('automation/create', { enabled: false, spec }) as JsonObject;
  const remove = (job: JsonObject) => jobs.command('automation/remove', { id: job.id!, expectedRevision: job.revision! });
  return { db, jobs, now, create, remove };
}

it('bounds persistent plan rows across repeated creation and removal', () => {
  const f = fixture();
  try {
    for (let count = 0; count < 1025; count++) f.remove(f.create());
    expect(f.jobs.read('automation/list', {})).toEqual({ data: [] });
    expect(f.db.prepare('SELECT count(*) AS count FROM automations').get()!.count).toBe(0);
    expect(f.create().revision).toBe(1);
  } finally { f.db.close(); }
});

it('retains run results and rejects removal while a run outcome remains unknown', () => {
  const f = fixture();
  try {
    const job = f.create();
    const run = f.jobs.command('automation/run', { id: job.id!, expectedRevision: job.revision! }) as JsonObject;
    f.jobs.claim(String(run.runId)); f.jobs.recover();
    expect(() => f.remove(job)).toThrow('请先结束或核对');
    f.jobs.command('automation/acknowledge', { runId: run.runId!, confirm: true });
    f.remove(job);
    expect(f.jobs.getRun(String(run.runId)).state).toBe('closed_unknown');
    expect(() => f.jobs.get(String(job.id))).toThrow('计划已移除');
  } finally { f.db.close(); }
});

it('reclaims legacy removed plans on reopen while preserving unresolved run associations', () => {
  const f = fixture();
  try {
    const old = f.create(), unresolved = f.create();
    const run = f.jobs.command('automation/run', { id: unresolved.id!, expectedRevision: unresolved.revision! }) as JsonObject;
    f.jobs.claim(String(run.runId)); f.jobs.recover();
    // Simulate retained rows from the prior storage format, including an
    // inconsistent legacy association that must not lose unknown-run evidence.
    f.db.prepare("UPDATE automations SET state='removed' WHERE id IN (?,?)").run(String(old.id), String(unresolved.id));
    const reopened = new Automations(f.db, () => f.now);
    expect(f.db.prepare('SELECT id FROM automations ORDER BY id').all()).toEqual([{ id: unresolved.id }]);
    expect(reopened.getRun(String(run.runId)).state).toBe('unknown');
    reopened.command('automation/acknowledge', { runId: run.runId!, confirm: true });
    new Automations(f.db, () => f.now);
    expect(f.db.prepare('SELECT count(*) AS count FROM automations').get()!.count).toBe(0);
    expect(reopened.getRun(String(run.runId)).state).toBe('closed_unknown');
  } finally { f.db.close(); }
});
