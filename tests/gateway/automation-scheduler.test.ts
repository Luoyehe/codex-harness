import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../src/core/ledger.js';
import type { AutomationSpec } from '../../src/core/automations.js';
import type { CallContext, JsonObject, JsonValue } from '../../src/core/contracts.js';
import { HarnessError } from '../../src/core/errors.js';
import { Dispatcher } from '../../src/gateway/dispatch.js';
import { AutomationScheduler } from '../../src/gateway/automation-scheduler.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function setup(file = ':memory:', initialTime = Date.parse('2026-01-01T00:00:00Z')) {
  let time = initialTime; const ledger = new Ledger(file, () => time); ledger.recover();
  const leases = new Set<string>(); const calls: { method: string; params: JsonObject; clientId: string }[] = []; let turnState = 'inProgress';
  let behavior: ((method: string, params: JsonObject, context: CallContext) => Promise<JsonValue>) | undefined;
  const worker = {
    connected: true,
    clientConnected: async (id: string) => { leases.add(id); }, clientDisconnected: async (id: string) => { leases.delete(id); },
    call: async (method: string, params: JsonObject, context: CallContext): Promise<JsonValue> => {
      calls.push({ method, params, clientId: context.clientId });
      if (behavior) return behavior(method, params, context);
      context.beforeWrite?.();
      if (method === 'conversation/start') { expect(leases.has(context.clientId)).toBe(true); return { thread: { id: 'thread', cwd: '/project' }, turn: { id: 'turn', status: 'inProgress' } }; }
      if (method === 'thread/history') return { turns: [{ id: 'turn', status: turnState }], nextCursor: null, complete: true };
      if (method === 'turn/interrupt') { turnState = 'interrupted'; return {}; }
      return {};
    },
  };
  const dispatcher = new Dispatcher(ledger, worker, { call: async () => ({}) });
  dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, subscriptions: 0, unknown: false } } });
  const scheduler = new AutomationScheduler(ledger, dispatcher, worker, () => time);
  const project = ledger.addProject('/project', 'Project');
  const spec: AutomationSpec = { name: 'Check', projectId: project.id, text: 'Check the workspace', options: {}, schedule: { kind: 'interval', hours: 1, anchor: time + 60_000, timeZone: 'UTC' }, maxRunMinutes: 10 };
  const command = (method: string, params: JsonObject, operationId = randomUUID()) => dispatcher.call({ method, params, operationId }, { clientId: 'browser', requireConnection: () => {} });
  const create = async () => (await command('automation/create', { spec: spec as unknown as JsonValue })) as JsonObject;
  cleanups.push(async () => { await scheduler.close(); ledger.close(); });
  return { ledger, worker, dispatcher, scheduler, project, spec, command, create, calls, leases, advance: (ms: number) => { time += ms; }, terminal: (status: string) => { turnState = status; }, behavior: (run: typeof behavior) => { behavior = run; } };
}
describe('durable bounded automation execution', () => {
  it('atomically saves definitions and receipt, replays without duplicate schedules and detects stale revisions', async () => {
    const f = setup(), operationId = randomUUID();
    const first = await f.command('automation/create', { spec: f.spec as unknown as JsonValue }, operationId);
    expect(await f.command('automation/create', { spec: f.spec as unknown as JsonValue }, operationId)).toEqual(first);
    const { id } = first as JsonObject;
    expect(f.ledger.automations.read('automation/list', {})).toMatchObject({ data: [{ id, revision: 1 }] });
    expect(await f.command('automation/pause', { id: id!, expectedRevision: 1 })).toMatchObject({ revision: 2, state: 'paused' });
    await expect(f.command('automation/resume', { id: id!, expectedRevision: 1 })).rejects.toMatchObject({ code: 'automation_conflict', delivery: 'not_sent' });
    expect(f.calls.filter(call => call.method === 'conversation/start')).toHaveLength(0);
  });
  it('rolls back local changes if receipt persistence fails and refuses plans for removed projects', async () => {
    const f = setup(); const original = f.ledger.settle.bind(f.ledger);
    f.ledger.settle = (id, result) => { if (result.ok) throw new Error('disk failure'); return original(id, result); };
    const op = randomUUID(); await expect(f.command('automation/create', { spec: f.spec as unknown as JsonValue }, op)).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(f.ledger.automations.read('automation/list', {})).toEqual({ data: [] }); expect(f.ledger.read(op)?.state).toBe('not_sent');
    f.ledger.settle = original; f.ledger.removeProject(f.project.id);
    await expect(f.create()).rejects.toMatchObject({ code: 'project_missing' });
  });
  it('uses a registered owner and original dispatch receipt, then resolves matching terminal history without restarting work', async () => {
    const f = setup(), job = await f.create(); f.advance(60_000); await f.scheduler.tick();
    const current = f.ledger.automations.outstanding()[0]!; expect(current).toMatchObject({ state: 'running', threadId: 'thread', turnId: 'turn' });
    expect(f.ledger.read(current.operationId)?.state).toBe('accepted'); expect(f.leases.size).toBe(1);
    f.terminal('completed'); f.advance(30_000); await f.scheduler.tick();
    expect(f.ledger.automations.getRun(current.id).state).toBe('completed'); expect(f.leases.size).toBe(0);
    expect(f.calls.filter(call => call.method === 'conversation/start')).toHaveLength(1);
    expect(f.ledger.automations.get(String(job.id)).nextAt).toBe(Date.parse('2026-01-01T01:01:00Z'));
  });
  it('dispatches the due weekly run and an unrelated job once while advancing past a nonexistent DST occurrence', async () => {
    const firstDue = Date.parse('2026-03-01T07:30:00Z'), nextDue = Date.parse('2026-03-15T06:30:00Z');
    const f = setup(':memory:', firstDue - 60_000);
    f.spec.schedule = { kind: 'weekly', days: [0], time: '02:30', timeZone: 'America/New_York' }; f.spec.text = 'Weekly run';
    const weekly = await f.create();
    const unrelated = await f.command('automation/create', { spec: { ...f.spec, text: 'Unrelated run', schedule: { kind: 'once', at: firstDue, timeZone: 'UTC' } } as unknown as JsonValue }) as JsonObject;
    f.behavior(async (method, params, context) => {
      context.beforeWrite?.();
      if (method === 'workspace/witness/pending') return { data: [], nextCursor: null };
      if (method === 'conversation/start') {
        expect(f.leases.has(context.clientId)).toBe(true);
        const id = params.text === 'Weekly run' ? 'weekly' : 'unrelated';
        return { thread: { id, cwd: '/project' }, turn: { id: id + '-turn', status: 'completed' } };
      }
      throw new Error('Unexpected scheduler call: ' + method);
    });
    const starts = () => f.calls.filter(call => call.method === 'conversation/start');
    f.advance(60_000); await f.scheduler.tick();
    expect(starts().map(call => call.params.text).sort()).toEqual(['Unrelated run', 'Weekly run']);
    expect(f.ledger.automations.get(String(weekly.id)).nextAt).toBe(nextDue);
    expect(f.ledger.automations.get(String(unrelated.id))).toMatchObject({ state: 'paused', nextAt: null });
    const runs = [weekly, unrelated].map(job => (f.ledger.automations.read('automation/runs', { id: job.id! }) as JsonObject).data as JsonObject[]);
    for (const entries of runs) {
      expect(entries).toHaveLength(1); expect(entries[0]).toMatchObject({ state: 'completed', scheduledAt: firstDue });
      expect(f.ledger.read(String(entries[0]!.operationId))?.state).toBe('accepted');
    }
    await f.scheduler.tick(); expect(starts()).toHaveLength(2);
    expect([weekly, unrelated].map(job => (f.ledger.automations.read('automation/runs', { id: job.id! }) as JsonObject).data)).toEqual(runs);
    const skippedWeek = Date.parse('2026-03-08T07:30:00Z');
    f.advance(skippedWeek - firstDue); await f.scheduler.tick(); expect(starts()).toHaveLength(2);
    f.advance(nextDue - skippedWeek); await f.scheduler.tick(); await f.scheduler.tick();
    expect(starts()).toHaveLength(3); expect(starts()[2]!.params.text).toBe('Weekly run');
    const subsequent = (f.ledger.automations.read('automation/runs', { id: weekly.id! }) as JsonObject).data as JsonObject[];
    expect(subsequent).toHaveLength(2); expect(subsequent[0]).toMatchObject({ state: 'completed', scheduledAt: nextDue });
    expect(subsequent[0]!.operationId).not.toBe(runs[0]![0]!.operationId);
    expect(f.ledger.automations.get(String(weekly.id)).nextAt).toBe(Date.parse('2026-03-22T06:30:00Z'));
  });
  it('records missed schedules without backfill and freezes queued specifications across edits', async () => {
    const f = setup(), job = await f.create(); f.advance(600_000); await f.scheduler.tick();
    expect(f.ledger.automations.read('automation/runs', { id: job.id! })).toMatchObject({ data: [{ state: 'skipped', code: 'missed_window' }] });
    const queued = await f.command('automation/run', { id: job.id!, expectedRevision: 1 }) as JsonObject;
    await f.command('automation/update', { id: job.id!, expectedRevision: 1, spec: { ...f.spec, text: 'new content' } as unknown as JsonValue });
    await f.scheduler.tick(); expect(f.calls.find(call => call.method === 'conversation/start')?.params.text).toBe('Check the workspace');
    await expect(f.command('automation/run', { id: job.id!, expectedRevision: 2 })).rejects.toMatchObject({ code: 'automation_busy' });
    expect(f.ledger.automations.getRun(String(queued.runId)).state).toBe('running');
  });
  it('never replays a lost dispatch and requires confirmed idle recovery before explicitly closing an unknown run', async () => {
    const f = setup(); await f.create(); f.advance(60_000);
    f.behavior(async (method, _params, context) => { context.beforeWrite?.(); if (method === 'conversation/start') throw new HarnessError('lost', 'response lost', 'unknown'); return {}; });
    await f.scheduler.tick(); const run = f.ledger.automations.outstanding()[0]!; expect(run.state).toBe('unknown');
    await f.scheduler.tick(); expect(f.calls.filter(call => call.method === 'conversation/start')).toHaveLength(1);
    await expect(f.command('automation/acknowledge', { runId: run.id, confirm: true })).rejects.toMatchObject({ code: 'activity_unknown' });
    f.ledger.setMeta('activityUncertain', 'false'); // Represents the separate manager's stop-confirmed recovery.
    await f.command('automation/acknowledge', { runId: run.id, confirm: true });
    expect(f.ledger.automations.getRun(run.id).state).toBe('closed_unknown'); expect(f.ledger.read(run.operationId)?.state).toBe('unknown');
  });
  it('interrupts once at the run deadline and waits for terminal evidence', async () => {
    const f = setup(); await f.create(); f.advance(60_000); await f.scheduler.tick(); const run = f.ledger.automations.outstanding()[0]!;
    f.advance(600_000); await f.scheduler.tick(); await f.scheduler.tick();
    expect(f.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(1);
    expect(f.ledger.automations.getRun(run.id)).toMatchObject({ state: 'interrupted', stopRequested: true, stopSent: true });
  });
  it('retains stable run IDs on gateway restart and positively recovers an accepted receipt without a new start', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'harness-scheduler-')), file = join(directory, 'journal.sqlite');
    const f = setup(file); await f.create(); f.advance(60_000); await f.scheduler.tick(); const run = f.ledger.automations.outstanding()[0]!;
    await cleanups.pop()!();
    const next = setup(file); expect(next.ledger.automations.getRun(run.id).state).toBe('unknown');
    next.terminal('completed'); await next.scheduler.tick();
    expect(next.ledger.automations.getRun(run.id)).toMatchObject({ id: run.id, operationId: run.operationId, state: 'completed' });
    expect(next.calls.filter(call => call.method === 'conversation/start')).toHaveLength(0);
    const close = cleanups.pop()!; cleanups.push(async () => { await close(); rmSync(directory, { recursive: true }); });
  });
});
