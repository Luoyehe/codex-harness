import type { NativeOptions } from './native.js';
import type { ProviderSwitchPlan } from './providers.js';
import { canonical, DeliveryError, object, string, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';

export interface ProviderSwitchHost {
  call(method: string, params: JsonObject, options: NativeOptions): Promise<JsonValue>;
  /** Recheck the caller's pending lock, epoch, activity and history, without marking a write. */
  check(): void;
  beforeWrite(phase: 'detach' | 'resume'): void;
  onDetached(): void;
  /** Capture settings and rehydrate the invalidated history proof before allowing a turn. */
  afterResume(result: JsonObject): Promise<void>;
}

const preserved = ['cwd', 'runtimeWorkspaceRoots', 'approvalPolicy', 'approvalsReviewer', 'sandbox', 'activePermissionProfile', 'disabledPluginIds'] as const;

/** Called under the existing per-thread mutation lock. It never sends user input. */
export async function switchThreadProvider(plan: ProviderSwitchPlan, snapshot: JsonObject, host: ProviderSwitchHost): Promise<JsonObject> {
  const thread = object(snapshot.thread), threadId = string(thread.id, 'threadId');
  if (snapshot.requiresResume === true || snapshot.modelProvider !== plan.sourceProvider || preserved.some(key => snapshot[key] === undefined))
    throw new DeliveryError('session_not_loaded', '请先加载当前会话设置，再选择新的模型。');
  const resume: JsonObject = { threadId, excludeTurns: true, modelProvider: plan.modelProvider, model: plan.model,
    ...(Object.keys(plan.config).length ? { config: plan.config } : {}) };
  validateOfficial('ThreadResumeParams', resume);
  const deadline = Date.now() + 30000;
  let dispatched = false;
  const check = (): void => {
    host.check();
    if (Date.now() >= deadline) throw new DeliveryError('provider_switch_timeout', '切换模型供应商超时，请核对会话状态。');
  };
  const call = async (method: string, params: JsonObject, phase?: 'detach' | 'resume'): Promise<JsonValue> => {
    check();
    const result = await host.call(method, params, { timeoutMs: Math.max(1, deadline - Date.now()), beforeWrite: () => {
      check(); if (phase) { host.beforeWrite(phase); dispatched = true; }
    } });
    check(); return result;
  };
  const idle = async (): Promise<void> => {
    const goal = object(await call('thread/goal/get', { threadId })); validateOfficial('ThreadGoalGetResponse', goal);
    if (goal.goal !== null && object(goal.goal).threadId !== threadId) throw new DeliveryError('invalid_native_response', 'Goal identity changed during provider selection');
    const queue = object(await call('thread/queue/list', { threadId, limit: 1 })); validateOfficial('ThreadQueueListResponse', queue);
    const current = object(await call('thread/read', { threadId })); validateOfficial('ThreadReadResponse', current);
    const currentThread = object(current.thread);
    if (currentThread.id !== threadId || currentThread.modelProvider !== plan.sourceProvider || currentThread.cwd !== snapshot.cwd)
      throw new DeliveryError('thread_changed', '会话已变化，请重新读取后选择模型。');
    if (object(currentThread.status).type !== 'idle' && object(currentThread.status).type !== 'notLoaded' ||
        goal.goal !== null && object(goal.goal).status === 'active' || (queue.data as JsonValue[]).length || queue.nextCursor !== null)
      throw new DeliveryError('thread_busy', '请先处理当前会话的运行任务、目标或队列，再切换模型。');
  };
  try {
    await idle();
    const detached = await call('thread/unsubscribe', { threadId }, 'detach'); validateOfficial('ThreadUnsubscribeResponse', detached);
    host.onDetached();
    // Unsubscribe does not prove unloading. In 0.164, resume with changed
    // provider overrides shuts down an idle unsubscribed cache entry before
    // rebuilding it. A remaining subscriber keeps the old provider; verify
    // the response instead of ever submitting a turn to that old provider.
    const result = object(await call('thread/resume', resume, 'resume')); validateOfficial('ThreadResumeResponse', result);
    const next = object(result.thread);
    if (next.id !== threadId || result.modelProvider !== plan.modelProvider || next.modelProvider !== plan.modelProvider || result.model !== plan.model)
      throw new DeliveryError('provider_switch_unconfirmed', '模型供应商切换未得到确认，可能仍有其它客户端占用会话。');
    for (const key of preserved) if (canonical(result[key]!) !== canonical(snapshot[key]!))
      throw new DeliveryError('provider_switch_settings_changed', '重新加载后的会话权限或工作目录发生变化，请核对后继续。');
    if (canonical(next.environments ?? null) !== canonical(thread.environments ?? null))
      throw new DeliveryError('provider_switch_settings_changed', '重新加载后的会话执行环境发生变化，请核对后继续。');
    await host.afterResume(result);
    check(); return result;
  } catch (error) {
    if (dispatched) throw new DeliveryError(error instanceof DeliveryError ? error.code : 'provider_switch_unconfirmed',
      '会话模型切换已开始，但未能完整确认；本次消息尚未发送，请核对会话和原操作状态后继续。', 'unknown', { inputSent: false });
    throw error;
  }
}
