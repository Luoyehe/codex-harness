import { randomUUID } from 'node:crypto';
import type { CallContext, JsonObject, JsonValue } from '../core/contracts.js';
import { Ledger } from '../core/ledger.js';
import { HarnessError } from '../core/errors.js';
import { object } from '../core/validation.js';

interface ExportLease { id: string; owner: string; digest: string; nextGeneration: number; bytes: number; offset: number; expires: number }
/** A single bounded export is tied to the exact live browser connection. */
export class ReceiptMaintenance {
  private lease: ExportLease | undefined;
  constructor(private ledger: Ledger, private now: () => number = Date.now) {}
  forget(owner?: string): void { if (!owner || this.lease?.owner === owner) this.lease = undefined; }
  call(method: string, params: JsonObject, context: CallContext): JsonValue {
    context.requireConnection?.();
    if (method === 'operation/maintenance/preview') {
      this.keys(params, []);
      const preview = this.ledger.maintenancePreview();
      object(preview);
      const id = randomUUID();
      this.lease = { id, owner: context.clientId, digest: String(preview.digest), nextGeneration: Number(preview.nextGeneration), bytes: Number(preview.bytes), offset: 0, expires: this.now() + 10 * 60 * 1000 };
      return { ...preview, exportId: id };
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
    const lease = this.lease;
    if (!lease || lease.expires <= this.now() || lease.owner !== context.clientId || params.exportId !== lease.id || params.digest !== lease.digest)
      throw new HarnessError('archive_expired', '归档已过期或不属于当前连接，请重新预览并导出。');
    return lease;
  }
  private keys(params: JsonObject, allowed: string[]): void {
    if (Object.keys(params).some(key => !allowed.includes(key))) throw new HarnessError('invalid', '归档请求包含未知参数。');
  }
}
