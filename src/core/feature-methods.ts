import { extensionMethods } from './extension-methods.js';
import { organizationMethods } from './organization-methods.js';
import { processMethods } from './process-methods.js';
import { realtimeMethods } from './realtime-methods.js';
import { remoteMethods } from './remote-methods.js';
/** Public workflows, deliberately enumerated rather than an arbitrary native RPC tunnel. */
export interface FeatureMethod {
  access: 'read' | 'write' | 'live';
  activity?: 'start' | 'continue' | 'idle' | 'configuration';
  project?: boolean;
}
const read: FeatureMethod = Object.freeze({ access: 'read' });
const write: FeatureMethod = Object.freeze({ access: 'write' });
const idle: FeatureMethod = Object.freeze({ access: 'write', activity: 'idle' });
const start: FeatureMethod = Object.freeze({ access: 'write', activity: 'start' });
const continuation: FeatureMethod = Object.freeze({ access: 'write', activity: 'continue' });
const projectRead: FeatureMethod = Object.freeze({ access: 'read', project: true });
const projectWrite: FeatureMethod = Object.freeze({ access: 'write', activity: 'continue', project: true });
const methods: Readonly<Record<string, FeatureMethod>> = Object.freeze({
  ...extensionMethods,
  ...organizationMethods,
  ...processMethods,
  ...realtimeMethods,
  ...remoteMethods,
  'collaborationMode/list': read,
  'modelProvider/capabilities/read': read,
  'diagnostics/cli/run': Object.freeze({ access: 'write', activity: 'configuration' }),
  'diagnostics/cli/result/read': read,
  'permissionProfile/list': projectRead,
  'attachment/history/read': read,
  'account/login/handoff': read,
  'mcp/oauth/handoff': read,
  'mcp/tool/call': idle,
  'mcp/resource/read': read,
  'mcp/stream/start': continuation,
  'mcp/stream/stop': write,
  'mcp/stream/list': read,
  'mcp/result/read': read,
  'mcp/result/remove': write,
  'mcp/reload': Object.freeze({ access: 'write', activity: 'configuration' }),
  'thread/agents/list': read,
  'thread/shellCommand': start,
  'thread/guardian/list': read,
  'thread/prediction/request': idle,
  'thread/prediction/read': read,
  'thread/approveGuardianDeniedAction': idle,
  'thread/backgroundTerminals/list': read,
  'thread/backgroundTerminals/terminate': continuation,
  'thread/backgroundTerminals/clean': continuation,
  'thread/loaded/list': read,
  'thread/session': read,
  'thread/resume': continuation,
  'thread/search': Object.freeze({ access: 'read', project: true }),
  'thread/searchOccurrences': read,
  'thread/history/window': read,
  'thread/export': read,
  'thread/queue/list': read,
  'thread/goal/get': read,
  'turn/steer': continuation,
  'thread/queue/add': continuation,
  'thread/queue/update': continuation,
  'thread/queue/delete': write,
  'thread/queue/reorder': write,
  'thread/queue/start': start,
  'thread/goal/set': continuation,
  'thread/goal/clear': continuation,
  'thread/fork': idle,
  'thread/revert': idle,
  'thread/delete': idle,
  'thread/unsubscribe': idle,
  'thread/readState/update': write,
  'thread/metadata/update': write,
  'thread/settings/update': continuation,
  'turn/settings/update': continuation,
  'review/start': start,
  'review/startNew': Object.freeze({ access: 'write', activity: 'start', project: true }),
  'workspace/list': projectRead,
  'workspace/search': projectRead,
  'workspace/read': projectRead,
  'workspace/download': projectRead,
  'workspace/metadata': projectRead,
  'workspace/git/status': projectRead,
  'workspace/git/diff': projectRead,
  'workspace/git/refs': projectRead,
  'workspace/git/commit': Object.freeze({ access: 'write', activity: 'configuration', project: true }),
  'workspace/git/stage': Object.freeze({ access: 'write', activity: 'configuration', project: true }),
  'workspace/git/unstage': Object.freeze({ access: 'write', activity: 'configuration', project: true }),
  'workspace/git/index/recovery/list': projectRead,
  'workspace/git/index/recovery/read': projectRead,
  'workspace/git/index/recovery/restore': Object.freeze({ access: 'write', activity: 'configuration', project: true }),
  'workspace/git/index/recovery/discard': Object.freeze({ access: 'write', activity: 'configuration', project: true }),
  'workspace/operation/read': projectRead,
  'workspace/recovery/list': projectRead,
  'workspace/recovery/read': projectRead,
  'workspace/write': projectWrite,
  'workspace/mkdir': projectWrite,
  'workspace/copy': projectWrite,
  'workspace/remove': projectWrite,
  'workspace/recovery/restore': projectWrite,
  'workspace/recovery/discard': projectWrite,
  'workspace/worktree/list': projectRead,
  'workspace/worktree/read': projectRead,
  'workspace/worktree/create': Object.freeze({ access: 'write', activity: 'configuration', project: true }),
  'workspace/worktree/attach': Object.freeze({ access: 'write', activity: 'configuration', project: true }),
  'workspace/worktree/archive': Object.freeze({ access: 'write', activity: 'configuration', project: true }),
  'workspace/worktree/restore': Object.freeze({ access: 'write', activity: 'configuration', project: true }),
});
export function featureMethod(method: string): FeatureMethod | undefined {
  return Object.hasOwn(methods, method) ? methods[method] : undefined;
}
