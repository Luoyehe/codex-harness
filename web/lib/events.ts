import { useEffect } from 'react';
import type { HarnessEvent } from './types';
export class Events {
  private listeners = new Set<(event: HarnessEvent) => void>();
  publish(event: HarnessEvent) { this.listeners.forEach(listener => listener(event)); }
  subscribe(listener: (event: HarnessEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
export function useSubscription(events: Events, listener: (event: HarnessEvent) => void) {
  useEffect(() => events.subscribe(listener), [events, listener]);
}
