import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DeliveryError, integer, jsonBytes, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
import type { NativeOptions } from './native.js';
import type { DiagnosticRedactor } from './redaction.js';
export interface RemoteHost {
  native(method: string, params: JsonValue, options?: NativeOptions): Promise<JsonValue>;
  configure(operation: (write: (method: string, params: JsonValue, options?: NativeOptions) => Promise<JsonValue>) => Promise<JsonValue>, context: CallContext): Promise<JsonValue>;
  redactor: DiagnosticRedactor;
}
interface Environment { environmentId: string; name: string; endpoint: string; info?: JsonObject; cwd?: string }
export function remoteResponse(schema: string, result: JsonValue, max = 1024 * 1024): JsonObject { try { jsonBytes(result, max); validateOfficial(schema, result); return object(result); } catch { throw new DeliveryError('invalid_native_response', 'Native remote response was invalid or exceeded its budget', 'unknown'); } }
/** Registration grants remote execution authority for this service epoch only. */
export class Environments {
  private entries = new Map<string, Environment>();
  constructor(private host: RemoteHost) {}
  private get(id: JsonValue | undefined): Environment { const entry = this.entries.get(string(id, 'environmentId', 36)); if (!entry) throw new DeliveryError('environment_not_registered', 'Register this environment in the current runtime before using it'); return entry; }
  private describe(entry: Environment): JsonObject { return { environmentId: entry.environmentId, name: entry.name, endpoint: entry.endpoint, requiresRestartToDisconnect: true, selectionReady: entry.cwd !== undefined, ...(entry.info ? { info: entry.info } : {}) }; }
  selection(value: JsonValue): JsonValue[] {
    if (!Array.isArray(value) || value.length > 8) throw new DeliveryError('invalid_params', 'Select at most eight registered environment IDs');
    const ids = value.map(id => string(id, 'environmentId', 36)); if (new Set(ids).size !== ids.length) throw new DeliveryError('invalid_params', 'Duplicate environment selection');
    return ids.map(id => { const entry = this.get(id); if (!entry.cwd) throw new DeliveryError('environment_not_inspected', 'Explicitly inspect the remote environment before selecting it'); return { environmentId: id, cwd: entry.cwd }; });
  }
  assertThread(thread: JsonObject): void {
    if (!Array.isArray(thread.environments)) {
      if (this.entries.size) throw new DeliveryError('environment_selection_unknown', 'This unloaded thread has no verifiable executor selection. Restart the runtime to disconnect registered remote environments before resuming it.');
      return;
    }
    for (const value of thread.environments) {
      const current = object(value);
      // The pinned CLI reports its built-in local executor on ordinary threads.
      // It derives authority from the thread cwd, never from remote registration.
      const cwd = current.environmentId === 'local' ? thread.cwd : this.get(current.environmentId).cwd;
      if (!cwd || current.cwd !== cwd || (Array.isArray(current.runtimeWorkspaceRoots) && current.runtimeWorkspaceRoots.some(root => root !== cwd))) throw new DeliveryError('environment_changed', 'Thread environment differs from its explicitly inspected root');
    }
  }
  assertIndependentLoad(): void { if (this.entries.size) throw new DeliveryError('environment_selection_unknown', 'This native workflow cannot constrain inherited executor selection. Restart the runtime to disconnect remote environments before forking or reopening stored threads.'); }
  async call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    if (method === 'environment/list') { onlyKeys(params, []); return { data: [...this.entries.values()].map(entry => this.describe(entry)) }; }
    if (method === 'environment/add') {
      onlyKeys(params, ['name', 'execServerUrl', 'authBearerToken', 'websocketRequestId', 'connectTimeoutMs', 'skills', 'confirmRemoteExecution']);
      if (params.confirmRemoteExecution !== true) throw new DeliveryError('confirmation_required', 'Explicit remote execution authorization is required');
      const name = string(params.name, 'name', 128), endpoint = string(params.execServerUrl, 'execServerUrl', 4096); let url: URL; try { url = new URL(endpoint); } catch { throw new DeliveryError('invalid_params', 'Invalid executor URL'); }
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || (url.protocol !== 'wss:' && !loopback)) throw new DeliveryError('invalid_params', 'Remote executor requires WSS, or a loopback WS URL without embedded credentials');
      if (params.authBearerToken != null) this.host.redactor.addSecret(string(params.authBearerToken, 'authBearerToken', 4096));
      if (params.websocketRequestId != null) string(params.websocketRequestId, 'websocketRequestId', 128);
      if (params.connectTimeoutMs != null) integer(params.connectTimeoutMs, 'connectTimeoutMs', 100, 30000);
      if (params.skills != null) { const skills = object(params.skills); onlyKeys(skills, ['required']); if (skills.required != null && (!Array.isArray(skills.required) || skills.required.length > 128 || skills.required.some(item => typeof item !== 'string' || Buffer.byteLength(item) > 256))) throw new DeliveryError('invalid_params', 'Invalid environment skills'); }
      if (this.entries.size >= 32) throw new DeliveryError('capacity', 'Environment registration budget reached; restart to disconnect retired environments');
      const { name: _name, confirmRemoteExecution: _confirm, ...native } = params; const environmentId = randomUUID(), p = { ...native, environmentId }; validateOfficial('EnvironmentAddParams', p);
      return this.host.configure(async write => { remoteResponse('EnvironmentAddResponse', await write(method, p)); this.entries.set(environmentId, { environmentId, name, endpoint: url.origin }); return { environmentId, registered: true, requiresRestartToDisconnect: true }; }, context);
    }
    onlyKeys(params, ['environmentId']); const entry = this.get(params.environmentId);
    if (method === 'environment/read') return this.describe(entry);
    if (method === 'environment/status') { const status = remoteResponse('EnvironmentStatusResponse', await this.host.native(method, params), 64 * 1024); return this.host.redactor.value(status); }
    if (method === 'environment/info') return this.host.configure(async write => {
      const info = remoteResponse('EnvironmentInfoResponse', await write(method, params), 64 * 1024);
      if (info.cwd != null) {
        try { const uri = new URL(string(info.cwd, 'environment cwd', 4096)); if (uri.protocol !== 'file:' || uri.search || uri.hash) throw new Error(); const windows = /^\/[A-Za-z]:\//.test(uri.pathname) || !!uri.hostname; entry.cwd = fileURLToPath(uri, { windows }); }
        catch { throw new DeliveryError('unsupported_environment_path', 'Remote default directory cannot be represented safely; it was not selected', 'unknown'); }
      } else delete entry.cwd;
      entry.info = info; return { environmentId: entry.environmentId, inspected: true, selectionReady: entry.cwd !== undefined };
    }, context);
    throw new DeliveryError('method_not_found', 'Unsupported environment workflow');
  }
  reset(): void { this.entries.clear(); }
}
