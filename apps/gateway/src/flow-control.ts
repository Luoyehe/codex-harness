export const FLOW_LIMITS = {
  clients: 16, perClient: 8, total: 32, heavy: 1, controls: 8, controlsPerClient: 4,
  outgoingBytes: 40 * 1024 * 1024, frameBytes: 36 * 1024 * 1024,
  incomingQueuedBytes: 48 * 1024 * 1024, incomingPerClientBytes: 40 * 1024 * 1024,
  // Ordinary work can never consume these byte reserves. They are sized for
  // the maximum number of 1 MiB server-request responses admitted by the
  // control-count budget, including four responses from one browser.
  controlIncomingBytes: 8 * 1024 * 1024, controlIncomingPerClientBytes: 4 * 1024 * 1024,
  historyBytes: 8 * 1024 * 1024,
} as const;
const HEAVY = new Set([
  "attachment/upload", "attachment/read", "attachment/delete",
  "turn/start", "thread/start", "thread/read", "thread/resume", "thread/delete",
  "fs/readDirectory",
]);
const CONTROL = new Set([
  "turn/interrupt", "terminal/terminate", "account/login/cancel",
  "turn/operation", "thread/start/operation", "management/status", "account/login/status",
  "serverRequestResponse",
]);

/** Reject before dispatch, with a separate reserve for stop/reconciliation. */
export class RpcBudget {
  private total = 0;
  private heavy = 0;
  private controls = 0;
  private incomingBytes = 0;
  private controlIncomingBytes = 0;
  private owners = new Map<string, number>();
  private controlOwners = new Map<string, number>();
  private incomingOwners = new Map<string, number>();
  private controlIncomingOwners = new Map<string, number>();
  acquire(owner: string, method: string, requestBytes = 0): () => void {
    if (!Number.isSafeInteger(requestBytes) || requestBytes < 0 || requestBytes > FLOW_LIMITS.frameBytes) {
      throw Object.assign(new Error("请求帧大小无效，本次请求未派发。"), { errorCode: "BUSY" });
    }
    const control = CONTROL.has(method);
    const heavy = HEAVY.has(method);
    const owned = this.owners.get(owner) ?? 0;
    const controlOwned = this.controlOwners.get(owner) ?? 0;
    const ownerBytes = this.incomingOwners.get(owner) ?? 0;
    const controlOwnerBytes = this.controlIncomingOwners.get(owner) ?? 0;
    if (this.incomingBytes + requestBytes > FLOW_LIMITS.incomingQueuedBytes
      || ownerBytes + requestBytes > FLOW_LIMITS.incomingPerClientBytes
      || (control
        ? this.controlIncomingBytes + requestBytes > FLOW_LIMITS.controlIncomingBytes
          || controlOwnerBytes + requestBytes > FLOW_LIMITS.controlIncomingPerClientBytes
        : this.incomingBytes + requestBytes > FLOW_LIMITS.incomingQueuedBytes - FLOW_LIMITS.controlIncomingBytes
          || ownerBytes + requestBytes > FLOW_LIMITS.incomingPerClientBytes - FLOW_LIMITS.controlIncomingPerClientBytes)
      || (control
      ? this.controls >= FLOW_LIMITS.controls || controlOwned >= FLOW_LIMITS.controlsPerClient
      : this.total >= FLOW_LIMITS.total || owned >= FLOW_LIMITS.perClient || (heavy && this.heavy >= FLOW_LIMITS.heavy))) {
      throw Object.assign(new Error("请求队列已满，本次请求未派发；请等待正在进行的请求完成。"), { errorCode: "BUSY" });
    }
    if (control) {
      this.controls++;
      this.controlOwners.set(owner, controlOwned + 1);
      this.controlIncomingBytes += requestBytes;
      this.controlIncomingOwners.set(owner, controlOwnerBytes + requestBytes);
    } else this.total++;
    if (heavy) this.heavy++;
    this.incomingBytes += requestBytes;
    this.incomingOwners.set(owner, ownerBytes + requestBytes);
    this.owners.set(owner, owned + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (control) {
        this.controls--;
        const controlsLeft = (this.controlOwners.get(owner) ?? 1) - 1;
        if (controlsLeft) this.controlOwners.set(owner, controlsLeft); else this.controlOwners.delete(owner);
        this.controlIncomingBytes -= requestBytes;
        const controlOwnerBytesLeft = (this.controlIncomingOwners.get(owner) ?? requestBytes) - requestBytes;
        if (controlOwnerBytesLeft) this.controlIncomingOwners.set(owner, controlOwnerBytesLeft);
        else this.controlIncomingOwners.delete(owner);
      } else this.total--;
      if (heavy) this.heavy--;
      this.incomingBytes -= requestBytes;
      const ownerBytesLeft = (this.incomingOwners.get(owner) ?? requestBytes) - requestBytes;
      if (ownerBytesLeft) this.incomingOwners.set(owner, ownerBytesLeft); else this.incomingOwners.delete(owner);
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
