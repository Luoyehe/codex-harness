import type { FeatureMethod } from './feature-methods.js';
export const processMethods: Readonly<Record<string, FeatureMethod>> = Object.freeze({
  'process/spawn': { access: 'write', activity: 'continue', project: true },
  'process/list': { access: 'read' }, 'process/read': { access: 'read' },
  'process/writeStdin': { access: 'write' }, 'process/resizePty': { access: 'write' }, 'process/kill': { access: 'write' }, 'process/remove': { access: 'write' },
});
