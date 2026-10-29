import { beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { initializeOperations } from '../lib/operations';

beforeEach(async () => {
  if (typeof window === 'undefined') return;
  // A fresh persistent-store adapter per test; individual tests can inject real IDB failures.
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: new IDBFactory() });
  localStorage.clear();
  await initializeOperations(2);
});
