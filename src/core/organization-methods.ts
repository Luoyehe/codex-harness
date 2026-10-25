import type { FeatureMethod } from './feature-methods.js';
const read: FeatureMethod = Object.freeze({ access: 'read' });
const write: FeatureMethod = Object.freeze({ access: 'write', activity: 'continue' });
export const organizationMethods: Readonly<Record<string, FeatureMethod>> = Object.freeze({
  'nativeProject/list': read, 'nativeProject/read': read,
  'nativeProject/create': write, 'nativeProject/import': write, 'nativeProject/update': write, 'nativeProject/move': write, 'nativeProject/delete': write,
  'thread/project/set': write,
  'threadSection/list': read, 'threadSection/create': write, 'threadSection/update': write, 'threadSection/delete': write,
  'thread/section/move': write,
  'thread/attachment/list': read, 'thread/attachment/add': write, 'thread/attachment/remove': write,
  'thread/attachmentOwner/list': Object.freeze({ access: 'read', project: true }),
  'thread/memoryMode/set': Object.freeze({ access: 'write', activity: 'idle' }),
});
