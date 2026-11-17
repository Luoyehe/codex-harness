import { useEffect } from 'react';
import type { HarnessEvent } from './types';
export class Events {
  private listeners = new Set<(event: HarnessEvent) => void>();
  publish(event: HarnessEvent) {
    for (const listener of this.listeners) {
      try { listener(event); }
      catch {
        // A broken view is not a transport failure. Keep other owners supplied
        // with lifecycle facts and expose a bounded diagnostic without payloads.
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('harness-view-error'));
      }
    }
  }
  subscribe(listener: (event: HarnessEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
export function useSubscription(events: Events, listener: (event: HarnessEvent) => void) {
  useEffect(() => events.subscribe(listener), [events, listener]);
}
