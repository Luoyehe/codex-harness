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
// One source of truth for history RPCs: admission, private IPC and browser
// output must all apply the same budgets when a new history method is added.
export const HISTORY_READ_METHODS: ReadonlySet<string> = new Set([
  "thread/read", "thread/resume", "thread/turns/list", "thread/items/list",
]);
const HEAVY = new Set([
  "attachment/upload", "attachment/read", "attachment/delete",
  "turn/start", "thread/start", "thread/delete", ...HISTORY_READ_METHODS,
  "fs/readDirectory",
]);
const CONTROL = new Set([
  "turn/interrupt", "terminal/terminate", "account/login/cancel",
  "turn/operation", "thread/start/operation", "management/status", "account/login/status",
  "serverRequestResponse",
]);

export const WORKER_LIMITS = {
  requests: 64, controls: 8,
  // Private IPC adds its own method/id envelope to browser answers. Allow a
  // bounded envelope margin so eight exact 1 MiB answers retain their reserve.
  incomingBytes: FLOW_LIMITS.incomingQueuedBytes + 64 * 1024,
  controlIncomingBytes: FLOW_LIMITS.controlIncomingBytes + 64 * 1024,
} as const;

/** The caller's RPC timeout cannot cancel physical worker work. Hold this
 * independent reservation until its handler actually settles, even after the
 * control connection stopped waiting for the response. */
export class WorkerRequestBudget {
  private ordinary = 0;
  private controls = 0;
  private bytes = 0;
  private controlBytes = 0;

  acquire(method: string, nestedMethod: unknown, bytes: number): () => void {
    const control = ["gateway/connect", "gateway/disconnect", "gateway/answer"].includes(method)
      || method === "gateway/dispatch" && typeof nestedMethod === "string"
        && (CONTROL.has(nestedMethod) || nestedMethod === "terminal/resize");
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > FLOW_LIMITS.frameBytes
        || this.bytes + bytes > WORKER_LIMITS.incomingBytes
        || (control
          ? this.controls >= WORKER_LIMITS.controls || this.controlBytes + bytes > WORKER_LIMITS.controlIncomingBytes
          : this.ordinary >= WORKER_LIMITS.requests
            || this.bytes + bytes > WORKER_LIMITS.incomingBytes - WORKER_LIMITS.controlIncomingBytes)) {
      throw new Error("worker request count/byte limit reached; request was not dispatched");
    }
    this.bytes += bytes;
    if (control) { this.controls++; this.controlBytes += bytes; }
    else this.ordinary++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.bytes -= bytes;
      if (control) { this.controls--; this.controlBytes -= bytes; }
      else this.ordinary--;
    };
  }
}

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
