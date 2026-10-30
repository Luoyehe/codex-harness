import type { JsonObject, JsonValue } from '../core/contracts.js';
import { HarnessError } from '../core/errors.js';
import { identifier, object, validText } from '../core/validation.js';
import { organizationMethods } from '../core/organization-methods.js';
import { executionModeState } from '../core/execution-mode.js';
import { organizationReceipt } from './organization-receipt.js';

function threadMetadata(input: JsonValue | undefined): JsonObject {
  object(input, '会话结果');
  const result: JsonObject = { id: identifier(input.id, '会话标识') };
  for (const key of ['cwd', 'createdAt', 'updatedAt', 'modelProvider']) {
    const value = input[key]; if (typeof value === 'string' || typeof value === 'number') result[key] = value;
  }
  // Titles/previews, instructions and turns can contain private conversation text.
  return result;
}
function turnMetadata(input: JsonValue | undefined): JsonObject {
  object(input, '回合结果');
  return { id: identifier(input.id, '回合标识'), ...(typeof input.status === 'string' ? { status: input.status } : {}) };
}
const providerKinds = ['chatgpt', 'chatgpt-gateway', 'responses', 'zhipu-coding', 'bedrock-runtime', 'bedrock-mantle'];
function hex(value: JsonValue | undefined, length: number): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) throw new Error('Invalid management revision');
  return value;
}
function managementText(value: JsonValue | undefined, bytes: number): string {
  const text = validText(value, bytes);
  if (!text || Buffer.byteLength(text) > bytes || /[\x00-\x1f\x7f]/u.test(text)) throw new Error('Invalid management text');
  return text;
}
function endpoint(value: JsonValue | undefined, https = false): string {
  const text = managementText(value, 2048); const url = new URL(text);
  if (!(https ? url.protocol === 'https:' : ['https:', 'http:'].includes(url.protocol)) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error('Invalid management URL');
  return text;
}
function providerReceipt(input: JsonValue): JsonObject {
  object(input);
  if (typeof input.kind !== 'string' || !providerKinds.includes(input.kind) || typeof input.hasApiKey !== 'boolean' || !Array.isArray(input.models) || input.models.length > 1000) throw new Error('Invalid provider receipt');
  const result: JsonObject = { kind: input.kind!, revision: hex(input.revision, 32), hasApiKey: input.hasApiKey };
  const providerId = (value: JsonValue | undefined): string => {
    const id = managementText(value, 32);
    if (id !== 'default' && !/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid provider identity');
    return id;
  };
  if (input.providerId !== undefined) result.providerId = providerId(input.providerId);
  if (input.defaultProviderId !== undefined) result.defaultProviderId = providerId(input.defaultProviderId);
  if (input.modelProvider !== undefined) result.modelProvider = managementText(input.modelProvider, 80);
  if (input.connections !== undefined) {
    if (!Array.isArray(input.connections) || input.connections.length < 1 || input.connections.length > 16) throw new Error('Invalid provider registry');
    const seen = new Set<string>();
    result.connections = input.connections.map(value => {
      object(value);
      const id = providerId(value.id);
      if (seen.has(id) || value.connections !== undefined || typeof value.enabled !== 'boolean') throw new Error('Invalid provider record');
      seen.add(id);
      return { ...providerReceipt(value), id, name: managementText(value.name, 256), enabled: value.enabled,
        modelProvider: managementText(value.modelProvider, 80) };
    });
  }
  for (const key of ['model', 'region', 'effort']) if (input[key] !== undefined) result[key] = managementText(input[key], key === 'effort' ? 64 : 256);
  if (input.supportsTools !== undefined) {
    if (typeof input.supportsTools !== 'boolean') throw new Error('Invalid provider tool default');
    result.supportsTools = input.supportsTools;
  }
  for (const key of ['catalogSource', 'catalogError']) if (input[key] !== undefined) result[key] = managementText(input[key], 2048);
  if (input.baseUrl !== undefined) result.baseUrl = endpoint(input.baseUrl);
  if (input.allowInsecureHttp !== undefined) {
    if (typeof input.allowInsecureHttp !== 'boolean') throw new Error('Invalid transport confirmation');
    result.allowInsecureHttp = input.allowInsecureHttp;
  }
  if (input.gatewayOAuth !== undefined) {
    object(input.gatewayOAuth); const oauth = input.gatewayOAuth;
    const projected: JsonObject = { authorizationUrl: endpoint(oauth.authorizationUrl, true), tokenUrl: endpoint(oauth.tokenUrl, true),
      clientId: managementText(oauth.clientId, 512), cookieName: managementText(oauth.cookieName, 128) };
    if (oauth.redirectPort !== undefined) {
      if (typeof oauth.redirectPort !== 'number' || !Number.isSafeInteger(oauth.redirectPort) || oauth.redirectPort < 1024 || oauth.redirectPort > 65535) throw new Error('Invalid OAuth redirect port');
      projected.redirectPort = oauth.redirectPort;
    }
    result.gatewayOAuth = projected;
  }
  const models = new Set<string>();
  result.models = input.models.map(item => {
    object(item); const id = managementText(item.id, 256);
    if (models.has(id) || !(item.defaultEffort === null || typeof item.defaultEffort === 'string') || !Array.isArray(item.efforts) || item.efforts.length > 32) throw new Error('Invalid provider model');
    models.add(id);
    const model: JsonObject = { id, defaultEffort: item.defaultEffort === '' || item.defaultEffort === null ? item.defaultEffort : managementText(item.defaultEffort, 64), efforts: item.efforts.map(value => managementText(value, 64)) };
    if (item.inputModalities !== undefined) {
      if (!Array.isArray(item.inputModalities) || item.inputModalities.length < 1 || item.inputModalities.length > 3 || !item.inputModalities.includes('text') || item.inputModalities.some(value => typeof value !== 'string' || !['text', 'image', 'audio'].includes(value))) throw new Error('Invalid input modalities');
      model.inputModalities = item.inputModalities;
    }
    if (item.contextWindow !== undefined) {
      if (!(item.contextWindow === null || typeof item.contextWindow === 'number' && Number.isSafeInteger(item.contextWindow) && item.contextWindow >= 4096 && item.contextWindow <= 10_000_000)) throw new Error('Invalid context window');
      model.contextWindow = item.contextWindow;
    }
    if (item.supportsTools !== undefined) {
      if (typeof item.supportsTools !== 'boolean') throw new Error('Invalid model tools flag');
      model.supportsTools = item.supportsTools;
    }
    if (item.toolsSource !== undefined) {
      if (!['provider', 'configured', 'administrator'].includes(String(item.toolsSource))) throw new Error('Invalid tool metadata source');
      model.toolsSource = item.toolsSource;
    }
    if (item.instructions !== undefined) {
      const instructions = validText(item.instructions, 65536);
      if (!instructions || Buffer.byteLength(instructions) > 65536) throw new Error('Invalid model instructions');
      model.instructions = instructions;
    }
    return model;
  });
  if (input.profiles !== undefined) {
    if (!Array.isArray(input.profiles) || input.profiles.length > 16) throw new Error('Invalid saved profiles');
    const ids = new Set<string>(); const names = new Set<string>();
    result.profiles = input.profiles.map(value => {
      object(value); const id = hex(value.id, 32); const name = managementText(value.name, 256);
      if (Array.from(name).length > 64 || name !== name.trim() || ids.has(id) || names.has(name) || typeof value.kind !== 'string' || !providerKinds.includes(value.kind) || typeof value.hasApiKey !== 'boolean') throw new Error('Invalid saved profile');
      ids.add(id); names.add(name);
      const profile: JsonObject = { id, name, kind: value.kind!, revision: hex(value.revision, 32), hasApiKey: value.hasApiKey };
      for (const key of ['model', 'region']) if (value[key] !== undefined) profile[key] = managementText(value[key], 256);
      if (value.baseUrl !== undefined) profile.baseUrl = endpoint(value.baseUrl);
      return profile;
    });
  }
  if (input.retention !== undefined) {
    object(input.retention); const retention = input.retention;
    if (typeof retention.generations !== 'number' || !Number.isSafeInteger(retention.generations) || retention.generations < 0 || retention.generations > 128 || retention.limit !== 128 || retention.retainedHistory !== 3) throw new Error('Invalid provider retention');
    result.retention = { generations: retention.generations, limit: 128, retainedHistory: 3 };
  }
  return result;
}
/** The initial response and every replay share this projection; native history owns message bodies. */
export function receiptResult(method: string, input: JsonValue): JsonValue {
  try { return projectResult(method, input); }
  catch { throw new HarnessError('receipt_contract', '操作已发送，但返回结果无法确认；请核对操作记录。', 'unknown'); }
}
function projectResult(method: string, input: JsonValue): JsonValue {
  if (method === 'thread/prediction/request') { object(input); if (input.requested !== true) throw new Error('Missing prediction acknowledgement'); return { predictionId: identifier(input.predictionId), threadId: identifier(input.threadId), sourceTurnId: identifier(input.sourceTurnId), requested: true }; }
  if (method === 'account/sendAddCreditsNudgeEmail') { object(input); if (!['sent', 'cooldown_active'].includes(String(input.status)) || !['credits', 'usage_limit'].includes(String(input.creditType))) throw new Error('Invalid nudge acknowledgement'); return { status: input.status!, creditType: input.creditType!, accountId: identifier(input.accountId) }; }
  if (method === 'account/login') { object(input); if (input.type !== 'chatgptDeviceCode') throw new Error('Invalid login type'); return { type: input.type, loginId: identifier(input.loginId) }; }
  if (method === 'account/login/cancel') { object(input); if (!['canceled', 'notFound'].includes(String(input.status))) throw new Error('Invalid cancellation result'); return { status: input.status! }; }
  if (method === 'diagnostics/cli/run') { object(input); if (!['doctor', 'models-bundled'].includes(String(input.kind)) || !['completed', 'failed'].includes(String(input.status))) throw new Error('Invalid diagnostic result'); return { resultId: identifier(input.resultId), kind: input.kind!, status: input.status! }; }
  if (method === 'thread/approveGuardianDeniedAction') { object(input); if (input.registered !== true) throw new Error('Retry authorization was not registered'); return { threadId: identifier(input.threadId), approvalId: identifier(input.approvalId), registered: true }; }
  if (['workspace/git/stage', 'workspace/git/unstage', 'workspace/git/index/recovery/restore'].includes(method)) {
    object(input); const sha = /^[a-f0-9]{64}$/;
    if ((input.head !== null && (typeof input.head !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.head))) || typeof input.indexRevision !== 'string' || !sha.test(input.indexRevision) || typeof input.previousIndexRevision !== 'string' || !sha.test(input.previousIndexRevision)) throw new Error('Invalid index result');
    const result: JsonObject = { head: input.head!, indexRevision: input.indexRevision, previousIndexRevision: input.previousIndexRevision, recoveryOperationId: identifier(input.recoveryOperationId) };
    if (method.endsWith('/restore')) result.restoredFromOperationId = identifier(input.restoredFromOperationId);
    else { if (typeof input.pathsDigest !== 'string' || !sha.test(input.pathsDigest) || typeof input.selectedCount !== 'number' || !Number.isSafeInteger(input.selectedCount) || input.selectedCount < 1 || input.selectedCount > 32) throw new Error('Invalid index selection'); result.pathsDigest = input.pathsDigest; result.selectedCount = input.selectedCount; }
    return result;
  }
  if (method === 'workspace/git/index/recovery/discard') { object(input); if (input.discarded !== true || input.receiptRetained !== true) throw new Error('Missing index backup discard acknowledgement'); return { recoveryOperationId: identifier(input.recoveryOperationId), discarded: true, receiptRetained: true }; }
  if (method === 'account/resetCredit/consume') { object(input); if (!['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'].includes(String(input.outcome))) throw new Error('Invalid credit redemption outcome'); return { outcome: input.outcome!, accountId: identifier(input.accountId) }; }
  if (method === 'account/gatewayOAuth/login') { object(input); if (input.started !== true) throw new Error('Missing OAuth start acknowledgement'); return { handoffId: identifier(input.handoffId), providerId: validText(input.providerId, 1024), started: true }; }
  if (method === 'account/gatewayOAuth/cancel') { object(input); if (input.cancelled !== true) throw new Error('Missing OAuth cancellation'); return { handoffId: identifier(input.handoffId), cancelled: true }; }
  if (method === 'thread/shellCommand' || method === 'thread/backgroundTerminals/clean') { object(input); const field = method === 'thread/shellCommand' ? 'submitted' : 'cleanupRequested'; if (input[field] !== true) throw new Error('Missing native command acknowledgement'); return { threadId: identifier(input.threadId), [field]: true }; }
  if (method === 'thread/backgroundTerminals/terminate') { object(input); if (typeof input.terminated !== 'boolean') throw new Error('Missing native terminal status'); return { threadId: identifier(input.threadId), processId: identifier(input.processId), terminated: input.terminated }; }
  if (method === 'workspace/git/commit') {
    object(input); const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
    if (typeof input.commitId !== 'string' || !oid.test(input.commitId) || (input.previousHead !== null && (typeof input.previousHead !== 'string' || !oid.test(input.previousHead))) || typeof input.indexRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.indexRevision)) throw new Error('Invalid Git commit receipt');
    return { commitId: input.commitId, previousHead: input.previousHead!, indexRevision: input.indexRevision, recoveryOperationId: identifier(input.recoveryOperationId) };
  }
  if (method === 'project/trust/write') {
    object(input); if (!['ok', 'okOverridden'].includes(String(input.status)) || ![null, 'trusted', 'untrusted'].includes(input.configuredTrust as null | string) || input.hookTrustChanged !== false || input.appliesTo !== 'next_project_load') throw new Error('Invalid project trust response');
    return { status: input.status!, version: validText(input.version, 4096), cwd: validText(input.cwd, 4096), configuredTrust: input.configuredTrust!, hookTrustChanged: false, appliesTo: 'next_project_load' };
  }
  if (method === 'environment/add' || method === 'environment/info') {
    object(input); const field = method.endsWith('/add') ? 'registered' : 'inspected'; if (input[field] !== true) throw new Error('Environment acknowledgement missing');
    return { environmentId: identifier(input.environmentId), [field]: true, ...(field === 'registered' ? { requiresRestartToDisconnect: true } : { selectionReady: input.selectionReady === true }) };
  }
  if (method === 'remoteControl/enable' || method === 'remoteControl/disable') {
    object(input); if (!['disabled', 'connecting', 'connected', 'errored'].includes(String(input.status))) throw new Error('Invalid remote status');
    return { status: input.status!, serverName: validText(input.serverName, 4096), installationId: identifier(input.installationId), environmentId: input.environmentId === null ? null : identifier(input.environmentId) };
  }
  if (method === 'remoteControl/pairing/start') { object(input); if (!Number.isSafeInteger(input.expiresAt)) throw new Error('Invalid pairing expiry'); return { pairingId: identifier(input.pairingId), environmentId: identifier(input.environmentId), expiresAt: input.expiresAt! }; }
  if (method === 'remoteControl/client/revoke') { object(input); if (input.revoked !== true) throw new Error('Revocation not confirmed'); return { environmentId: identifier(input.environmentId), clientId: identifier(input.clientId), revoked: true }; }
  if (method === 'skills/extraRoots/set') { object(input); if (!Array.isArray(input.roots) || input.roots.length > 16 || input.persistence !== 'current_runtime') throw new Error('Invalid skill roots'); return { roots: input.roots.map(root => validText(root, 4096)), persistence: 'current_runtime' }; }
  if (method === 'thread/realtime/start' || method === 'thread/realtime/stop') {
    object(input); if (!['starting', 'active', 'stopping', 'closed'].includes(String(input.state)) || !Number.isSafeInteger(input.nextSequence) || !Number.isSafeInteger(input.lastAcceptedSequence)) throw new Error('Invalid realtime session');
    if (method.endsWith('/stop') && input.stopped !== true) throw new Error('Voice stop not confirmed');
    return { sessionHandle: identifier(input.sessionHandle), threadId: identifier(input.threadId), state: input.state!, nextSequence: input.nextSequence!, lastAcceptedSequence: input.lastAcceptedSequence!, ...(method.endsWith('/stop') ? { stopped: true } : {}) };
  }
  if (method === 'feedback/save' || method === 'feedback/upload') {
    object(input); const saved = method === 'feedback/save';
    if (input[saved ? 'saved' : 'uploaded'] !== true || (input.promptHash !== null && (typeof input.promptHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.promptHash)))) throw new Error('Invalid feedback acknowledgement');
    return { feedbackId: identifier(input.feedbackId), threadId: identifier(input.threadId), promptHash: input.promptHash!, ...(saved ? { path: validText(input.path, 256), saved: true } : { uploaded: true }) };
  }
  if (method === 'rollout/compress') { object(input); if (input.triggered !== true || input.completionConfirmed !== false) throw new Error('Invalid maintenance trigger'); return { triggered: true, completionConfirmed: false }; }
  if (method === 'plugin/share/delete') { object(input); if (input.deleted !== true) throw new Error('Unconfirmed share removal'); return { remotePluginId: identifier(input.remotePluginId), deleted: true }; }
  if (method === 'plugin/share/save') {
    object(input); const url = new URL(validText(input.shareUrl, 4096)); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Unsafe share URL');
    if (input.canPublishToWorkspace !== null && typeof input.canPublishToWorkspace !== 'boolean') throw new Error('Missing publishing state');
    return { remotePluginId: identifier(input.remotePluginId), shareUrl: url.href, canPublishToWorkspace: input.canPublishToWorkspace! };
  }
  if (method === 'plugin/share/updateTargets') {
    object(input); if (!Array.isArray(input.principals) || !['LISTED', 'UNLISTED', 'PRIVATE'].includes(String(input.discoverability))) throw new Error('Missing share result');
    return { remotePluginId: identifier(input.remotePluginId), discoverability: input.discoverability!, principalCount: input.principals.length };
  }
  if (method === 'plugin/share/checkout') {
    object(input); return { remotePluginId: identifier(input.remotePluginId), pluginId: validText(input.pluginId, 1024), pluginName: validText(input.pluginName, 256), pluginPath: validText(input.pluginPath, 4096), marketplaceName: validText(input.marketplaceName, 256), marketplacePath: validText(input.marketplacePath, 4096), remoteVersion: input.remoteVersion === null ? null : validText(input.remoteVersion, 256) };
  }
  if (['workspace/worktree/create', 'workspace/worktree/attach', 'workspace/worktree/archive', 'workspace/worktree/restore'].includes(method)) {
    object(input); const flag = method.endsWith('/create') ? 'created' : method.endsWith('/attach') ? 'attached' : method.endsWith('/archive') ? 'archived' : 'restored';
    if (input[flag] !== true || input.phase !== (flag === 'archived' ? 'archived' : 'active') || typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision) || typeof input.head !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.head)) throw new Error('Invalid worktree receipt');
    if (typeof input.worktreeVersion !== 'number' || !Number.isSafeInteger(input.worktreeVersion) || input.worktreeVersion < 1) throw new Error('Missing supervisor generation');
    return { worktreeId: identifier(input.worktreeId), worktreeVersion: input.worktreeVersion, path: validText(input.path, 4096), phase: input.phase!, head: input.head, revision: input.revision, [flag]: true };
  }
  if (method === 'import/apply') {
    object(input); if (input.completed !== true || !Array.isArray(input.itemTypeResults)) throw new Error('Import completion missing');
    return { importId: identifier(input.importId), completed: true, itemTypeResults: input.itemTypeResults.map(value => {
      object(value); if (!Array.isArray(value.successes) || !Array.isArray(value.failures)) throw new Error('Import type results missing');
      return { itemType: validText(value.itemType, 128), successCount: value.successes.length, failureCount: value.failures.length,
        failures: value.failures.map(entry => { object(entry); return { failureStage: validText(entry.failureStage, 256), message: validText(entry.message, 4096) }; }) };
    }) };
  }
  if (method === 'process/spawn') { object(input); if (typeof input.tty !== 'boolean') throw new Error('Missing process terminal status'); return { processHandle: identifier(input.processHandle), cwd: validText(input.cwd, 4096), tty: input.tty }; }
  if (method === 'process/kill') { object(input); if (input.stopped !== true) throw new Error('Process stop was not confirmed'); return { processHandle: identifier(input.processHandle), stopped: true }; }
  if (method === 'process/writeStdin' || method === 'process/resizePty') { object(input); return { processHandle: identifier(input.processHandle) }; }
  if (method === 'process/remove') { object(input); if (input.removed !== true) throw new Error('Process removal not confirmed'); return { removed: true }; }
  if (Object.hasOwn(organizationMethods, method)) return organizationReceipt(method, input);
  if (method === 'mcp/tool/call') {
    object(input); if (typeof input.isError !== 'boolean') throw new Error('Missing MCP result status');
    return { resultId: identifier(input.resultId), threadId: identifier(input.threadId), server: validText(input.server, 256), tool: validText(input.tool, 256), isError: input.isError };
  }
  if (method === 'mcp/stream/start') { object(input); return { subscriptionId: identifier(input.subscriptionId), threadId: identifier(input.threadId), server: validText(input.server, 256), name: validText(input.name, 256) }; }
  if (method === 'mcp/stream/stop') { object(input); if (input.stopped !== true) throw new Error('MCP stop was not confirmed'); return { subscriptionId: identifier(input.subscriptionId), stopped: true }; }
  if (method === 'mcp/result/remove') { object(input); if (input.removed !== true) throw new Error('MCP result removal was not confirmed'); return { removed: true }; }
  if (method === 'mcp/reload') { object(input); return {}; }
  if (method === 'thread/unsubscribe') { object(input); if (!['notLoaded', 'notSubscribed', 'unsubscribed'].includes(String(input.status))) throw new Error('Invalid subscription status'); return { status: input.status! }; }
  if (method === 'settings/write' || method === 'mcp/config/write') {
    object(input); if (!['ok', 'okOverridden'].includes(String(input.status))) throw new Error('Invalid config write status');
    return { status: input.status!, version: validText(input.version, 4096), filePath: validText(input.filePath, 4096) };
  }
  if (method === 'skills/config/write') { object(input); if (typeof input.effectiveEnabled !== 'boolean') throw new Error('Missing effective skill state'); return { effectiveEnabled: input.effectiveEnabled }; }
  if (method === 'plugin/install') {
    object(input); if (!['ON_INSTALL', 'ON_USE'].includes(String(input.authPolicy)) || !Array.isArray(input.appsNeedingAuth)) throw new Error('Invalid installation result');
    return { pluginId: validText(input.pluginId, 1024), authPolicy: input.authPolicy!, appsNeedingAuth: input.appsNeedingAuth.map(app => { object(app); return { id: validText(app.id, 1024) }; }) };
  }
  if (method === 'plugin/uninstall') { object(input); return { pluginId: validText(input.pluginId, 1024) }; }
  if (method === 'marketplace/add' || method === 'marketplace/remove') {
    object(input); const result: JsonObject = { marketplaceName: validText(input.marketplaceName, 256), installedRoot: input.installedRoot === null ? null : validText(input.installedRoot, 4096) };
    if (method === 'marketplace/add') { if (typeof input.alreadyAdded !== 'boolean') throw new Error('Invalid marketplace add response'); result.alreadyAdded = input.alreadyAdded; } return result;
  }
  if (method === 'marketplace/upgrade') {
    object(input); if (!Array.isArray(input.selectedMarketplaces) || !Array.isArray(input.upgradedRoots) || !Array.isArray(input.errors)) throw new Error('Invalid marketplace upgrade response');
    return { selectedMarketplaces: input.selectedMarketplaces.map(value => validText(value, 256)), upgradedRoots: input.upgradedRoots.map(value => validText(value, 4096)), errors: input.errors.map(value => { object(value); return { marketplaceName: validText(value.marketplaceName, 256), message: validText(value.message, 4096) }; }) };
  }
  if (method === 'plugin/reconcile') {
    object(input); if (!Array.isArray(input.changedPlugins) || !Array.isArray(input.failedRemotePluginIds) || !Array.isArray(input.failedMaterializationRemotePluginIds)) throw new Error('Invalid reconciliation result');
    return { changedPlugins: input.changedPlugins.map(value => { object(value); const row: JsonObject = { id: validText(value.id, 1024) }; for (const key of ['hasMcps', 'hasApps', 'hasHooks', 'hasSkills']) { if (typeof value[key] !== 'boolean') throw new Error('Missing change kind'); row[key] = value[key]!; } return row; }),
      failedRemotePluginIds: input.failedRemotePluginIds.map(id => validText(id, 1024)), failedMaterializationRemotePluginIds: input.failedMaterializationRemotePluginIds.map(id => validText(id, 1024)) };
  }
  if (method === 'experimentalFeature/enablement/set') { object(input); object(input.enablement); if (Object.values(input.enablement).some(value => typeof value !== 'boolean')) throw new Error('Invalid feature switches'); return { enablement: input.enablement }; }
  if (method === 'memory/reset') { object(input); return {}; }
  if (method === 'conversation/start') {
    object(input); return { thread: threadMetadata(input.thread), turn: turnMetadata(input.turn) };
  }
  if (method === 'turn/start') { object(input); return { turn: turnMetadata(input.turn) }; }
  if (['thread/fork', 'thread/revert', 'thread/metadata/update', 'thread/resume'].includes(method)) { object(input); return { thread: threadMetadata(input.thread) }; }
  if (method === 'review/start' || method === 'review/startNew') {
    object(input); return { ...(method === 'review/startNew' ? { thread: threadMetadata(input.thread) } : {}),
      turn: turnMetadata(input.turn), reviewThreadId: identifier(input.reviewThreadId) };
  }
  if (method === 'thread/queue/start') { object(input); return { turn: turnMetadata(input.turn) }; }
  if (method === 'turn/steer') { object(input); return { turnId: identifier(input.turnId) }; }
  if (method === 'thread/queue/add' || method === 'thread/queue/update') {
    object(input); object(input.queuedSubmission);
    return { queuedSubmission: { id: identifier(input.queuedSubmission.id), clientUserMessageId: identifier(input.queuedSubmission.clientUserMessageId) } };
  }
  if (method === 'thread/goal/set') {
    object(input); object(input.goal); const goal = input.goal;
    const result: JsonObject = { threadId: identifier(goal.threadId), status: validText(goal.status, 32) };
    for (const key of ['tokenBudget', 'tokensUsed', 'timeUsedSeconds', 'createdAt', 'updatedAt']) {
      const value = goal[key];
      if (key === 'tokenBudget' && value === null) result[key] = null;
      else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
      else throw new Error('Invalid goal accounting');
    }
    return { goal: result };
  }
  if (method === 'turn/settings/update') {
    object(input); if (input.status !== 'applied' && input.status !== 'targetUnavailable') throw new Error('Invalid settings result');
    return { status: input.status };
  }
  if (method === 'thread/readState/update') {
    object(input); object(input.readState); const state = input.readState;
    let firstUnread: JsonValue = null;
    if (state.firstUnread !== null) {
      object(state.firstUnread); const first = state.firstUnread;
      if (first.type === 'threadStart') firstUnread = { type: 'threadStart' };
      else if (first.type === 'turn') firstUnread = { type: 'turn', turnId: identifier(first.turnId) };
      else throw new Error('Invalid unread position');
    }
    return { readState: { firstUnread, revision: validText(state.revision, 4096) } };
  }
  if (method === 'thread/queue/delete' || method === 'thread/goal/clear') {
    object(input); const key = method === 'thread/queue/delete' ? 'deleted' : 'cleared';
    if (typeof input[key] !== 'boolean') throw new Error('Invalid deletion result');
    return { [key]: input[key] };
  }
  if (['thread/queue/reorder', 'thread/delete', 'thread/unsubscribe', 'thread/settings/update'].includes(method)) { object(input); return {}; }
  if (['thread/name/set', 'thread/archive', 'thread/unarchive', 'thread/compact', 'prompt/answer', 'attachment/remove', 'account/logout', 'project/remove'].includes(method)) return {};
  if (method === 'terminal/open') { object(input); return { terminalId: identifier(input.terminalId) }; }
  if (method === 'workspace/recovery/discard') {
    object(input); if (input.discarded !== true || input.receiptRetained !== true) throw new Error('Unconfirmed recovery discard');
    return { recoveryOperationId: identifier(input.recoveryOperationId), discarded: true, receiptRetained: true };
  }
  if (method === 'workspace/recovery/restore') {
    object(input); if (!['file', 'directory'].includes(String(input.kind)) || typeof input.revision !== 'string' || !/^[0-9a-f]{64}$/.test(input.revision)) throw new Error('Invalid recovery revision');
    const result: JsonObject = { path: validText(input.path, 4096), kind: input.kind!, revision: input.revision,
      restoredFromOperationId: identifier(input.restoredFromOperationId), recoveryOperationId: identifier(input.recoveryOperationId) };
    if (input.kind === 'file') {
      if (typeof input.bytes !== 'number' || !Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > 512 * 1024) throw new Error('Invalid restored byte count');
      result.bytes = input.bytes;
    }
    return result;
  }
  if (['workspace/write', 'workspace/mkdir', 'workspace/copy', 'workspace/remove'].includes(method)) {
    object(input); const result: JsonObject = { path: validText(input.path, 4096) };
    if (method === 'workspace/mkdir') { if (input.created !== true) throw new Error('Unconfirmed directory creation'); result.created = true; }
    else {
      result.recoveryOperationId = identifier(input.recoveryOperationId);
      if (method === 'workspace/remove') { if (input.removed !== true) throw new Error('Unconfirmed removal'); result.removed = true; }
      else {
        if (typeof input.revision !== 'string' || !/^[0-9a-f]{64}$/.test(input.revision) || typeof input.bytes !== 'number' || !Number.isSafeInteger(input.bytes) || input.bytes < 0) throw new Error('Invalid file revision');
        result.revision = input.revision; result.bytes = input.bytes;
      }
    }
    return result;
  }
  if (method === 'project/add' || method === 'project/create' || method === 'project/rename') { object(input); return { id: identifier(input.id), name: validText(input.name, 128), path: validText(input.path, 4096) }; }
  if (method === 'mcp/oauth') {
    object(input); return { handoffId: identifier(input.handoffId), epoch: identifier(input.epoch), name: identifier(input.name), threadId: input.threadId === null ? null : identifier(input.threadId) };
  }
  if (method === 'attachment/upload') {
    object(input); const output: JsonObject = {};
    const allowed = ['attachmentId', 'id', 'name', 'mimeType', 'size', 'kind'];
    for (const key of allowed) if (Object.hasOwn(input, key)) output[key] = input[key]!;
    return output;
  }
  if (method === 'system/restart') {
    object(input); if (input.restarted !== true) throw new Error('Unconfirmed service restart');
    return { restarted: true, release: hex(input.release, 64) };
  }
  if (method === 'system/provider/write') return providerReceipt(input);
  if (method === 'system/execution-mode/write') {
    const result = executionModeState(input); object(input);
    if (typeof input.changed !== 'boolean' || input.servicesRestored !== true ||
        input.changed && (typeof input.transaction !== 'string' || !/^[a-f0-9]{32}$/.test(input.transaction)) ||
        !input.changed && input.transaction !== undefined)
      throw new Error('Execution mode change is not confirmed');
    return { ...result, changed: input.changed, servicesRestored: true,
      ...(input.changed ? { transaction: input.transaction! } : {}) };
  }
  if (method === 'system/models/refresh') {
    const result = providerReceipt(input); object(input);
    if (typeof input.applied !== 'boolean' || typeof input.requiresConfirmation !== 'boolean' || input.applied && input.requiresConfirmation) throw new Error('Invalid catalog confirmation');
    result.applied = input.applied; result.requiresConfirmation = input.requiresConfirmation;
    if (input.source !== undefined) {
      if (typeof input.source !== 'string' || !['native', 'provider'].includes(input.source)) throw new Error('Invalid model catalog source');
      result.source = input.source;
    }
    if (input.notice !== undefined) result.notice = managementText(input.notice, 2048);
    return result;
  }
  throw new HarnessError('receipt_contract', '此操作没有定义可持久化的回执格式。', 'unknown');
}
