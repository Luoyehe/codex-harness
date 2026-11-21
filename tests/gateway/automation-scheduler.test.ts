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
      if (method === 'thread/history') return { threadId: params.threadId!, turns: [{ id: 'turn', status: turnState }], nextCursor: null, complete: true };
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
      if (method === 'thread/history') return { threadId: 'thread', turns: [{ id: 'turn', status: 'inProgress' }], complete: true, nextCursor: null };
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
  it.each([
    ['deadline', 'disconnect-first'], ['deadline', 'rejection-first'],
    ['manual', 'disconnect-first'], ['manual', 'rejection-first'],
  ])('retries a definitely unsent %s stop after %s only on fresh identity and after cooldown', async (trigger, order) => {
    const f = setup(); f.scheduler.start(); await f.create(); f.advance(60_000); await f.scheduler.tick();
    const run = f.ledger.automations.outstanding()[0]!;
    const gate = Promise.withResolvers<void>();
    let attempts = 0, delivered = 0;
    f.behavior(async (method, params) => {
      if (method === 'turn/interrupt') {
        attempts++;
        if (attempts === 1) { await gate.promise; throw new HarnessError('client_disconnected', 'lease revoked', 'not_sent'); }
        delivered++; return {};
      }
      return { threadId: params.threadId ?? null, turns: [{ id: run.turnId, status: 'inProgress' }], nextCursor: null };
    });
    f.advance(trigger === 'deadline' ? 600_000 : 31_000);
    if (trigger === 'manual') await f.command('automation/stop', { runId: run.id });
    const pending = f.scheduler.tick();
    try {
      await vi.waitFor(() => expect(attempts).toBe(1));
      expect(f.ledger.automations.getRun(run.id)).toMatchObject({ state: 'stopping', stopSent: true });
      const disconnect = () => { f.worker.connected = false; f.dispatcher.disconnected(); };
      if (order === 'disconnect-first') disconnect();
      f.advance(25_000); gate.resolve(); await pending;
      await vi.waitFor(() => expect(f.ledger.automations.getRun(run.id).stopSent).toBe(false));
      if (order === 'rejection-first') {
        expect(f.ledger.automations.getRun(run.id).state).toBe('running');
        disconnect();
      }
      expect(f.ledger.automations.getRun(run.id)).toMatchObject({ state: 'unknown', code: 'gateway_restarted', stopRequested: true, stopSent: false });
      await expect(f.command('automation/stop', { runId: run.id })).rejects.toMatchObject({ code: 'operation_unknown' });
      f.worker.connected = true; f.advance(5000); await f.scheduler.tick();
      expect(f.ledger.automations.getRun(run.id)).toMatchObject({ state: 'running', stopSent: false });
      expect(attempts).toBe(1);
      f.advance(24_999); await f.scheduler.tick(); expect(attempts).toBe(1);
      f.advance(1); await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
      expect(f.ledger.automations.getRun(run.id)).toMatchObject({ state: 'stopping', stopSent: true });
      expect(attempts).toBe(2); expect(delivered).toBe(1);
      f.dispatcher.emit('event', { type: 'notification', data: { method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'interrupted' } } } });
      f.advance(31_000); await f.scheduler.tick();
      expect(f.ledger.automations.getRun(run.id).state).toBe('interrupted');
      expect(f.calls.filter(call => call.method === 'conversation/start')).toHaveLength(1);
      expect(attempts).toBe(2);
    } finally { gate.resolve(); await pending; }
  });
  it.each(['accepted', 'unknown', 'not_sent'])('preserves %s stop delivery after disconnect, exact live history and a gateway restart', async outcome => {
    const dir = mkdtempSync(join(tmpdir(), 'automation-stop-')), file = join(dir, 'journal.sqlite');
    const f = setup(file); f.scheduler.start(); await f.create(); f.advance(60_000); await f.scheduler.tick();
    const run = f.ledger.automations.outstanding()[0]!, gate = Promise.withResolvers<void>();
    f.behavior(async method => {
      if (method === 'turn/interrupt') {
        await gate.promise;
        if (outcome === 'unknown') throw new HarnessError('worker_lost', 'reply lost', 'unknown');
        if (outcome === 'not_sent') throw new HarnessError('client_disconnected', 'lease revoked', 'not_sent');
        return {};
      }
      return { threadId: run.threadId, turns: [{ id: run.turnId, status: 'inProgress' }], nextCursor: null };
    });
    f.advance(600_000); const pending = f.scheduler.tick();
    try {
      await vi.waitFor(() => expect(f.calls.some(call => call.method === 'turn/interrupt')).toBe(true));
      f.worker.connected = false; f.dispatcher.disconnected(); gate.resolve(); await pending;
      expect(f.ledger.automations.getRun(run.id)).toMatchObject({ state: 'unknown', stopSent: outcome !== 'not_sent' });
    } finally { gate.resolve(); await pending; }
    await cleanups.pop()!();
    const next = setup(file, run.scheduledAt + 650_000);
    const close = cleanups.pop()!; cleanups.push(async () => { await close(); rmSync(dir, { recursive: true }); });
    await next.scheduler.tick(); next.advance(31_000); await next.scheduler.tick();
    expect(next.ledger.automations.getRun(run.id)).toMatchObject({ state: outcome === 'not_sent' ? 'interrupted' : 'unknown', stopSent: true });
    next.terminal('interrupted'); next.advance(31_000); await next.scheduler.tick();
    expect(next.ledger.automations.getRun(run.id).state).toBe('interrupted');
    expect(next.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(outcome === 'not_sent' ? 1 : 0);
    expect(next.calls.filter(call => call.method === 'conversation/start')).toHaveLength(0);
  });
  it.each(['completed', 'closed_unknown'])('keeps %s immutable when a disconnected stop is later definitively rejected', async outcome => {
    const f = setup(); f.scheduler.start(); await f.create(); f.advance(60_000); await f.scheduler.tick();
    const run = f.ledger.automations.outstanding()[0]!, gate = Promise.withResolvers<void>();
    f.behavior(async method => {
      if (method === 'turn/interrupt') { await gate.promise; throw new HarnessError('client_disconnected', 'not delivered'); }
      return { threadId: run.threadId, turns: [], nextCursor: null };
    });
    f.advance(600_000); const pending = f.scheduler.tick();
    try {
      await vi.waitFor(() => expect(f.ledger.automations.getRun(run.id).state).toBe('stopping'));
      f.dispatcher.disconnected();
      f.dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
      if (outcome === 'completed') f.dispatcher.emit('event', { type: 'notification', data: { method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed' } } } });
      else await f.command('automation/acknowledge', { runId: run.id, confirm: true });
      const closed = f.ledger.automations.getRun(run.id);
      expect(closed.state).toBe(outcome); gate.resolve(); await pending;
      f.advance(31_000); await f.scheduler.tick();
      expect(f.ledger.automations.getRun(run.id)).toEqual(closed); expect(f.scheduler['nextStop'].size).toBe(0);
      expect(f.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(1);
    } finally { gate.resolve(); await pending; }
  });
  it('does not label an unconfirmed lease registration as an attempted interrupt', async () => {
    const f = setup(); f.scheduler.start(); await f.create(); f.advance(60_000); await f.scheduler.tick();
    const run = f.ledger.automations.outstanding()[0]!;
    const register = vi.spyOn(f.worker, 'clientConnected').mockRejectedValueOnce(new HarnessError('worker_lost', 'registration lost', 'unknown'));
    f.advance(600_000); const pending = f.scheduler.tick();
    f.dispatcher.disconnected(); await pending;
    expect(register).toHaveBeenCalled(); expect(f.ledger.automations.getRun(run.id)).toMatchObject({ state: 'unknown', code: 'gateway_restarted', stopSent: false });
    expect(f.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(0);
    f.advance(31_000); await f.scheduler.tick();
    expect(f.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(1);
  });
  it('requires a new exact active proof after disconnect before retrying an unsent stop', async () => {
    const f = setup(); f.scheduler.start(); await f.create(); f.advance(60_000); await f.scheduler.tick();
    const run = f.ledger.automations.outstanding()[0]!;
    f.ledger.transaction(() => f.ledger.automations.requestStop(run.id));
    f.dispatcher.disconnected();
    let answer = 'stale'; const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    f.behavior(async method => {
      if (method !== 'thread/history') return {};
      if (answer === 'stale') { entered.resolve(); await gate.promise; }
      return { threadId: answer === 'other-thread' ? 'other' : run.threadId,
        turns: answer === 'absent' ? [] : [{ id: answer === 'other-turn' ? 'other' : run.turnId, status: 'inProgress' }], nextCursor: null };
    });
    f.advance(31_000); const read = f.scheduler.tick();
    try {
      await entered.promise;
      f.dispatcher.disconnected(); gate.resolve(); await read;
      for (answer of ['other-thread', 'other-turn', 'absent']) {
        f.advance(31_000); await f.scheduler.tick();
        expect(f.ledger.automations.getRun(run.id)).toMatchObject({ state: 'unknown', stopSent: false });
      }
      expect(f.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(0);
      answer = 'exact'; f.advance(31_000); await f.scheduler.tick();
      expect(f.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(1);
    } finally { gate.resolve(); await read; }
  });
  it('known not-sent stop failures retry only after cooldown without marking the run unknown', async () => {
    const f = setup(); await f.create(); f.advance(60_000); await f.scheduler.tick(); const run = f.ledger.automations.outstanding()[0]!;
    f.behavior(async (method, _params, context) => {
      if (method === 'turn/interrupt') throw new HarnessError('temporarily_busy', 'not sent');
      context.beforeWrite?.(); return { threadId: 'thread', turns: [{ id: 'turn', status: 'inProgress' }], complete: true, nextCursor: null };
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
      return { threadId: 'thread', turns: [{ id: 'turn', status: 'inProgress' }], complete: true, nextCursor: null };
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
      if (method === 'thread/history') { await readGate; return { threadId: run.threadId, turns: [{ id: run.turnId, status: 'inProgress' }], complete: true, nextCursor: null }; }
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
      return { threadId: run.threadId, turns: [{ id: run.turnId, status: 'inProgress' }], complete: true, nextCursor: null };
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
  f.ledger.automations.setAttention(run.threadId!, run.turnId!, true);
  f.behavior(async method => {
    if (method === 'turn/interrupt') throw new HarnessError('busy', '请稍后再试', 'not_sent');
    return { threadId: run.threadId, turns: [{ id: run.turnId, status: 'inProgress' }], complete: true, nextCursor: null };
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

it.each([24, 25, 3500])('recovers the exact result past %i newer turns while new turns arrive, one page per tick', async newer => {
  const f = setup(), job = await f.create();
  f.advance(60_000); await f.scheduler.tick();
  const run = f.ledger.automations.outstanding()[0]!;
  f.ledger.automations.recover();
  const reads: (JsonValue | undefined)[] = [];
  let newest = newer;
  f.behavior(async (method, params, context) => {
    if (method === 'conversation/start') { context.beforeWrite?.(); return { thread: { id: 'next' }, turn: { id: 'next-turn', status: 'completed' } }; }
    if (method !== 'thread/history') return {};
    reads.push(params.cursor);
    expect(params).toMatchObject({ intent: 'turnStatus', threadId: run.threadId, turnId: run.turnId, limit: 25 });
    const first = params.cursor === undefined ? newest : Number(String(params.cursor).slice(6));
    newest += 25; // Newer work grows at least as quickly as the reader consumes it.
    const more = first >= 25;
    return { threadId: run.threadId, turns: more ? [] : [{ id: run.turnId, status: 'completed' }], nextCursor: more ? 'older:' + (first - 25) : null };
  });
  const pages = Math.floor(newer / 25) + 1;
  for (let i = 0; i < pages; i++) {
    f.advance(2000); await f.scheduler.tick(); await f.scheduler.tick();
    expect(reads).toHaveLength(i + 1);
    expect(f.leases.size).toBe(0);
  }
  expect(reads.filter(cursor => cursor === undefined)).toHaveLength(1);
  expect(f.ledger.automations.getRun(run.id).state).toBe('completed');
  expect(f.ledger.automationCursor(run.id)).toBeNull();
  f.advance(3_600_000 - pages * 2000); await f.scheduler.tick();
  const history = f.ledger.automations.read('automation/runs', { id: job.id! });
  expect(history).toMatchObject({ data: [{ state: 'completed', turnId: 'next-turn' }, { id: run.id, state: 'completed' }] });
  expect(f.calls.filter(call => call.method === 'conversation/start')).toHaveLength(2);
});

it('reopens an older run, preserves its native scan through another restart and transient failure, and keeps skipped occurrences', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'automation-scan-')), file = join(dir, 'journal.sqlite');
  const first = setup(file), job = await first.create();
  first.advance(60_000); await first.scheduler.tick();
  const run = first.ledger.automations.outstanding()[0]!, recycled = randomUUID();
  first.ledger.setAutomationCursor(recycled, 'orphaned-by-an-older-gateway');
  first.ledger.setMeta('unrelated', 'preserved');
  await cleanups.pop()!();
  const current = setup(file, run.scheduledAt + 3_600_000);
  expect(current.ledger.automationCursor(recycled)).toBeNull(); expect(current.ledger.getMeta('unrelated')).toBe('preserved');
  current.behavior(async () => ({ threadId: run.threadId, turns: [], nextCursor: 'native-page-two' }));
  await current.scheduler.tick(); // This occurrence was due while the old execution was unresolved.
  expect(current.ledger.automationCursor(run.id)).toBe('native-page-two');
  await cleanups.pop()!();
  const next = setup(file, run.scheduledAt + 3_600_000);
  const close = cleanups.pop()!; cleanups.push(async () => { await close(); rmSync(dir, { recursive: true }); });
  let attempts = 0;
  next.behavior(async (method, params, ctx) => {
    if (method === 'conversation/start') { ctx.beforeWrite?.(); return { thread: { id: 'next' }, turn: { id: 'new-turn', status: 'completed' } }; }
    if (method !== 'thread/history') return {};
    expect(params.cursor).toBe('native-page-two');
    if (!attempts++) throw new HarnessError('worker_unavailable', 'temporary failure');
    return { threadId: run.threadId, turns: [{ id: run.turnId, status: 'failed' }], nextCursor: null };
  });
  await next.scheduler.tick(); await next.scheduler.tick();
  expect(attempts).toBe(1); expect(next.ledger.automations.getRun(run.id).state).toBe('unknown');
  next.advance(30_000); await next.scheduler.tick();
  expect(next.ledger.automations.getRun(run.id).state).toBe('failed'); expect(next.ledger.automationCursor(run.id)).toBeNull();
  next.advance(3_570_000); await next.scheduler.tick();
  expect(next.ledger.automations.read('automation/runs', { id: job.id! })).toMatchObject({ data: [
    { state: 'completed', turnId: 'new-turn' }, { state: 'skipped', code: 'previous_run_unresolved' }, { id: run.id, state: 'failed' },
  ] });
  expect(next.calls.filter(call => call.method === 'conversation/start')).toHaveLength(1);
});

it('gives same-thread runs separate positions, and a blocked read cannot delay another result or duplicate a launch', async () => {
  const f = setup();
  for (const text of ['first', 'second']) await f.command('automation/create', { spec: { ...f.spec, text } as unknown as JsonValue });
  f.behavior(async (method, params, ctx) => {
    if (method !== 'conversation/start') return { threadId: params.threadId ?? null, turns: [{ id: params.turnId ?? null, status: 'inProgress' }], nextCursor: null };
    ctx.beforeWrite?.(); return { thread: { id: 'shared' }, turn: { id: params.text!, status: 'inProgress' } };
  });
  f.advance(60_000); await f.scheduler.tick(); f.ledger.automations.recover();
  const [first, second] = ['first', 'second'].map(id => f.ledger.automations.outstanding().find(run => run.turnId === id)!);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.behavior(async (method, params) => {
    if (method !== 'thread/history') return {};
    if (!params.cursor) return { threadId: 'shared', turns: [], nextCursor: 'older-' + params.turnId };
    if (params.turnId === 'first') await gate;
    expect(params.cursor).toBe('older-' + params.turnId);
    return { threadId: 'shared', turns: [{ id: params.turnId!, status: params.turnId === 'first' ? 'interrupted' : 'completed' }], nextCursor: null };
  });
  await f.scheduler.tick(); f.advance(2000);
  const waiting = f.scheduler.tick();
  try {
    await vi.waitFor(() => expect(f.ledger.automations.getRun(second!.id).state).toBe('completed'));
    f.advance(30_000); await f.scheduler.tick();
    expect(f.ledger.automations.getRun(first!.id).state).toBe('unknown');
    expect(f.calls.filter(call => call.params.cursor === 'older-first')).toHaveLength(1);
  } finally { release(); await waiting; }
  expect(f.ledger.automations.getRun(first!.id).state).toBe('interrupted');
  expect(f.leases.size).toBe(0); expect(f.calls.filter(call => call.method === 'conversation/start')).toHaveLength(2);
});

it('retains uncertain outcomes for unrelated, malformed or missing turns and backs off on invalid or cyclic positions', async () => {
  const f = setup(); await f.create(); f.advance(60_000); await f.scheduler.tick();
  const run = f.ledger.automations.outstanding()[0]!; f.ledger.automations.finish(run.id, 'unknown', 'stop_unconfirmed');
  const reads: (JsonValue | undefined)[] = [];
  let phase = 'cycle';
  f.behavior(async (method, params) => {
    if (method !== 'thread/history') return {};
    reads.push(params.cursor);
    if (phase === 'cycle') return { threadId: run.threadId, turns: [], nextCursor: params.cursor === 'a' ? 'b' : 'a' };
    if (phase === 'expired' && params.cursor) throw new HarnessError('invalid_cursor', 'invalidated');
    if (phase === 'expired') return { threadId: run.threadId, turns: [], nextCursor: 'invalidated' };
    if (phase === 'wrong thread') return { threadId: 'another', turns: [{ id: run.turnId, status: 'completed' }], nextCursor: null };
    if (phase === 'wrong turn') return { threadId: run.threadId, turns: [{ id: 'another', status: 'completed' }], nextCursor: null };
    return { threadId: run.threadId, turns: [{ id: run.turnId, status: phase === 'invalid status' ? ['completed'] : 'inProgress' }], nextCursor: null };
  });
  for (let i = 0; i < 4; i++) { f.advance(2000); await f.scheduler.tick(); }
  expect(reads).toEqual([undefined, 'a', 'b', 'a']); expect(f.ledger.automationCursor(run.id)).toBeNull();
  f.advance(2000); await f.scheduler.tick(); expect(reads).toHaveLength(4);
  phase = 'expired'; f.advance(30_000); await f.scheduler.tick(); f.advance(2000); await f.scheduler.tick();
  expect(f.ledger.automationCursor(run.id)).toBeNull();
  for (phase of ['wrong thread', 'wrong turn', 'invalid status', 'active']) {
    f.advance(30_000); await f.scheduler.tick(); expect(f.ledger.automations.getRun(run.id).state).toBe('unknown');
  }
  expect(f.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(0);
  expect(f.calls.filter(call => call.method === 'conversation/start')).toHaveLength(1);
});

it('polls the matched older page for an active recovered turn until that exact turn ends', async () => {
  const f = setup(); await f.create(); f.advance(60_000); await f.scheduler.tick();
  const run = f.ledger.automations.outstanding()[0]!; f.ledger.automations.recover();
  let status = 'inProgress';
  f.behavior(async (method, params) => {
    if (method !== 'thread/history') return {};
    return params.cursor === 'older' ? { threadId: run.threadId, turns: [{ id: run.turnId, status }], nextCursor: 'still-older' }
      : { threadId: run.threadId, turns: [], nextCursor: 'older' };
  });
  await f.scheduler.tick(); f.advance(2000); await f.scheduler.tick();
  expect(f.ledger.automations.getRun(run.id).state).toBe('running');
  status = 'interrupted'; f.advance(30_000); await f.scheduler.tick();
  expect(f.calls.filter(call => call.method === 'thread/history').slice(-3).map(call => call.params.cursor)).toEqual([undefined, 'older', 'older']);
  expect(f.ledger.automations.getRun(run.id).state).toBe('interrupted');
  expect(f.ledger.automationCursor(run.id)).toBeNull();
});

it('uses only current approvals for the exact accepted turn, including requests received before the start reply', async () => {
  const f = setup(); f.scheduler.start(); await f.create();
  const pending = new Map<string, { threadId: string; turnId: string | null }>();
  const open = (id: string, turnId: string | null) => {
    const target = { threadId: 'thread', turnId };
    pending.set(id, target);
    f.dispatcher.event({ type: 'prompt', data: { promptId: id, ...target } });
  };
  const close = (id: string) => {
    const target = pending.get(id)!;
    pending.delete(id);
    f.dispatcher.event({ type: 'prompt-closed', data: { promptId: id, ...target,
      pendingForTurn: [...pending.values()].some(other => other.turnId === target.turnId) } });
  };
  let hold: (() => void) | undefined; let holdLists = false;
  f.behavior(async (method, _params, context) => {
    context.beforeWrite?.();
    if (method === 'conversation/start') {
      open('early', 'turn');
      return { thread: { id: 'thread' }, turn: { id: 'turn', status: 'inProgress' } };
    }
    if (method === 'prompt/list') {
      const snapshot = [...pending.values()];
      if (holdLists) await new Promise<void>(resolve => { hold = resolve; });
      return { epoch: 'current', prompts: snapshot };
    }
    return { threadId: 'thread', turns: [{ id: 'turn', status: 'inProgress' }], nextCursor: null };
  });
  f.advance(60_000); await f.scheduler.tick();
  const run = f.ledger.automations.outstanding()[0]!;
  const state = () => f.ledger.automations.getRun(run.id).state;
  expect(state()).toBe('needs_attention');
  open('second', 'turn'); open('different', 'next-turn'); open('unattributed', null);
  close('early'); expect(state()).toBe('needs_attention');
  close('second'); expect(state()).toBe('running');
  holdLists = true; f.advance(31_000); const tick = f.scheduler.tick();
  await vi.waitFor(() => expect(hold).toBeDefined());
  open('late', 'turn'); hold!(); await tick;
  expect(state()).toBe('needs_attention');
  holdLists = false; close('late'); expect(state()).toBe('running');
  open('will-close-offline', 'turn');
  f.worker.connected = false; f.dispatcher.disconnected(); pending.delete('will-close-offline');
  f.worker.connected = true; f.advance(31_000); await f.scheduler.tick();
  expect(state()).toBe('running');
  expect(f.calls.filter(call => call.method === 'conversation/start')).toHaveLength(1);
  expect(f.calls.some(call => call.method === 'prompt/answer')).toBe(false);
});
