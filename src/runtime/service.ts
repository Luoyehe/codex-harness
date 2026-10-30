import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { NativeRpc, type NativeConfig, type NativeOptions } from './native.js';
import { Attachments, type PreparedAttachments } from './attachments.js';
import { options, supportedPrompt, validateOfficial, validatePrompt } from './validation.js';
import { canonical, DeliveryError, integer, jsonBytes, LIMITS, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue, type RuntimeEvent } from './types.js';
import { DiagnosticRedactor } from './redaction.js';
import { resolveNativeProject } from './native-launch.js';
import { createProject, resolveProject } from './projects.js';
import { Workflows, type WorkflowMutation } from './workflows.js';
import { workflowMethods } from './workflow-methods.js';
import { SessionSnapshots } from './session-snapshots.js';
import { RuntimeWorkspace } from './workspace-service.js';
import { devResource } from './dev-resources.js';
import { previewProjectPlugin, readSkillResource, resolveProjectDirectory } from './skill-resources.js';
import { Extensions } from './extensions.js';
import { extensionMethods } from '../core/extension-methods.js';
import { Mcp, mcpMethods } from './mcp.js';
import { Organization, type MetadataMutation } from './organization.js';
import { organizationMethods } from '../core/organization-methods.js';
import { Processes } from './processes.js';
import { processMethods } from '../core/process-methods.js';
import { InputContext } from './input-context.js';
import { Realtime } from './realtime.js';
import { realtimeMethods } from '../core/realtime-methods.js';
import { remoteMethods } from '../core/remote-methods.js';
import { Environments } from './environments.js';
import { RemoteControl } from './remote-control.js';
import { ThreadTerminals, threadTerminalMethods } from './thread-terminals.js';
import { Guardian, guardianMethods } from './guardian.js';
import { CliTerminals } from './cli-terminals.js';
import { featureMethod } from '../core/feature-methods.js';
import { UnifiedHistory } from './history.js';
import { mediaModalities, selectedInputModel, validateInputModalities } from './input-modalities.js';
import { CliDiagnostics, cliDiagnosticMethods } from './cli-diagnostics.js';
import { DeviceLogin } from './device-login.js';
import { McpOauth } from './mcp-oauth.js';
import { Predictions, predictionMethods } from './predictions.js';
import { ThreadActivity, hasTurnActivity, type Activity } from './thread-activity.js';
import { ManagedProviders, readNativeCatalog } from './providers.js';

export interface RuntimeConfig extends NativeConfig { workerHome: string; nativeHome?: string; shell?: string; attachmentGid?: number; providerRegistry?: JsonObject }
interface Prompt { promptId: string; epoch: string; method: string; params: JsonObject; threadId: string | null; turnId: string | null; requestId: string | number; bytes: number; answering: boolean }
interface Terminal { terminalId: string; clientId: string; eventChannelId: string | undefined; generation: number; ended: boolean }
export class RuntimeService extends EventEmitter {
  readonly epoch = randomUUID();
  private activity = new ThreadActivity(
    id => this.realtime?.has(id) || this.continuationChecks.has(id) ||
      this.predictions?.activeThreads().includes(id) || [...this.prompts.values()].some(prompt => prompt.threadId === id),
    id => {
      this.historyStore.invalidate(id);
      this.sessions.invalidate(id);
      this.guardian?.invalidate(id);
      this.predictions?.invalidate(id);
    },
  );
  private prompts = new Map<string, Prompt>();
  private terminals = new Map<string, Terminal>();
  private generations = new Map<string, number>();
  private promptBytes = 0;
  private pendingStarts = 0;
  private unknown = false;
  private restarting = false;
  private closed = false;
  private attachments: Attachments;
  private defaultsCache = new Map<string, JsonValue>();
  private defaultsPending = false;
  private defaultsProbe: NativeRpc | undefined;
  private providers: ManagedProviders;
  private catalogProbes = new Map<string, Promise<JsonObject[]>>();
  private catalogProcesses = new Set<NativeRpc>();
  private closePromise: Promise<void> | undefined;
  private historyStore: UnifiedHistory;
  private gcTimer: NodeJS.Timeout;
  private redactor: DiagnosticRedactor;
  private workflows: Workflows;
  private extensions: Extensions;
  private mcp: Mcp;
  private organization: Organization;
  private processes: Processes;
  private inputContext: InputContext;
  private realtime: Realtime;
  private environments: Environments;
  private remoteControl: RemoteControl;
  private threadTerminals: ThreadTerminals;
  private guardian: Guardian;
  private cliTerminals: CliTerminals;
  private cliDiagnostics: CliDiagnostics;
  private deviceLogin: DeviceLogin;
  private mcpOauth: McpOauth;
  private predictions: Predictions;
  private configurationPending = false;
  private workspace: RuntimeWorkspace;
  private sessions = new SessionSnapshots();
  private continuationChecks = new Map<string, Promise<void>>();
  constructor(readonly config: RuntimeConfig, readonly native: NativeRpc) {
    super();
    this.providers = new ManagedProviders(config.providerRegistry);
    this.workspace = new RuntimeWorkspace({
      config, cwd: value => this.cwd(value), admit: () => this.admit(),
      configure: (operation, context) => this.configurationMutation((_write, boundary) => operation(boundary), context),
      pending: change => { this.pendingStarts += change; this.emitState(); },
      uncertain: () => { this.unknown = true; },
    });
    this.historyStore = new UnifiedHistory({ native: (method, params) => this.native.call(method, params), state: id => this.track(id), observe: (value, revision) => this.observeThread(value, revision), checkTurns: turns => this.checkHistory(turns), closed: () => this.closed }); this.attachments = new Attachments(config.workerHome, config.attachmentGid); this.redactor = new DiagnosticRedactor(config.env);
    this.workflows = new Workflows({ native: (method, params, options) => this.native.call(method, params, options), mutate: (operation, context) => this.workflowMutation(operation, context), call: (method, params, context) => this.call(method, params, context), prepare: (ids, threadId) => this.attachments.prepare(ids, threadId), describeInput: (input, threadId) => this.attachments.describeInput(input, threadId), contextInput: (cwd, references, extra, context, threadId) => this.inputContext.prepare(cwd, references, extra, context, threadId), checkHistory: turns => this.checkHistory(turns), cwd: value => this.cwd(value) });
    this.extensions = new Extensions({ native: (method, params, options) => this.native.call(method, params, options), configure: (operation, context) => this.configurationMutation(operation, context), cwd: value => this.cwd(value), redactor: this.redactor, notify: (method, params) => this.emitEvent('notification', { method, params }),
      resource: async (cwd, action, params) => {
        const root = { path: this.cwd(cwd) }, context = { clientId: 'internal-resource' };
        if (!this.config.launcher && this.config.dev) return devResource(root.path, action, params, [path.join(this.config.env.HOME ?? this.config.workerHome, '.agents', 'skills'), path.join(this.config.home, 'skills'), path.join(this.config.home, 'plugins', 'cache')]);
        if (action === 'resource/skill/read') return readSkillResource(this.config, root, params, context);
        if (action === 'resource/directory/resolve') return resolveProjectDirectory(this.config, root, string(params.path, 'relative directory', 4096, true), context);
        if (action === 'resource/plugin/preview') return previewProjectPlugin(this.config, root, string(params.path, 'plugin directory', 4096, true), context);
        throw new DeliveryError('method_not_found', 'Unknown scoped resource action');
      } });
    this.inputContext = new InputContext({ extension: (method, params, context) => this.extensions.call(method, params, context), file: (cwd, relative, context) => this.call('workspace/read', { cwd, path: relative }, context) });
    this.organization = new Organization({ native: (method, params, options) => this.native.call(method, params, options), mutate: (operation, context) => this.workflowMutation(operation, context), metadata: (operation, context) => this.metadataMutation(operation, context), cwd: value => this.cwd(value) });
    this.mcp = new Mcp({ native: (method, params, options) => this.native.call(method, params, options), mutate: (operation, context) => this.workflowMutation(operation, context), configure: (operation, context) => this.configurationMutation(operation, context),
      requireLoaded: threadId => { this.admit(); if (this.track(threadId).subscribed !== true) throw new DeliveryError('session_not_loaded', 'Explicitly load this thread before using its MCP connections'); },
      emit: (data, channel) => this.emitEvent('mcp', data, channel), changed: () => this.emitState(), failEpoch: async () => { this.unknown = true; this.emitState(); this.emit('fatal'); await this.close(); } });
    this.processes = new Processes({ native: (method, params, options) => this.native.call(method, params, options), start: (operation, context) => this.metadataMutation(operation, context), cwd: value => this.cwd(value), available: () => this.admit(), emit: (data, channel) => this.emitEvent('process', data, channel), changed: () => this.emitState(), failEpoch: async () => { this.unknown = true; this.emitState(); this.emit('fatal'); await this.close(); } });
    this.realtime = new Realtime({ native: (method, params, options) => this.native.call(method, params, options), mutate: (operation, context) => this.workflowMutation(operation, context), available: () => this.admit(), invalidate: threadId => this.invalidateHistory(threadId),
      requireLoaded: threadId => { this.admit(); if (this.track(threadId).subscribed !== true) throw new DeliveryError('session_not_loaded', 'Explicitly load the thread before starting voice'); },
      emit: (data, channel) => this.emitEvent('realtime', data, channel), changed: () => this.emitState(), failEpoch: async () => { this.unknown = true; this.emitState(); this.emit('fatal'); await this.close(); } });
    const remoteHost = { native: (method: string, params: JsonValue, options?: NativeOptions) => this.native.call(method, params, options), configure: (operation: (write: (method: string, params: JsonValue, options?: NativeOptions) => Promise<JsonValue>) => Promise<JsonValue>, context: CallContext) => this.configurationMutation(operation, context), redactor: this.redactor };
    this.environments = new Environments(remoteHost); this.remoteControl = new RemoteControl(remoteHost);
    this.threadTerminals = new ThreadTerminals({ native: (method, params, options) => this.native.call(method, params, options), mutate: (operation, context) => this.workflowMutation(operation, context) });
    this.guardian = new Guardian({ mutate: (operation, context) => this.workflowMutation(operation, context) });
    this.cliTerminals = new CliTerminals({ bin: config.bin, native: (method, params, options) => method === 'account/read' ? this.readAccount() : this.native.call(method, params, options), start: (operation, context) => this.metadataMutation(operation, context, true), available: () => this.admit(undefined, false, false, true), cwd: value => this.cwd(value), emit: (data, channel) => this.emitEvent('terminal', data, channel), changed: () => this.emitState(),
      settled: () => {
        // The CLI can edit native configuration and sessions independently. Its
        // confirmed exit requires a fresh epoch, not a permanent unknown state.
        if (this.closed || this.restarting) return;
        this.restarting = true; this.defaultsCache.clear(); this.sessions.clear(); this.historyStore.clear(); this.guardian.invalidateAll(); this.predictions.invalidate(); this.emitState(); this.emit('restart-required');
      }, failEpoch: async () => { this.unknown = true; this.emitState(); this.emit('fatal'); await this.close(); } });
    this.cliDiagnostics = new CliDiagnostics({ bin: config.bin, cwd: config.nativeHome ?? config.workerHome, native: (method, params, options) => this.native.call(method, params, options), redactor: this.redactor, configure: (operation, context) => this.configurationMutation(operation, context, false), available: () => this.admit(undefined, false, true), failEpoch: async () => { this.unknown = true; this.emitState(); this.emit('fatal'); await this.close(); } });
    this.deviceLogin = new DeviceLogin({ native: (method, params, options) => this.native.call(method, params, options), redactor: this.redactor });
    this.mcpOauth = new McpOauth({ epoch: this.epoch, redactor: this.redactor, notify: (params, channel) => this.emitEvent('mcp', { type: 'oauth-completed', ...params }, channel) });
    this.predictions = new Predictions({ native: (method, params) => this.native.call(method, params), mutate: (operation, context) => this.workflowMutation(operation, context), revision: threadId => this.track(threadId).revision, emit: (data, channel) => this.emitEvent('prediction', data, channel), changed: () => this.emitState(), unknown: () => { this.unknown = true; this.emitState(); } });
    native.on('notification', (message: JsonObject) => {
      try { this.notification(message); }
      catch (error) {
        if (!(error instanceof DeliveryError) || error.code !== 'activity_capacity') throw error;
        // An unsolicited native thread cannot be ignored when every retained
        // slot describes live/uncertain work. Unlike read pressure, this is an
        // actual loss of activity knowledge and must close execution admission.
        this.unknown = true; this.emitState();
      }
    });
    native.on('request', (message: JsonObject) => { void this.serverRequest(message).catch(() => { this.unknown = true; this.emitState(); void this.native.close(); }); });
    native.on('fatal', () => {
      this.unknown = true; for (const item of this.activity.values()) if (item.pending || hasTurnActivity(item)) item.unknown = true;
      this.sessions.clear();
      this.mcp.reset();
      this.processes.reset();
      this.realtime.reset();
      this.guardian.reset();
      this.predictions.reset();
      this.cliTerminals.reset();
      this.cliDiagnostics.reset();
      this.environments.reset(); this.remoteControl.reset();
      this.extensions.close(); this.deviceLogin.close(); this.mcpOauth.close();
      this.historyStore.clear();
      for (const prompt of [...this.prompts.values()]) this.closePrompt(prompt, 'runtime_lost');
      for (const terminal of this.terminals.values()) this.emitEvent('terminal', { terminalId: terminal.terminalId, clientId: terminal.clientId, type: 'error', error: 'Native runtime disconnected' }, terminal.eventChannelId);
      this.terminals.clear(); this.emitState(); this.emit('fatal');
    });
    this.gcTimer = setInterval(() => { try { this.attachments.gc(); } catch { this.emit('diagnostic', 'Attachment collection failed'); } }, 60 * 60 * 1000); this.gcTimer.unref();
  }
  static async create(config: RuntimeConfig): Promise<RuntimeService> {
    const native = new NativeRpc(config); let service: RuntimeService | undefined;
    try { service = new RuntimeService(config, native); await native.initialize(); service.emitState(); return service; } catch (error) { if (service) await service.close(); else await native.close(); throw error; }
  }
  status(): JsonValue {
    const activeThreads = new Set([...this.activity].filter(([, value]) => hasTurnActivity(value) || value.pending || value.unknown || value.goalActive || value.queued || value.checkingContinuation).map(([id]) => id));
    for (const id of this.realtime.activeThreads()) activeThreads.add(id);
    return { epoch: this.epoch, connected: this.native.connected && !this.closed, restarting: this.restarting, activity: { activeThreads: [...activeThreads], pendingStarts: this.pendingStarts + (this.predictions?.activeThreads().length ?? 0), terminals: this.terminals.size + (this.cliTerminals?.active ?? 0), subscriptions: this.mcp.subscriptions, processes: this.processes.active, unknown: this.unknown || [...this.activity.values()].some(value => value.unknown) }, budget: this.native.budget, prompts: this.prompts.size };
  }
  private emitEvent(type: RuntimeEvent['type'], data: JsonValue, eventChannelId?: string): void { jsonBytes({ type, data }, LIMITS.eventBytes); this.emit('event', { type, data, ...(eventChannelId ? { eventChannelId } : {}) } satisfies RuntimeEvent); }
  private ownerKey(clientId: string, eventChannelId?: string): string { return canonical([eventChannelId ?? null, clientId]); }
  private emitState(): void { this.emitEvent('state', this.status()); }
  private track(id: string): Activity {
    return this.activity.track(id);
  }
  private admit(threadId?: string, ownPending = false, ownConfiguration = false, ownCli = false): void {
    if (!this.native.connected || this.closed) throw new DeliveryError('runtime_unavailable', 'Runtime unavailable');
    if (this.restarting) throw new DeliveryError('runtime_restarting', '终端已退出，正在自动刷新后台环境，请稍候。');
    if (this.unknown) throw new DeliveryError('activity_unknown', 'Runtime activity is unknown; recovery is required');
    if (!ownCli && this.cliTerminals?.active) throw new DeliveryError('native_cli_busy', '请先关闭 Codex CLI 终端；后台会自动刷新后恢复其他操作。');
    if (this.configurationPending && !ownConfiguration) throw new DeliveryError('configuration_busy', 'Runtime configuration is changing');
    if (threadId) { const state = this.track(threadId); if (state.unknown) throw new DeliveryError('activity_unknown', 'Thread outcome is unknown'); if (hasTurnActivity(state) || state.goalActive || state.queued || state.checkingContinuation || this.realtime.has(threadId) || (state.pending && !ownPending)) throw new DeliveryError('thread_busy', 'Thread already has active or pending work'); }
  }
  private observeThread(value: JsonValue, revision?: number): void {
    const response = object(value); const thread = object(response.thread); const id = string(thread.id, 'native thread id'); const state = this.track(id);
    if (typeof thread.historyMode === 'string') state.historyMode = thread.historyMode;
    if (typeof thread.canAcceptDirectInput === 'boolean' || thread.canAcceptDirectInput === null) state.directInput = thread.canAcceptDirectInput;
    if ((Array.isArray(thread.turns) && thread.turns.length > 0) || (thread.status && typeof thread.status === 'object' && !Array.isArray(thread.status) && thread.status.type === 'active')) state.fresh = false;
    if (revision !== undefined && revision !== state.revision) return;
    this.sessions.thread(thread);
    if (thread.status && typeof thread.status === 'object' && !Array.isArray(thread.status)) state.status = String(thread.status.type);
    if (Array.isArray(thread.turns)) { const active = thread.turns.map(turn => object(turn)).find(turn => turn.status === 'inProgress' && turn.id !== state.lastTerminalTurn?.id); if (active) { const turnId = string(active.id, 'turn id'); if (state.turnId !== turnId) state.turnRevision = (state.turnRevision ?? 0) + 1; state.status = 'active'; state.turnId = turnId; } }
    this.emitState();
  }
  private notification(message: JsonObject): void {
    const method = string(message.method, 'notification method'); const params = object(message.params ?? {});
    if (typeof params.threadId === 'string' && method.startsWith('thread/realtime/') && !['thread/realtime/outputAudio/delta', 'thread/realtime/sdp'].includes(method)) this.invalidateHistory(params.threadId);
    if (this.extensions.notification(method, params)) return;
    if (this.predictions.notification(method, params)) return;
    this.guardian.notification(method, params); this.deviceLogin.notification(method, params);
    if (this.mcpOauth.notification(method, params)) return;
    if (this.mcp.notification(method, params)) return;
    if (this.cliDiagnostics.notification(method, params)) return;
    if (this.cliTerminals.notification(method, params)) return;
    if (this.processes.notification(method, params)) return;
    if (this.realtime.notification(method, params)) return;
    if (method === 'account/updated' || method === 'account/login/completed') {
      this.defaultsCache.clear(); this.accountReadGeneration++; this.accountProbe = undefined;
    }
    if (typeof params.threadId === 'string') {
      const state = this.track(params.threadId); state.revision++;
      if (['thread/status/changed', 'turn/started', 'turn/completed', 'thread/goal/updated', 'thread/goal/cleared', 'thread/queue/changed', 'thread/closed', 'thread/deleted'].includes(method)) state.continuationRevision = (state.continuationRevision ?? 0) + 1;
      if (method === 'thread/status/changed') { state.status = string(object(params.status).type, 'thread status'); if (state.status === 'active') state.fresh = false; }
      if (method === 'turn/started') {
        const turnId = string(object(params.turn).id, 'turn id');
        if (!state.pending || (state.turnId !== null && state.turnId !== turnId)) delete state.activeModel;
        if (state.turnId !== turnId) { state.modelRevision = (state.modelRevision ?? 0) + 1; state.settingsRevision = (state.settingsRevision ?? 0) + 1; }
        state.turnRevision = (state.turnRevision ?? 0) + 1;
        state.fresh = false; state.status = 'active'; state.turnId = turnId;
      }
      if (method === 'turn/completed') {
        const turn = object(params.turn), turnId = string(turn.id, 'turn id');
        state.turnRevision = (state.turnRevision ?? 0) + 1;
        if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted') state.lastTerminalTurn = { id: turnId, status: turn.status };
        if (state.turnId === turnId) { state.status = 'idle'; state.turnId = null; delete state.activeModel; state.modelRevision = (state.modelRevision ?? 0) + 1; state.settingsRevision = (state.settingsRevision ?? 0) + 1; }
        for (const prompt of [...this.prompts.values()]) if (prompt.threadId === params.threadId && prompt.turnId === turnId) this.closePrompt(prompt, 'turn_ended');
      }
      if (method === 'thread/reverted') { delete state.lastTerminalTurn; state.turnRevision = (state.turnRevision ?? 0) + 1; this.invalidateHistory(params.threadId); }
      if (method === 'thread/closed' || method === 'thread/deleted') { state.status = 'notLoaded'; state.subscribed = false; state.turnId = null; delete state.lastTerminalTurn; state.turnRevision = (state.turnRevision ?? 0) + 1; state.goalActive = false; state.goalRevision = (state.goalRevision ?? 0) + 1; delete state.activeModel; state.modelRevision = (state.modelRevision ?? 0) + 1; state.settingsRevision = (state.settingsRevision ?? 0) + 1; state.queued = false; this.invalidateHistory(params.threadId); this.emitState(); }
      if (method === 'thread/closed' || method === 'thread/deleted' || (method === 'thread/status/changed' && state.status === 'notLoaded')) this.sessions.invalidate(params.threadId);
      if (method === 'thread/settings/updated') { state.settingsRevision = (state.settingsRevision ?? 0) + 1; validateOfficial('ThreadSettings', params.threadSettings!); if (state.status !== 'notLoaded') this.sessions.settings(params.threadId, object(params.threadSettings)); }
      if (method === 'model/rerouted') { validateOfficial('ModelReroutedNotification', params); if (state.turnId === params.turnId) { state.activeModel = string(params.toModel, 'rerouted model'); state.modelRevision = (state.modelRevision ?? 0) + 1; state.settingsRevision = (state.settingsRevision ?? 0) + 1; } }
      if (method === 'thread/goal/updated') { validateOfficial('ThreadGoal', params.goal!); state.goalActive = object(params.goal).status === 'active'; state.goalRevision = (state.goalRevision ?? 0) + 1; this.emitState(); }
      if (method === 'thread/goal/cleared') { state.goalActive = false; state.goalRevision = (state.goalRevision ?? 0) + 1; this.emitState(); }
      if (method === 'thread/queue/changed') { state.queued = true; this.emitState(); void this.refreshContinuation(params.threadId).catch(() => {}); }
      if (method.startsWith('turn/') || method === 'thread/status/changed') this.emitState();
    }
    if (method === 'serverRequest/resolved') for (const prompt of [...this.prompts.values()]) if (prompt.requestId === params.requestId) this.closePrompt(prompt, 'resolved');
    if (method === 'command/exec/outputDelta') {
      const terminal = typeof params.processId === 'string' ? this.terminals.get(params.processId) : undefined;
      if (terminal) this.emitEvent('terminal', { ...params, terminalId: terminal.terminalId, clientId: terminal.clientId, type: 'output' }, terminal.eventChannelId);
      return;
    }
    this.emitEvent('notification', { method, params: method === 'error' || method === 'account/login/completed' ? this.redactor.value(params) : params });
  }
  private async serverRequest(message: JsonObject): Promise<void> {
    const id = message.id; if (typeof id !== 'string' && typeof id !== 'number') throw new Error('Invalid native request id');
    const method = string(message.method, 'server request method'); const params = object(message.params ?? {});
    if (method === 'currentTime/read') { await this.native.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) }); return; }
    if (method === 'item/tool/call') { await this.native.respond(id, { contentItems: [{ type: 'inputText', text: 'No dynamic tool handler is registered' }], success: false }); return; }
    if (!supportedPrompt(method)) { await this.native.rejectRequest(id, -32601, 'Unsupported server request'); return; }
    const duplicate = [...this.prompts.values()].find(prompt => prompt.requestId === id);
    if (duplicate) { if (duplicate.method !== method || canonical(duplicate.params) !== canonical(params)) throw new Error('Native request id was reused with different content'); return; }
    const bytes = Buffer.byteLength(jsonBytes(params));
    if (this.prompts.size >= LIMITS.prompts || this.promptBytes + bytes > LIMITS.promptBytes) { await this.native.rejectRequest(id, -32000, 'Approval capacity exceeded'); return; }
    const prompt: Prompt = { promptId: randomUUID(), epoch: this.epoch, method, params, threadId: typeof params.threadId === 'string' ? params.threadId : null, turnId: typeof params.turnId === 'string' ? params.turnId : null, requestId: id, bytes, answering: false };
    this.prompts.set(prompt.promptId, prompt); this.promptBytes += bytes; this.emitEvent('prompt', this.publicPrompt(prompt));
  }
  private publicPrompt(prompt: Prompt): JsonObject { return { promptId: prompt.promptId, epoch: prompt.epoch, method: prompt.method, params: prompt.params, threadId: prompt.threadId, turnId: prompt.turnId }; }
  private closePrompt(prompt: Prompt, reason: string): void { if (!this.prompts.delete(prompt.promptId)) return; this.promptBytes -= prompt.bytes; this.emitEvent('prompt-closed', { promptId: prompt.promptId, reason }); }
  async call(method: string, input: JsonValue, context: CallContext): Promise<JsonValue> {
    const params = object(input); string(context.clientId, 'clientId', 256); jsonBytes(params);
    if (this.cliTerminals.active && !['terminal/write', 'terminal/resize', 'terminal/close', 'runtime/status', 'thread/read', 'thread/list', 'thread/history', 'prompt/list', 'attachment/read', 'model/list', 'account/read', 'account/rateLimits', 'project/defaults'].includes(method) && featureMethod(method)?.access !== 'read') throw new DeliveryError('native_cli_busy', '请先关闭 Codex CLI 终端；后台会自动刷新后恢复其他操作。');
    if (mcpMethods.has(method)) return this.mcp.call(method, params, context);
    if (Object.hasOwn(organizationMethods, method)) return this.organization.call(method, params, context);
    if (Object.hasOwn(processMethods, method)) return this.processes.call(method, params, context);
    if (Object.hasOwn(realtimeMethods, method)) return this.realtime.call(method, params, context);
    if (threadTerminalMethods.has(method)) return this.threadTerminals.call(method, params, context);
    if (guardianMethods.has(method)) return this.guardian.call(method, params, context);
    if (predictionMethods.has(method)) return this.predictions.call(method, params, context);
    if (cliDiagnosticMethods.has(method)) return this.cliDiagnostics.call(method, params, context);
    if (Object.hasOwn(remoteMethods, method)) {
      try { return await (method.startsWith('environment/') ? this.environments.call(method, params, context) : this.remoteControl.call(method, params, context)); }
      catch (error) { if (error instanceof DeliveryError) throw new DeliveryError(error.code, this.redactor.text(error.message), error.delivery, error.data === undefined ? undefined : this.redactor.value(error.data)); throw error; }
    }
    if (workflowMethods.has(method)) return this.workflows.call(method, params, context);
    if (Object.hasOwn(extensionMethods, method)) return this.extensions.call(method, params, context);
    if (method.startsWith('workspace/')) return this.workspace.call(method, params, context);
    switch (method) {
      case 'automation/validate': {
        onlyKeys(params, ['cwd', 'options']); const cwd = this.cwd(params.cwd);
        validateOfficial('ThreadStartParams', { cwd, ...this.threadOptions(params.options, false) });
        validateOfficial('TurnStartParams', { threadId: 'preflight', input: [{ type: 'text', text: 'validation', text_elements: [] }], ...this.threadOptions(params.options, true) }); return {};
      }
      case 'project/resolve': {
        onlyKeys(params, ['path']); const requested = this.cwd(params.path);
        return resolveProject(this.config, requested);
      }
      case 'project/defaults': {
        onlyKeys(params, []); return { directory: path.join(this.config.nativeHome ?? this.config.workerHome, 'projects') };
      }
      case 'project/create': {
        onlyKeys(params, ['directory']); this.admit();
        if (!context.beforeWrite) throw new DeliveryError('operation_required', 'Project creation requires a durable operation');
        return createProject(this.config, this.config.nativeHome ?? this.config.workerHome, params.directory, () => { this.admit(); context.beforeWrite!(); });
      }
      case 'runtime/status': return this.status();
      case 'runtime/maintenance/check': {
        onlyKeys(params, []);
        this.assertIdle();
        await this.remoteControl.assertDisabledForMaintenance();
        this.assertIdle();
        if (this.prompts.size || this.workspace.pending) throw new DeliveryError('activity_busy', 'Finish pending prompts and workspace operations before maintenance');
        return { idle: true, epoch: this.epoch, workspaceWitness: this.workspace.usage() };
      }
      case 'thread/session': onlyKeys(params, ['threadId']); return this.closed || !this.native.connected ? { requiresResume: true } : this.sessions.read(string(params.threadId, 'threadId'));
      case 'prompt/list': return { epoch: this.epoch, prompts: [...this.prompts.values()].map(prompt => this.publicPrompt(prompt)) };
      case 'prompt/answer': return this.answer(params, context);
      case 'attachment/upload': return this.attachments.upload(params, context.clientId);
      case 'attachment/read': return this.attachments.read(params);
      case 'attachment/history/read': return this.attachments.readHistory(params);
      case 'attachment/remove': return this.attachments.remove(params);
      case 'terminal/open': return this.openTerminal(params, context);
      case 'terminal/write': case 'terminal/resize': case 'terminal/close': return this.terminalCall(method, params, context);
      case 'conversation/start': return this.startConversation(params, context);
      case 'thread/start': {
        onlyKeys(params, ['projectId', 'cwd', 'options']); const cwd = this.cwd(params.cwd); const selected = this.threadOptions(params.options, false); const nativeParams = { cwd, ...selected, environments: selected.environments ?? [{ environmentId: 'local', cwd }] }; validateOfficial('ThreadStartParams', nativeParams);
        this.admit(); this.pendingStarts++; this.emitState();
        let accepted = false;
        try { const result = await this.native.call(method, nativeParams, { beforeWrite: () => { this.admit(); context.beforeWrite?.(); } }); accepted = true; this.observeThread(result); this.sessions.capture(result); const state = this.track(string(object(object(result).thread).id, 'thread id')); state.subscribed = true; if (state.fresh !== false && state.turnId === null && state.status !== 'active') state.fresh = true; return result; }
        catch (error) { if (accepted) { this.unknown = true; throw new DeliveryError('invalid_native_response', 'Native thread creation returned an invalid result', 'unknown'); } if (error instanceof DeliveryError && error.delivery === 'unknown') this.unknown = true; throw error; }
        finally { this.pendingStarts--; this.emitState(); }
      }
      case 'thread/resume': {
        onlyKeys(params, ['threadId']); const threadId = string(params.threadId, 'threadId'); const p = { threadId, excludeTurns: true }; validateOfficial('ThreadResumeParams', p);
        this.pendingStarts++; this.emitState();
        try { const result = await this.workflowMutation({ method, params: p, schema: 'ThreadResumeParams', responseSchema: 'ThreadResumeResponse', threadId, mode: 'any', history: true }, context); this.track(threadId).subscribed = true; this.sessions.capture(result); await this.refreshContinuation(threadId); return result; }
        catch (error) { if (error instanceof DeliveryError && error.delivery === 'unknown') this.track(threadId).unknown = true; throw error; }
        finally { this.pendingStarts--; this.emitState(); }
      }
      case 'thread/read': {
        onlyKeys(params, ['threadId']); const threadId = string(params.threadId, 'threadId');
        return this.activity.read(threadId, async state => {
          const revision = state.revision;
          const result = await this.native.call(method, { threadId });
          if (object(object(result).thread).id !== threadId) throw new DeliveryError('invalid_native_response', 'Thread identity mismatch');
          this.observeThread(result, revision);
          return result;
        });
      }
      case 'thread/list': return this.page(method, 'ThreadListParams', params, { sourceKinds: ['cli', 'vscode', 'appServer', 'exec'] }, ['cwd', 'archived', 'cursor', 'limit', 'searchTerm', 'sortKey', 'sortDirection']);
      case 'thread/history': return this.history(params, context);
      case 'thread/name/set': validateOfficial('ThreadSetNameParams', params); return this.directMutation(method, params, context);
      case 'thread/archive': case 'thread/unarchive': { onlyKeys(params, ['threadId']); string(params.threadId, 'threadId'); if (method === 'thread/unarchive') this.environments.assertIndependentLoad(); return this.directMutation(method, params, context); }
      case 'thread/compact': return this.newTurn('thread/compact/start', params, context);
      case 'turn/start': return this.newTurn(method, params, context);
      case 'turn/interrupt': {
        onlyKeys(params, ['threadId', 'turnId']); const threadId = string(params.threadId, 'threadId'); const turnId = string(params.turnId ?? this.track(threadId).turnId, 'turnId'); return this.directMutation(method, { threadId, turnId }, context);
      }
      case 'model/list': return this.providers.list(params, (method, params) => this.native.call(method, params), (provider, chatgpt, hidden) => this.providerCatalog(provider, chatgpt, hidden));
      case 'mcp/oauth': return this.mcpOauth.start(params, (method, params, options) => this.directMutation(method, params, context, options), context);
      case 'mcp/oauth/handoff': return this.mcpOauth.read(params, context);
      case 'defaults/read': return this.defaults(params);
      case 'account/read': onlyKeys(params, []); return this.readAccount();
      case 'account/login/handoff': return this.deviceLogin.read(params, context);
      case 'account/login': return this.configurationMutation(write => this.deviceLogin.start(params, write, context), context);
      case 'account/login/cancel': return this.configurationMutation(write => this.deviceLogin.cancel(params, write, context), context);
      case 'account/logout': return this.configurationMutation(write => this.deviceLogin.logout(params, write), context);
      case 'account/rateLimits': onlyKeys(params, []); return this.native.call('account/rateLimits/read', {});
      default: throw new DeliveryError('method_not_found', 'Unsupported runtime method');
    }
  }
  private async directMutation(method: string, params: JsonValue, context: CallContext, options: NativeOptions = {}): Promise<JsonValue> {
    const guard = (): void => { if (this.restarting) throw new DeliveryError('runtime_restarting', '终端已退出，正在自动刷新后台环境，请稍候。'); if (this.cliTerminals.active) throw new DeliveryError('native_cli_busy', 'The native CLI has exclusive execution access'); if (this.configurationPending) throw new DeliveryError('configuration_busy', 'Runtime configuration is changing'); };
    guard(); this.pendingStarts++; this.emitState();
    try { return await this.native.call(method, params, { ...options, beforeWrite: () => { guard(); context.beforeWrite?.(); options.beforeWrite?.(); if (params && typeof params === 'object' && !Array.isArray(params) && typeof params.threadId === 'string') this.predictions.invalidate(params.threadId); } }); }
    catch (error) { if (!(error instanceof DeliveryError) || error.delivery === 'unknown') this.unknown = true; throw error; }
    finally { this.pendingStarts--; this.emitState(); }
  }
  private cwd(value: unknown): string { const cwd = string(value, 'cwd'); if (!path.isAbsolute(cwd) || cwd.includes('\0')) throw new DeliveryError('invalid_params', 'cwd must be an absolute native path'); return cwd; }
  private threadOptions(value: JsonValue | undefined, turn: boolean): JsonObject {
    const prepared = this.providers.selection(value, turn);
    if (prepared === undefined) return options(prepared, turn);
    const { environments, modelProvider, ...ordinary } = object(prepared, 'options'); const selected = options(ordinary, turn);
    if (!turn && modelProvider !== undefined) {
      selected.modelProvider = modelProvider;
      const overrides = this.providers.catalogOverride(modelProvider);
      if (Object.keys(overrides).length) selected.config = { ...(selected.config ? object(selected.config) : {}), ...overrides };
    }
    if (environments !== undefined) selected.environments = this.environments.selection(environments);
    return selected;
  }
  private async providerCatalog(provider: string, chatgpt: boolean, hidden = false): Promise<JsonObject[]> {
    const key = provider + ':' + hidden;
    const existing = this.catalogProbes.get(key); if (existing) return existing;
    if (this.catalogProbes.size >= 4 || this.closed) throw new DeliveryError('capacity', '模型目录正在读取，请稍后重试。');
    const pending = (async () => {
      const probe = new NativeRpc({ ...this.config, catalogProvider: provider, isolatedGroup: true });
      this.catalogProcesses.add(probe);
      probe.on('fatal', () => {});
      try {
        await probe.initialize();
        return await readNativeCatalog((method, params) => probe.call(method, params), chatgpt, hidden);
      } finally { try { await probe.close(); } finally { this.catalogProcesses.delete(probe); } }
    })();
    this.catalogProbes.set(key, pending);
    try { return await pending; } finally { if (this.catalogProbes.get(key) === pending) this.catalogProbes.delete(key); }
  }
  private accountProbe: Promise<JsonValue> | undefined;
  private accountReadGeneration = 0;
  private async readAccount(retry = 1): Promise<JsonValue> {
    const provider = this.providers.accountProvider();
    if (!provider) return this.native.call('account/read', { refreshToken: false });
    if (this.accountProbe) return this.accountProbe;
    if (this.closed) throw new DeliveryError('runtime_unavailable', 'Native runtime is closing');
    // Login, cancellation and logout stay on the main process, which owns the
    // shared credential cache and device-code notifications. Account display
    // must select ChatGPT: native account/read otherwise reports only the
    // default API-key provider, even when the shared ChatGPT login exists.
    const generation = this.accountReadGeneration;
    const pending = (async () => {
      const probe = new NativeRpc({ ...this.config, catalogProvider: provider, isolatedGroup: true });
      this.catalogProcesses.add(probe); probe.on('fatal', () => {});
      try {
        await probe.initialize(); const result = await probe.call('account/read', { refreshToken: false });
        if (generation !== this.accountReadGeneration) throw new DeliveryError('account_changed', '登录状态已改变，请刷新账户。');
        return result;
      }
      finally { try { await probe.close(); } finally { this.catalogProcesses.delete(probe); } }
    })();
    this.accountProbe = pending;
    try { return await pending; }
    catch (error) {
      if (error instanceof DeliveryError && error.code === 'account_changed' && retry > 0) return this.readAccount(retry - 1);
      throw error;
    } finally { if (this.accountProbe === pending) this.accountProbe = undefined; }
  }
  private async startConversation(params: JsonObject, context: CallContext): Promise<JsonValue> {
    onlyKeys(params, ['projectId', 'cwd', 'text', 'attachmentIds', 'options', 'references', 'extraContext']); const cwd = this.cwd(params.cwd); const text = string(params.text ?? '', 'text', 1024 * 1024, true);
    const prepared = this.attachments.prepare(params.attachmentIds, '');
    const selected = await this.inputContext.prepare(cwd, params.references, params.extraContext, context);
    if (!text.length && prepared.input.length === 0 && !selected.input.length && !Object.keys(selected.additionalContext).length) throw new DeliveryError('invalid_params', 'Conversation requires text, attachments or context references');
    validateOfficial('ThreadStartParams', { cwd, ...this.threadOptions(params.options, false) });
    validateOfficial('TurnStartParams', { threadId: 'preflight', input: [{ type: 'text', text, text_elements: [] }, ...prepared.input, ...selected.input], additionalContext: selected.additionalContext, ...this.threadOptions(params.options, true) });
    // The gateway owns the single durable dispatch boundary. This hook checks
    // the current worker owner and must run before each native mutation.
    const creation = object(await this.call('thread/start', { cwd, ...(params.options !== undefined ? { options: params.options } : {}) }, context));
    const thread = object(creation.thread); const threadId = string(thread.id, 'created thread id');
    try {
      const result = object(await this.newTurn('turn/start', { threadId, text, ...(params.attachmentIds !== undefined ? { attachmentIds: params.attachmentIds } : {}), ...(params.options !== undefined ? { options: params.options } : {}), ...(params.references !== undefined ? { references: params.references } : {}), ...(params.extraContext !== undefined ? { extraContext: params.extraContext } : {}) }, context));
      const turn = object(result.turn); return { thread, turn };
    } catch (error) {
      // Creation is a known side effect, but a definitive first-turn rejection is not unknown live work.
      if (!(error instanceof DeliveryError) || error.delivery === 'unknown') this.track(threadId).unknown = true;
      this.emitState();
      throw new DeliveryError('conversation_start_incomplete', 'Thread was created, but the first turn was not accepted or confirmed. Inspect the partial thread before retrying.', 'unknown', { phase: 'first_turn', threadId, causeCode: error instanceof DeliveryError ? error.code : 'internal_error', causeDelivery: error instanceof DeliveryError ? error.delivery : 'unknown' });
    }
  }
  private async page(method: string, schema: string, params: JsonObject, fixed: JsonObject, keys: string[]): Promise<JsonValue> {
    onlyKeys(params, keys); if (params.cursor !== undefined && params.cursor !== null) string(params.cursor, 'cursor', LIMITS.cursorBytes, true);
    const p = { ...params, limit: params.limit === undefined ? 50 : integer(params.limit, 'limit', 1, 100), ...fixed }; validateOfficial(schema, p);
    const result = object(await this.native.call(method, p)); jsonBytes(result, LIMITS.historyBytes);
    if (!Array.isArray(result.data) || result.data.length > 100) throw new DeliveryError('invalid_native_response', 'Invalid directory page');
    if (result.nextCursor !== null && result.nextCursor !== undefined) { string(result.nextCursor, 'nextCursor', LIMITS.cursorBytes, true); if (result.nextCursor === params.cursor) throw new DeliveryError('cursor_loop', 'Native pagination did not advance'); }
    return result;
  }
  private history(params: JsonObject, context: CallContext): Promise<JsonValue> {
    const threadId = string(params.threadId, 'threadId');
    return this.activity.read(threadId, () => this.historyStore.read(params, context));
  }
  private checkHistory(turns: JsonValue[]): void { jsonBytes(turns, LIMITS.historyBytes); let items = 0; for (const turn of turns) { const value = object(turn); if (!Array.isArray(value.items) || value.itemsView !== 'full') throw new DeliveryError('invalid_native_response', 'History turn lacks full items'); items += value.items.length; } if (turns.length > 1000 || items > LIMITS.historyItems) throw new DeliveryError('capacity', 'History page exceeds item budget; narrow the requested page'); }
  private admitHistory(threadId: string, context: CallContext): void {
    if (this.track(threadId).fresh) return;
    if (!this.historyStore.complete(threadId, context)) throw new DeliveryError('history_incomplete', 'Read the complete thread history on this connection before starting work');
  }
  private invalidateHistory(threadId: string): void {
    const removed = this.historyStore.invalidate(threadId), state = this.track(threadId); state.fresh = false; state.historyRevision = (state.historyRevision ?? 0) + 1;
    if (removed) this.emitEvent('notification', { method: 'thread/history/invalidated', params: { threadId, historyVersion: state.historyRevision } });
  }
  private refreshContinuation(threadId: string): Promise<void> {
    const existing = this.continuationChecks.get(threadId); if (existing) return existing;
    const state = this.track(threadId); state.checkingContinuation = true; this.emitState();
    const check = Promise.resolve().then(async () => {
      const deadline = Date.now() + 3000;
      for (let attempt = 0; attempt < 32 && Date.now() < deadline; attempt++) {
        const revision = state.continuationRevision ?? 0;
        const goal = object(await this.native.call('thread/goal/get', { threadId })); validateOfficial('ThreadGoalGetResponse', goal);
        if (goal.goal !== null && object(goal.goal).threadId !== threadId) throw new Error('Continuation goal identity mismatch');
        const queue = object(await this.native.call('thread/queue/list', { threadId, limit: 1 })); validateOfficial('ThreadQueueListResponse', queue);
        if ((queue.data as JsonValue[]).length > 1) throw new Error('Continuation queue page exceeded requested limit');
        const threadRevision = state.revision;
        const current = await this.native.call('thread/read', { threadId }); if (object(object(current).thread).id !== threadId) throw new Error('Continuation thread identity mismatch');
        if (revision !== (state.continuationRevision ?? 0)) { await new Promise(resolve => setTimeout(resolve, 25)); continue; }
        this.observeThread(current, threadRevision);
        // A read may complete while a goal write is still awaiting its reply.
        // That write or a newer notification owns goal state until it settles.
        if (!state.goalPending) { state.goalActive = goal.goal !== null && object(goal.goal).status === 'active'; state.goalRevision = (state.goalRevision ?? 0) + 1; }
        state.queued = (queue.data as JsonValue[]).length > 0; return;
      }
      throw new Error('Continuation changed throughout bounded state checks');
    }).catch(error => { state.unknown = true; throw new DeliveryError('activity_unknown', 'Native continuation state could not be confirmed', 'unknown'); })
      .finally(() => { state.checkingContinuation = false; this.continuationChecks.delete(threadId); this.emitState(); });
    this.continuationChecks.set(threadId, check); return check;
  }
  private async metadataMutation(operation: MetadataMutation, context: CallContext, ownCli = false): Promise<JsonValue> {
    this.admit(undefined, false, false, ownCli); validateOfficial(operation.schema, operation.params);
    const locked = new Set(operation.threadIds ?? []); const states = [...locked].map(id => ({ id, state: this.track(id) }));
    const guard = (own = false): void => {
      this.admit(undefined, false, own && operation.idle === true, ownCli);
      for (const { id } of states) { this.admit(id, own, own && operation.idle === true); this.admitHistory(id, context); }
      if (operation.idle && (this.pendingStarts > (own ? 1 : 0) || this.predictions.activeThreads().length || this.defaultsPending || this.terminals.size || this.mcp.subscriptions || this.processes.active || this.realtime.activeThreads().length || [...this.activity].some(([id, state]) => hasTurnActivity(state) || state.unknown || state.goalActive || state.queued || state.checkingContinuation || (state.pending && !(own && locked.has(id)))))) throw new DeliveryError('activity_busy', 'Finish active work before importing thread organization');
    };
    guard(); if (operation.idle) this.configurationPending = true; this.pendingStarts++; for (const { state } of states) state.pending = true; this.emitState(); let accepted = false;
    try {
      for (const { id, state } of states) { const revision = state.revision; const current = await this.native.call('thread/read', { threadId: id }); if (object(object(current).thread).id !== id) throw new DeliveryError('invalid_native_response', 'Imported thread identity mismatch'); this.observeThread(current, revision); }
      guard(true); await operation.preflight?.();
      const result = await this.native.call(operation.method, operation.params, { beforeWrite: () => { guard(true); context.beforeWrite?.(); operation.beforeWrite?.(); } }); accepted = true; validateOfficial(operation.responseSchema, result); jsonBytes(result, LIMITS.historyBytes);
      return operation.project ? operation.project(result) : result;
    } catch (error) {
      if (accepted || !(error instanceof DeliveryError) || error.delivery === 'unknown') this.unknown = true;
      if (accepted) throw new DeliveryError('invalid_native_response', 'Native organization change returned an invalid result', 'unknown'); throw error;
    } finally { for (const { state } of states) state.pending = false; this.pendingStarts--; if (operation.idle) this.configurationPending = false; this.emitState(); }
  }
  private assertIdle(own = false): void {
    this.admit(undefined, false, own);
    if (this.pendingStarts > (own ? 1 : 0) || this.predictions.activeThreads().length || this.defaultsPending ||
        this.terminals.size || this.mcp.subscriptions || this.processes.active || this.realtime.activeThreads().length ||
        [...this.activity.values()].some(state => hasTurnActivity(state) || state.pending || state.unknown ||
          state.goalActive || state.queued || state.checkingContinuation)) {
      throw new DeliveryError('activity_busy', 'Finish active work and terminals before changing configuration');
    }
  }
  private async configurationMutation(operation: (write: (method: string, params: JsonValue, options?: NativeOptions) => Promise<JsonValue>, beforeWrite: () => void) => Promise<JsonValue>, context: CallContext, invalidate = true): Promise<JsonValue> {
    if (!context.beforeWrite) throw new DeliveryError('operation_required', 'Configuration changes require the durable operation boundary');
    const idle = (own = false): void => this.assertIdle(own);
    idle(); this.configurationPending = true; this.pendingStarts++; this.emitState(); let dispatched = false;
    try {
      const beforeWrite = (): void => { idle(true); context.beforeWrite!(); dispatched = true; };
      const result = await operation((method, params, options = {}) => this.native.call(method, params, { ...options, beforeWrite: () => { beforeWrite(); options.beforeWrite?.(); } }), beforeWrite);
      if (invalidate) { this.defaultsCache.clear(); this.sessions.clear(); this.guardian.invalidateAll(); this.predictions.invalidate(); } return result;
    } catch (error) {
      if (dispatched && (!(error instanceof DeliveryError) || error.delivery === 'unknown')) this.unknown = true;
      throw error;
    } finally { this.configurationPending = false; this.pendingStarts--; this.emitState(); }
  }
  private async workflowMutation(operation: WorkflowMutation, context: CallContext): Promise<JsonValue> {
    const { threadId } = operation; this.admit(); const state = this.track(threadId);
    if (state.unknown) throw new DeliveryError('activity_unknown', 'Thread outcome is unknown');
    if (state.pending) throw new DeliveryError('thread_busy', 'Thread already has a pending mutation');
    if (operation.history) this.admitHistory(threadId, context);
    state.pending = true; if (operation.newThread) this.pendingStarts++; this.emitState();
    let accepted = false; let writeRevision: number | undefined; let restoreSession: (() => void) | undefined; let mediaRevision: number | undefined; const wasFresh = state.fresh;
    const goalMutation = operation.method === 'thread/goal/set' || operation.method === 'thread/goal/clear';
    let goalRevision: number | undefined; let modelRevision: number | undefined; let modelTurnId: string | null | undefined;
    const guard = (): void => {
      this.admit(); if (state.unknown) throw new DeliveryError('activity_unknown', 'Thread outcome is unknown');
      if (operation.method !== 'thread/realtime/start' && this.realtime.has(threadId)) throw new DeliveryError('voice_busy', 'Stop voice before changing this thread');
      if (operation.history) this.admitHistory(threadId, context);
      if (operation.mode === 'idle' && (hasTurnActivity(state) || state.goalActive || state.checkingContinuation || (state.queued && operation.method !== 'thread/queue/start'))) throw new DeliveryError('thread_busy', 'Thread has active or continuing work');
      if (operation.mode === 'active' && (!hasTurnActivity(state) || (state.turnId !== null && state.turnId !== operation.expectedTurnId))) throw new DeliveryError('turn_changed', 'The selected turn is no longer active');
      if (operation.directInput && state.directInput === false) throw new DeliveryError('direct_input_unavailable', 'Native thread does not accept direct input');
      if (operation.directInput && state.subscribed === false) throw new DeliveryError('session_not_loaded', 'Explicitly load the thread before starting work');
      if (mediaRevision !== undefined && mediaRevision !== (state.settingsRevision ?? 0)) throw new DeliveryError('model_changed', 'Model settings changed during media validation');
    };
    try {
      const revision = state.revision; const current = await this.native.call('thread/read', { threadId });
      if (object(object(current).thread).id !== threadId) throw new DeliveryError('invalid_native_response', 'Thread identity mismatch'); this.observeThread(current, revision); guard();
      if (operation.method === 'thread/resume' || operation.method === 'thread/fork') {
        const provider = object(object(current).thread).modelProvider;
        if (typeof provider === 'string') {
          this.providers.assertThread(provider, operation.params.modelProvider === undefined ? undefined : { modelProvider: operation.params.modelProvider });
          operation.params.modelProvider = provider;
          const overrides = this.providers.catalogOverride(provider);
          const previous = object(object(current).thread);
          if (operation.params.model === undefined && typeof previous.model === 'string') operation.params.model = previous.model;
          const supplied = operation.params.config ? object(operation.params.config) : {};
          if (supplied.model_reasoning_effort === undefined && typeof previous.reasoningEffort === 'string')
            overrides.model_reasoning_effort = previous.reasoningEffort;
          if (Object.keys(overrides).length) operation.params.config = { ...(operation.params.config ? object(operation.params.config) : {}), ...overrides };
        }
      }
      if (operation.newThread) this.environments.assertIndependentLoad();
      if (operation.directInput || operation.newThread || operation.method === 'thread/resume') this.environments.assertThread(object(object(current).thread));
      await operation.preflight?.(object(object(current).thread)); validateOfficial(operation.schema, operation.params);
      const input = operation.mediaInput ?? operation.params.input;
      if (mediaModalities(input).length) {
        mediaRevision = state.settingsRevision ?? 0;
        const fallback = operation.method === 'turn/steer' ? state.activeModel : object(object(current).thread).model ?? this.sessions.read(threadId).model;
        const provider = object(object(current).thread).modelProvider;
        await validateInputModalities((method, params) => method === 'model/list'
          ? this.providers.list({ ...object(params), ...(provider !== undefined ? { modelProvider: provider } : {}) }, (method, params) => this.native.call(method, params), (provider, chatgpt, hidden) => this.providerCatalog(provider, chatgpt, hidden))
          : this.native.call(method, params), selectedInputModel(operation.params, fallback), input);
      }
      const result = await this.native.call(operation.method, operation.params, { beforeWrite: () => {
        guard(); context.beforeWrite?.(); operation.beforeWrite?.(); operation.prepared?.pin(); if (operation.method !== 'thread/prediction/request') this.predictions.invalidate(threadId); if (operation.invalidateHistory) this.invalidateHistory(threadId); if (operation.method === 'thread/settings/update') restoreSession = this.sessions.invalidate(threadId);
        writeRevision = state.revision;
        if (goalMutation) { goalRevision = state.goalRevision ?? 0; state.goalPending = true; state.continuationRevision = (state.continuationRevision ?? 0) + 1; }
        if (operation.method === 'turn/settings/update') { modelRevision = state.modelRevision ?? 0; modelTurnId = state.turnId; }
      } });
      accepted = true; operation.prepared?.settle(true); validateOfficial(operation.responseSchema, result);
      const value = object(result);
      if (value.goal !== undefined && object(value.goal).threadId !== threadId) throw new Error('Native goal identity mismatch');
      if (goalMutation) {
        // Reply promises can resume after later notifications from the same
        // native read. Keep their state and invalidate overlapping readbacks.
        state.continuationRevision = (state.continuationRevision ?? 0) + 1;
        if (goalRevision === (state.goalRevision ?? 0)) { state.goalActive = operation.method !== 'thread/goal/clear' && object(value.goal).status === 'active'; state.goalRevision = (state.goalRevision ?? 0) + 1; }
      }
      if (operation.method === 'thread/delete' || operation.method === 'thread/unsubscribe') { this.sessions.invalidate(threadId); state.subscribed = false; }
      if (['thread/delete', 'thread/unsubscribe', 'thread/revert'].includes(operation.method)) { delete state.lastTerminalTurn; state.turnRevision = (state.turnRevision ?? 0) + 1; }
      if (operation.method === 'turn/settings/update' && value.status === 'applied' && typeof operation.params.model === 'string' && modelRevision === (state.modelRevision ?? 0) && modelTurnId === state.turnId) { state.activeModel = operation.params.model; state.modelRevision = (state.modelRevision ?? 0) + 1; state.settingsRevision = (state.settingsRevision ?? 0) + 1; }
      if (['thread/delete', 'thread/unsubscribe', 'thread/revert', 'thread/settings/update', 'turn/settings/update'].includes(operation.method)) this.guardian.invalidate(threadId);
      if (operation.method === 'turn/steer' && value.turnId !== operation.expectedTurnId) throw new Error('Native steering target mismatch');
      if (operation.method === 'review/start' && value.reviewThreadId !== threadId) throw new Error('Native review target mismatch');
      if (value.queuedSubmission !== undefined) { const queued = object(value.queuedSubmission); if ((operation.method === 'thread/queue/update' && queued.id !== operation.params.queuedSubmissionId) || (operation.method === 'thread/queue/add' && queued.clientUserMessageId !== operation.params.clientUserMessageId)) throw new Error('Native queue identity mismatch'); }
      if (operation.newThread) {
        const fork = object(value.thread); const forkId = string(fork.id, 'forked thread id'); if (forkId === threadId || fork.cwd !== object(object(current).thread).cwd) throw new Error('Native fork identity or project mismatch'); this.observeThread(result); this.sessions.capture(result); this.track(forkId).fresh = false; this.track(forkId).subscribed = true;
      } else if (value.thread !== undefined) { if (object(value.thread).id !== threadId) throw new Error('Native mutation returned a different thread'); this.observeThread(result, writeRevision); }
      if (state.revision === writeRevision && operation.workResult === 'turn') { const turn = object(value.turn); if (turn.status === 'inProgress') { state.status = 'active'; state.turnId = string(turn.id, 'turn id'); state.turnRevision = (state.turnRevision ?? 0) + 1; } state.fresh = false; }
      if (state.revision === writeRevision && operation.workResult === 'shell') { state.status = 'active'; state.fresh = false; }
      return operation.project ? operation.project(result) : result;
    } catch (error) {
      const notSent = !accepted && error instanceof DeliveryError && error.delivery === 'not_sent';
      if (notSent && operation.method === 'thread/realtime/start' && wasFresh && state.revision === writeRevision && state.status !== 'active' && state.turnId === null) state.fresh = true;
      if (notSent) restoreSession?.();
      try { operation.prepared?.settle(!notSent); } catch { this.emit('diagnostic', 'Workflow attachment reservation could not be released'); }
      if (!notSent) { state.unknown = true; if (operation.newThread) this.unknown = true; }
      if (accepted) throw new DeliveryError('invalid_native_response', 'Native workflow returned an invalid result', 'unknown'); throw error;
    } finally { if (goalMutation) state.goalPending = false; state.pending = false; if (operation.newThread) this.pendingStarts--; this.emitState(); }
  }
  private async newTurn(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    onlyKeys(params, method === 'turn/start' ? ['threadId', 'text', 'attachmentIds', 'options', 'references', 'extraContext'] : ['threadId']);
    const threadId = string(params.threadId, 'threadId'); this.admit(threadId); this.admitHistory(threadId, context); const activity = this.track(threadId); activity.pending = true; this.emitState();
    let accepted = false; let prepared: PreparedAttachments | undefined; const wasFresh = activity.fresh; const initialRevision = activity.revision; let writeRevision: number | undefined; let mediaRevision: number | undefined; let model: JsonValue | undefined;
    try {
      const p: JsonObject = { threadId };
      const revision = activity.revision; const current = await this.native.call('thread/read', { threadId }); if (object(object(current).thread).id !== threadId) throw new DeliveryError('invalid_native_response', 'Thread identity mismatch'); this.observeThread(current, revision);
      if (method !== 'turn/start') this.environments.assertThread(object(object(current).thread));
      if (method === 'turn/start') {
        this.providers.assertThread(object(object(current).thread).modelProvider, params.options);
        const text = string(params.text ?? '', 'text', 1024 * 1024, true); prepared = this.attachments.prepare(params.attachmentIds, threadId);
        const selected = params.references === undefined && params.extraContext === undefined ? { input: [], additionalContext: {} } : await this.inputContext.prepare(this.cwd(object(object(current).thread).cwd), params.references, params.extraContext, context, threadId);
        if (!text.length && prepared.input.length === 0 && !selected.input.length && !Object.keys(selected.additionalContext).length) throw new DeliveryError('invalid_params', 'Turn requires text, attachments or context references');
        p.input = [{ type: 'text', text, text_elements: [] }, ...prepared.input, ...selected.input]; if (Object.keys(selected.additionalContext).length) p.additionalContext = selected.additionalContext;
        Object.assign(p, this.threadOptions(params.options, true)); validateOfficial('TurnStartParams', p);
        model = selectedInputModel(p, object(object(current).thread).model ?? this.sessions.read(threadId).model);
        if (mediaModalities(p.input).length) {
          mediaRevision = activity.settingsRevision ?? 0;
          const provider = object(object(current).thread).modelProvider;
          await validateInputModalities((method, params) => method === 'model/list'
            ? this.providers.list({ ...object(params), ...(provider !== undefined ? { modelProvider: provider } : {}) }, (method, params) => this.native.call(method, params), (provider, chatgpt, hidden) => this.providerCatalog(provider, chatgpt, hidden))
            : this.native.call(method, params), model, p.input);
        }
        if (p.environments === undefined) this.environments.assertThread(object(object(current).thread));
      }
      if (activity.directInput === false) throw new DeliveryError('direct_input_unavailable', 'Native thread does not accept direct input');
      if (activity.subscribed === false) throw new DeliveryError('session_not_loaded', 'Explicitly load the thread before starting work');
      const result = await this.native.call(method, p, { beforeWrite: () => { this.admit(threadId, true); this.admitHistory(threadId, context); if (mediaRevision !== undefined && mediaRevision !== (activity.settingsRevision ?? 0)) throw new DeliveryError('model_changed', 'Model settings changed during media validation'); prepared?.pin(); context.beforeWrite?.(); this.predictions.invalidate(threadId); if (method === 'turn/start') { activity.fresh = false; if (typeof model === 'string') activity.activeModel = model; else delete activity.activeModel; } writeRevision = activity.revision; } });
      accepted = true; prepared?.settle(true);
      if (activity.revision === writeRevision) {
        if (method === 'turn/start') { const turn = object(object(result).turn); if (turn.status === 'inProgress') { activity.status = 'active'; activity.turnId = string(turn.id, 'turn id'); activity.turnRevision = (activity.turnRevision ?? 0) + 1; } }
        else activity.status = 'active';
      }
      return result;
    } catch (error) {
      const notSent = !accepted && error instanceof DeliveryError && error.delivery === 'not_sent';
      try { prepared?.settle(!notSent); } catch { this.emit('diagnostic', 'Rejected turn attachment reservation could not be released'); }
      if (notSent && wasFresh && activity.revision === (writeRevision ?? initialRevision) && activity.status !== 'active' && activity.turnId === null) activity.fresh = true;
      if (accepted) { activity.unknown = true; throw new DeliveryError('invalid_native_response', 'Native turn returned an invalid result', 'unknown'); }
      if (!notSent) activity.unknown = true; throw error;
    }
    finally { activity.pending = false; this.emitState(); }
  }
  private async answer(params: JsonObject, context: CallContext): Promise<JsonValue> {
    onlyKeys(params, ['promptId', 'response']); const id = string(params.promptId, 'promptId'); const prompt = this.prompts.get(id);
    if (!prompt || prompt.epoch !== this.epoch || prompt.answering) throw new DeliveryError('prompt_unavailable', 'Prompt is no longer waiting');
    if (params.response === undefined) throw new DeliveryError('invalid_params', 'Missing prompt response'); validatePrompt(prompt.method, prompt.params, params.response); prompt.answering = true;
    try { await this.native.respond(prompt.requestId, params.response, () => { if (this.prompts.get(id) !== prompt) throw new DeliveryError('prompt_unavailable', 'Prompt resolved before write'); context.beforeWrite?.(); }); this.closePrompt(prompt, 'answered'); return {}; }
    finally { prompt.answering = false; }
  }
  private async defaults(params: JsonObject): Promise<JsonValue> {
    if (this.closed) throw new DeliveryError('runtime_unavailable', 'Runtime is closing');
    onlyKeys(params, ['cwd', 'options']); const cwd = params.cwd === undefined ? this.config.cwd : this.cwd(params.cwd); const selected = this.threadOptions(params.options, false);
    if (this.config.launcher) await resolveNativeProject(this.config, cwd);
    const config = object(await this.native.call('config/read', { cwd, includeLayers: false })); jsonBytes(config.config, 256 * 1024); const key = createHash('sha256').update(canonical({ cwd, selected, config: config.config! })).digest('hex');
    if (this.closed) throw new DeliveryError('runtime_unavailable', 'Runtime closed during the defaults read');
    const cached = this.defaultsCache.get(key); if (cached) return cached;
    if (this.defaultsPending) throw new DeliveryError('capacity', 'Another effective-defaults probe is running'); this.defaultsPending = true;
    let probe: NativeRpc | undefined;
    try {
      probe = new NativeRpc({ ...this.config, cwd, isolatedGroup: true }); this.defaultsProbe = probe; probe.on('fatal', () => {});
      await probe.initialize(); const result = object(await probe.call('thread/start', { cwd, ...selected, ephemeral: true }));
      const defaults: JsonObject = {}; for (const name of ['model', 'modelProvider', 'reasoningEffort', 'approvalPolicy', 'sandbox', 'activePermissionProfile', 'cwd']) defaults[name] = result[name] ?? null;
      // Closing the entire dedicated process is the cleanup acknowledgement; unsubscribe is not sufficient.
      await probe.close(); if (this.closed) throw new DeliveryError('runtime_unavailable', 'Runtime closed during the defaults probe');
      if (this.defaultsCache.size >= 16) this.defaultsCache.delete(this.defaultsCache.keys().next().value!); this.defaultsCache.set(key, defaults); return defaults;
    } finally {
      try { await probe?.close(); }
      catch (error) { this.unknown = true; this.emitState(); this.emit('fatal'); throw error; }
      finally { if (this.defaultsProbe === probe) this.defaultsProbe = undefined; this.defaultsPending = false; }
    }
  }
  private async openTerminal(params: JsonObject, context: CallContext): Promise<JsonValue> {
    if (params.program === 'codex' || params.program === 'codex-cloud') return this.cliTerminals.open(params, context);
    onlyKeys(params, ['cwd', 'projectId', 'rows', 'cols', 'program']); if (params.program !== undefined && params.program !== 'shell') throw new DeliveryError('invalid_params', 'Unknown fixed terminal program'); this.admit(); const cwd = this.cwd(params.cwd); const rows = integer(params.rows ?? 24, 'rows', 1, 500); const cols = integer(params.cols ?? 80, 'cols', 1, 500);
    const ownerKey = this.ownerKey(context.clientId, context.eventChannelId);
    if (this.terminals.size >= LIMITS.terminals || [...this.terminals.values()].filter(item => this.ownerKey(item.clientId, item.eventChannelId) === ownerKey).length >= 2) throw new DeliveryError('capacity', 'Terminal capacity exhausted');
    const terminalId = randomUUID(); const generation = this.generations.get(ownerKey) ?? 0; const terminal: Terminal = { terminalId, clientId: context.clientId, eventChannelId: context.eventChannelId, generation, ended: false }; this.terminals.set(terminalId, terminal); this.emitState();
    let writtenResolve!: () => void; let writtenReject!: (error: unknown) => void; const written = new Promise<void>((resolve, reject) => { writtenResolve = resolve; writtenReject = reject; });
    const command = [this.config.shell ?? (process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh')];
    void this.native.call('command/exec', { command, cwd, processId: terminalId, tty: true, size: { rows, cols }, disableTimeout: true, disableOutputCap: true, sandboxPolicy: { type: 'dangerFullAccess' } }, { timeoutMs: 0, beforeWrite: () => { if ((this.generations.get(ownerKey) ?? 0) !== generation || this.terminals.get(terminalId) !== terminal) throw new DeliveryError('client_disconnected', 'Terminal owner disconnected'); context.beforeWrite?.(); }, onWritten: writtenResolve }).then(result => {
      terminal.ended = true;
      this.emitEvent('terminal', { terminalId, clientId: context.clientId, type: 'exit', ...object(result) }, context.eventChannelId);
    }, error => { terminal.ended = error instanceof DeliveryError && error.delivery === 'not_sent'; writtenReject(error); this.emitEvent('terminal', { terminalId, clientId: context.clientId, type: 'error', error: error instanceof Error ? error.message : 'Terminal failed' }, context.eventChannelId); }).finally(() => { this.terminals.delete(terminalId); if (![...this.terminals.values()].some(item => this.ownerKey(item.clientId, item.eventChannelId) === ownerKey)) this.generations.delete(ownerKey); this.emitState(); });
    try { await written; return { terminalId }; } catch (error) { this.terminals.delete(terminalId); throw error; }
  }
  private async terminalCall(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    if (this.cliTerminals.has(params.terminalId)) return this.cliTerminals.call(method, params, context);
    const terminalId = string(params.terminalId, 'terminalId'); const terminal = this.terminals.get(terminalId); if (!terminal || terminal.clientId !== context.clientId || terminal.eventChannelId !== context.eventChannelId) throw new DeliveryError('not_found', 'Terminal not found for this connection');
    const nativeOptions = { beforeWrite: () => { if (this.terminals.get(terminalId) !== terminal) throw new DeliveryError('not_found', 'Terminal ended'); context.beforeWrite?.(); } };
    if (method === 'terminal/close') { onlyKeys(params, ['terminalId']); return this.native.call('command/exec/terminate', { processId: terminalId }, nativeOptions); }
    if (method === 'terminal/resize') { onlyKeys(params, ['terminalId', 'rows', 'cols']); return this.native.call('command/exec/resize', { processId: terminalId, size: { rows: integer(params.rows, 'rows', 1, 500), cols: integer(params.cols, 'cols', 1, 500) } }, nativeOptions); }
    onlyKeys(params, ['terminalId', 'text', 'deltaBase64', 'closeStdin']);
    if (params.text !== undefined && params.deltaBase64 !== undefined) throw new DeliveryError('invalid_params', 'Use text or base64');
    const deltaBase64 = params.text !== undefined ? Buffer.from(string(params.text, 'text', 65536, true)).toString('base64') : string(params.deltaBase64 ?? '', 'deltaBase64', 90000, true);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(deltaBase64)) throw new DeliveryError('invalid_params', 'Invalid terminal base64');
    if (params.closeStdin !== undefined && typeof params.closeStdin !== 'boolean') throw new DeliveryError('invalid_params', 'Invalid closeStdin');
    return this.native.call('command/exec/write', { processId: terminalId, deltaBase64, ...(params.closeStdin !== undefined ? { closeStdin: params.closeStdin } : {}) }, nativeOptions);
  }
  async clientDisconnected(clientId: string, eventChannelId?: string): Promise<void> {
    if (this.closed) return this.close();
    this.historyStore.disconnect(clientId, eventChannelId);
    this.remoteControl.disconnect(clientId, eventChannelId);
    this.predictions.disconnect(clientId, eventChannelId);
    this.mcpOauth.disconnect(clientId, eventChannelId);
    // Each subsystem revokes its leases synchronously before any cleanup waits.
    await Promise.all([this.mcp.disconnect(clientId, eventChannelId), this.processes.disconnect(clientId, eventChannelId), this.realtime.disconnect(clientId, eventChannelId), this.extensions.disconnect(clientId, eventChannelId), this.cliTerminals.disconnect(clientId, eventChannelId), this.cliDiagnostics.disconnect(clientId, eventChannelId), this.deviceLogin.disconnect(clientId, eventChannelId)]);
    const owned = [...this.terminals.values()].filter(item => item.clientId === clientId && item.eventChannelId === eventChannelId); if (!owned.length) return;
    const ownerKey = this.ownerKey(clientId, eventChannelId); this.generations.set(ownerKey, (this.generations.get(ownerKey) ?? 0) + 1);
    const results = await Promise.allSettled(owned.map(terminal => this.native.call('command/exec/terminate', { processId: terminal.terminalId })));
    if (results.some((result, index) => result.status === 'rejected' && !owned[index]!.ended)) {
      // A rejected terminate, including capacity/not_sent, is no cleanup proof.
      // End this epoch once instead of leaving ownerless processes or retrying forever.
      const notify = !this.closed; this.unknown = true; const closing = this.close();
      if (notify) { this.emitState(); this.emit('fatal'); }
      await closing;
    } else if (this.closed) await this.close();
  }
  async gatewayDisconnected(eventChannelId?: string): Promise<void> {
    if (this.closed) return this.close();
    this.historyStore.disconnect(undefined, eventChannelId);
    this.remoteControl.disconnect(undefined, eventChannelId);
    this.predictions.disconnect(undefined, eventChannelId);
    this.mcpOauth.disconnect(undefined, eventChannelId);
    await Promise.all([this.mcp.disconnect(undefined, eventChannelId), this.processes.disconnect(undefined, eventChannelId), this.realtime.disconnect(undefined, eventChannelId), this.extensions.disconnect(undefined, eventChannelId), this.cliTerminals.disconnect(undefined, eventChannelId), this.cliDiagnostics.disconnect(undefined, eventChannelId), this.deviceLogin.disconnect(undefined, eventChannelId)]);
    const owners = new Map([...this.terminals.values()].filter(terminal => eventChannelId === undefined || terminal.eventChannelId === eventChannelId).map(terminal => [this.ownerKey(terminal.clientId, terminal.eventChannelId), terminal]));
    const results = await Promise.allSettled([...owners.values()].map(terminal => this.clientDisconnected(terminal.clientId, terminal.eventChannelId)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason as unknown);
    if (errors.length) throw new AggregateError(errors, 'Disconnected terminal cleanup was not confirmed');
    if (this.closed) await this.close();
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.historyStore.clear(); clearInterval(this.gcTimer);
    this.mcp.reset();
    this.processes.reset();
    this.realtime.reset();
    this.guardian.reset();
    this.predictions.reset();
    this.cliTerminals.reset();
    this.cliDiagnostics.reset();
    this.environments.reset(); this.remoteControl.reset();
    this.extensions.close(); this.deviceLogin.close(); this.mcpOauth.close();
    this.closePromise = Promise.allSettled([this.native.close(), ...[...this.catalogProcesses].map(probe => probe.close()), ...(this.defaultsProbe ? [this.defaultsProbe.close()] : []), this.workspace.close()]).then(results => {
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason as unknown);
      if (errors.length) throw new AggregateError(errors, 'Runtime process cleanup was not fully confirmed');
    });
    return this.closePromise;
  }
}
