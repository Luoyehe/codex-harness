import type { ObservedNotification } from "./protocol.js";

/** Connection-scoped turn identity. Retryable errors do not end a turn. */
export class ActiveTurns {
  private readonly turns = new Map<string, string>();

  get(threadId: string): string | null { return this.turns.get(threadId) ?? null; }
  delete(threadId: string): void { this.turns.delete(threadId); }
  clear(): void { this.turns.clear(); }

  observe(event: ObservedNotification): void {
    switch (event.method) {
      case "turn/started":
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
    if (this.turns.get(threadId) === turnId) this.turns.delete(threadId);
  }
}
