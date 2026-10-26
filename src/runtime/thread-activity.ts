import { DeliveryError } from './types.js';

export interface Activity {
  status: string;
  turnId: string | null;
  pending: boolean;
  unknown: boolean;
  revision: number;
  historyMode?: string;
  historyRevision?: number;
  fresh?: boolean;
  directInput?: boolean | null;
  goalActive?: boolean;
  goalRevision?: number;
  goalPending?: boolean;
  queued?: boolean;
  checkingContinuation?: boolean;
  continuationRevision?: number;
  subscribed?: boolean;
  settingsRevision?: number;
  activeModel?: string;
  modelRevision?: number;
}

// Idle metadata does not settle an accepted turn; its matching completion does.
export const hasTurnActivity = (state: Activity): boolean =>
  state.turnId !== null || state.status === 'active';

/** Live/uncertain state is never evicted. Historical metadata has an LRU lifetime. */
export class ThreadActivity {
  private entries = new Map<string, Activity>();
  private readers = new Map<string, number>();
  private successfulReads = new WeakSet<Activity>();

  constructor(
    private readonly retained: (id: string) => boolean,
    private readonly evicted: (id: string) => void,
    private readonly maximum = 2048,
  ) {}

  get size(): number { return this.entries.size; }
  values(): IterableIterator<Activity> { return this.entries.values(); }
  [Symbol.iterator](): IterableIterator<[string, Activity]> { return this.entries.entries(); }

  private disposable(id: string, state: Activity): boolean {
    return !hasTurnActivity(state) && !state.pending && !state.unknown &&
      !state.goalActive && !state.queued && !state.checkingContinuation &&
      state.subscribed !== true && !this.readers.has(id) && !this.retained(id);
  }

  private remove(id: string): void {
    this.entries.delete(id);
    this.evicted(id);
  }

  track(id: string): Activity {
    const existing = this.entries.get(id);
    if (existing) {
      this.entries.delete(id);
      this.entries.set(id, existing);
      return existing;
    }
    if (this.entries.size >= this.maximum) {
      for (const [candidate, state] of this.entries) {
        if (!this.disposable(candidate, state)) continue;
        this.remove(candidate);
        break;
      }
    }
    if (this.entries.size >= this.maximum) {
      // Capacity is not evidence that already tracked work became unknown.
      throw new DeliveryError('activity_capacity', 'Close an inactive loaded thread before opening another thread');
    }
    const state: Activity = { status: 'notLoaded', turnId: null, pending: false, unknown: false, revision: 0 };
    this.entries.set(id, state);
    return state;
  }

  async read<T>(id: string, operation: (state: Activity) => Promise<T>): Promise<T> {
    const state = this.track(id);
    this.readers.set(id, (this.readers.get(id) ?? 0) + 1);
    try {
      const result = await operation(state);
      this.successfulReads.add(state);
      return result;
    }
    finally {
      const count = this.readers.get(id)! - 1;
      if (count) this.readers.set(id, count); else this.readers.delete(id);
      // A successfully read cold thread legitimately remains notLoaded. Keep
      // its history proof until normal LRU eviction, including when another
      // concurrent read fails after that successful result has arrived.
      if (!this.successfulReads.has(state) && state.status === 'notLoaded' && state.revision === 0 && this.disposable(id, state)) this.remove(id);
    }
  }
}
