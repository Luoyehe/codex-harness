import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { CallContext, HarnessEvent, JsonObject, JsonValue, Receipt, RpcCall, WorkerPort } from '../core/contracts.js';
import { HarnessError, errorBody } from '../core/errors.js';
import { Ledger } from '../core/ledger.js';
import { digest, identifier, object, uuid, validText } from '../core/validation.js';
import type { ManagerPort } from './manager-client.js';
import { receiptResult } from './receipt-result.js';
import { featureMethod } from '../core/feature-methods.js';
import { automationReads, automationWrites, automationSpec } from '../core/automations.js';
import { WorkspaceAcknowledgements } from './workspace-ack.js';
import { ReceiptMaintenance } from './receipt-maintenance.js';

const readMethods = new Set(['thread/list', 'thread/read', 'thread/history', 'model/list', 'defaults/read', 'account/read', 'account/rateLimits', 'mcp/list', 'prompt/list', 'attachment/read', 'runtime/status', 'project/defaults']);
const mutations = new Set(['conversation/start', 'thread/name/set', 'thread/archive', 'thread/unarchive', 'thread/compact', 'turn/start', 'account/login', 'account/login/cancel', 'account/logout', 'mcp/oauth', 'prompt/answer', 'attachment/upload', 'attachment/remove', 'terminal/open', 'project/add', 'project/create', 'project/remove', 'system/restart', 'system/provider/write', 'system/models/refresh']);
const volatile = new Set(['turn/interrupt', 'terminal/write', 'terminal/resize', 'terminal/close']);
const workMethods = new Set(['conversation/start', 'turn/start', 'thread/compact', 'terminal/open']);
const systemReads = new Set(['system/status', 'system/logs', 'system/provider/read']);
const projectMethods = new Set(['thread/list', 'conversation/start', 'defaults/read', 'terminal/open']);
interface Activity { activeThreads: string[]; pendingStarts: number; terminals: number; subscriptions: number; processes: number; unknown: boolean }
export class Dispatcher extends EventEmitter {
  readonly workspaceAcknowledgements: WorkspaceAcknowledgements;
  readonly receiptMaintenance: ReceiptMaintenance;
  #pendingWork = new Set<string>(); #maintenance = false;
  #automationHealth: JsonObject = { running: false, lastTickAt: null, lastError: null };
  #runtime: JsonValue = null; #activity: Activity = { activeThreads: [], pendingStarts: 0, terminals: 0, subscriptions: 0, processes: 0, unknown: true };
  constructor(readonly ledger: Ledger, readonly worker: WorkerPort, readonly manager: ManagerPort) { super(); this.workspaceAcknowledgements = new WorkspaceAcknowledgements(ledger, worker); this.receiptMaintenance = new ReceiptMaintenance(ledger); }
  event(event: HarnessEvent): void {
    if (event.type === 'state') {
      this.#runtime = event.data;
      try {
        object(event.data); object(event.data.activity); const activity = event.data.activity;
        if (!Array.isArray(activity.activeThreads) || !activity.activeThreads.every(x => typeof x === 'string') || typeof activity.pendingStarts !== 'number' || typeof activity.terminals !== 'number' || typeof activity.unknown !== 'boolean') throw new Error();
        if (activity.subscriptions !== undefined && (typeof activity.subscriptions !== 'number' || !Number.isSafeInteger(activity.subscriptions) || activity.subscriptions < 0)) throw new Error();
        if (activity.processes !== undefined && (typeof activity.processes !== 'number' || !Number.isSafeInteger(activity.processes) || activity.processes < 0)) throw new Error();
        this.#activity = { activeThreads: activity.activeThreads as string[], pendingStarts: activity.pendingStarts, terminals: activity.terminals, subscriptions: activity.subscriptions as number | undefined ?? 0, processes: activity.processes as number | undefined ?? 0, unknown: activity.unknown || event.data.connected !== true };
      } catch { this.#activity.unknown = true; }
    }
    this.emit('event', event.type === 'state' ? { type: 'state', data: this.status() } : event);
  }
  disconnected(): void { this.workspaceAcknowledgements.reconnected(); this.#activity.unknown = true; this.emit('event', { type: 'state', data: { connected: false, activity: { ...this.#activity } } }); }
  status(): JsonValue {
    const runtime = this.#runtime && typeof this.#runtime === 'object' && !Array.isArray(this.#runtime) ? this.#runtime : {};
    return { ...runtime, connected: this.worker.connected && runtime.connected === true, operationGeneration: this.ledger.operationGeneration(), activity: { ...this.#activity }, activityUncertain: this.ledger.getMeta('activityUncertain') === 'true', maintenance: this.#maintenance, automation: this.#automationHealth };
  }
  automationHealth(value: JsonObject): void { this.#automationHealth = value; this.emit('event', { type: 'automation', data: { health: value } }); }
  private replay(receipt: Receipt): JsonValue {
    if (receipt.state === 'accepted') return receipt.result ?? null;
    if (receipt.state === 'not_sent') throw new HarnessError(receipt.error?.code ?? 'not_sent', receipt.error?.message ?? '该操作未发送。');
    throw new HarnessError(receipt.state === 'unknown' ? 'operation_unknown' : 'operation_pending', '该操作结果尚未确认，请查询操作记录，不要重复提交。', 'unknown', receipt.error?.data);
  }
  async call(call: RpcCall, context: CallContext): Promise<JsonValue> {
    context.requireAuthorization?.();
    this.workspaceAcknowledgements.opportunistic(context);
    const { method, params } = call; const feature = featureMethod(method);
    if (method.startsWith('operation/maintenance/')) {
      if (method !== 'operation/maintenance/rotate') return this.receiptMaintenance.call(method, params, context);
      const rotation = this.receiptMaintenance.validateRotation(params, context);
      this.requireIdle(); this.#maintenance = true;
      try {
        await this.workspaceAcknowledgements.drain(context);
        context.requireConnection?.();
        const idle = await this.worker.call('runtime/maintenance/check', {}, context); object(idle); object(idle.workspaceWitness);
        if (idle.idle !== true || idle.workspaceWitness.total !== 0) throw new HarnessError('journal_busy', '仍有未确认的工作区记录，不能轮换回执。');
        context.requireConnection?.(); this.requireIdle(true);
        this.receiptMaintenance.validateRotation(params, context);
        context.requireAuthorization?.();
        const result = this.ledger.rotate(rotation); this.receiptMaintenance.forget(); return result;
      } finally { this.#maintenance = false; this.emit('event', { type: 'state', data: this.status() }); }
    }
    if (method === 'operation/retire') {
      if (Object.keys(params).some(key => key !== 'operationId')) throw new HarnessError('invalid', '阻止请求只接受操作编号。');
      const receipt = this.ledger.retire(uuid(params.operationId)); this.emitReceipt(receipt);
      return { ...receipt } as unknown as JsonValue;
    }
    if (method === 'operation/read') {
      const operationId = uuid(params.operationId); let saved = this.ledger.read(operationId);
      if (saved?.method.startsWith('system/') && saved.state === 'unknown') {
        try {
          const proof = await this.manager.call('operation/read', { operationId }, undefined, context.requireAuthorization); object(proof);
          if (proof.operationId === operationId && proof.method === saved.method.slice(7) && this.ledger.matchesDigest(operationId, proof.gatewayRequestDigest) && proof.state === 'completed' && Object.hasOwn(proof, 'result'))
            saved = this.ledger.confirm(operationId, receiptResult(saved.method, proof.result!));
        } catch { /* Preserve uncertainty until positive root-manager evidence exists. */ }
      }
      if (saved?.method.startsWith('workspace/') && saved.state === 'unknown') {
        try {
          context.requireConnection?.(); const proof = await this.worker.call('workspace/witness/read', { operationId }, context); object(proof);
          if (proof.operationId === operationId && proof.method === saved.method && saved.scope === 'project:' + proof.projectId && this.ledger.matchesDigest(operationId, proof.gatewayRequestDigest) && proof.state === 'completed' && Object.hasOwn(proof, 'result')) {
            saved = this.ledger.confirmWorkspace(operationId, saved.method, saved.scope, String(proof.gatewayRequestDigest), receiptResult(saved.method, proof.result!)); this.emitReceipt(saved);
          }
        } catch { /* Native-owned helper journals and absence are never acceptance proofs. */ }
      }
      if (saved?.state === 'accepted') await this.workspaceAcknowledgements.accepted(saved, context);
      return saved ? { ...saved } as unknown as JsonValue : { operationId, state: 'not_received' };
    }
    if (method === 'project/list') return { data: this.ledger.projects() } as unknown as JsonValue;
    if (method === 'workspace/worktree/list') {
      if (Object.keys(params).some(key => key !== 'projectId')) throw new HarnessError('invalid', '工作树列表只接受项目编号。');
      const project = this.ledger.project(identifier(params.projectId)); return this.ledger.worktrees.list(project.id);
    }
    if (method === 'automation/status') { if (Object.keys(params).length) throw new HarnessError('invalid', '状态查询不接受参数。'); return this.#automationHealth; }
    if (automationReads.has(method)) return this.ledger.automations.read(method, params);
    if (automationWrites.has(method)) return this.automation(call, context);
    if (systemReads.has(method)) {
      const result = await this.manager.call(method.slice(7), params, undefined, context.requireAuthorization);
      if (method !== 'system/status') return result;
      object(result); return { ...result, operationGeneration: this.ledger.operationGeneration(), journalUsage: this.ledger.usage() };
    }
    if (readMethods.has(method) || volatile.has(method) || feature?.access === 'read' || feature?.access === 'live') { context.requireConnection?.(); return this.worker.call(method, this.projectParams(method, params), context); }
    if (!mutations.has(method) && feature?.access !== 'write') throw new HarnessError('method_not_found', '不支持此操作。');
    const operationId = uuid(call.operationId); const scope = this.scope(method, params);
    const reserved = this.ledger.reserve(operationId, method, params, scope);
    if (!reserved.created) return this.replay(reserved.receipt);
    const startsWork = workMethods.has(method) || feature?.activity === 'start';
    const isWork = startsWork || feature?.activity === 'continue' || feature?.activity === 'idle';
    const rootManagement = method.startsWith('system/');
    const management = rootManagement || feature?.activity === 'configuration';
    let locked = false; let dispatched = false;
    try {
      // Recorded identities replay before connection admission. Only a new worker dispatch needs a live owner.
      if (!rootManagement && method !== 'project/remove') context.requireConnection?.();
      if ((isWork || management || feature?.access === 'write' || method.startsWith('account/') || method.startsWith('project/')) && this.#maintenance) throw new HarnessError('maintenance', '服务器正在变更配置，请稍后重试。');
      if (isWork && (this.ledger.getMeta('activityUncertain') === 'true' || this.#activity.unknown)) throw new HarnessError('activity_unknown', '后台任务状态需要核对，暂不能开始新任务。');
      if (isWork && (this.#pendingWork.has(scope) || ((startsWork || feature?.activity === 'idle') && this.#activity.activeThreads.includes(String(params.threadId))))) throw new HarnessError('thread_busy', '此会话已有正在执行或等待确认的任务。');
      if (management) {
        if (method !== 'system/restart' && (this.ledger.getMeta('activityUncertain') === 'true' || this.#activity.unknown)) throw new HarnessError('activity_unknown', '后台状态未知，请先检查并恢复服务。');
        // Explicit restart is the stop-confirmed recovery path, including when
        // the last worker snapshot still reports uncertain or active work.
        // Never race a gateway submission that has not settled yet.
        if (this.#pendingWork.size || (method !== 'system/restart' && (this.#activity.pendingStarts || this.#activity.activeThreads.length || this.#activity.terminals || this.#activity.subscriptions || this.#activity.processes)))
          throw new HarnessError('activity_busy', '请先结束任务和网页终端，再变更服务配置。');
        this.#maintenance = true; locked = true;
      } else if (isWork) { this.#pendingWork.add(scope); locked = true; }
      const recordDispatch = () => { if (!dispatched) { this.ledger.dispatch(operationId); dispatched = true; } };
      const beforeWrite = () => {
        context.requireAuthorization?.();
        if (!rootManagement && method !== 'project/remove') context.requireConnection?.();
        recordDispatch();
      };
      let result: JsonValue;
      if (method.startsWith('workspace/worktree/')) {
        const originId = identifier(params.projectId);
        if (method !== 'workspace/worktree/create') this.ledger.worktrees.require(originId, params.worktreeId);
        else if (this.ledger.projects().length >= 128) throw new HarnessError('capacity', '请先释放项目登记空间再创建工作树。');
      }
      if (method === 'project/create') {
        if (Object.keys(params).some(key => !['name', 'directory'].includes(key))) throw new HarnessError('invalid', '新建项目只接受项目名称和目录名。');
        const name = validText(params.name, 128, '项目名称').trim(), directory = validText(params.directory, 320, '目录名');
        if (!name) throw new HarnessError('invalid', '项目名称不能为空。');
        if (this.ledger.projects().length >= 128) throw new HarnessError('capacity', '项目数量已达上限，请先移除不再使用的项目。');
        const created = await this.worker.call('project/create', { directory }, { ...context, operationId, beforeWrite }); object(created);
        // Directory creation is already accepted even if the browser goes away.
        // Persist registration and its receipt without demanding a new lease.
        result = this.ledger.addProject(validText(created.path, 4096), name) as unknown as JsonValue;
      } else if (method === 'project/add') {
        if (Object.keys(params).some(key => !['name', 'path'].includes(key))) throw new HarnessError('invalid', '添加已有项目只接受项目名称和目录。');
        const path = validText(params.path, 4096, '项目路径');
        const resolved = await this.worker.call('project/resolve', { path }, context); object(resolved);
        const name = params.name === undefined ? validText(resolved.name, 128) : validText(params.name, 128, '项目名称').trim();
        if (!name) throw new HarnessError('invalid', '项目名称不能为空。');
        // Resolution is read-only; the local registration still needs its original live owner.
        beforeWrite(); result = this.ledger.addProject(validText(resolved.path, 4096), name) as unknown as JsonValue;
      } else if (method === 'project/remove') {
        const id = identifier(params.id); beforeWrite(); this.ledger.removeProject(id); result = {};
      } else if (rootManagement) result = await this.manager.call(method.slice(7), params, operationId, beforeWrite);
      else result = await this.worker.call(method, this.projectParams(method, params), { ...context, operationId, beforeWrite,
        ...(method.startsWith('workspace/') ? { gatewayRequestDigest: digest({ method, params }), projectId: identifier(params.projectId, '项目') } : {}) });
      // A positive backend acknowledgement is acceptance evidence even if its adapter omitted the boundary callback.
      // Authorization changes after dispatch cannot retroactively turn that success into an unsent operation.
      if (!dispatched) recordDispatch();
      const projected = receiptResult(method, result);
      const receipt = this.ledger.transaction(() => {
        if (method.startsWith('workspace/worktree/')) this.ledger.worktrees.apply(method, identifier(params.projectId), operationId, projected);
        return this.ledger.settle(operationId, { ok: true, value: projected });
      }); this.emitReceipt(receipt);
      await this.workspaceAcknowledgements.accepted(receipt, context, digest({ method, params }));
      return this.replay(receipt);
    } catch (error) {
      const body = errorBody(error, dispatched ? 'unknown' : 'not_sent');
      const current = this.ledger.read(operationId);
      if (current && ['pending', 'dispatching'].includes(current.state)) {
        const receipt = this.ledger.settle(operationId, { ok: false, error: body }); this.emitReceipt(receipt);
      }
      throw new HarnessError(body.code, body.message, body.delivery ?? (dispatched ? 'unknown' : 'not_sent'), body.data);
    } finally {
      if (locked && management) {
        this.#maintenance = false;
        this.emit('event', { type: 'state', data: this.status() });
      }
      if (locked && isWork) this.#pendingWork.delete(scope);
    }
  }
  private async automation(call: RpcCall, context: CallContext): Promise<JsonValue> {
    const { method, params } = call, operationId = uuid(call.operationId);
    const reserved = this.ledger.reserve(operationId, method, params, 'automation');
    if (!reserved.created) return this.replay(reserved.receipt);
    try {
      context.requireConnection?.();
      if (this.#maintenance) throw new HarnessError('maintenance', '回执或配置维护正在进行，请稍后重试。');
      if (method === 'automation/acknowledge' && (this.ledger.getMeta('activityUncertain') === 'true' || this.#activity.unknown || this.#pendingWork.size || this.#activity.pendingStarts || this.#activity.activeThreads.length || this.#activity.terminals || this.#activity.subscriptions || this.#activity.processes)) throw new HarnessError('activity_unknown', '请先核对会话并完成服务恢复，确认没有活动执行后才能关闭未知记录。');
      let projectId: string | undefined;
      if (method === 'automation/create' || method === 'automation/update' || method === 'automation/run' || method === 'automation/resume') {
        const spec = method === 'automation/create' || method === 'automation/update' ? automationSpec(params.spec!) : this.ledger.automations.get(uuid(params.id));
        projectId = spec.projectId; const project = this.ledger.project(projectId);
        await this.worker.call('automation/validate', { cwd: project.path, options: spec.options }, context);
      }
      // Definition changes, queued runs and their receipt commit in the same SQLite transaction.
      const receipt = this.ledger.transaction(() => {
        context.requireAuthorization?.(); context.requireConnection?.(); if (projectId) this.ledger.project(projectId);
        if (this.#maintenance) throw new HarnessError('maintenance', '回执或配置维护正在进行，请稍后重试。');
        this.ledger.dispatch(operationId);
        return this.ledger.settle(operationId, { ok: true, value: this.ledger.automations.command(method, params) });
      });
      this.emitReceipt(receipt); this.emit('automation-changed'); return this.replay(receipt);
    } catch (error) {
      const current = this.ledger.read(operationId);
      if (current?.state === 'accepted') return this.replay(current);
      const body = { ...errorBody(error), delivery: 'not_sent' as const };
      if (current?.state === 'pending') this.emitReceipt(this.ledger.settle(operationId, { ok: false, error: body }));
      throw new HarnessError(body.code, body.message, body.delivery, body.data);
    }
  }
  private emitReceipt(receipt: Receipt): void {
    this.emit('event', { type: 'receipt', data: { ...receipt } as unknown as JsonValue });
    this.emit('event', { type: 'state', data: this.status() });
  }
  maintenanceActive(): boolean { return this.#maintenance; }
  private requireIdle(locked = false): void {
    if ((!locked && this.#maintenance) || !this.worker.connected || this.#activity.unknown || this.ledger.getMeta('activityUncertain') === 'true' || this.#pendingWork.size || this.#activity.pendingStarts || this.#activity.activeThreads.length || this.#activity.terminals || this.#activity.subscriptions || this.#activity.processes)
      throw new HarnessError('journal_busy', '请先结束后台任务并恢复所有未知状态，再轮换回执。');
  }
  private scope(method: string, params: JsonObject): string {
    if (typeof params.threadId === 'string') return 'thread:' + identifier(params.threadId);
    if (typeof params.projectId === 'string') return 'project:' + identifier(params.projectId);
    if (method.startsWith('system/')) return 'system';
    return method;
  }
  private projectParams(method: string, params: JsonObject): JsonObject {
    if (method === 'skills/extraRoots/set') {
      if (Object.keys(params).some(key => !['projectIds', 'confirm'].includes(key)) || !Array.isArray(params.projectIds) || params.projectIds.length > 16 || new Set(params.projectIds).size !== params.projectIds.length) throw new HarnessError('invalid', '额外技能目录必须从已注册项目选择，最多 16 个。');
      return { roots: params.projectIds.map(id => this.ledger.project(identifier(id)).path), confirm: params.confirm ?? false };
    }
    if (['nativeProject/create', 'nativeProject/import', 'nativeProject/update'].includes(method)) {
      if (Object.hasOwn(params, 'roots') || Object.hasOwn(params, 'cwd') || Object.hasOwn(params, 'projectId')) throw new HarnessError('invalid', '原生项目根目录必须从已注册项目选择。');
      const next = { ...params }; delete next.projectIds;
      if (params.projectIds === undefined && method === 'nativeProject/update') return next;
      if (!Array.isArray(params.projectIds) || params.projectIds.length < 1 || params.projectIds.length > 32) throw new HarnessError('invalid', '请选择 1 到 32 个已注册项目。');
      const ids = params.projectIds.map(value => identifier(value, '项目')); if (new Set(ids).size !== ids.length) throw new HarnessError('invalid', '项目不能重复。');
      next.roots = ids.map(id => { const project = this.ledger.project(id); if (!path.isAbsolute(project.path)) throw new HarnessError('invalid', '注册项目路径不是绝对路径。'); return { path: path.normalize(project.path) }; });
      return next;
    }
    if (!projectMethods.has(method) && !featureMethod(method)?.project) return params;
    if (Object.hasOwn(params, 'cwd')) throw new HarnessError('invalid', '工作目录必须由已注册项目选择。');
    const project = this.ledger.project(identifier(params.projectId, '项目'));
    const next: JsonObject = { ...params, cwd: project.path };
    if (method !== 'conversation/start') delete next.projectId;
    return next;
  }
}
