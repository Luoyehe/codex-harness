/** Worker-to-control work admission only. No privileged operation is exposed.
 * Responses are independently correlated, so a compact dispatch can run while
 * its admission request awaits a reply (there is no nested RPC serial lock). */
export class ControlRequests {
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly send: (frame: unknown) => void, private readonly timeoutMs = 120_000) {}
  compact(threadId: string): Promise<unknown> {
    if (this.closed || this.pending.size >= 32) return Promise.reject(Object.assign(new Error("control admission unavailable"), { delivery: "rejected" }));
    const id = `auto-compact-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error("compaction admission result unknown; no automatic retry"), { delivery: "unknown" }));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method: "gateway/autoCompact", params: { threadId } }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(Object.assign(new Error("control admission transport failed"), { delivery: "unknown" })); }
    });
  }
  receive(frame: any): boolean {
    if (!frame || typeof frame !== "object" || Array.isArray(frame) || typeof frame.id !== "string" || "method" in frame) return false;
    const request = this.pending.get(frame.id);
    if (!request || ("result" in frame) === ("error" in frame)) return false;
    this.pending.delete(frame.id);
    clearTimeout(request.timer);
    if ("error" in frame) request.reject(Object.assign(new Error(typeof frame.error?.message === "string" ? frame.error.message : "compaction admission failed"), {
      delivery: frame.error?.data?.delivery === "rejected" ? "rejected" : "unknown",
    }));
    else request.resolve(frame.result);
    return true;
  }
  close(): void {
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(Object.assign(new Error("control admission connection closed"), { delivery: "unknown" }));
    }
    this.pending.clear();
  }
}
