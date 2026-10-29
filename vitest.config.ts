import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  setupFiles: ['web/tests/operation-setup.ts'],
  include: ['tests/**/*.test.ts', 'web/**/*.test.ts', 'web/**/*.test.tsx'],
  testTimeout: 15000, hookTimeout: 15000, maxWorkers: 4,
  environment: 'node', clearMocks: true, restoreMocks: true,
}});
