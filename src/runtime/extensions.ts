import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonical, DeliveryError, integer, jsonBytes, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
import type { NativeOptions } from './native.js';
import type { DiagnosticRedactor } from './redaction.js';
import { extensionMethods } from '../core/extension-methods.js';
import { McpConfiguration } from './mcp-configuration.js';
import { Imports } from './imports.js';
import { PluginSharing } from './plugin-sharing.js';
import { Feedback } from './feedback.js';
import { ProjectTrust } from './project-trust.js';
import { AccountTools } from './account-tools.js';

type NativeCall = (method: string, params: JsonValue, options?: NativeOptions) => Promise<JsonValue>;
export interface ExtensionHost {
  native: NativeCall;
  configure: (operation: (write: NativeCall) => Promise<JsonValue>, context: CallContext) => Promise<JsonValue>;
  cwd: (value: JsonValue | undefined) => string;
  redactor: DiagnosticRedactor;
  resource?: (cwd: string, action: string, params: JsonObject) => Promise<JsonObject>;
  notify?: (method: string, params: JsonObject) => void;
}
interface ReadSpec { schema?: string; response: string; keys: string[] }
const reads: Record<string, ReadSpec> = {
  'app/list': { schema: 'AppsListParams', response: 'AppsListResponse', keys: ['cursor', 'limit', 'threadId', 'forceRefetch'] },
  'app/read': { schema: 'AppsReadParams', response: 'AppsReadResponse', keys: ['appIds', 'threadId', 'includeTools'] },
  'app/installed': { schema: 'AppsInstalledParams', response: 'AppsInstalledResponse', keys: ['threadId', 'forceRefresh'] },
  'experimentalFeature/list': { schema: 'ExperimentalFeatureListParams', response: 'ExperimentalFeatureListResponse', keys: ['cursor', 'limit', 'threadId'] },
  'memory/status': { schema: 'MemoryStatusParams', response: 'MemoryStatusResponse', keys: ['minConsolidatedThreads'] },
  'account/usage/read': { schema: 'GetAccountTokenUsageParams', response: 'GetAccountTokenUsageResponse', keys: ['threadId'] },
  'account/workspaceMessages/read': { response: 'GetWorkspaceMessagesResponse', keys: [] },
  'userVerification/status': { response: 'UserVerificationStatusResponse', keys: [] },
  'server/diagnostics': { schema: 'ServerDiagnosticsParams', response: 'ServerDiagnosticsResponse', keys: [] },
  'configRequirements/read': { response: 'ConfigRequirementsReadResponse', keys: [] },
};
const editable = new Set([
  'model', 'review_model', 'model_context_window', 'model_auto_compact_token_limit', 'model_auto_compact_token_limit_scope',
  'approval_policy', 'approvals_reviewer', 'sandbox_mode', 'sandbox_workspace_write', 'permissions', 'default_permissions',
  'web_search', 'tools', 'developer_instructions', 'compact_prompt', 'model_reasoning_effort', 'model_reasoning_summary',
  'memories.generate_memories', 'memories.use_memories',
  'model_verbosity', 'service_tier', 'analytics', 'apps', 'features', 'memories', 'mcp_servers', 'agents',
]);
const hash = (value: JsonValue): string => createHash('sha256').update(canonical(value)).digest('hex');
function revision(value: JsonValue | undefined): string {
  const result = string(value, 'previewHash', 64); if (!/^[a-f0-9]{64}$/.test(result)) throw new DeliveryError('invalid_params', 'Invalid preview hash'); return result;
}
function pageBounds(params: JsonObject): void {
  if (params.limit !== undefined && params.limit !== null) integer(params.limit, 'limit', 1, 100);
  if (params.cursor !== undefined && params.cursor !== null) string(params.cursor, 'cursor', 4096);
  if (params.threadId !== undefined && params.threadId !== null) string(params.threadId, 'threadId', 256);
}
function sensitiveConfig(value: JsonValue, redactor: DiagnosticRedactor): JsonValue {
  if (Array.isArray(value)) return value.map(item => sensitiveConfig(item, redactor));
  if (value && typeof value === 'object') return redactor.value(Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(?:env|http_headers|headers|bearer_token|bearer_token_env_var|env_http_headers)$/i.test(key) ? '[redacted]' : sensitiveConfig(item, redactor)])));
  return redactor.value(value);
}
function rejectRedacted(value: JsonValue): void {
  if (typeof value === 'string' && value.includes('[redacted]')) throw new DeliveryError('invalid_params', 'Masked configuration cannot be written; supply the actual changed value');
  if (Array.isArray(value)) value.forEach(rejectRedacted);
  else if (value && typeof value === 'object') Object.values(value).forEach(rejectRedacted);
}

/** Extension discovery supplies identity and policy. Browser strings never become arbitrary native paths. */
export class Extensions {
  private mcpConfiguration: McpConfiguration;
  private imports: Imports;
  private sharing: PluginSharing;
  private feedback: Feedback;
  private skillRoots: string[] = [];
  private trust: ProjectTrust;
  private accounts: AccountTools;
  constructor(private host: ExtensionHost) {
    this.mcpConfiguration = new McpConfiguration(host.native); this.imports = new Imports(host.native); this.feedback = new Feedback(host.native);
    this.trust = new ProjectTrust(host.native);
    this.accounts = new AccountTools(host);
    this.sharing = new PluginSharing({ native: host.native, select: params => this.selectPlugin(params), preview: (cwd, relative) => this.resource(cwd, 'resource/plugin/preview', { path: relative }) });
  }
  private resource(cwd: string, action: string, params: JsonObject): Promise<JsonObject> {
    if (!this.host.resource) throw new DeliveryError('resource_unsupported', 'Native resource helper is unavailable');
    return this.host.resource(cwd, action, params);
  }
  notification(method: string, params: JsonObject): boolean { this.imports.notification(method, params); return this.accounts.notification(method, params); }
  disconnect(clientId?: string, channel?: string): Promise<void> { return this.accounts.disconnect(clientId, channel); }
  close(): void { this.imports.close(); this.accounts.close(); }
  private async request(method: string, params: JsonObject, schema: string | undefined, response: string, call = this.host.native): Promise<JsonObject> {
    pageBounds(params); if (schema) validateOfficial(schema, params); jsonBytes(params, 1024 * 1024);
    const result = await call(method, params);
    try { validateOfficial(response, result); return object(result); }
    catch { throw new DeliveryError('invalid_native_response', `Invalid ${method} result`, call === this.host.native ? 'not_sent' : 'unknown'); }
  }
  async call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    if (!Object.hasOwn(extensionMethods, method)) throw new DeliveryError('method_not_found', 'Unsupported extension operation');
    if (extensionMethods[method]!.access === 'write') return this.host.configure(write => this.mutate(method, params, write, context), context);
    if (method.startsWith('account/gatewayOAuth/') || method === 'account/resetCredit/preview') return this.accounts.read(method, params, context);
    if (Object.hasOwn(reads, method)) {
      const spec = reads[method]!; onlyKeys(params, spec.keys);
      if (method === 'memory/status' && params.minConsolidatedThreads !== undefined && params.minConsolidatedThreads !== null) integer(params.minConsolidatedThreads, 'minimum threads', 1, 4096);
      const result = await this.request(method, params, spec.schema, spec.response);
      return method === 'server/diagnostics' || method === 'configRequirements/read' ? sensitiveConfig(result, this.host.redactor) : result;
    }
    switch (method) {
      case 'project/trust/read': onlyKeys(params, ['cwd']); return this.trust.read(this.host.cwd(params.cwd));
      case 'skills/extraRoots/read': onlyKeys(params, []); return { roots: [...this.skillRoots], persistence: 'current_runtime' };
      case 'plugin/share/list': return this.sharing.list(params);
      case 'plugin/share/preview': this.host.cwd(params.cwd); return this.sharing.preview(params);
      case 'import/preview': this.host.cwd(params.cwd); return this.host.redactor.value(await this.imports.preview(params));
      case 'import/history': this.host.cwd(params.cwd); return this.host.redactor.value(await this.imports.history(params));
      case 'mcp/config/read': onlyKeys(params, ['cwd']); return this.host.redactor.value(await this.mcpConfiguration.read(this.host.cwd(params.cwd)));
      case 'skills/list': {
        onlyKeys(params, ['cwd', 'forceReload']); const cwd = this.host.cwd(params.cwd);
        const result = await this.request(method, { cwds: [cwd], ...(params.forceReload !== undefined ? { forceReload: params.forceReload } : {}) }, 'SkillsListParams', 'SkillsListResponse');
        for (const entry of result.data as JsonValue[]) { const row = object(entry); if (row.cwd !== cwd) throw new DeliveryError('invalid_native_response', 'Skill scope mismatch'); row.skills = (row.skills as JsonValue[]).map(skill => ({ ...object(skill), skillId: hash({ cwd, path: object(skill).path!, name: object(skill).name! }) })); }
        return result;
      }
      case 'hooks/list': onlyKeys(params, ['cwd']); return this.request(method, { cwds: [this.host.cwd(params.cwd)] }, 'HooksListParams', 'HooksListResponse');
      case 'skills/read': {
        onlyKeys(params, ['cwd', 'skillId']); const cwd = this.host.cwd(params.cwd), id = revision(params.skillId);
        const catalog = object(await this.call('skills/list', { cwd, forceReload: true }, context));
        const found = (catalog.data as JsonValue[]).flatMap(row => object(row).skills as JsonValue[]).map(value => object(value)).filter(value => value.skillId === id);
        if (found.length !== 1) throw new DeliveryError('skill_unavailable', 'Skill changed; reload its catalog');
        const filename = string(found[0]!.path, 'skill path');
        const extra = this.skillRoots.find(root => { const relative = path.relative(root, filename); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); });
        return { ...await this.resource(extra ?? cwd, 'resource/skill/read', { path: filename }), skillId: id, name: found[0]!.name! };
      }
      case 'plugin/list': case 'plugin/installed': {
        const allowed = method === 'plugin/list' ? ['cwd', 'marketplaceKinds', 'forceRefetch'] : ['cwd']; onlyKeys(params, allowed);
        const { cwd, ...rest } = params; return this.request(method, { ...rest, cwds: [this.host.cwd(cwd)] }, method === 'plugin/list' ? 'PluginListParams' : 'PluginInstalledParams', method === 'plugin/list' ? 'PluginListResponse' : 'PluginInstalledResponse');
      }
      case 'plugin/search': {
        onlyKeys(params, ['cwd', 'searchTerm', 'scope', 'cursor', 'limit']); string(params.searchTerm, 'searchTerm', 512);
        const { cwd, ...rest } = params; return this.request(method, { ...rest, cwds: [this.host.cwd(cwd)] }, 'PluginSearchParams', 'PluginSearchResponse');
      }
      case 'plugin/read': {
        onlyKeys(params, ['cwd', 'pluginId']); const selected = await this.selectPlugin(params);
        const detail = await this.request(method, selected.locator, 'PluginReadParams', 'PluginReadResponse');
        if (object(object(detail.plugin).summary).id !== selected.plugin.id) throw new DeliveryError('plugin_changed', 'Plugin identity changed; refresh its catalog');
        return { ...detail, previewHash: hash(detail.plugin!) };
      }
      case 'plugin/skill/read': {
        onlyKeys(params, ['cwd', 'pluginId', 'skillName']); const skillName = string(params.skillName, 'skillName', 256); const selected = await this.selectPlugin(params);
        const detail = object((await this.request('plugin/read', selected.locator, 'PluginReadParams', 'PluginReadResponse')).plugin);
        const skills = (detail.skills as JsonValue[]).map(skill => object(skill)).filter(skill => skill.name === skillName);
        if (object(detail.summary).id !== params.pluginId || skills.length !== 1) throw new DeliveryError('skill_unavailable', 'Skill is absent or ambiguous in the current plugin details');
        if (typeof selected.locator.remoteMarketplaceName !== 'string' || typeof selected.plugin.remotePluginId !== 'string') {
          const filename = skills[0]!.path;
          if (typeof filename !== 'string') throw new DeliveryError('skill_unavailable', 'Native plugin details did not provide a readable local skill path');
          const resource = await this.resource(this.host.cwd(params.cwd), 'resource/skill/read', { path: filename });
          return { contents: string(resource.text, 'skill contents', 512 * 1024, true) };
        }
        return this.request(method, { remoteMarketplaceName: selected.locator.remoteMarketplaceName, remotePluginId: selected.plugin.remotePluginId, skillName }, 'PluginSkillReadParams', 'PluginSkillReadResponse');
      }
      case 'settings/read': {
        onlyKeys(params, ['cwd']); const read = await this.request('config/read', { cwd: this.host.cwd(params.cwd), includeLayers: true }, 'ConfigReadParams', 'ConfigReadResponse');
        const layers = read.layers as JsonValue[] | null;
        const user = layers?.filter(layer => { const name = object(object(layer).name); return name.type === 'user' && name.profile === null; }) ?? [];
        if (user.length > 1) throw new DeliveryError('invalid_native_response', 'Ambiguous user configuration layer');
        return { ...object(sensitiveConfig(read, this.host.redactor)), userVersion: user.length ? object(user[0]).version! : null, editableKeys: [...editable] };
      }
      default: throw new DeliveryError('method_not_found', 'Unsupported extension operation');
    }
  }
  private async selectPlugin(params: JsonObject, installed = false): Promise<{ plugin: JsonObject; locator: JsonObject }> {
    const cwd = this.host.cwd(params.cwd), id = string(params.pluginId, 'pluginId', 1024);
    const result = await this.request(installed ? 'plugin/installed' : 'plugin/list', { cwds: [cwd], ...(!installed ? { marketplaceKinds: ['local'] } : {}) }, installed ? 'PluginInstalledParams' : 'PluginListParams', installed ? 'PluginInstalledResponse' : 'PluginListResponse');
    const found: { plugin: JsonObject; locator: JsonObject }[] = [];
    const inspect = (catalog: JsonObject): void => { for (const value of catalog.marketplaces as JsonValue[]) {
      const marketplace = object(value);
      for (const entry of marketplace.plugins as JsonValue[]) {
        const plugin = object(entry); if (plugin.id !== id) continue;
        found.push({ plugin, locator: { pluginName: plugin.name!, ...(marketplace.path === null ? { remoteMarketplaceName: marketplace.name! } : { marketplacePath: marketplace.path! }) } });
      }
    } };
    inspect(result);
    // A local package does not require a ChatGPT account. Only a remote-only
    // selection asks the authenticated catalog for its current identity.
    if (!found.length && !installed) inspect(await this.request('plugin/list', { cwds: [cwd], marketplaceKinds: ['vertical', 'workspace-directory', 'shared-with-me', 'created-by-me-remote'] }, 'PluginListParams', 'PluginListResponse'));
    if (found.length !== 1) throw new DeliveryError('plugin_unavailable', 'Plugin is missing or ambiguous in the current project catalog');
    return found[0]!;
  }
  private async mutate(method: string, params: JsonObject, write: NativeCall, context: CallContext): Promise<JsonValue> {
    switch (method) {
      case 'account/sendAddCreditsNudgeEmail': case 'account/resetCredit/consume': case 'account/gatewayOAuth/login': case 'account/gatewayOAuth/cancel': return this.accounts.mutate(method, params, write, context);
      case 'project/trust/write': return this.trust.write(params, this.host.cwd(params.cwd), write);
      case 'skills/extraRoots/set': {
        onlyKeys(params, ['roots', 'confirm']);
        if (params.confirm !== true || !Array.isArray(params.roots) || params.roots.length > 16) throw new DeliveryError('invalid_params', 'Confirm up to 16 registered skill roots');
        const roots = params.roots.map(value => this.host.cwd(value)); if (new Set(roots).size !== roots.length) throw new DeliveryError('invalid_params', 'Duplicate skill root');
        for (const cwd of roots) await this.resource(cwd, 'resource/directory/resolve', { path: '' });
        await this.request('skills/extraRoots/set', { extraRoots: roots }, 'SkillsExtraRootsSetParams', 'SkillsExtraRootsSetResponse', write);
        this.skillRoots = roots; return { roots, persistence: 'current_runtime' };
      }
      case 'plugin/share/save': this.host.cwd(params.cwd); return this.sharing.mutate(method, params, write);
      case 'plugin/share/updateTargets': case 'plugin/share/delete': case 'plugin/share/checkout': return this.sharing.mutate(method, params, write);
      case 'feedback/save': case 'feedback/upload': this.host.cwd(params.cwd); return this.feedback.submit(method, params, context, write);
      case 'rollout/compress': onlyKeys(params, ['confirm']); if (params.confirm !== true) throw new DeliveryError('invalid_params', 'Confirm the native storage maintenance trigger'); return { ...await this.request(method, {}, undefined, 'RolloutCompressResponse', write), triggered: true, completionConfirmed: false };
      case 'import/apply': this.host.cwd(params.cwd); return this.host.redactor.value(await this.imports.apply(params, write));
      case 'mcp/config/write': return this.mcpConfiguration.write(params, this.host.cwd(params.cwd), write);
      case 'skills/config/write': {
        onlyKeys(params, ['cwd', 'skillId', 'enabled']); const id = revision(params.skillId);
        if (typeof params.enabled !== 'boolean') throw new DeliveryError('invalid_params', 'enabled must be boolean');
        const catalog = object(await this.call('skills/list', { cwd: params.cwd!, forceReload: true }, context));
        const skills = (catalog.data as JsonValue[]).flatMap(entry => object(entry).skills as JsonValue[]).map(value => object(value)).filter(skill => skill.skillId === id);
        if (skills.length !== 1) throw new DeliveryError('skill_unavailable', 'Skill identity changed; refresh the skill catalog');
        return this.request(method, { path: skills[0]!.path!, enabled: params.enabled }, 'SkillsConfigWriteParams', 'SkillsConfigWriteResponse', write);
      }
      case 'plugin/install': {
        onlyKeys(params, ['cwd', 'pluginId', 'previewHash']); const previewHash = revision(params.previewHash); const selected = await this.selectPlugin(params);
        if (selected.plugin.availability !== 'AVAILABLE' || selected.plugin.installPolicy === 'NOT_AVAILABLE') throw new DeliveryError('plugin_unavailable', 'Plugin installation is restricted by current policy');
        const detail = await this.request('plugin/read', selected.locator, 'PluginReadParams', 'PluginReadResponse');
        if (object(object(detail.plugin).summary).id !== params.pluginId || hash(detail.plugin!) !== previewHash) throw new DeliveryError('plugin_changed', 'Plugin details changed; review the current details before installation');
        const result = await this.request(method, { ...selected.locator, installAttemptId: string(context.operationId, 'operationId', 36) }, 'PluginInstallParams', 'PluginInstallResponse', write);
        return { ...result, pluginId: params.pluginId! };
      }
      case 'plugin/uninstall': {
        onlyKeys(params, ['cwd', 'pluginId']); const selected = await this.selectPlugin(params, true);
        if (selected.plugin.installed !== true) throw new DeliveryError('plugin_unavailable', 'Plugin is not currently installed');
        const result = await this.request(method, { pluginId: selected.plugin.id! }, 'PluginUninstallParams', 'PluginUninstallResponse', write);
        return { ...result, pluginId: selected.plugin.id! };
      }
      case 'plugin/reconcile': onlyKeys(params, []); return this.request(method, { reason: 'Explicit administrator update request' }, 'PluginReconcileParams', 'PluginReconcileResponse', write);
      case 'marketplace/add': {
        onlyKeys(params, ['cwd', 'source', 'refName']); const cwd = this.host.cwd(params.cwd); const source = object(params.source); onlyKeys(source, ['type', 'path', 'url']); let nativeSource: string;
        if (source.type === 'project') {
          if (source.url !== undefined) throw new DeliveryError('invalid_params', 'Project marketplace cannot also specify a URL');
          const relative = string(source.path ?? '', 'marketplace relative path', 4096, true);
          if (relative && (relative.startsWith('/') || relative.includes('\\') || /[\x00-\x1f\x7f:]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..'))) throw new DeliveryError('invalid_params', 'Marketplace must be a relative path in the selected project');
          nativeSource = string((await this.resource(cwd, 'resource/directory/resolve', { path: relative })).path, 'resolved marketplace directory');
        } else if (source.type === 'git') {
          if (source.path !== undefined) throw new DeliveryError('invalid_params', 'Git marketplace cannot also specify a local path');
          const value = string(source.url, 'marketplace URL', 2048); let url: URL; try { url = new URL(value); } catch { throw new DeliveryError('invalid_params', 'Invalid marketplace URL'); }
          if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /\s/.test(value)) throw new DeliveryError('invalid_params', 'Remote marketplaces require a credential-free HTTPS Git URL');
          nativeSource = url.href;
        } else throw new DeliveryError('invalid_params', 'Choose a project directory or HTTPS Git marketplace');
        if (params.refName !== undefined) { const ref = string(params.refName, 'refName', 256); if (ref.startsWith('-') || /[\x00-\x20\x7f]/.test(ref)) throw new DeliveryError('invalid_params', 'Invalid Git ref'); }
        return this.request(method, { source: nativeSource, ...(params.refName !== undefined ? { refName: params.refName } : {}) }, 'MarketplaceAddParams', 'MarketplaceAddResponse', write);
      }
      case 'marketplace/remove': case 'marketplace/upgrade': {
        onlyKeys(params, ['cwd', 'marketplaceName']); const name = string(params.marketplaceName, 'marketplaceName', 256);
        const catalog = await this.request('plugin/list', { cwds: [this.host.cwd(params.cwd)] }, 'PluginListParams', 'PluginListResponse');
        if (!(catalog.marketplaces as JsonValue[]).some(value => object(value).name === name)) throw new DeliveryError('marketplace_unavailable', 'Marketplace is absent from the selected project');
        return this.request(method, { marketplaceName: name }, method === 'marketplace/remove' ? 'MarketplaceRemoveParams' : 'MarketplaceUpgradeParams', method === 'marketplace/remove' ? 'MarketplaceRemoveResponse' : 'MarketplaceUpgradeResponse', write);
      }
      case 'settings/write': {
        onlyKeys(params, ['expectedVersion', 'changes']); const expectedVersion = string(params.expectedVersion, 'expectedVersion', 4096);
        if (!Array.isArray(params.changes) || !params.changes.length || params.changes.length > 32) throw new DeliveryError('invalid_params', 'Choose between 1 and 32 changed settings');
        const seen = new Set<string>(); const edits = params.changes.map(value => {
          const edit = object(value); onlyKeys(edit, ['key', 'value']); const key = string(edit.key, 'setting key', 128);
          if (!editable.has(key) || seen.has(key) || edit.value === undefined) throw new DeliveryError('invalid_params', 'Setting is managed, unsupported or duplicated');
          seen.add(key); rejectRedacted(edit.value); jsonBytes(edit.value, 256 * 1024);
          return { keyPath: key, value: edit.value, mergeStrategy: 'replace' };
        });
        return this.request('config/batchWrite', { expectedVersion, edits, reloadUserConfig: true }, 'ConfigBatchWriteParams', 'ConfigWriteResponse', write);
      }
      case 'experimentalFeature/enablement/set': {
        onlyKeys(params, ['enablement']); const updates = object(params.enablement);
        if (!Object.keys(updates).length || Object.keys(updates).length > 64 || Object.values(updates).some(value => typeof value !== 'boolean')) throw new DeliveryError('invalid_params', 'Expected between 1 and 64 feature switches');
        const known = new Map<string, JsonObject>(); let cursor: JsonValue = null; const cursors = new Set<string>();
        do {
          const page = await this.request('experimentalFeature/list', { cursor, limit: 100 }, 'ExperimentalFeatureListParams', 'ExperimentalFeatureListResponse');
          for (const entry of page.data as JsonValue[]) { const feature = object(entry); known.set(string(feature.name, 'feature name'), feature); }
          cursor = page.nextCursor!;
          if (cursor !== null) { const next = string(cursor, 'cursor', 4096); if (cursors.has(next) || cursors.size >= 32) throw new DeliveryError('capacity', 'Feature catalog pagination did not finish'); cursors.add(next); }
        } while (cursor !== null);
        for (const name of Object.keys(updates)) if (!known.has(name) || ['deprecated', 'removed'].includes(String(known.get(name)!.stage))) throw new DeliveryError('feature_unavailable', 'Feature is unavailable in this CLI version');
        return this.request(method, params, 'ExperimentalFeatureEnablementSetParams', 'ExperimentalFeatureEnablementSetResponse', write);
      }
      case 'memory/reset': onlyKeys(params, ['confirm']); if (params.confirm !== true) throw new DeliveryError('invalid_params', 'Memory reset requires explicit confirmation'); return this.request(method, {}, undefined, 'MemoryResetResponse', write);
      default: throw new DeliveryError('method_not_found', 'Unsupported extension mutation');
    }
  }
}
