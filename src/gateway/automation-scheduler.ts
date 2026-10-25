import type { CallContext, HarnessEvent, JsonObject, JsonValue, WorkerPort } from '../core/contracts.js';
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
  private task: Promise<void> | undefined;
  private closed = false;
  private leases = new Set<string>();
  private nextRead = new Map<string, number>();
  private readCursor = 0;
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
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.task) return this.task;
    this.task = this.step().then(() => { this.dispatcher.automationHealth({ running: !this.closed, lastTickAt: this.now(), lastError: null }); }, error => {
      this.dispatcher.automationHealth({ running: !this.closed, lastTickAt: this.now(), lastError: error instanceof HarnessError ? error.code : 'scheduler_failed' });
    }).finally(() => { this.task = undefined; }); return this.task;
  }
  private async step(): Promise<void> {
    this.ledger.transaction(() => this.ledger.automations.collectDue());
    if (!this.worker.connected) return;
    const outstanding = this.ledger.automations.outstanding();
    const running = outstanding.filter(value => ['dispatching', 'running', 'needs_attention', 'stopping'].includes(value.state));
    let slots = Math.max(0, 4 - running.length);
    for (const value of outstanding.filter(value => value.state === 'queued')) {
      if (this.closed || !this.worker.connected || slots <= 0) break;
      if (this.now() - value.scheduledAt > 300_000) { this.ledger.transaction(() => this.ledger.automations.finish(value.id, 'not_sent', 'missed_window')); this.publish(value.id); continue; }
      const claimed = this.ledger.transaction(() => this.ledger.automations.claim(value.id));
      if (claimed) { slots--; await this.launch(claimed); }
    }
    // Bound each read sweep, including a large set of unresolved historical runs.
    const candidates = this.ledger.automations.outstanding().filter(value => value.state !== 'queued' && value.state !== 'dispatching');
    if (candidates.length) {
      for (let i = 0; i < Math.min(4, candidates.length); i++) {
        const value = candidates[(this.readCursor + i) % candidates.length]!;
        if (this.closed || !this.worker.connected) break;
        if (value.state !== 'unknown' && value.startedAt !== null && this.now() - value.startedAt >= value.spec.maxRunMinutes * 60_000) this.ledger.transaction(() => this.ledger.automations.requestStop(value.id));
        const latest = this.ledger.automations.getRun(value.id);
        if (latest.stopRequested && !latest.stopSent && latest.threadId && latest.turnId && latest.state !== 'unknown') await this.stop(latest);
        if ((this.nextRead.get(value.id) ?? 0) <= this.now()) { this.nextRead.set(value.id, this.now() + 30_000); await this.reconcile(this.ledger.automations.getRun(value.id)); }
      }
      this.readCursor = (this.readCursor + 4) % candidates.length;
    }
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
      await this.reconcile(this.ledger.automations.getRun(run.id));
    } catch (error) {
      const receipt = this.ledger.read(run.operationId);
      this.ledger.transaction(() => {
        if (receipt?.error?.data && typeof receipt.error.data === 'object' && !Array.isArray(receipt.error.data) && typeof receipt.error.data.threadId === 'string') this.ledger.automations.partial(run.id, receipt.error.data.threadId);
        this.ledger.automations.finish(run.id, receipt?.state === 'not_sent' || (!receipt && error instanceof HarnessError && error.delivery === 'not_sent') ? 'not_sent' : 'unknown', receipt?.error?.code ?? 'dispatch_unconfirmed');
      }); this.publish(run.id);
    } finally {
      if (!['running', 'needs_attention', 'stopping'].includes(this.ledger.automations.getRun(run.id).state)) await this.release(run.clientId);
    }
  }
  private async stop(run: AutomationRun): Promise<void> {
    try {
      await this.lease(run.clientId); const context = this.context(run.clientId); context.requireConnection?.();
      if (!this.ledger.transaction(() => this.ledger.automations.claimStop(run.id))) return;
      await this.dispatcher.call({ method: 'turn/interrupt', params: { threadId: run.threadId!, turnId: run.turnId! } }, context);
      // An interrupt acknowledgement is not proof the turn completed or its processes exited.
    } catch { this.ledger.transaction(() => this.ledger.automations.finish(run.id, 'unknown', 'stop_unconfirmed')); }
    this.publish(run.id);
  }
  private async reconcile(original: AutomationRun): Promise<void> {
    try {
      let run = original;
      if (run.state === 'unknown' && (!run.threadId || !run.turnId)) {
        const receipt = this.ledger.read(run.operationId);
        if (receipt?.state === 'accepted' && receipt.result) { this.accept(run, receipt.result); run = this.ledger.automations.getRun(run.id); }
        else if (receipt?.state === 'not_sent') { this.ledger.transaction(() => this.ledger.automations.finish(run.id, 'not_sent', receipt.error?.code ?? 'not_sent')); this.publish(run.id); return; }
      }
      if (finalStates.has(run.state) || !run.threadId || !run.turnId) return;
      await this.lease(run.clientId);
      const history = await this.dispatcher.call({ method: 'thread/history', params: { threadId: run.threadId, limit: 25 } }, this.context(run.clientId)); object(history);
      if (!Array.isArray(history.turns)) return;
      const found = history.turns.find(turn => !!turn && typeof turn === 'object' && !Array.isArray(turn) && turn.id === run.turnId) as JsonObject | undefined;
      if (found && finalStates.has(String(found.status))) { this.ledger.transaction(() => this.ledger.automations.finish(run.id, found.status as RunState)); this.publish(run.id); }
    } catch { /* Only a matching terminal turn is positive completion evidence. No resume or re-dispatch. */ }
    finally {
      const latest = this.ledger.automations.getRun(original.id);
      if (!['running', 'needs_attention', 'stopping'].includes(latest.state)) { this.nextRead.delete(original.id); await this.release(original.clientId); }
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
      if (!finalStates.has(String(turn.status))) return;
      for (const run of this.ledger.automations.outstanding()) if (run.threadId === params.threadId && run.turnId === turn.id) {
        this.ledger.transaction(() => this.ledger.automations.finish(run.id, turn.status as RunState)); this.nextRead.delete(run.id); void this.release(run.clientId); this.publish(run.id);
      }
    } catch { /* Ignore unrelated or malformed event data; read recovery remains available. */ }
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    this.dispatcher.off('event', this.onEvent); this.dispatcher.off('automation-changed', this.onChanged);
    await this.task;
    await Promise.allSettled([...this.leases].map(id => this.release(id)));
    this.dispatcher.automationHealth({ running: false, lastTickAt: this.now(), lastError: null });
  }
}
