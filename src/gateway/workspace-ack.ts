import type { CallContext, JsonObject, Receipt, WorkerPort } from '../core/contracts.js';
import { HarnessError } from '../core/errors.js';
import type { Ledger } from '../core/ledger.js';
import { digest, object, uuid } from '../core/validation.js';
import { receiptResult } from './receipt-result.js';

const MAX_WITNESSES = 2000;
const PAGE = 64;
const CONCURRENCY = 4;

/** Durable gateway acceptance is the only authority for collecting private proofs. */
export class WorkspaceAcknowledgements {
  private background: Promise<void> | undefined;
  private lastAttempt: number | undefined;
  private resumeCursor: string | undefined;
  constructor(private readonly ledger: Ledger, private readonly worker: WorkerPort) {}

  reconnected(): void { this.lastAttempt = undefined; this.resumeCursor = undefined; }
  private context(context: CallContext): CallContext {
    return { clientId: context.clientId, ...(context.requireConnection ? { requireConnection: context.requireConnection } : {}),
      beforeWrite: () => { context.requireConnection?.(); } };
  }
  private matches(receipt: Receipt | null, proof: JsonObject): receipt is Receipt {
    return !!receipt && receipt.state === 'accepted' && receipt.method.startsWith('workspace/') &&
      receipt.operationId === proof.operationId && receipt.method === proof.method &&
      receipt.scope === 'project:' + proof.projectId && this.ledger.matchesDigest(receipt.operationId, proof.gatewayRequestDigest) &&
      Object.hasOwn(receipt, 'result') && proof.resultDigest === digest(receiptResult(receipt.method, receipt.result!));
  }
  private async acknowledge(proof: JsonObject, context: CallContext): Promise<boolean> {
    const id = uuid(proof.operationId);
    if (!this.matches(this.ledger.read(id), proof)) return false;
    context.requireConnection?.();
    const result = await this.worker.call('workspace/witness/ack', {
      operationId: id, method: proof.method!, projectId: proof.projectId!,
      gatewayRequestDigest: proof.gatewayRequestDigest!, resultDigest: proof.resultDigest!,
    }, this.context(context));
    object(result);
    if (result.acknowledged !== true || result.operationId !== id || typeof result.removed !== 'boolean') {
      throw new HarnessError('worker_protocol', '后台没有确认回执清理。');
    }
    return true;
  }

  /** Cleanup failure must never turn an already durable success into a failed operation. */
  async accepted(receipt: Receipt, context: CallContext, gatewayRequestDigest?: string): Promise<void> {
    if (receipt.state !== 'accepted' || !receipt.method.startsWith('workspace/')) return;
    try {
      let fingerprint = gatewayRequestDigest;
      if (fingerprint === undefined) {
        context.requireConnection?.();
        const proof = await this.worker.call('workspace/witness/read', { operationId: receipt.operationId }, this.context(context));
        object(proof);
        if (proof.state !== 'completed' || proof.operationId !== receipt.operationId || proof.method !== receipt.method ||
            receipt.scope !== 'project:' + proof.projectId || !Object.hasOwn(proof, 'result') ||
            digest(receiptResult(receipt.method, proof.result!)) !== digest(receipt.result!)) return;
        fingerprint = String(proof.gatewayRequestDigest);
      }
      await this.acknowledge({ operationId: receipt.operationId, method: receipt.method, projectId: receipt.scope.slice(8),
        gatewayRequestDigest: fingerprint, resultDigest: digest(receipt.result!) }, context);
    } catch { /* The persisted receipt and retained witness permit later reconciliation. */ }
  }

  opportunistic(context: CallContext): void {
    if (!context.requireConnection || !this.worker.connected || this.background ||
        (this.lastAttempt !== undefined && Date.now() - this.lastAttempt < 30_000) || !this.ledger.hasWorkspaceReceipts()) return;
    this.lastAttempt = Date.now();
    this.background = this.sweep(context, 8, this.resumeCursor).then(next => { this.resumeCursor = next; }, () => {}).finally(() => { this.background = undefined; });
  }

  private async sweep(context: CallContext, maximum: number, after?: string): Promise<string | undefined> {
    let examined = 0;
    while (examined < maximum) {
      context.requireConnection?.();
      const page = await this.worker.call('workspace/witness/pending', { limit: Math.min(PAGE, maximum - examined), ...(after ? { after } : {}) }, this.context(context));
      object(page);
      if (!Array.isArray(page.data) || page.data.length > Math.min(PAGE, maximum - examined)) throw new HarnessError('worker_protocol', '后台回执页超过界限。');
      const rows = page.data.map(value => { object(value); return value; });
      let previous = after ?? '';
      for (const row of rows) {
        const id = uuid(row.operationId);
        if (id <= previous) throw new HarnessError('worker_protocol', '后台回执分页顺序无效。');
        previous = id;
      }
      const next = page.nextCursor === null ? null : uuid(page.nextCursor);
      if (next !== null && (!rows.length || next !== previous)) throw new HarnessError('worker_protocol', '后台回执游标无效。');
      for (let index = 0; index < rows.length; index += CONCURRENCY) {
        // All spawned requests must settle before maintenance can rotate the journal.
        await Promise.allSettled(rows.slice(index, index + CONCURRENCY).map(row => this.acknowledge(row, context)));
      }
      examined += rows.length;
      if (next === null) return undefined;
      after = next;
    }
    return after;
  }

  /** Called with the gateway's exclusive maintenance lock held. */
  async drain(context: CallContext): Promise<void> {
    if (this.background) await this.background;
    await this.sweep(context, MAX_WITNESSES);
    this.resumeCursor = undefined;
    context.requireConnection?.();
    const state = await this.worker.call('runtime/maintenance/check', {}, this.context(context));
    object(state); object(state.workspaceWitness);
    if (state.idle !== true || state.workspaceWitness.total !== 0) {
      throw new HarnessError('journal_busy', '仍有未确认或未能清理的工作区回执，不能轮换操作日志。');
    }
  }
}
