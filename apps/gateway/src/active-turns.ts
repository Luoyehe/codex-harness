import type { ObservedNotification } from "./protocol.js";

/** Connection-scoped turn identity. Retryable errors do not end a turn. */
export class ActiveTurns {
  static readonly MAX_TRACKED = 256;
  private readonly turns = new Map<string, string>();
  private readonly conflicts = new Set<string>();

  get(threadId: string): string | null { return this.conflicts.has(threadId) ? null : this.turns.get(threadId) ?? null; }
  delete(threadId: string): void { this.turns.delete(threadId); this.conflicts.delete(threadId); }
  clear(): void { this.turns.clear(); this.conflicts.clear(); }

  observe(event: ObservedNotification): void {
    switch (event.method) {
      case "turn/started":
        if (this.conflicts.has(event.params.threadId)) return;
        if (!this.turns.has(event.params.threadId) && this.turns.size + this.conflicts.size >= ActiveTurns.MAX_TRACKED) return;
        if (this.turns.has(event.params.threadId) && this.turns.get(event.params.threadId) !== event.params.turn.id) {
          // Ambiguous concurrent identities cannot safely drive the interrupt
          // fallback. Retain a bounded tombstone until thread lifecycle reset.
          this.turns.delete(event.params.threadId);
          this.conflicts.add(event.params.threadId);
          return;
        }
        this.turns.set(event.params.threadId, event.params.turn.id);
        return;
      case "turn/completed":
        this.end(event.params.threadId, event.params.turn.id);
        return;
      case "error":
        if (!event.params.willRetry) this.end(event.params.threadId, event.params.turnId);
        return;
      case "thread/archived": case "thread/deleted": case "thread/closed":
        this.delete(event.params.threadId);
        return;
    }
  }

  private end(threadId: string, turnId: string): void {
    if (this.conflicts.has(threadId)) return;
    if (this.turns.get(threadId) === turnId) this.turns.delete(threadId);
  }
}
