import { randomUUID } from 'node:crypto';
import type { CallContext, JsonObject, JsonValue } from '../core/contracts.js';
import { Ledger } from '../core/ledger.js';
import { HarnessError } from '../core/errors.js';
import { object } from '../core/validation.js';
import { OPERATION_EXPORT_SNAPSHOT_LIMIT, OPERATION_EXPORT_TTL_MS } from '../core/operation-retention.js';

interface ExportLease { id: string; owner: string; digest: string; nextGeneration: number; bytes: number; offset: number; expires: number }
/** Independent bounded exports belong to their exact live browser connections. */
export class ReceiptMaintenance {
  private leases = new Map<string, ExportLease>();
  private preparing = new Map<string, symbol>();
  constructor(private ledger: Ledger, private now: () => number = Date.now) {}
  forget(owner?: string): void {
    if (owner === undefined) this.preparing.clear(); else this.preparing.delete(owner);
    for (const [key, lease] of this.leases) {
      if (owner !== undefined && key !== owner) continue;
      this.leases.delete(key);
      // Identical ledger snapshots may be shared by two independent exports.
      if (![...this.leases.values()].some(other => other.digest === lease.digest)) this.ledger.releaseMaintenanceExport(lease.digest);
    }
  }
  private expire(): void {
    for (const lease of this.leases.values()) if (lease.expires <= this.now()) this.forget(lease.owner);
  }
  call(method: string, params: JsonObject, context: CallContext): JsonValue | Promise<JsonValue> {
    context.requireConnection?.();
    if (method === 'operation/maintenance/preview') {
      this.keys(params, []);
      this.expire();
      if (this.preparing.has(context.clientId)) throw new HarnessError('capacity', '本页面正在生成回执归档，请等待本次预览。');
      if (!this.leases.has(context.clientId) && this.leases.size + this.preparing.size >= OPERATION_EXPORT_SNAPSHOT_LIMIT)
        throw new HarnessError('capacity', '已有两个页面正在导出，请关闭其中一个页面或等待导出过期后重试。');
      // Replacing this owner's preview must release its old snapshot first:
      // otherwise the core's bounded cache could evict the other live owner.
      this.forget(context.clientId);
      const owner = context.clientId, token = Symbol();
      this.preparing.set(owner, token);
      const check = () => {
        context.requireConnection?.();
        if (this.preparing.get(owner) !== token) throw new HarnessError('archive_expired', '连接已经关闭，请重新预览。');
      };
      const finish = (preview: JsonObject) => {
        check();
        const id = randomUUID();
        this.leases.set(owner, { id, owner, digest: String(preview.digest), nextGeneration: Number(preview.nextGeneration), bytes: Number(preview.bytes), offset: 0, expires: this.now() + OPERATION_EXPORT_TTL_MS });
        return { ...preview, exportId: id };
      };
      const done = () => { if (this.preparing.get(owner) === token) this.preparing.delete(owner); };
      try {
        const preview = this.ledger.connectionPreview(check);
        if (preview instanceof Promise) return preview.then(finish).finally(done);
        const result = finish(preview); done(); return result;
      } catch (error) { done(); throw error; }
    }
    if (method === 'operation/maintenance/chunk') {
      this.keys(params, ['exportId', 'digest', 'offset', 'limit']);
      const lease = this.require(params, context);
      if (params.offset !== lease.offset) throw new HarnessError('invalid', '归档必须按顺序完整下载，请重新预览。');
      const chunk = this.ledger.maintenanceChunk({ digest: lease.digest, offset: lease.offset, ...(params.limit === undefined ? {} : { limit: params.limit as number }) });
      object(chunk);
      lease.offset = chunk.nextOffset === null ? lease.bytes : Number(chunk.nextOffset);
      return chunk;
    }
    throw new HarnessError('method_not_found', '不支持此维护操作。');
  }
  validateRotation(params: JsonObject, context: CallContext): { digest: string; nextGeneration: number; exportedDigest: string } {
    context.requireConnection?.();
    this.keys(params, ['exportId', 'digest', 'nextGeneration', 'exportedDigest', 'confirm']);
    const lease = this.require(params, context);
    if (params.confirm !== true || lease.offset !== lease.bytes || params.exportedDigest !== lease.digest || params.nextGeneration !== lease.nextGeneration)
      throw new HarnessError('archive_required', '请先完整导出并校验回执，再明确确认轮换。');
    return { digest: lease.digest, nextGeneration: lease.nextGeneration, exportedDigest: lease.digest };
  }
  private require(params: JsonObject, context: CallContext): ExportLease {
    this.expire();
    const lease = this.leases.get(context.clientId);
    if (!lease || params.exportId !== lease.id || params.digest !== lease.digest)
      throw new HarnessError('archive_expired', '归档已过期或不属于当前连接，请重新预览并导出。');
    return lease;
  }
  private keys(params: JsonObject, allowed: string[]): void {
    if (Object.keys(params).some(key => !allowed.includes(key))) throw new HarnessError('invalid', '归档请求包含未知参数。');
  }
}
