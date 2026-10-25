export const workflowMethods = new Set([
  'collaborationMode/list', 'turn/steer', 'turn/settings/update',
  'thread/queue/list', 'thread/queue/add', 'thread/queue/update', 'thread/queue/delete', 'thread/queue/reorder', 'thread/queue/start',
  'thread/goal/get', 'thread/goal/set', 'thread/goal/clear', 'thread/fork', 'thread/revert',
  'review/start', 'review/startNew', 'thread/agents/list', 'thread/settings/update', 'thread/metadata/update',
  'thread/search', 'thread/searchOccurrences', 'thread/history/window', 'thread/export',
  'thread/loaded/list', 'thread/delete', 'thread/unsubscribe', 'thread/readState/update', 'modelProvider/capabilities/read', 'permissionProfile/list',
]);
export const threadSettingsKeys = ['threadId', 'disabledPluginIds', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy', 'permissions', 'model', 'serviceTier', 'effort', 'summary', 'collaborationMode'];
export const turnSettingsKeys = ['threadId', 'turnId', 'approvalsReviewer', 'model', 'effort', 'summary', 'serviceTier'];
