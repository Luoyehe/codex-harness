import type { CallContext, HarnessEvent, JsonValue, WorkerPort } from '../core/contracts.js';
import type { AutomationRun, RunState } from '../core/automations.js';
import { Ledger } from '../core/ledger.js';
import { HarnessError } from '../core/errors.js';
import { identifier, object } from '../core/validation.js';
import { Dispatcher } from './dispatch.js';

interface SchedulerWorker extends WorkerPort { clientConnected(id: string): Promise<void>; clientDisconnected(id: string): Promise<void> }
const finalStates = new Set(['completed', 'failed', 'interrupted']);
/** In-process scheduler owned by the gateway identity. It obtains ordinary fenced worker leases. */
export class AutomationScheduler {
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private leases = new Set<string>();
  private nextRead = new Map<string, number>();
  private nextStop = new Map<string, number>();
  private controls = new Map<string, Promise<void>>();
  private readCursor = 0;
  // Detect even long cursor cycles with one checkpoint per outstanding run.
  private scans = new Map<string, { anchor: string; span: number; distance: number }>();
  private launches = new Map<string, Promise<void>>();
  private readonly onEvent = (event: HarnessEvent): void => { this.event(event); };
  private readonly onChanged = (): void => { void this.tick(); };
  constructor(private ledger: Ledger, private dispatcher: Dispatcher, private worker: SchedulerWorker, private now: () => number = Date.now) {}
  start(): void {
    if (this.timer || this.closed) return;
    this.dispatcher.on('event', this.onEvent); this.dispatcher.on('automation-changed', this.onChanged);
    this.timer = setInterval(() => { void this.tick(); }, 2000); this.timer.unref(); void this.tick();
  }
  private publish(runId?: string): void { this.dispatcher.emit('event', { type: 'automation', data: runId ? { runId } : { changed: true } }); }
  private context(clientId: string): CallContext { return { clientId, requireConnection: () => { if (this.closed || !this.worker.connected || !this.leases.has(clientId)) throw new HarnessError('worker_unavailable', '计划运行的后台连接已断开。'); } }; }
  private async lease(clientId: string): Promise<void> {
    if (this.leases.has(clientId)) return;
    if (this.closed || !this.worker.connected) throw new HarnessError('worker_unavailable', '后台尚未连接。');
    await this.worker.clientConnected(clientId);
    if (this.closed || !this.worker.connected) { await this.worker.clientDisconnected(clientId); throw new HarnessError('worker_unavailable', '后台连接已断开。'); }
    this.leases.add(clientId);
  }
  private async release(clientId: string): Promise<void> {
    if (!this.leases.delete(clientId)) return;
    try { await this.worker.clientDisconnected(clientId); } catch { /* WorkerClient fences its exact channel on failed cleanup. */ }
  }
  private clearCooldowns(runId: string): void { this.nextRead.delete(runId); this.nextStop.delete(runId); this.scans.delete(runId); this.ledger.setAutomationCursor(runId, null); }
  private pruneCooldowns(): void {
    const outstanding = new Set(this.ledger.automations.outstanding().map(run => run.id));
    for (const id of new Set([...this.nextRead.keys(), ...this.nextStop.keys(), ...this.scans.keys()])) if (!outstanding.has(id)) this.clearCooldowns(id);
  }
  private async releaseSettled(run: AutomationRun): Promise<void> {
    // Terminal records may already have been recycled while an older read or
    // stop awaits its result. Outstanding identity is the retained authority.
    const latest = this.ledger.automations.outstanding().find(value => value.id === run.id);
    if (!latest) this.clearCooldowns(run.id);
    if (!latest || !['running', 'needs_attention', 'stopping'].includes(latest.state)) await this.release(run.clientId);
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.pruneCooldowns();
    const controls = this.control();
    const work = this.step().then(() => {
      this.dispatcher.automationHealth({ running: !this.closed, lastTickAt: this.now(), lastError: null });
    }, error => {
      this.dispatcher.automationHealth({ running: !this.closed, lastTickAt: this.now(), lastError: error instanceof HarnessError ? error.code : 'scheduler_failed' });
    });
    return Promise.all([work, controls, ...this.launches.values()]).then(() => {});
  }
  private async step(): Promise<void> {
    if (this.closed || this.dispatcher.maintenanceActive()) return;
    this.ledger.transaction(() => this.ledger.automations.collectDue());
    if (!this.worker.connected) return;
    const outstanding = this.ledger.automations.outstanding();
    const running = outstanding.filter(value => ['dispatching', 'running', 'needs_attention', 'stopping'].includes(value.state));
    let slots = Math.max(0, 4 - running.length);
    const admitted: Promise<void>[] = [];
    for (const value of outstanding.filter(value => value.state === 'queued')) {
      if (this.closed || !this.worker.connected || this.dispatcher.maintenanceActive() || slots <= 0) break;
      if (this.now() - value.scheduledAt > 300_000) { this.ledger.transaction(() => this.ledger.automations.finish(value.id, 'not_sent', 'missed_window')); this.publish(value.id); continue; }
      const project = value.spec.projectId;
      if (this.launches.has(project)) continue;
      const claimed = this.ledger.transaction(() => this.ledger.automations.claim(value.id));
      if (claimed) {
        slots--;
        const task = this.launch(claimed).finally(() => { this.launches.delete(project); });
        this.launches.set(project, task);
        admitted.push(task.then(() => this.step()));

      }
    }
    await Promise.all(admitted);
  }
  private controlRun(key: string, operation: () => Promise<void>): Promise<void> {
    const existing = this.controls.get(key);
    if (existing) return existing;
    const work = Promise.resolve().then(operation).finally(() => { this.controls.delete(key); this.pruneCooldowns(); });
    this.controls.set(key, work);
    return work;
  }
  private async control(): Promise<void> {
    if (this.closed || !this.worker.connected || this.dispatcher.maintenanceActive()) return;
    const pending: Promise<void>[] = [];
    const run = (key: string, operation: () => Promise<void>): void => {
      if (!this.controls.has(key)) pending.push(this.controlRun(key, operation));
    };
    // Stop/deadline admission never waits behind a different launch or history
    // read. One in-flight stop and read per run preserve exact delivery state.
    const candidates = this.ledger.automations.outstanding().filter(value => value.state !== 'queued' && value.state !== 'dispatching');
    for (const value of candidates) {
      if (value.state !== 'unknown' && value.startedAt !== null && this.now() - value.startedAt >= value.spec.maxRunMinutes * 60_000) this.ledger.transaction(() => this.ledger.automations.requestStop(value.id));
      const latest = this.ledger.automations.getRun(value.id);
      if (latest.stopRequested && !latest.stopSent && latest.threadId && latest.turnId && latest.state !== 'unknown' && (this.nextStop.get(value.id) ?? 0) <= this.now()) run(`stop:${value.id}`, () => this.stop(latest));
    }
    if (candidates.length) {
      for (let i = 0; i < Math.min(4, candidates.length); i++) {
        const value = candidates[(this.readCursor + i) % candidates.length]!;
        if (this.closed || !this.worker.connected) break;
        if (!this.controls.has(`read:${value.id}`) && (this.nextRead.get(value.id) ?? 0) <= this.now()) { this.nextRead.set(value.id, this.now() + 30_000); run(`read:${value.id}`, () => this.reconcile(this.ledger.automations.getRun(value.id))); }
      }
      this.readCursor = (this.readCursor + 4) % candidates.length;
    }
    await Promise.allSettled(pending);
  }
  private accept(run: AutomationRun, value: JsonValue): void {
    object(value); object(value.thread); object(value.turn);
    const threadId = identifier(value.thread.id), turnId = identifier(value.turn.id), status = identifier(value.turn.status);
    if (!['inProgress', 'completed', 'failed', 'interrupted'].includes(status)) throw new HarnessError('invalid_result', '计划运行返回未知回合状态。', 'unknown');
    this.ledger.transaction(() => this.ledger.automations.accepted(run.id, threadId, turnId, status)); this.publish(run.id);
  }
  private async launch(run: AutomationRun): Promise<void> {
    try {
      await this.lease(run.clientId);
      const result = await this.dispatcher.call({ method: 'conversation/start', params: { projectId: run.spec.projectId, text: run.spec.text, options: run.spec.options }, operationId: run.operationId }, this.context(run.clientId));
      this.accept(run, result);
      await this.controlRun(`read:${run.id}`, () => this.reconcile(this.ledger.automations.getRun(run.id)));
    } catch (error) {
      const receipt = this.ledger.read(run.operationId);
      this.ledger.transaction(() => {
        if (receipt?.error?.data && typeof receipt.error.data === 'object' && !Array.isArray(receipt.error.data) && typeof receipt.error.data.threadId === 'string') this.ledger.automations.partial(run.id, receipt.error.data.threadId);
        this.ledger.automations.finish(run.id, receipt?.state === 'not_sent' || (!receipt && error instanceof HarnessError && error.delivery === 'not_sent') ? 'not_sent' : 'unknown', receipt?.error?.code ?? 'dispatch_unconfirmed');
      }); this.publish(run.id);
    } finally {
      await this.releaseSettled(run);
    }
  }
  private async stop(run: AutomationRun): Promise<void> {
    try {
      await this.lease(run.clientId); const context = this.context(run.clientId); context.requireConnection?.();
      if (!this.ledger.transaction(() => this.ledger.automations.claimStop(run.id))) return;
      await this.dispatcher.call({ method: 'turn/interrupt', params: { threadId: run.threadId!, turnId: run.turnId! } }, context);
      // An interrupt acknowledgement is not proof the turn completed or its processes exited.
    } catch (error) {
      if (error instanceof HarnessError && error.delivery === 'not_sent') { this.ledger.transaction(() => this.ledger.automations.stopNotSent(run.id, error.code)); this.nextStop.set(run.id, this.now() + 30_000); }
      else this.ledger.transaction(() => this.ledger.automations.finish(run.id, 'unknown', 'stop_unconfirmed'));
    } finally { await this.releaseSettled(run); }
    this.publish(run.id);
  }
  private advanceScan(id: string, cursor: string | null, next: JsonValue | undefined): void {
    let scan = this.scans.get(id);
    if (typeof next !== 'string' || !next.length || !next.isWellFormed() || Buffer.byteLength(next) > 4096 || next === cursor || next === scan?.anchor) {
      this.scans.delete(id); this.ledger.setAutomationCursor(id, null);
      return;
    }
    if (!scan) { scan = { anchor: next, span: 1, distance: 0 }; this.scans.set(id, scan); }
    else if (++scan.distance >= scan.span) { scan.anchor = next; scan.span *= 2; scan.distance = 0; }
    this.ledger.setAutomationCursor(id, next);
    // A continuation competes for a normal rotation slot on the next tick.
    this.nextRead.set(id, this.now() + 2000);
  }
  private async reconcile(original: AutomationRun): Promise<void> {
    let cursor: string | null = null;
    try {
      let run = original;
      if (run.state === 'unknown' && (!run.threadId || !run.turnId)) {
        const receipt = this.ledger.read(run.operationId);
        if (receipt?.state === 'accepted' && receipt.result) { this.accept(run, receipt.result); run = this.ledger.automations.getRun(run.id); }
        else if (receipt?.state === 'not_sent') { this.ledger.transaction(() => this.ledger.automations.finish(run.id, 'not_sent', receipt.error?.code ?? 'not_sent')); this.publish(run.id); return; }
      }
      if (finalStates.has(run.state) || !run.threadId || !run.turnId) return;
      await this.lease(run.clientId);
      cursor = this.ledger.automationCursor(run.id);
      const history = await this.dispatcher.call({ method: 'thread/history', params: { intent: 'turnStatus', threadId: run.threadId, turnId: run.turnId, limit: 25, ...(cursor === null ? {} : { cursor }) } }, this.context(run.clientId));
      object(history);
      if (history.threadId !== run.threadId || !Array.isArray(history.turns) || history.turns.length > 1) return;
      if (history.turns.length === 0) { this.advanceScan(run.id, cursor, history.nextCursor); return; }
      const found = history.turns[0]; object(found);
      if (found.id !== run.turnId) return;
      if (found.status === 'inProgress' && run.state === 'unknown' && run.threadId && run.turnId &&
          this.ledger.transaction(() => this.ledger.automations.restoreActive(run.id, run.threadId!, run.turnId!))) {
        this.publish(run.id);
        const active = this.ledger.automations.getRun(run.id);
        if (active.stopRequested || (active.startedAt !== null && this.now() - active.startedAt >= active.spec.maxRunMinutes * 60_000)) {
          this.ledger.transaction(() => this.ledger.automations.requestStop(active.id));
          await this.stop(active);
        }
      }
      if (typeof found.status === 'string' && finalStates.has(found.status)) { this.ledger.transaction(() => this.ledger.automations.finish(run.id, found.status as RunState)); this.publish(run.id); }
    } catch (error) {
      // Transport and stale-read failures retry the exact page. The native
      // server can reject a formerly valid position after a revert or upgrade.
      if (cursor !== null && error instanceof HarnessError && ['invalid_cursor', 'cursor_loop'].includes(error.code)) {
        this.scans.delete(original.id); this.ledger.setAutomationCursor(original.id, null);
      }
    }
    finally {
      await this.releaseSettled(original);
    }
  }
  private event(event: HarnessEvent): void {
    try {
      object(event.data);
      if (event.type === 'state' && event.data.connected === false) {
        this.leases.clear(); this.ledger.transaction(() => this.ledger.automations.recover()); return;
      }
      if (event.type === 'prompt') {
        const threadId = event.data.threadId;
        if (typeof threadId === 'string') this.ledger.transaction(() => this.ledger.automations.attention(threadId));
        return;
      }
      if (event.type !== 'notification' || event.data.method !== 'turn/completed') return;
      object(event.data.params); const params = event.data.params; object(params.turn); const turn = params.turn;
      if (typeof turn.status !== 'string' || !finalStates.has(turn.status)) return;
      for (const run of this.ledger.automations.outstanding()) if (run.threadId === params.threadId && run.turnId === turn.id) {
        this.ledger.transaction(() => this.ledger.automations.finish(run.id, turn.status as RunState)); this.clearCooldowns(run.id); void this.release(run.clientId); this.publish(run.id);
      }
    } catch { /* Ignore unrelated or malformed event data; read recovery remains available. */ }
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    this.dispatcher.off('event', this.onEvent); this.dispatcher.off('automation-changed', this.onChanged);
    await Promise.allSettled(this.launches.values());
    await Promise.allSettled(this.controls.values());
    this.nextRead.clear(); this.nextStop.clear(); this.scans.clear();
    await Promise.allSettled([...this.leases].map(id => this.release(id)));
    this.dispatcher.automationHealth({ running: false, lastTickAt: this.now(), lastError: null });
  }
}
