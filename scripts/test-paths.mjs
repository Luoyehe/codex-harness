import { validateRelative } from './release-audit.mjs';

// Keep collection, selection and execution on the same path grammar. Vitest
// accepts colocated browser tests and names containing spaces or Unicode.
export const javascriptTestPattern = /^(?:tests|web)\/.+\.test\.tsx?$/u;
export const pythonTestPattern = /^tests\/deploy\/(?:[^/]+\/)*test_[^/]+\.py$/u;
export function validateTestPath(name) {
  validateRelative(name);
  if (/[\x00-\x1f\x7f]/u.test(name)) throw Error('Control character in test path');
  return name;
}
