import { beforeEach } from 'vitest';

beforeEach(async () => {
  if (typeof window === 'undefined') return;
  const [{ IDBFactory }, { initializeOperations }] = await Promise.all([import('fake-indexeddb'), import('../lib/operations')]);
  // A fresh persistent-store adapter per test; individual tests can inject real IDB failures.
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: new IDBFactory() });
  localStorage.clear();
  await initializeOperations(2);
});
