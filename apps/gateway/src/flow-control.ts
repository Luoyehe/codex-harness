export const FLOW_LIMITS = {
  clients: 16, perClient: 8, total: 32, heavy: 1,
  outgoingBytes: 40 * 1024 * 1024, frameBytes: 36 * 1024 * 1024,
  historyBytes: 8 * 1024 * 1024,
} as const;
const HEAVY = new Set(["attachment/upload", "attachment/read", "thread/read", "thread/resume"]);
const CONTROL = new Set(["turn/interrupt", "terminal/terminate", "turn/operation", "management/status"]);

/** Reject before dispatch, with a separate reserve for stop/reconciliation. */
export class RpcBudget {
  private total = 0;
  private heavy = 0;
  private controls = 0;
  private owners = new Map<string, number>();
  acquire(owner: string, method: string): () => void {
    const control = CONTROL.has(method);
    const heavy = HEAVY.has(method);
    const owned = this.owners.get(owner) ?? 0;
    if (control ? this.controls >= 8 : this.total >= FLOW_LIMITS.total || owned >= FLOW_LIMITS.perClient || (heavy && this.heavy >= FLOW_LIMITS.heavy)) {
      throw Object.assign(new Error("请求队列已满，本次请求未派发；请等待正在进行的请求完成。"), { errorCode: "BUSY" });
    }
    if (control) this.controls++; else this.total++;
    if (heavy) this.heavy++;
    this.owners.set(owner, owned + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (control) this.controls--; else this.total--;
      if (heavy) this.heavy--;
      const left = (this.owners.get(owner) ?? 1) - 1;
      if (left) this.owners.set(owner, left); else this.owners.delete(owner);
    };
  }
}

export function encodeBounded(value: unknown, limit = FLOW_LIMITS.frameBytes): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > limit) throw Object.assign(new Error("响应超过安全大小上限，请缩小请求范围；没有将截断数据当作完整历史。"), { errorCode: "RESPONSE_TOO_LARGE" });
  return encoded;
}
