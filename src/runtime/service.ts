import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { NativeRpc, type NativeConfig, type NativeOptions } from './native.js';
import { Attachments, type PreparedAttachments } from './attachments.js';
import { GeneratedMedia } from './generated-media.js';
import { readMediaHistory } from './media-history.js';
import { options, supportedPrompt, validateOfficial, validatePrompt } from './validation.js';
import { canonical, DeliveryError, integer, jsonBytes, LIMITS, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue, type RuntimeEvent } from './types.js';
import { DiagnosticRedactor } from './redaction.js';
import { readNativeExecutionMode, resolveNativeProject, type ExecutionMode, type ExecutionPolicy } from './native-launch.js';
import { createProject, resolveProject } from './projects.js';
import { Workflows, type WorkflowMutation } from './workflows.js';
import { workflowMethods } from './workflow-methods.js';
import { SessionSnapshots } from './session-snapshots.js';
import { runWorkspace } from './workspace.js';
import { RepositoryLeases } from './repository-leases.js';
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
import { LiveThreadList } from './live-thread-list.js';
import { convertThread } from './thread-conversion.js';
import { historyHelper } from './thread-history-compatibility.js';

function hasDevelopmentSystemConfig(config: NativeConfig): boolean {
  const system = process.platform === 'win32'
    ? path.join(config.env.ProgramData ?? config.env.PROGRAMDATA ?? process.env.ProgramData ?? 'C:\\ProgramData', 'OpenAI', 'Codex', 'config.toml')
    : '/etc/codex/config.toml';
  return config.dev === true && existsSync(system);
}

export interface RuntimeConfig extends NativeConfig { workerHome: string; nativeHome?: string; shell?: string; attachmentGid?: number; providerRegistry?: JsonObject; executionPolicy?: ExecutionPolicy }
interface Prompt { promptId: string; epoch: string; method: string; params: JsonObject; threadId: string | null; turnId: string | null; requestId: string | number; bytes: number; answering: boolean }
interface Terminal { cwd: string; terminalId: string; clientId: string; eventChannelId: string | undefined; generation: number; ended: boolean }
export class RuntimeService extends EventEmitter {
  readonly epoch = randomUUID();
  private activity = new ThreadActivity(
    id => this.realtime?.has(id) || this.continuationChecks.has(id) ||
      this.predictions?.activeThreads().includes(id) || [...this.prompts.values()].some(prompt => prompt.threadId === id),
    id => {
      this.historyStore.invalidate(id);
      this.generatedMedia?.invalidate(id);
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
  private generatedMedia: GeneratedMedia;
  private defaultsCache = new Map<string, JsonValue>();
  private defaultsGeneration = 0;
  private defaultsReaders = 0;
  private defaultsFlight: { key: string; result: Promise<JsonValue | undefined> } | undefined;
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
  private cliSwitchArgs: string[] = [];
  private workspace: RuntimeWorkspace;
  private readonly repositories: RepositoryLeases;
  private sessions = new SessionSnapshots();
  private liveThreads = new LiveThreadList();
  private continuationChecks = new Map<string, Promise<void>>();
  private readonly executionMode: Readonly<ExecutionMode> | undefined;
  constructor(readonly config: RuntimeConfig, readonly native: NativeRpc, executionMode?: ExecutionMode) {
    super();
    this.executionMode = executionMode && Object.freeze({ ...executionMode });
    this.providers = new ManagedProviders(config.providerRegistry);
    this.generatedMedia = new GeneratedMedia({ native: (method, params) => this.native.call(method, params), revision: id => this.track(id).historyRevision ?? 0, closed: () => this.closed || !this.native.connected });
    this.repositories = new RepositoryLeases(async cwd => {
      const value = object(await runWorkspace(config, { path: cwd }, 'repository/identity', {}, { clientId: 'repository-admission' }, true));
      if (typeof value.identity !== 'string' || !/^[a-f0-9]{64}$/.test(value.identity))
        throw new DeliveryError('invalid_native_response', '仓库资源身份未由本机助手确认。');
      return value.identity;
    }, () => this.repositoryActivity());
    this.workspace = new RuntimeWorkspace({
      config, cwd: value => this.cwd(value), admit: () => this.admit(),
      repository: (cwd, work) => this.repositories.run(cwd, true, work),
      pending: change => { this.pendingStarts += change; this.emitState(); },
      uncertain: () => { this.unknown = true; },
    });
    this.historyStore = new UnifiedHistory({ native: (method, params, historyImageDisplayChars, windowTail) => this.readNative(method, params, { ...(historyImageDisplayChars ? { historyImageDisplayChars } : {}), ...(windowTail ? { historyWindowTail: true } : {}) }), state: id => this.track(id), observe: (value, revision) => this.observeThread(value, revision), checkTurns: turns => this.checkHistory(turns), closed: () => this.closed }); this.attachments = new Attachments(config.workerHome, config.attachmentGid); this.redactor = new DiagnosticRedactor(config.env);
    this.workflows = new Workflows({ queueCapacity: threadId => this.native instanceof NativeRpc && (this.config.launcher || this.config.dev) && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(threadId) ? historyHelper(this.config, { action: 'queue-capacity', threadId, attachmentRoot: this.attachments.root }) : Promise.resolve(undefined),
      queueItem: (threadId, queuedSubmissionId) => historyHelper(this.config, { action: 'queue-item', threadId, queuedSubmissionId, attachmentRoot: this.attachments.root }), queueImage: (threadId, queuedSubmissionId, ordinal, marker) => historyHelper(this.config, { action: 'queue-image', threadId, queuedSubmissionId, ordinal,
        expectedSha256: marker.sha256!, expectedBytes: marker.bytes!, attachmentRoot: this.attachments.root }), queueHandoffs: this.attachments, historyTraversal: context => { const reader = this.historyStore.isolated(context); return { read: params => this.activity.read(string(params.threadId, 'threadId'), () => reader.read(params)), close: () => reader.close() }; }, native: (method, params, options) => this.readNative(method, params, options), mutate: (operation, context) => this.workflowMutation(operation, context), call: (method, params, context) => this.call(method, params, context), prepare: (ids, threadId) => this.attachments.prepare(ids, threadId), describeInput: (input, threadId, queuedId) => this.attachments.describeInput(input, threadId, queuedId), contextInput: (cwd, references, extra, context, threadId) => this.inputContext.prepare(cwd, references, extra, context, threadId), checkHistory: turns => this.checkHistory(turns), cwd: value => this.cwd(value) });
    this.extensions = new Extensions({ native: (method, params, options) => this.native.call(method, params, options), configure: (operation, context) => this.configurationMutation(operation, context), cwd: value => this.cwd(value), redactor: this.redactor, notify: (method, params) => this.emitEvent('notification', { method, params }),
      resource: async (cwd, action, params) => {
        const root = { path: this.cwd(cwd) }, context = { clientId: 'internal-resource' };
        if (action === 'mcp/enabled-read' || action === 'mcp/user-state') return this.config.launcher
          ? object(await runWorkspace(config, root, action, {}, context, true))
          : historyHelper(config, { action: action === 'mcp/user-state' ? 'mcp-user-state' : 'mcp-enabled-read' });
        if (!this.config.launcher && this.config.dev) return devResource(root.path, action, params, [path.join(this.config.env.HOME ?? this.config.workerHome, '.agents', 'skills'), path.join(this.config.home, 'skills'), path.join(this.config.home, 'plugins', 'cache')]);
        if (action === 'feedback/path' || action === 'project/trust-roots') return object(await runWorkspace(config, root, action, {}, context, true));
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
    this.realtime = new Realtime({ native: (method, params, options) => this.readNative(method, params, options), mutate: (operation, context) => this.workflowMutation(operation, context), available: () => this.admit(), invalidate: threadId => this.invalidateHistory(threadId),
      requireLoaded: threadId => { this.admit(); if (this.track(threadId).subscribed !== true) throw new DeliveryError('session_not_loaded', 'Explicitly load the thread before starting voice'); },
      redact: message => this.redactor.text(message), uncertain: id => { this.track(id).unknown = true; this.emitState(); }, emit: (data, channel) => this.emitEvent('realtime', data, channel), changed: () => this.emitState(), failEpoch: async () => { this.unknown = true; this.emitState(); this.emit('fatal'); await this.close(); } });
    const remoteHost = { native: (method: string, params: JsonValue, options?: NativeOptions) => this.native.call(method, params, options), configure: (operation: (write: (method: string, params: JsonValue, options?: NativeOptions) => Promise<JsonValue>) => Promise<JsonValue>, context: CallContext) => this.configurationMutation(operation, context), redactor: this.redactor };
    this.environments = new Environments(remoteHost); this.remoteControl = new RemoteControl(remoteHost);
    this.threadTerminals = new ThreadTerminals({ native: (method, params, options) => this.native.call(method, params, options), mutate: (operation, context) => this.workflowMutation(operation, context) });
    this.guardian = new Guardian({ mutate: (operation, context) => this.workflowMutation(operation, context) });
    this.cliTerminals = new CliTerminals({ switchArgs: () => this.cliSwitchArgs, bin: config.bin, native: (method, params, options) => method === 'account/read' ? this.readAccount() : this.native.call(method, params, options), start: (operation, context) => this.metadataMutation(operation, context, true), available: () => this.admit(undefined, false, false, true), cwd: value => this.cwd(value), emit: (data, channel) => this.emitEvent('terminal', data, channel), changed: () => this.emitState(),
      settled: () => {
        // The CLI can edit native configuration and sessions independently. Its
        // confirmed exit requires a fresh epoch, not a permanent unknown state.
        if (this.closed || this.restarting) return;
        this.restarting = true; this.invalidateDefaults(); this.sessions.clear(); this.historyStore.clear(); this.guardian.invalidateAll(); this.predictions.invalidate(); this.emitState(); this.emit('restart-required');
      }, failEpoch: async () => { this.unknown = true; this.emitState(); this.emit('fatal'); await this.close(); } });
    this.cliDiagnostics = new CliDiagnostics({ bin: config.bin, cwd: config.nativeHome ?? config.workerHome, native: (method, params, options) => this.native.call(method, params, options), redactor: this.redactor, configure: async (operation, context) => {
      if (!context.beforeWrite) throw new DeliveryError('operation_required', 'Diagnostic execution requires an operation receipt');
      this.admit(); this.pendingStarts++; this.emitState();
      try { return await operation((method, body, opts = {}) => this.native.call(method, body, { ...opts, beforeWrite: () => { this.admit(); context.beforeWrite!(); opts.beforeWrite?.(); } })); }
      finally { this.pendingStarts--; this.emitState(); }
    }, available: () => this.admit(), failEpoch: async () => { this.unknown = true; this.emitState(); this.emit('fatal'); await this.close(); } });
    this.deviceLogin = new DeviceLogin({ native: (method, params, options) => this.native.call(method, params, options), redactor: this.redactor });
    this.mcpOauth = new McpOauth({ epoch: this.epoch, redactor: this.redactor, serverStatus: params => this.mcp.list(params), notify: (params, channel) => this.emitEvent('mcp', { type: 'oauth-completed', ...params }, channel) });
    this.predictions = new Predictions({ native: (method, params) => this.native.call(method, params), mutate: (operation, context) => this.workflowMutation(operation, context), revision: threadId => this.track(threadId).revision, emit: (data, channel) => this.emitEvent('prediction', data, channel), changed: () => this.emitState(), unknown: id => { this.track(id).unknown = true; this.emitState(); } });
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
  private static async nativeProcess(config: RuntimeConfig): Promise<NativeRpc> {
    if (!config.launcher && hasDevelopmentSystemConfig(config)) {
      const { args } = await historyHelper(config, { action: 'mcp-enabled-launch' });
      if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === 'string')) throw new DeliveryError('invalid_native_response', '原生 MCP 配置层无效。');
      return new NativeRpc({ ...config, args: [...(config.args ?? ['app-server', '--listen', 'stdio://']), ...args] });
    }
    return new NativeRpc(config);
  }
  static async create(config: RuntimeConfig): Promise<RuntimeService> {
    if (config.launcher?.user === 'root' && !config.executionPolicy) throw new DeliveryError('native_identity_mismatch', 'Root execution requires a managed execution policy');
    const executionMode = config.executionPolicy ? await readNativeExecutionMode(config, config.executionPolicy) : undefined;
    const native = await RuntimeService.nativeProcess(config); let service: RuntimeService | undefined;
    try { service = new RuntimeService(config, native, executionMode); await native.initialize();
      if (config.launcher || hasDevelopmentSystemConfig(config)) {
        const { layers } = object(await native.call('config/read', { includeLayers: true }));
        const flags = Array.isArray(layers) ? layers.map(value => object(value)).find(layer => object(layer.name).type === 'sessionFlags') : undefined;
        const entries = flags ? Object.entries(object(object(flags.config).mcp_servers ?? {})) : [];
        const switches = entries.flatMap(([name, item]) => {
          const server = object(item);
          return Object.keys(server).length === 1 && typeof server.enabled === 'boolean' ? [JSON.stringify(name) + '={enabled=' + String(server.enabled) + '}'] : [];
        });
        if (switches.length) service.cliSwitchArgs = ['-c', 'mcp_servers={' + switches.join(',') + '}'];
      }
      await service.reconcileAttachments(); service.emitState(); return service; } catch (error) { if (service) await service.close(); else await native.close(); throw error; }
  }
  private async reconcileAttachments(): Promise<void> {
    if (!this.attachments.needsReconciliation) return;
    this.attachments.protectUnverifiedReferences();
    try { this.attachments.reconcile(await historyHelper(this.config, { action: 'attachment-index', attachmentRoot: this.attachments.root, activeImageDigests: this.attachments.activeImageDigests })); }
    catch { this.emit('diagnostic', '附件历史核对未完成，已保留原引用与复制保护；不会根据文件年龄删除历史附件。'); }
  }
  private async finishAttachmentCopy(id: string | undefined, thread: JsonObject): Promise<void> {
    if (!id) return;
    const threadId = string(thread.id, 'copy target thread', 256), inspected = await historyHelper(this.config, { action: 'attachment-inspect', mode: 'plaintext', threadId, path: string(thread.path, 'copy target history path'), attachmentRoot: this.attachments.root, activeImageDigests: this.attachments.activeImageDigests });
    if (!Array.isArray(inspected.paths) || inspected.paths.length > 128) throw new DeliveryError('attachment_storage', 'Invalid copied attachment reference proof', 'unknown');
    this.attachments.finishCopy(id, threadId, inspected.paths.map(value => string(value, 'copied attachment path', 4096)), inspected.images);
  }
  status(): JsonValue {
    const activeThreads = new Set([...this.activity].filter(([, value]) => hasTurnActivity(value) || value.pending || value.unknown || value.goalActive || value.queued || value.checkingContinuation || value.continuationUnverified).map(([id]) => id));
    for (const id of this.realtime.activeThreads()) activeThreads.add(id);
    return { repositoryScopes: 1, epoch: this.epoch, connected: this.native.connected && !this.closed, restarting: this.restarting, ...(this.executionMode ? { executionMode: { ...this.executionMode } } : {}), activity: { activeThreads: [...activeThreads], pendingStarts: this.pendingStarts + (this.predictions?.activeThreads().length ?? 0), terminals: this.terminals.size + (this.cliTerminals?.active ?? 0), subscriptions: this.mcp.subscriptions, processes: this.processes.active, unknown: this.unknown || [...this.activity.values()].some(value => value.unknown) }, budget: this.native.budget, predictionBudget: this.predictions.budget(), prompts: this.prompts.size };
  }
  private emitEvent(type: RuntimeEvent['type'], data: JsonValue, eventChannelId?: string): void { jsonBytes({ type, data }, LIMITS.eventBytes); this.emit('event', { type, data, ...(eventChannelId ? { eventChannelId } : {}) } satisfies RuntimeEvent); }
  private ownerKey(clientId: string, eventChannelId?: string): string { return canonical([eventChannelId ?? null, clientId]); }
  private emitState(): void { this.emitEvent('state', this.status()); }
  private track(id: string): Activity {
    return this.activity.track(id);
  }
  private admit(threadId?: string, ownPending = false, ownConfiguration = false, ownCli = false): void {
    if (!this.native.connected || this.closed) throw new DeliveryError('runtime_unavailable', 'Runtime unavailable');
    if (this.restarting) throw new DeliveryError('runtime_restarting', '正在自动刷新后台环境，请稍候。');
    if (this.unknown) throw new DeliveryError('activity_unknown', 'Runtime activity is unknown; recovery is required');
    if (!ownCli && this.cliTerminals?.active) throw new DeliveryError('native_cli_busy', '请先关闭 Codex CLI 终端；后台会自动刷新后恢复其他操作。');
    if (this.configurationPending && !ownConfiguration) throw new DeliveryError('configuration_busy', 'Runtime configuration is changing');
    if (threadId) { const state = this.track(threadId); if (state.unknown) throw new DeliveryError('activity_unknown', 'Thread outcome is unknown'); if (hasTurnActivity(state) || state.goalActive || state.queued || state.checkingContinuation || state.continuationUnverified || this.realtime.has(threadId) || (state.pending && !ownPending)) throw new DeliveryError('thread_busy', 'Thread already has active or pending work'); }
  }
  private observeThread(value: JsonValue, revision?: number): void {
    const response = object(value); const thread = object(response.thread); const id = string(thread.id, 'native thread id'); const state = this.track(id);
    if (typeof thread.historyMode === 'string') state.historyMode = thread.historyMode;
    if (typeof thread.canAcceptDirectInput === 'boolean' || thread.canAcceptDirectInput === null) state.directInput = thread.canAcceptDirectInput;
    if ((Array.isArray(thread.turns) && thread.turns.length > 0) || (thread.status && typeof thread.status === 'object' && !Array.isArray(thread.status) && thread.status.type === 'active')) state.fresh = false;
    if (revision !== undefined && revision !== state.revision) return;
    if (typeof thread.cwd === 'string') state.cwd = thread.cwd;
    this.sessions.thread(thread);
    if (thread.status && typeof thread.status === 'object' && !Array.isArray(thread.status)) state.status = String(thread.status.type);
    if (Array.isArray(thread.turns)) { const active = thread.turns.map(turn => object(turn)).find(turn => turn.status === 'inProgress' && turn.id !== state.lastTerminalTurn?.id); if (active) { const turnId = string(active.id, 'turn id'); if (state.turnId !== turnId) state.turnRevision = (state.turnRevision ?? 0) + 1; state.status = 'active'; state.turnId = turnId; } }
    this.emitState();
  }
  private notification(message: JsonObject): void {
    const method = string(message.method, 'notification method'); const params = object(message.params ?? {});
    if (method === 'harness/historyPreviewOmitted') { this.invalidateHistory(string(params.threadId, 'threadId'), true); return; }
    this.liveThreads.notification(method, params);
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
      this.invalidateDefaults(); this.accountReadGeneration++; this.accountProbe = undefined;
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
      if (method === 'thread/closed' || method === 'thread/deleted' || (method === 'thread/status/changed' && state.status === 'notLoaded')) { this.sessions.invalidate(params.threadId); }
      if (method === 'thread/deleted') { try { this.attachments.releaseThread(params.threadId); } catch { this.emit('diagnostic', '已删除会话的附件清理待重启核对，未删除其它会话引用。'); } }
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
    const diagnostic = ['error', 'warning', 'guardianWarning', 'configWarning', 'deprecationNotice', 'account/login/completed', 'mcpServer/startupStatus/updated'].includes(method) || method.startsWith('modelProvider/authRecovery');
    let projected = diagnostic ? this.redactor.value(params) : this.generatedMedia.project(params);
    if (method === 'turn/completed' && params.turn && typeof params.turn === 'object' && !Array.isArray(params.turn) && params.turn.error != null)
      projected = { ...object(projected), turn: { ...object(object(projected).turn), error: this.redactor.value(params.turn.error) } };
    this.emitEvent('notification', { method, params: projected });
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
  private closePrompt(prompt: Prompt, reason: string): void {
    if (!this.prompts.delete(prompt.promptId)) return;
    this.promptBytes -= prompt.bytes;
    const { promptId, threadId, turnId, epoch } = prompt;
    const pendingForTurn = [...this.prompts.values()].some(other => other.threadId === threadId && other.turnId === turnId);
    this.emitEvent('prompt-closed', { promptId, reason, epoch, threadId, turnId, pendingForTurn });
  }
  private repositoryActivity(): (string | undefined)[] {
    this.admit();
    const roots: (string | undefined)[] = [...this.processes.activeRoots(), ...[...this.terminals.values()].map(entry => entry.cwd)];
    if (this.pendingStarts > this.workspace.pendingWrites || this.defaultsPending || this.cliTerminals.active) roots.push(undefined);
    const threads = new Set([...this.mcp.subscriptionThreads(), ...this.realtime.activeThreads(), ...this.predictions.activeThreads()]);
    for (const [id, state] of this.activity) {
      if (state.unknown) { roots.push(undefined); continue; }
      if (hasTurnActivity(state) || state.pending || state.goalActive || state.queued ||
          state.checkingContinuation || state.continuationUnverified) threads.add(id);
    }
    for (const id of threads) roots.push(this.track(id).cwd);
    return roots;
  }
  async call(method: string, input: JsonValue, context: CallContext): Promise<JsonValue> {
    const params = object(input), feature = featureMethod(method);
    const cwd = typeof params.cwd === 'string' ? params.cwd :
      typeof params.threadId === 'string' ? this.track(params.threadId).cwd : undefined;
    const scoped = context.beforeWrite && feature?.activity !== 'repository' &&
      (feature?.access === 'write' || ['conversation/start', 'thread/start', 'turn/start', 'thread/compact', 'terminal/open'].includes(method));
    const result = scoped ? await this.repositories.run(cwd, false, () => this.dispatch(method, input, context)) :
      await this.dispatch(method, input, context);
    return this.generatedMedia.project(result, typeof params.threadId === 'string' ? params.threadId : undefined);
  }
  private async readNative(method: string, params: JsonValue, options?: NativeOptions): Promise<JsonValue> {
    return readMediaHistory((method, params, options) => this.native.call(method, params, options), this.generatedMedia, method, params, options);
  }
  private async dispatch(method: string, input: JsonValue, context: CallContext): Promise<JsonValue> {
    const params = object(input); string(context.clientId, 'clientId', 256); jsonBytes(params);
    if (typeof params.threadId === 'string' && this.track(params.threadId).continuationUnverified && ['thread/session', 'turn/start', 'thread/compact', 'thread/resume', 'thread/fork', 'thread/convert', 'thread/settings/update', 'thread/queue/start', 'thread/goal/set', 'thread/prediction/request'].includes(method)) await this.refreshContinuation(params.threadId);
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
        onlyKeys(params, ['path']); const requested = string(params.path, 'path');
        return resolveProject(this.config, requested, this.config.nativeHome ?? this.config.workerHome);
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
      case 'thread/session': {
        onlyKeys(params, ['threadId', 'checkContinuation']);
        if (params.checkContinuation !== undefined && typeof params.checkContinuation !== 'boolean') throw new DeliveryError('invalid_params', 'Invalid continuation check');
        const threadId = string(params.threadId, 'threadId');
        const snapshot = this.closed || !this.native.connected ? { requiresResume: true } : this.sessions.read(threadId);
        if (snapshot.requiresResume !== true || params.checkContinuation !== true || this.closed || !this.native.connected) return snapshot;
        return { ...snapshot, requiresContinuationConfirmation: (await this.continuationForLoad(threadId)).required };
      }
      case 'thread/convert': return this.convert(params, context);
      case 'prompt/list': {
        const prompts = [...this.prompts.values()];
        if (params.view === 'turns') return { epoch: this.epoch, prompts: prompts.map(({ threadId, turnId }) => ({ threadId, turnId })) };
        return { epoch: this.epoch, prompts: prompts.map(prompt => this.publicPrompt(prompt)) };
      }
      case 'prompt/answer': return this.answer(params, context);
      case 'attachment/upload': return this.attachments.upload(params, context.clientId);
      case 'attachment/read': return this.attachments.read(params);
      case 'attachment/history/read': return this.attachments.readHistory(params);
      case 'thread/media/read': return this.generatedMedia.read(params);
      case 'attachment/remove': return this.attachments.remove(params);
      case 'terminal/open': return this.openTerminal(params, context);
      case 'terminal/write': case 'terminal/resize': case 'terminal/close': return this.terminalCall(method, params, context);
      case 'conversation/start': return this.startConversation(params, context);
      case 'thread/start': {
        onlyKeys(params, ['projectId', 'cwd', 'options']); const cwd = this.cwd(params.cwd); const selected = this.threadOptions(params.options, false); const nativeParams = { cwd, ...selected, environments: selected.environments ?? [{ environmentId: 'local', cwd }] }; validateOfficial('ThreadStartParams', nativeParams);
        this.admit(); const releaseListing = this.liveThreads.reserve(); this.pendingStarts++; this.emitState();
        let accepted = false;
        try { const result = await this.native.call(method, nativeParams, { beforeWrite: () => { this.admit(); context.beforeWrite?.(); } }); accepted = true; this.liveThreads.capture(object(object(result).thread), cwd); this.observeThread(result); this.sessions.capture(result); const state = this.track(string(object(object(result).thread).id, 'thread id')); state.subscribed = true; if (state.fresh !== false && state.turnId === null && state.status !== 'active') state.fresh = true; return result; }
        catch (error) { if (accepted) { this.unknown = true; throw new DeliveryError('invalid_native_response', 'Native thread creation returned an invalid result', 'unknown'); } if (error instanceof DeliveryError && error.delivery === 'unknown') this.unknown = true; throw error; }
        finally { releaseListing(); this.pendingStarts--; this.emitState(); }
      }
      case 'thread/resume': {
        onlyKeys(params, ['threadId', 'automatic', 'options']);
        if (params.automatic !== undefined && typeof params.automatic !== 'boolean') throw new DeliveryError('invalid_params', 'Invalid automatic load');
        const selection = params.options === undefined ? undefined : this.threadOptions(this.providers.resumeSelection(params.options), false);
        const threadId = string(params.threadId, 'threadId'); const p: JsonObject = { threadId, excludeTurns: true, ...selection }; validateOfficial('ThreadResumeParams', p);
        this.pendingStarts++; this.emitState();
        let accepted = false;
        let checkedRevision: number | undefined;
        let previousThread: JsonObject | undefined;
        const mediaInput: JsonValue[] = [];
        try { const result = await this.workflowMutation({ method, params: p, schema: 'ThreadResumeParams', responseSchema: 'ThreadResumeResponse', threadId, mode: 'any', history: true,
          mediaInput,
            preflight: async (thread: JsonObject) => {
              previousThread = thread;
              if (selection && !['idle', 'notLoaded'].includes(String(object(thread.status).type)))
                throw new DeliveryError('thread_busy', '请先结束当前任务，再使用其它模型加载会话。');
              if (params.automatic === true) {
                const check = await this.continuationForLoad(threadId);
                if (check.required) throw new DeliveryError('continuation_confirmation_required', selection
                  ? '此会话有已保存的队列或持续目标，请确认后使用所选模型继续执行。'
                  : '此会话有已保存的队列或持续目标，请确认后继续执行。');
                checkedRevision = check.revision;
              }
              // Even a cold, explicitly confirmed resume can immediately consume the
              // persisted queue. Validate it before sending any resume frame.
              mediaInput.push(...await this.workflows.queuedInputs(threadId));
            },
            beforeWrite: () => {
              if (params.automatic === true && checkedRevision !== (this.track(threadId).continuationRevision ?? 0)) throw new DeliveryError('continuation_changed', '会话待执行任务已变化，请重新读取。');
              if (selection && hasTurnActivity(this.track(threadId))) throw new DeliveryError('thread_busy', '会话已开始运行，请先结束任务。');
            },
          ...(selection ? { project: (value: JsonValue) => {
            const resumed = object(value), thread = object(resumed.thread);
            if (resumed.modelProvider !== selection.modelProvider || thread.modelProvider !== selection.modelProvider || resumed.model !== selection.model ||
                resumed.cwd !== previousThread?.cwd || thread.cwd !== previousThread?.cwd ||
                previousThread?.environments != null && canonical(thread.environments ?? null) !== canonical(previousThread.environments))
              throw new DeliveryError('provider_switch_unconfirmed', '会话加载已受理，但所选模型或原工作环境未得到确认；本次未发送消息。', 'unknown', { inputSent: false });
            // Cold thread/read omits executor details. Only the normal local
            // executor may become concrete here; registered remote selections
            // were already required above, and the resumed roots are rechecked.
            this.environments.assertThread(thread);
            return value;
          } } : {}),
        }, context, selection); accepted = true; this.track(threadId).subscribed = true; this.sessions.capture(result);
          try { await this.refreshContinuation(threadId); }
          catch (error) { if (error instanceof DeliveryError && error.code === 'continuation_unverified' && this.native.connected && !this.closed) return { ...object(result), continuationUnverified: true }; throw error; }
          return result; }
        catch (error) {
          const failure = accepted && (!(error instanceof DeliveryError) || error.delivery === 'not_sent')
            ? new DeliveryError('invalid_native_response', 'Thread loaded, but its settings could not be confirmed; inspect its state before continuing', 'unknown') : error;
          if (accepted || failure instanceof DeliveryError && failure.delivery === 'unknown') this.track(threadId).unknown = true;
          throw failure;
        }
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
      case 'thread/list': return this.liveThreads.page(params, object(await this.page(method, 'ThreadListParams', params, { modelProviders: [], sourceKinds: ['cli', 'vscode', 'appServer', 'exec'] }, ['cwd', 'archived', 'cursor', 'limit', 'searchTerm', 'sortKey', 'sortDirection'])));
      case 'thread/history': return this.history(params, context);
      case 'thread/name/set': validateOfficial('ThreadSetNameParams', params); return this.directMutation(method, params, context);
      case 'thread/archive': case 'thread/unarchive': { onlyKeys(params, ['threadId']); const threadId = string(params.threadId, 'threadId'); if (method === 'thread/unarchive') this.environments.assertIndependentLoad(); const result = await this.directMutation(method, params, context); if (method === 'thread/archive') this.liveThreads.remove(threadId); return result; }
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
    const guard = (): void => { if (this.restarting) throw new DeliveryError('runtime_restarting', '正在自动刷新后台环境，请稍候。'); if (this.cliTerminals.active) throw new DeliveryError('native_cli_busy', 'The native CLI has exclusive execution access'); if (this.configurationPending) throw new DeliveryError('configuration_busy', 'Runtime configuration is changing'); };
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
      // Codex 0.169 selects a provider on model/list. Account reads still use
      // the shared ChatGPT account probe because account/read has no selector.
      if (chatgpt && object(object(await this.readAccount(1, true)).account ?? {}).type !== 'chatgpt') return [];
      return readNativeCatalog((method, params) => this.native.call(method, params), false, hidden, provider);
    })();
    this.catalogProbes.set(key, pending);
    try { return await pending; } finally { if (this.catalogProbes.get(key) === pending) this.catalogProbes.delete(key); }
  }
  private accountProbe: Promise<JsonValue> | undefined;
  private accountCatalogSnapshot: { generation: number; expires: number; result: JsonValue } | undefined;
  private accountReadGeneration = 0;
  private checkAccountRead(): void {
    // Account reads are also used by an active CLI terminal, so the general
    // execution admission gate is too restrictive here.
    if (this.closed || !this.native.connected) throw new DeliveryError('runtime_unavailable', 'Native runtime is unavailable');
    if (this.unknown) throw new DeliveryError('activity_unknown', 'Runtime activity is unknown; recovery is required');
  }
  private async readAccount(retry = 1, cached = false): Promise<JsonValue> {
    this.checkAccountRead();
    if (cached && this.accountCatalogSnapshot?.generation === this.accountReadGeneration && this.accountCatalogSnapshot.expires > Date.now()) return this.accountCatalogSnapshot.result;
    const provider = this.providers.accountProvider();
    if (!provider) {
      const generation = this.accountReadGeneration, result = await this.native.call('account/read', { refreshToken: false });
      this.checkAccountRead();
      if (generation !== this.accountReadGeneration) {
        if (retry > 0) return this.readAccount(retry - 1);
        throw new DeliveryError('account_changed', '登录状态已改变，请刷新账户。');
      }
      return result;
    }
    if (this.accountProbe) return this.accountProbe;
    // Login, cancellation and logout stay on the main process, which owns the
    // shared credential cache and device-code notifications. Account display
    // must select ChatGPT: native account/read otherwise reports only the
    // default API-key provider, even when the shared ChatGPT login exists.
    const generation = this.accountReadGeneration;
    const pending = (async () => {
      const probe = await RuntimeService.nativeProcess({ ...this.config, catalogProvider: provider, isolatedGroup: true });
      this.catalogProcesses.add(probe); probe.on('fatal', () => {});
      let result: JsonValue;
      try {
        await probe.initialize(); result = await probe.call('account/read', { refreshToken: false });
      } finally {
        try { await probe.close(); }
        catch (error) {
          // Keep unconfirmed cleanup owned by close(); neither a cached result
          // nor a successful read can make the uncertain process safe to forget.
          this.accountCatalogSnapshot = undefined; this.unknown = true; this.emitState(); this.emit('fatal'); throw error;
        }
        this.catalogProcesses.delete(probe);
      }
      this.checkAccountRead();
      if (generation !== this.accountReadGeneration) throw new DeliveryError('account_changed', '登录状态已改变，请刷新账户。');
      this.accountCatalogSnapshot = { generation, expires: Date.now() + 30000, result };
      return result;
    })();
    this.accountProbe = pending;
    try { return await pending; }
    catch (error) {
      if (error instanceof DeliveryError && error.code === 'account_changed' && retry > 0) {
        if (this.accountProbe === pending) this.accountProbe = undefined;
        return this.readAccount(retry - 1);
      }
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
    if (mediaModalities(prepared.input).length) {
      const options = this.threadOptions(params.options, true);
      const defaults = typeof options.model === 'string' && typeof object(params.options ?? {}).modelProvider === 'string' ? {} : object(await this.defaults({ cwd, ...(params.options === undefined ? {} : { options: params.options }) }));
      const provider = object(params.options ?? {}).modelProvider ?? defaults.modelProvider;
      await validateInputModalities((_method, query) => this.providers.list(
        { ...object(query), ...(provider == null ? {} : { modelProvider: provider }) },
        (method, body) => this.native.call(method, body), (id, chatgpt, hidden) => this.providerCatalog(id, chatgpt, hidden)),
        selectedInputModel(options, defaults.model), prepared.input, item => this.attachments.toolReference(item));
    }
    // The gateway owns the single durable dispatch boundary. This hook checks
    // the current worker owner and must run before each native mutation.
    const creation = object(await this.call('thread/start', { cwd, ...(params.options !== undefined ? { options: params.options } : {}) }, context));
    const thread = object(creation.thread); const threadId = string(thread.id, 'created thread id');
    try {
      const result = object(await this.newTurn('turn/start', { threadId, text, ...(params.attachmentIds !== undefined ? { attachmentIds: params.attachmentIds } : {}), ...(params.options !== undefined ? { options: params.options } : {}), ...(params.references !== undefined ? { references: params.references } : {}), ...(params.extraContext !== undefined ? { extraContext: params.extraContext } : {}) }, context));
      const turn = object(result.turn); this.liveThreads.preview(threadId, text); return { thread, turn };
    } catch (error) {
      // Creation is a known side effect, but a definitive first-turn rejection is not unknown live work.
      if (!(error instanceof DeliveryError) || error.delivery === 'unknown') this.track(threadId).unknown = true;
      this.emitState();
      throw new DeliveryError('conversation_start_incomplete', 'Thread was created, but the first turn was not accepted or confirmed. Inspect the partial thread before retrying.', error instanceof DeliveryError ? error.delivery : 'unknown', { phase: 'first_turn', threadId, threadCreated: true, ...(error instanceof DeliveryError && error.delivery === 'not_sent' ? { inputSent: false } : {}), causeCode: error instanceof DeliveryError ? error.code : 'internal_error', causeDelivery: error instanceof DeliveryError ? error.delivery : 'unknown' });
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
  private admitHistory(threadId: string, context: CallContext, allowWindow = false): void {
    if (this.track(threadId).fresh) return;
    if (allowWindow && this.historyStore.windowReady(threadId, context) && !this.realtime.has(threadId) &&
        ![...this.prompts.values()].some(p => p.threadId === threadId || p.threadId === null)) return;
    if (!this.historyStore.complete(threadId, context)) throw new DeliveryError('history_incomplete', 'Read the complete thread history on this connection before starting work');
  }
  private invalidateHistory(threadId: string, previewOmitted = false): void {
    this.generatedMedia.invalidate(threadId);
    const removed = this.historyStore.invalidate(threadId), state = this.track(threadId); state.fresh = false; state.historyRevision = (state.historyRevision ?? 0) + 1;
    if (removed || previewOmitted) this.emitEvent('notification', { method: 'thread/history/invalidated', params: { threadId, historyVersion: state.historyRevision, ...(previewOmitted ? { previewOmitted: true } : {}) } });
  }
  /** Reading a cold thread must not itself resume its persisted work. */
  private async continuationForLoad(threadId: string): Promise<{ required: boolean; revision: number }> {
    const state = this.track(threadId), revision = state.continuationRevision ?? 0;
    const goal = object(await this.native.call('thread/goal/get', { threadId })); validateOfficial('ThreadGoalGetResponse', goal);
    if (goal.goal !== null && object(goal.goal).threadId !== threadId) throw new DeliveryError('invalid_native_response', 'Continuation goal identity mismatch');
    const queued = await this.workflows.hasQueued(threadId);
    if (revision !== (state.continuationRevision ?? 0)) throw new DeliveryError('continuation_changed', '会话待执行任务已变化，请重新读取。');
    return { required: goal.goal !== null && object(goal.goal).status === 'active' || queued, revision };
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
        const queued = await this.workflows.hasQueued(threadId);
        const threadRevision = state.revision;
        const current = await this.native.call('thread/read', { threadId }); if (object(object(current).thread).id !== threadId) throw new Error('Continuation thread identity mismatch');
        if (revision !== (state.continuationRevision ?? 0)) { await new Promise(resolve => setTimeout(resolve, 25)); continue; }
        this.observeThread(current, threadRevision);
        // A read may complete while a goal write is still awaiting its reply.
        // That write or a newer notification owns goal state until it settles.
        if (!state.goalPending) { state.goalActive = goal.goal !== null && object(goal.goal).status === 'active'; state.goalRevision = (state.goalRevision ?? 0) + 1; }
        state.queued = queued; state.continuationUnverified = false; return;
      }
      throw new Error('Continuation changed throughout bounded state checks');
    }).catch(error => { state.continuationUnverified = true; throw new DeliveryError('continuation_unverified', '会话状态暂未核对完成；刷新会话或再次操作时会重新核对，确认前不会开始新任务。'); })
      .finally(() => { state.checkingContinuation = false; this.continuationChecks.delete(threadId); this.emitState(); });
    this.continuationChecks.set(threadId, check); return check;
  }
  private async metadataMutation(operation: MetadataMutation, context: CallContext, ownCli = false): Promise<JsonValue> {
    this.admit(undefined, false, false, ownCli); validateOfficial(operation.schema, operation.params);
    const locked = new Set(operation.threadIds ?? []); const states = [...locked].map(id => ({ id, state: this.track(id) }));
    const guard = (own = false): void => {
      this.admit(undefined, false, own && operation.idle === true, ownCli);
      for (const { id } of states) { this.admit(id, own, own && operation.idle === true); this.admitHistory(id, context); }
      if (operation.idle && (this.pendingStarts > (own ? 1 : 0) || this.predictions.activeThreads().length || this.defaultsPending || this.terminals.size || this.mcp.subscriptions || this.processes.active || this.realtime.activeThreads().length || [...this.activity].some(([id, state]) => hasTurnActivity(state) || state.unknown || state.goalActive || state.queued || state.checkingContinuation || state.continuationUnverified || (state.pending && !(own && locked.has(id)))))) throw new DeliveryError('activity_busy', 'Finish active work before importing thread organization');
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
    if (this.repositories.writing || this.pendingStarts > (own ? 1 : 0) || this.predictions.activeThreads().length || this.defaultsPending ||
        this.terminals.size || this.mcp.subscriptions || this.processes.active || this.realtime.activeThreads().length ||
        [...this.activity.values()].some(state => hasTurnActivity(state) || state.pending || state.unknown ||
          state.goalActive || state.queued || state.checkingContinuation || state.continuationUnverified)) {
      throw new DeliveryError('activity_busy', 'Finish active work and terminals before changing configuration');
    }
  }
  private async configurationMutation(operation: (write: (method: string, params: JsonValue, options?: NativeOptions) => Promise<JsonValue>, beforeWrite: () => void) => Promise<JsonValue>, context: CallContext, invalidate = true): Promise<JsonValue> {
    if (!context.beforeWrite) throw new DeliveryError('operation_required', 'Configuration changes require the durable operation boundary');
    const idle = (own = false): void => this.assertIdle(own);
    idle(); this.configurationPending = true; this.pendingStarts++; this.emitState(); let dispatched = false; let acknowledged = false;
    try {
      const beforeWrite = (): void => { idle(true); context.beforeWrite!(); dispatched = true; };
      const result = await operation(async (method, params, options = {}) => {
        const boundary = () => { beforeWrite(); options.beforeWrite?.(); };
        let value: JsonValue;
        if (method === 'harness/mcp/user-edit') {
          const { cwd, ...change } = object(params);
          value = this.config.launcher
            ? await runWorkspace(this.config, { path: this.cwd(cwd) }, 'mcp/user-edit', change, { ...context, beforeWrite: boundary }, true)
            : await historyHelper(this.config, { action: 'mcp-user-edit', ...change }, true, boundary);
        } else if (method === 'harness/mcp/enabled-override') {
          const { cwd, ...change } = object(params);
          value = this.config.launcher
            ? await runWorkspace(this.config, { path: this.cwd(cwd) }, 'mcp/enabled-override', change, { ...context, beforeWrite: boundary }, true)
            : await historyHelper(this.config, { action: 'mcp-enabled-override', ...change }, true, boundary);
          acknowledged = true;
          if (change.discardLegacy === true) return value;
          const probe = await RuntimeService.nativeProcess({ ...this.config, isolatedGroup: true });
          this.catalogProcesses.add(probe);
          try {
            await probe.initialize();
            const next = object(await probe.call('config/read', { cwd: this.cwd(cwd) }));
            const server = object(object(object(next.config).mcp_servers)[string(change.name, 'server name')]);
            value = { ...object(value), effective: server.enabled !== false };
          } finally {
            await probe.close();
            this.catalogProcesses.delete(probe);
          }
        } else value = await this.native.call(method, params, { ...options, beforeWrite: boundary });
        acknowledged = true; return value;
      }, beforeWrite);
      if (invalidate) { this.invalidateDefaults(); this.sessions.clear(); this.guardian.invalidateAll(); this.predictions.invalidate(); }
      if (result && typeof result === 'object' && !Array.isArray(result) && result.restartRequired === true && this.listenerCount('restart-required') && !this.prompts.size) {
        // The HTTP bridge flushes this receipt before restarting the epoch.
        // A late native event must never terminate newly active work.
        try { idle(true); this.restarting = true; this.emit('restart-required'); }
        catch (error) { if (!(error instanceof DeliveryError) || !['activity_busy', 'activity_unknown', 'native_cli_busy'].includes(error.code)) throw error; }
      }
      return result;
    } catch (error) {
      // Local postprocessing cannot turn a positive native reply into proof
      // that no configuration operation ran, including in multi-write flows.
      const failure = acknowledged && (!(error instanceof DeliveryError) || error.delivery === 'not_sent')
        ? new DeliveryError('configuration_acknowledgement', 'Configuration acknowledgement could not be confirmed; inspect its state before another change', 'unknown') : error;
      if ((dispatched || acknowledged) && (!(failure instanceof DeliveryError) || failure.delivery === 'unknown')) this.unknown = true;
      throw failure;
    } finally { this.configurationPending = false; this.pendingStarts--; this.emitState(); }
  }
  private async workflowMutation(operation: WorkflowMutation, context: CallContext, resumeSelection?: JsonObject): Promise<JsonValue> {
    const { threadId } = operation; this.admit(); const state = this.track(threadId);
    if (state.unknown) throw new DeliveryError('activity_unknown', 'Thread outcome is unknown');
    if (state.pending) throw new DeliveryError('thread_busy', 'Thread already has a pending mutation');
    if (operation.history) this.admitHistory(threadId, context, ['thread/fork', 'thread/revert', 'thread/rollback', 'thread/resume'].includes(operation.method));
    const releaseListing = operation.newThread ? this.liveThreads.reserve() : undefined;
    state.pending = true; if (operation.newThread) this.pendingStarts++; this.emitState();
    const queueWrite = operation.method === 'thread/queue/add' || operation.method === 'thread/queue/update' ? operation.method : undefined;
    let queueImageWrite: string | undefined;
    let accepted = false; let attachmentCopy: string | undefined; let writeRevision: number | undefined; let restoreSession: (() => void) | undefined; let mediaRevision: number | undefined; let queueRevision: number | undefined; const wasFresh = state.fresh;
    const goalMutation = operation.method === 'thread/goal/set' || operation.method === 'thread/goal/clear';
    let goalRevision: number | undefined; let modelRevision: number | undefined; let modelTurnId: string | null | undefined;
    const guard = (): void => {
      this.admit(); if (state.unknown) throw new DeliveryError('activity_unknown', 'Thread outcome is unknown');
      if (operation.method !== 'thread/realtime/start' && this.realtime.has(threadId)) throw new DeliveryError('voice_busy', 'Stop voice before changing this thread');
      if (operation.history) this.admitHistory(threadId, context, ['thread/fork', 'thread/revert', 'thread/rollback', 'thread/resume'].includes(operation.method));
      if (operation.mode === 'idle' && (hasTurnActivity(state) || state.goalActive || state.checkingContinuation || state.continuationUnverified || (state.queued && operation.method !== 'thread/queue/start'))) throw new DeliveryError('thread_busy', 'Thread has active or continuing work');
      if (operation.mode === 'active' && (!hasTurnActivity(state) || (state.turnId !== null && state.turnId !== operation.expectedTurnId))) throw new DeliveryError('turn_changed', 'The selected turn is no longer active');
      if (operation.directInput && state.directInput === false) throw new DeliveryError('direct_input_unavailable', 'Native thread does not accept direct input');
      if (operation.directInput && state.subscribed === false) throw new DeliveryError('session_not_loaded', 'Explicitly load the thread before starting work');
      if (queueRevision !== undefined && queueRevision !== (state.continuationRevision ?? 0)) throw new DeliveryError('continuation_changed', '待执行队列已变化，请重新读取。');
      if (mediaRevision !== undefined && mediaRevision !== (state.settingsRevision ?? 0)) throw new DeliveryError('model_changed', 'Model settings changed during media validation');
    };
    try {
      const revision = state.revision; const current = await this.native.call('thread/read', { threadId });
      if (object(object(current).thread).id !== threadId) throw new DeliveryError('invalid_native_response', 'Thread identity mismatch'); this.observeThread(current, revision); guard();
      if (operation.method === 'thread/fork' || operation.method === 'thread/resume' && !resumeSelection) {
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
      if (operation.mediaInput || operation.method === 'thread/queue/update' || operation.method === 'thread/queue/delete') queueRevision = state.continuationRevision ?? 0;
      const dispatchOptions = await operation.preflight?.(object(object(current).thread)); validateOfficial(operation.schema, operation.params);
      if (operation.method === 'thread/resume' && !this.providers.sameProvider(object(object(current).thread).modelProvider, operation.params.modelProvider))
        throw new DeliveryError('provider_conversion_required', '请使用右上角切换供应商创建新会话；加载不会更改原会话供应商。');
      const input = operation.mediaInput ? this.attachments.queueMediaEvidence(operation.mediaInput, threadId) : operation.params.input;
      if (mediaModalities(input).length) {
        mediaRevision = state.settingsRevision ?? 0;
        const fallback = operation.method === 'turn/steer' ? state.activeModel : object(object(current).thread).model ?? this.sessions.read(threadId).model;
        const provider = object(object(current).thread).modelProvider;
        if (operation.method === 'thread/resume') {
          const model = selectedInputModel(operation.params, fallback);
          if (typeof model !== 'string' || !model) throw new DeliveryError('model_capability_unknown', '此会话的队列含媒体，冷启动无法确认将使用的模型。请明确选择模型后加载，或在待办中保存副本并确认删除原项。');
          // Bind the model which was validated even if a global default changes
          // between the catalog lookup and native auto-consumption on resume.
          operation.params.model = model;
        }
        await validateInputModalities((method, params) => method === 'model/list'
          ? this.providers.list({ ...object(params), ...(provider !== undefined ? { modelProvider: provider } : {}) }, (method, params) => this.native.call(method, params), (provider, chatgpt, hidden) => this.providerCatalog(provider, chatgpt, hidden))
          : this.native.call(method, params), selectedInputModel(operation.params, fallback), input, operation.mediaInput ? undefined : item => this.attachments.toolReference(item));
      }
      let recoveredQueue: JsonObject | undefined;
      let result: JsonValue;
      try { result = await this.native.call(operation.method, operation.params, { ...dispatchOptions, beforeWrite: () => {
        guard(); context.beforeWrite?.(); operation.beforeWrite?.(); operation.prepared?.pin();
        if (queueWrite) queueImageWrite = this.attachments.beginQueueImageWrite(threadId, queueWrite, operation.params, context.operationId);
        if (operation.method !== 'thread/prediction/request') this.predictions.invalidate(threadId); if (operation.invalidateHistory) this.invalidateHistory(threadId); if (operation.method === 'thread/settings/update') restoreSession = this.sessions.invalidate(threadId);
        if (operation.newThread) attachmentCopy = this.attachments.reserveCopy(threadId);
        writeRevision = state.revision;
        if (goalMutation) { goalRevision = state.goalRevision ?? 0; state.goalPending = true; state.continuationRevision = (state.continuationRevision ?? 0) + 1; }
        if (operation.method === 'turn/settings/update') { modelRevision = state.modelRevision ?? 0; modelTurnId = state.turnId; }
      } });
      } catch (error) {
        if (!queueWrite || !(error instanceof DeliveryError) || error.code !== 'queue_frame_unconfirmed' || !error.data) throw error;
        try {
          const proof = object(error.data), id = string(proof.queuedSubmissionId, 'queuedSubmissionId', 256);
          const client = string(proof.clientUserMessageId, 'clientUserMessageId', 256);
          if (queueWrite === 'thread/queue/add' && operation.params.clientUserMessageId !== client ||
              queueWrite === 'thread/queue/update' && operation.params.queuedSubmissionId !== id) throw error;
          const durable = await historyHelper(this.config, { action:'queue-item', threadId, queuedSubmissionId:id, attachmentRoot:this.attachments.root });
          const queued = object(durable.queuedSubmission);
          if (queued.id !== id || queued.clientUserMessageId !== client || !Array.isArray(queued.input) ||
              !Array.isArray(operation.params.input) || queued.input.length !== proof.inputCount ||
              queued.input.length !== operation.params.input.length || !Array.isArray(proof.urlBySlot)) throw error;
          const observed = new Map(proof.urlBySlot.map(value => { const row = object(value); return [row.ordinal, row.sha256]; }));
          for (const [ordinal, value] of queued.input.entries()) {
            const submitted = object(operation.params.input[ordinal]), persisted = object(value);
            const urlDigest = typeof persisted.url === 'string' ? createHash('sha256').update(persisted.url).digest('hex') : persisted.urlSha256;
            if (observed.get(ordinal) !== urlDigest) throw error;
            if (submitted.type === 'localImage' && ['image','harnessInlineImageDigest'].includes(String(persisted.type)) && typeof urlDigest === 'string') continue;
            if (submitted.type === 'localAudio' && persisted.type === 'audio' && typeof urlDigest === 'string') continue;
            if (canonical(submitted) !== canonical(persisted)) throw error;
          }
          recoveredQueue = queued;
          // Only IDs came from the drained response. Persistent row + identical
          // identities prove this exact write. Present the caller's admitted input
          // without transporting re-encoded image pixels or private metadata.
          result = { queuedSubmission: { id, clientUserMessageId: client, input: operation.params.input!, responsesapiClientMetadata: null } };
        } catch {
          throw new DeliveryError(error.code, error.message, 'unknown', { queuedSubmissionId: object(error.data).queuedSubmissionId!, clientUserMessageId: object(error.data).clientUserMessageId! });
        }
      }
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
      if (operation.method === 'thread/delete') { this.liveThreads.remove(threadId); try { this.attachments.releaseThread(threadId); } catch { this.emit('diagnostic', '已删除会话的附件清理待重启核对。'); } }
      if (['thread/delete', 'thread/unsubscribe', 'thread/revert'].includes(operation.method)) { delete state.lastTerminalTurn; state.turnRevision = (state.turnRevision ?? 0) + 1; }
      if (operation.method === 'turn/settings/update' && value.status === 'applied' && typeof operation.params.model === 'string' && modelRevision === (state.modelRevision ?? 0) && modelTurnId === state.turnId) { state.activeModel = operation.params.model; state.modelRevision = (state.modelRevision ?? 0) + 1; state.settingsRevision = (state.settingsRevision ?? 0) + 1; }
      if (['thread/delete', 'thread/unsubscribe', 'thread/revert', 'thread/settings/update', 'turn/settings/update'].includes(operation.method)) this.guardian.invalidate(threadId);
      if (operation.method === 'turn/steer' && value.turnId !== operation.expectedTurnId) throw new Error('Native steering target mismatch');
      if (operation.method === 'review/start' && value.reviewThreadId !== threadId) throw new Error('Native review target mismatch');
      if (value.queuedSubmission !== undefined) {
        const queued = object(value.queuedSubmission);
        if ((operation.method === 'thread/queue/update' && queued.id !== operation.params.queuedSubmissionId) ||
            (operation.method === 'thread/queue/add' && queued.clientUserMessageId !== operation.params.clientUserMessageId)) throw new Error('Native queue identity mismatch');
        if (queueWrite) this.attachments.confirmQueueImageWrite(threadId, queueImageWrite, recoveredQueue ?? queued);
      }
      if (operation.newThread) {
        const fork = object(value.thread); const forkId = string(fork.id, 'forked thread id'); if (forkId === threadId || fork.cwd !== object(object(current).thread).cwd) throw new Error('Native fork identity or project mismatch'); this.liveThreads.capture(fork, string(fork.cwd, 'forked thread cwd')); this.observeThread(result); this.sessions.capture(result); this.track(forkId).fresh = false; this.track(forkId).subscribed = true;
        await this.finishAttachmentCopy(attachmentCopy, fork);
      } else if (value.thread !== undefined) { if (object(value.thread).id !== threadId) throw new Error('Native mutation returned a different thread'); this.observeThread(result, writeRevision); }
      if (state.revision === writeRevision && operation.workResult === 'turn') { const turn = object(value.turn); if (turn.status === 'inProgress') { state.status = 'active'; state.turnId = string(turn.id, 'turn id'); state.turnRevision = (state.turnRevision ?? 0) + 1; } state.fresh = false; }
      if (state.revision === writeRevision && operation.workResult === 'shell') { state.status = 'active'; state.fresh = false; }
      const projected = operation.project ? operation.project(result) : result;
      if (operation.method === 'thread/queue/delete' && value.deleted === true) {
        try { this.attachments.retireQueueImageBindings(threadId, string(operation.params.queuedSubmissionId, 'queuedSubmissionId')); }
        catch { this.emit('diagnostic', '原生待办已确认删除，图片保护待重启核对。'); }
      }
      return projected;
    } catch (error) {
      const notSent = !accepted && error instanceof DeliveryError && error.delivery === 'not_sent';
      if (notSent && operation.method === 'thread/realtime/start' && wasFresh && state.revision === writeRevision && state.status !== 'active' && state.turnId === null) state.fresh = true;
      if (notSent) {
        restoreSession?.();
        if (queueWrite) try { this.attachments.cancelQueueImageWrite(threadId, queueImageWrite); }
          catch { this.emit('diagnostic', '未发送的待办图片保护将在核对后清理。'); }
      }
      if (notSent) { try { this.attachments.finishCopy(attachmentCopy); } catch { this.emit('diagnostic', '未发送复制的附件保护待重启核对。'); } }
      try { operation.prepared?.settle(!notSent); } catch { this.emit('diagnostic', 'Workflow attachment reservation could not be released'); }
      if (!notSent) { state.unknown = true; if (operation.newThread) this.unknown = true; }
      if (accepted) throw new DeliveryError('invalid_native_response', 'Native workflow returned an invalid result', 'unknown'); throw error;
    } finally { releaseListing?.(); if (goalMutation) state.goalPending = false; state.pending = false; if (operation.newThread) this.pendingStarts--; this.emitState(); }
  }
  private async convert(params: JsonObject, context: CallContext): Promise<JsonObject> {
    onlyKeys(params, ['threadId', 'sourceProvider', 'targetProvider', 'model', 'effort', 'confirm', 'handoffIds']);
    if (params.confirm !== true) throw new DeliveryError('confirmation_required', '请确认转换为新会话；原会话将保留。');
    const threadId = string(params.threadId, 'threadId', 128), sourceProvider = string(params.sourceProvider, 'sourceProvider', 128);
    const targetProvider = string(params.targetProvider, 'targetProvider', 128), model = string(params.model, 'model', 256);
    const selected = this.threadOptions(this.providers.resumeSelection({ modelProvider: targetProvider, model, ...(params.effort !== undefined ? { effort: params.effort } : {}) }), false);
    this.admit(threadId); const state = this.track(threadId); state.pending = true; this.emitState(); let attachmentCopy: string | undefined;
    try {
      const read = object(await this.native.call('thread/read', { threadId })); validateOfficial('ThreadReadResponse', read);
      const thread = object(read.thread), snapshot = this.sessions.read(threadId);
      if (thread.id !== threadId || thread.modelProvider !== sourceProvider || snapshot.modelProvider !== sourceProvider) throw new DeliveryError('provider_changed', '原会话供应商已变化，请重新读取后选择。');
      if (snapshot.requiresResume === true || state.subscribed !== true) throw new DeliveryError('session_not_loaded', '请等待原会话加载完成，再切换供应商。');
      if (object(thread.status).type !== 'idle') throw new DeliveryError('thread_busy', '请先停止当前任务，再创建转换会话。');
      this.providers.assertThread(sourceProvider, undefined); this.environments.assertThread(thread); this.environments.assertIndependentLoad();
      if ((await this.continuationForLoad(threadId)).required) throw new DeliveryError('thread_busy', '请先处理原会话的持续目标或队列，再创建转换会话。');
      const same = this.providers.sameProvider(sourceProvider, selected.modelProvider);
      if (same && !this.providers.requiresOpaqueReasoning(sourceProvider)) throw new DeliveryError('provider_unchanged', '同一供应商请直接使用模型菜单；无需转换会话。');
      const handoffIds = params.handoffIds ?? [];
      if (!Array.isArray(handoffIds) || handoffIds.length > 128 || !handoffIds.every((id): id is string => typeof id === 'string') ||
          new Set(handoffIds).size !== handoffIds.length) throw new DeliveryError('invalid_params', '待办副本清单无效。');
      const owned = handoffIds.length ? this.attachments.listQueueHandoffs(threadId) : [];
      if (!handoffIds.every(id => owned.some(row => row.id === id && row.state === 'ready'))) throw new DeliveryError('handoff_unconfirmed', '所选待办副本已变化，请重新读取后再转换。');
      const check = () => { this.admit(threadId, true); context.beforeWrite?.(); };
      const converted = await convertThread(this.config, this.native, thread, snapshot, selected, same ? 'plaintext' : 'foreign', this.providers.displayName(string(selected.modelProvider, 'target provider')), {
        reserve: () => { this.admit(); const release = this.liveThreads.reserve(); try { attachmentCopy = this.attachments.reserveCopy(threadId); } catch (error) { release(); throw error; } this.pendingStarts++; this.emitState(); return () => { release(); this.pendingStarts--; this.emitState(); }; },
        copied: (id, path) => this.finishAttachmentCopy(attachmentCopy, { id, path }),
        capture: result => { const id = string(object(result.thread).id, 'new thread'); const target = this.track(id); target.pending = true; this.environments.assertThread(object(result.thread)); this.observeThread(result); this.sessions.capture(result); target.subscribed = true; this.liveThreads.capture(object(result.thread), string(result.cwd, 'new cwd')); },
        closed: id => { this.track(id).subscribed = false; this.sessions.invalidate(id); this.invalidateHistory(id); },
        publish: (result, name) => { const thread = object(result.thread), target = this.track(string(thread.id, 'new thread')); this.observeThread(result); this.sessions.capture(result); target.pending = false; target.subscribed = true; target.fresh = false; this.liveThreads.capture(thread, string(result.cwd, 'new cwd')); this.emitEvent('notification', { method: 'thread/name/updated', params: { threadId: thread.id!, threadName: name } }); },
        uncertain: id => { if (id) { try { const target = this.track(id); target.pending = false; target.unknown = true; } catch { this.unknown = true; } } else this.unknown = true; },
      }, check);
      if (!handoffIds.length) return converted;
      const targetId = string(object(converted.thread).id, 'converted thread');
      try {
        this.attachments.moveReadyQueueHandoffs(threadId, targetId, handoffIds, same ? sourceProvider : targetProvider);
        return { ...converted, handoffTransfer: 'moved' };
      } catch {
        // The target was positively verified. A late change to a selected
        // backup cannot negate that acknowledgement or trigger a second copy.
        try {
          const target = this.attachments.listQueueHandoffs(targetId);
          const moved = handoffIds.filter(id => target.some(row => row.id === id)).length;
          return { ...converted, handoffTransfer: moved === handoffIds.length ? 'moved' : moved ? 'unconfirmed' : 'not_moved' };
        } catch {
          return { ...converted, handoffTransfer: 'unconfirmed' };
        }
      }
    } catch (error) { if (error instanceof DeliveryError && error.delivery === 'not_sent') { try { this.attachments.finishCopy(attachmentCopy); } catch { this.emit('diagnostic', '未发送转换的附件保护待重启核对。'); } } throw error; }
    finally { state.pending = false; this.emitState(); }
  }
  private async newTurn(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    onlyKeys(params, method === 'turn/start' ? ['threadId', 'text', 'attachmentIds', 'options', 'references', 'extraContext'] : ['threadId']);
    const threadId = string(params.threadId, 'threadId'); this.admit(threadId); this.admitHistory(threadId, context, true); const activity = this.track(threadId); activity.pending = true; this.emitState();
    let accepted = false; let prepared: PreparedAttachments | undefined; const wasFresh = activity.fresh; const initialRevision = activity.revision; let writeRevision: number | undefined; let mediaRevision: number | undefined; let model: JsonValue | undefined;
    try {
      const p: JsonObject = { threadId };
      const revision = activity.revision; const current = await this.native.call('thread/read', { threadId }); if (object(object(current).thread).id !== threadId) throw new DeliveryError('invalid_native_response', 'Thread identity mismatch'); this.observeThread(current, revision);
      if (method !== 'turn/start') this.environments.assertThread(object(object(current).thread));
      if (method === 'turn/start') {
        const provider = object(object(current).thread).modelProvider, requested = params.options === undefined ? undefined : object(params.options).modelProvider;
        if (requested !== undefined && !this.providers.sameProvider(provider, requested)) throw new DeliveryError('provider_conversion_required', '请使用右上角切换供应商创建新会话；发送不会更改原会话供应商。');
        this.providers.assertThread(provider, params.options);
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
            : this.native.call(method, params), model, p.input, item => this.attachments.toolReference(item));
        }
        if (p.environments === undefined) this.environments.assertThread(object(object(current).thread));
      }
      if (activity.directInput === false) throw new DeliveryError('direct_input_unavailable', 'Native thread does not accept direct input');
      if (activity.subscribed === false) throw new DeliveryError('session_not_loaded', 'Explicitly load the thread before starting work');
      const result = await this.native.call(method, p, { beforeWrite: () => { this.admit(threadId, true); this.admitHistory(threadId, context, true); if (mediaRevision !== undefined && mediaRevision !== (activity.settingsRevision ?? 0)) throw new DeliveryError('model_changed', 'Model settings changed during media validation'); prepared?.pin(); context.beforeWrite?.(); this.predictions.invalidate(threadId); if (method === 'turn/start') { activity.fresh = false; if (typeof model === 'string') activity.activeModel = model; else delete activity.activeModel; } writeRevision = activity.revision; } });
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
  private invalidateDefaults(): void { this.defaultsGeneration++; this.defaultsCache.clear(); }
  private async defaults(params: JsonObject): Promise<JsonValue> {
    this.admit(); onlyKeys(params, ['cwd', 'options']);
    const cwd = params.cwd === undefined ? this.config.cwd : this.cwd(params.cwd);
    if (this.defaultsReaders >= LIMITS.pending) throw new DeliveryError('capacity', 'Effective-defaults read capacity exhausted');
    this.defaultsReaders++; const deadline = Date.now() + 30000;
    const check = (): void => {
      this.admit();
      if (Date.now() >= deadline) throw new DeliveryError('timeout', 'Effective-defaults read deadline exceeded');
    };
    const wait = <T>(pending: Promise<T>, delivery: 'not_sent' | 'unknown'): Promise<T> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new DeliveryError('timeout', 'Effective-defaults read deadline exceeded', delivery)), Math.max(0, deadline - Date.now()));
      pending.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    try {
      for (;;) {
        check(); const generation = this.defaultsGeneration, selected = this.threadOptions(params.options, false);
        if (this.config.launcher) await wait(resolveNativeProject(this.config, cwd), 'not_sent');
        check();
        const config = object(await wait(this.native.call('config/read', { cwd, includeLayers: false }), 'unknown'));
        jsonBytes(config.config, 256 * 1024); check();
        if (generation !== this.defaultsGeneration) continue;
        const key = createHash('sha256').update(canonical({ cwd, selected, config: config.config!, generation })).digest('hex');
        const cached = this.defaultsCache.get(key); if (cached) return cached;
        const active = this.defaultsFlight;
        if (active) {
          if (active.key === key) {
            const result = await wait(active.result, 'unknown');
            if (result !== undefined && generation === this.defaultsGeneration) { check(); return result; }
          } else {
            // An unrelated key owns the one process. Its result/error is not
            // this caller's; after cleanup reread configuration and ownership.
            try { await wait(active.result, 'not_sent'); } catch { check(); }
          }
          continue;
        }
        this.defaultsPending = true;
        const flight = { key, result: this.probeDefaults(cwd, selected, key, generation, deadline, Object.keys(object(object(config.config).mcp_servers ?? {}))) };
        this.defaultsFlight = flight;
        flight.result = flight.result.finally(() => { if (this.defaultsFlight === flight) this.defaultsFlight = undefined; });
        const result = await wait(flight.result, 'unknown');
        if (result !== undefined && generation === this.defaultsGeneration) { check(); return result; }
      }
    } finally { this.defaultsReaders--; }
  }
  private async probeDefaults(cwd: string, selected: JsonObject, key: string, generation: number, deadline: number, servers: string[]): Promise<JsonValue | undefined> {
    let probe: NativeRpc | undefined;
    try {
      const remaining = (): number => { const value = deadline - Date.now(); if (value <= 0) throw new DeliveryError('timeout', 'Effective-defaults probe deadline exceeded', 'unknown'); return value; };
      const timeout = (): number => Math.max(1, Math.min(this.config.requestTimeoutMs || 30000, remaining()));
      probe = new NativeRpc({ ...this.config, cwd, isolatedGroup: true, requestTimeoutMs: timeout() }); this.defaultsProbe = probe; probe.on('fatal', () => {});
      await probe.initialize();
      const overrides = { ...object(selected.config ?? {}), ...Object.fromEntries(servers.map(name => [`mcp_servers.${name}.enabled`, false])) };
      const result = object(await probe.call('thread/start', { cwd, ...selected, config: overrides, ephemeral: true }, { timeoutMs: timeout() }));
      const defaults: JsonObject = {}; for (const name of ['model', 'modelProvider', 'reasoningEffort', 'approvalPolicy', 'sandbox', 'activePermissionProfile', 'cwd']) defaults[name] = result[name] ?? null;
      // Closing the entire dedicated process is the cleanup acknowledgement; unsubscribe is not sufficient.
      await probe.close(); if (this.closed) throw new DeliveryError('runtime_unavailable', 'Runtime closed during the defaults probe');
      if (generation !== this.defaultsGeneration) return undefined;
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
    const terminalId = randomUUID(); const generation = this.generations.get(ownerKey) ?? 0; const terminal: Terminal = { cwd, terminalId, clientId: context.clientId, eventChannelId: context.eventChannelId, generation, ended: false }; this.terminals.set(terminalId, terminal); this.emitState();
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
    this.closed = true; this.generatedMedia.clear(); this.historyStore.clear(); this.liveThreads.clear(); clearInterval(this.gcTimer);
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
