import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('a blocked launch cannot delay another run deadline stop', async () => {
    const f = setup(); await f.create(); f.advance(60_000); await f.scheduler.tick(); const first = f.ledger.automations.outstanding()[0]!;
    await f.command('automation/create', { spec: { ...f.spec, schedule: { kind: 'once', at: Date.parse('2026-01-01T00:02:00Z'), timeZone: 'UTC' } } as unknown as JsonValue }); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.behavior(async (method, _params, context) => {
      context.beforeWrite?.();
      if (method === 'conversation/start') { await gate; return { thread: { id: 'second', cwd: '/project' }, turn: { id: 'second-turn', status: 'inProgress' } }; }
      if (method === 'thread/history') return { turns: [{ id: 'turn', status: 'inProgress' }], complete: true, nextCursor: null };
      return {};
    });
    f.advance(60_000); const pending = f.scheduler.tick();
    try {
      await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'conversation/start')).toHaveLength(2));
      f.advance(600_000); const tick = f.scheduler.tick();
      await vi.waitFor(() => expect(f.calls.some(call => call.method === 'turn/interrupt')).toBe(true));
      expect(f.ledger.automations.getRun(first.id).stopSent).toBe(true); release(); await tick;
    } finally { release(); await pending; }
  });
  it('known not-sent stop failures retry only after cooldown without marking the run unknown', async () => {
    const f = setup(); await f.create(); f.advance(60_000); await f.scheduler.tick(); const run = f.ledger.automations.outstanding()[0]!;
    f.behavior(async (method, _params, context) => {
      if (method === 'turn/interrupt') throw new HarnessError('temporarily_busy', 'not sent');
      context.beforeWrite?.(); return { turns: [{ id: 'turn', status: 'inProgress' }], complete: true, nextCursor: null };
    });
    f.advance(600_000); await f.scheduler.tick(); await f.scheduler.tick();
    expect(f.ledger.automations.getRun(run.id)).toMatchObject({ state: 'running', stopRequested: true, stopSent: false });
    expect(f.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(1);
    f.advance(30_000); await f.scheduler.tick(); expect(f.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(2);
  });
  it('completion notifications reclaim both cooldowns after a definitively rejected stop', async () => {
    const f = setup(); await f.create(); f.advance(60_000); await f.scheduler.tick(); const run = f.ledger.automations.outstanding()[0]!;
    f.behavior(async method => {
      if (method === 'turn/interrupt') throw new HarnessError('temporarily_busy', 'not sent');
      return { turns: [{ id: 'turn', status: 'inProgress' }], complete: true, nextCursor: null };
    });
    f.scheduler.start(); f.advance(600_000); await f.scheduler.tick();
    expect(f.scheduler['nextRead'].has(run.id)).toBe(true); expect(f.scheduler['nextStop'].has(run.id)).toBe(true);
    f.dispatcher.emit('event', { type: 'notification', data: { method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed' } } } });
    expect(f.ledger.automations.getRun(run.id).state).toBe('completed');
    expect(f.scheduler['nextRead'].size).toBe(0); expect(f.scheduler['nextStop'].size).toBe(0); expect(f.leases.size).toBe(0);
    await f.scheduler.tick(); expect(f.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(1);
  });
  it.each(['not_sent', 'unknown'] as const)('completion wins a late %s stop and history response without leaking cooldowns or replaying', async delivery => {
    const f = setup(); await f.create(); f.advance(60_000); await f.scheduler.tick(); const run = f.ledger.automations.outstanding()[0]!;
    let releaseStop!: () => void, releaseRead!: () => void;
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve; }), readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    f.behavior(async (method, _params, context) => {
      if (method === 'turn/interrupt') { if (delivery === 'unknown') context.beforeWrite?.(); await stopGate; throw new HarnessError('delayed_stop', 'fixture failure', delivery); }
      if (method === 'thread/history') { await readGate; return { turns: [{ id: run.turnId, status: 'inProgress' }], complete: true, nextCursor: null }; }
      return {};
    });
    f.advance(600_000); f.scheduler.start(); const pending = f.scheduler.tick();
    try {
      await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(1));
      f.dispatcher.emit('event', { type: 'notification', data: { method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'interrupted' } } } });
      releaseStop(); releaseRead(); await pending;
      expect(f.ledger.automations.getRun(run.id).state).toBe('interrupted');
      expect(f.scheduler['nextRead'].size).toBe(0); expect(f.scheduler['nextStop'].size).toBe(0); expect(f.leases.size).toBe(0);
      await f.scheduler.tick(); expect(f.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(1); expect(f.calls.filter(call => call.method === 'conversation/start')).toHaveLength(1);
    } finally { releaseStop(); releaseRead(); await pending; }
  });
  it('unknown execution retains reconciliation cooldown until explicit confirmed closure, then survives record recycling', async () => {
    const f = setup(); const job = await f.create(); f.advance(60_000); await f.scheduler.tick(); const run = f.ledger.automations.outstanding()[0]!;
    f.behavior(async (method, _params, context) => {
      if (method === 'turn/interrupt') { context.beforeWrite?.(); throw new HarnessError('lost', 'unknown stop', 'unknown'); }
      return { turns: [{ id: run.turnId, status: 'inProgress' }], complete: true, nextCursor: null };
    });
    f.advance(600_000); await f.scheduler.tick();
    expect(f.ledger.automations.getRun(run.id).state).toBe('unknown'); expect(f.scheduler['nextRead'].has(run.id)).toBe(true);
    await f.scheduler.tick(); expect(f.scheduler['nextRead'].has(run.id)).toBe(true); expect(f.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(1);
    f.dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: true } } });
    await expect(f.command('automation/acknowledge', { runId: run.id, confirm: true })).rejects.toMatchObject({ code: 'activity_unknown' });
    f.dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
    f.ledger.setMeta('activityUncertain', 'false'); // Separate stop-confirmed recovery proof.
    await f.command('automation/acknowledge', { runId: run.id, confirm: true });
    for (let index = 0; index < 1000; index++) {
      const next = f.ledger.transaction(() => f.ledger.automations.command('automation/run', { id: job.id!, expectedRevision: 1 })) as JsonObject;
      f.ledger.transaction(() => f.ledger.automations.finish(String(next.runId), 'not_sent'));
    }
    expect(() => f.ledger.automations.getRun(run.id)).toThrow('运行记录不存在');
    await f.command('automation/remove', { id: job.id!, expectedRevision: 1 });
    f.worker.connected = false; await f.scheduler.tick();
    expect(f.scheduler['nextRead'].size).toBe(0); expect(f.scheduler['nextStop'].size).toBe(0);
  });
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

it('admits another repository while an earlier project start is suspended, without starting either twice', async () => {
  const f = setup(), second = f.ledger.addProject('/other', 'Other');
  await f.create(); await f.command('automation/create', { spec: { ...f.spec, projectId: second.id } as unknown as JsonValue });
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  f.behavior(async (method, params, context) => {
    if (method !== 'conversation/start') return {};
    context.beforeWrite?.();
    if (params.cwd === '/project') await first;
    return { thread: { id: params.cwd === '/project' ? 'first' : 'second', cwd: params.cwd! }, turn: { id: 'turn', status: 'inProgress' } };
  });
  f.advance(60_000); const ticking = f.scheduler.tick();
  try {
    await vi.waitFor(() => expect(f.ledger.automations.outstanding().some(row => row.threadId === 'second' && row.state === 'running')).toBe(true));
    expect(f.calls.filter(row => row.method === 'conversation/start')).toHaveLength(2);
  } finally { release(); await ticking; }
  await f.scheduler.tick(); expect(f.calls.filter(row => row.method === 'conversation/start')).toHaveLength(2);
});

it('restores pending approval when a stop is explicitly not sent', async () => {
  const f = setup(); await f.create(); f.advance(60_000); await f.scheduler.tick();
  const run = f.ledger.automations.outstanding()[0]!;
  f.ledger.automations.attention(run.threadId!);
  f.behavior(async method => {
    if (method === 'turn/interrupt') throw new HarnessError('busy', '请稍后再试', 'not_sent');
    return { turns: [{ id: run.turnId, status: 'inProgress' }], complete: true, nextCursor: null };
  });
  f.advance(600_000); await f.scheduler.tick();
  expect(f.ledger.automations.getRun(run.id)).toMatchObject({ state: 'needs_attention', stopRequested: true, stopSent: false });
});

it('honors an expired deadline after restart identifies the original running turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-recovered-deadline-')), file = join(dir, 'journal.sqlite');
  const f = setup(file); await f.create(); f.advance(60_000); await f.scheduler.tick();
  const original = f.ledger.automations.outstanding()[0]!;
  await cleanups.pop()!();
  const restored = setup(file, original.startedAt! + 601_000);
  const close = cleanups.pop()!; cleanups.push(async () => { await close(); rmSync(dir, { recursive: true }); });
  await restored.scheduler.tick(); await restored.scheduler.tick();
  expect(restored.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(1);
  expect(restored.calls.some(call => call.method === 'conversation/start')).toBe(false);
});

it('rolls back project removal, job pausing, queued cancellation and public events on receipt failure', async () => {
  const f = setup(), job = await f.create();
  const run = await f.command('automation/run', { id: job.id!, expectedRevision: 1 }) as JsonObject;
  const events = vi.fn(); f.dispatcher.on('automation-changed', events);
  const settle = f.ledger.settle.bind(f.ledger);
  f.ledger.settle = (id, result) => { if (result.ok) throw Error('simulated disk failure'); return settle(id, result); };
  const id = randomUUID();
  await expect(f.command('project/remove', { id: f.project.id }, id)).rejects.toMatchObject({ delivery: 'not_sent' });
  expect(f.ledger.project(f.project.id).id).toBe(f.project.id);
  expect(f.ledger.automations.get(String(job.id)).state).toBe('active');
  expect(f.ledger.automations.getRun(String(run.runId)).state).toBe('queued');
  expect(f.ledger.read(id)?.state).toBe('not_sent'); expect(events).not.toHaveBeenCalled();
});
