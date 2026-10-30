import { automationReads } from '../core/automations.js';
import { featureMethod } from '../core/feature-methods.js';
import { HarnessError } from '../core/errors.js';

const reads = new Set([
  'thread/list', 'thread/read', 'thread/history', 'model/list', 'defaults/read',
  'account/read', 'account/rateLimits', 'mcp/list', 'prompt/list', 'attachment/read', 'runtime/status',
  'system/status', 'system/logs', 'system/provider/read', 'system/execution-mode/read', 'project/list', 'project/defaults', 'workspace/worktree/list',
  'automation/status', 'operation/read', 'operation/maintenance/preview', 'operation/maintenance/chunk',
]);
/** Old documents cannot create side effects after the browser retires their storage namespace. */
export function requireRecoveryProtocol(method: string, version: string | undefined) {
  if (version === '2' || reads.has(method) || automationReads.has(method) || featureMethod(method)?.access === 'read') return;
  throw new HarnessError('client_update_required', '此页面的操作恢复协议已过期，请刷新页面后重试；本次请求尚未发送。', 'not_sent');
}
