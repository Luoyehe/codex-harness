import type { FeatureMethod } from './feature-methods.js';
export const remoteMethods: Readonly<Record<string, FeatureMethod>> = Object.freeze({
  'environment/add': { access: 'write', activity: 'configuration' }, 'environment/info': { access: 'write', activity: 'configuration' },
  'environment/list': { access: 'read' }, 'environment/read': { access: 'read' }, 'environment/status': { access: 'read' },
  'remoteControl/status/read': { access: 'read' },
  'remoteControl/enable': { access: 'write', activity: 'configuration' }, 'remoteControl/disable': { access: 'write', activity: 'configuration' },
  'remoteControl/pairing/start': { access: 'write', activity: 'configuration' }, 'remoteControl/pairing/read': { access: 'read' }, 'remoteControl/pairing/status': { access: 'read' },
  'remoteControl/client/list': { access: 'read' }, 'remoteControl/client/revoke': { access: 'write', activity: 'configuration' },
});
