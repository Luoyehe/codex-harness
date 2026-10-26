import { useSyncExternalStore } from 'react';

export type EnterBehavior = 'send' | 'newline';
const key = 'harness.enter-behavior',
  eventName = 'harness-input-preference';
let memory: EnterBehavior = 'send';
let volatile = false;
function read(): EnterBehavior {
  if (volatile) return memory;
  try {
    const value = localStorage.getItem(key);
    return value === 'newline' ? 'newline' : value === 'send' ? 'send' : memory;
  } catch {
    return memory;
  }
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) {
      volatile = false;
      listener();
    }
  };
  window.addEventListener(eventName, listener);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(eventName, listener);
    window.removeEventListener('storage', storage);
  };
}
export function setEnterBehavior(value: EnterBehavior): boolean {
  memory = value;
  let saved = true;
  try {
    localStorage.setItem(key, value);
    volatile = false;
  } catch {
    saved = false;
    volatile = true;
  }
  window.dispatchEvent(new Event(eventName));
  return saved;
}
export function useEnterBehavior(): EnterBehavior {
  return useSyncExternalStore(subscribe, read, () => 'send');
}
