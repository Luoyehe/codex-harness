import { execFile } from 'node:child_process';
import path from 'node:path';
import { nativeCommand, type LaunchConfig } from './native-launch.js';
import { DeliveryError, jsonBytes, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { indexFields, indexMutations, validateIndexAction } from './workspace-index.js';

// The caller resolves this from its project registry; browser-supplied roots are
// never accepted in params. The native helper repeats descriptor/path checks.
export interface WorkspaceRoot { path: string; worktreeBinding?: JsonObject }
const fields: Record<string, readonly string[]> = {
  ...indexFields,
  list: ['path'], read: ['path'], download: ['path', 'expectedRevision'], metadata: ['path'], write: ['path', 'text', 'expectedRevision'], mkdir: ['path'],
  search: ['path', 'query', 'mode', 'caseSensitive', 'limit'],
  copy: ['path', 'destination', 'expectedRevision'], remove: ['path', 'expectedRevision', 'confirm', 'recursive'],
  'git/status': [], 'git/diff': ['staged'], 'git/refs': [], 'operation/read': ['operationId'],
  'git/commit': ['expectedHead', 'expectedHeadRevision', 'expectedIndexRevision', 'author', 'message'],
  'recovery/list': [], 'recovery/read': ['operationId'],
  'recovery/restore': ['recoveryOperationId', 'slot', 'path', 'sourceRevision', 'expectedRevision'],
  'recovery/discard': ['recoveryOperationId', 'expectedManifest', 'confirm'],
  'worktree/create': ['ref'], 'worktree/read': ['worktreeId'], 'worktree/attach': ['worktreeId', 'expectedRevision'],
  'worktree/archive': ['worktreeId', 'expectedRevision', 'confirm'], 'worktree/restore': ['worktreeId', 'expectedRevision', 'confirm'],
  'resource/skill/read': ['path'], 'resource/directory/resolve': ['path'], 'resource/plugin/preview': ['path'],
};
export const workspaceMutations = new Set([...indexMutations, 'write', 'mkdir', 'copy', 'remove', 'git/commit', 'recovery/restore', 'recovery/discard', 'worktree/create', 'worktree/attach', 'worktree/archive', 'worktree/restore']);
function relative(value: JsonValue | undefined, empty = false): void {
  const name = string(value, 'workspace path', 4096, empty);
  if (name.startsWith('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name) || (name !== '' && name.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' || part === '.harness-workspace' || Buffer.byteLength(part) > 255))) throw new DeliveryError('invalid_params', 'Workspace path must remain relative to its registered root');
}
function operationId(value: unknown): string {
  const id = string(value, 'operationId', 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new DeliveryError('invalid_params', 'Canonical operationId is required');
  return id;
}
export function workspaceRequest(root: WorkspaceRoot, action: string, input: JsonObject, context: CallContext, internal = false): JsonObject {
  const internalAck = internal && action === 'operation/ack';
  if (!internalAck && !Object.hasOwn(fields, action)) throw new DeliveryError('method_not_found', 'Unsupported workspace action');
  onlyKeys(input, internalAck ? ['operationId', 'requestDigest'] : [...fields[action]!]);
  const rootPath = string(root.path, 'registered workspace root');
  if (!rootPath.startsWith('/') || path.posix.normalize(rootPath) !== rootPath || /[\u0000-\u001f\u007f]/.test(rootPath)) throw new DeliveryError('invalid_project', 'Registered native workspace root must be canonical');
  const params = { ...input };
  if (internalAck) {
    operationId(params.operationId);
    if (typeof params.requestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(params.requestDigest)) throw new DeliveryError('invalid_params', 'Invalid accepted helper request digest');
  }
  if (Object.hasOwn(indexFields, action)) validateIndexAction(action, params);
  if (action === 'list' || action === 'metadata') relative(params.path ?? '', true);
  else if (['read', 'download', 'write', 'mkdir', 'copy', 'remove'].includes(action)) relative(params.path);
  if (action === 'resource/directory/resolve' || action === 'resource/plugin/preview') relative(params.path ?? '', true);
  if (action === 'search') {
    relative(params.path ?? '', true);
    const query = string(params.query, 'literal search query', 512);
    if (/[\u0000-\u001f\u007f]/.test(query) || (params.mode !== undefined && params.mode !== 'path' && params.mode !== 'text') || (params.caseSensitive !== undefined && typeof params.caseSensitive !== 'boolean') || (params.limit !== undefined && (typeof params.limit !== 'number' || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100))) throw new DeliveryError('invalid_params', 'Invalid bounded literal search');
  }
  if (action === 'resource/skill/read') {
    const name = string(params.path, 'catalog skill path', 4096);
    if (!name.startsWith('/') || path.posix.normalize(name) !== name || path.posix.basename(name) !== 'SKILL.md') throw new DeliveryError('invalid_params', 'Catalog resource must name a canonical SKILL.md');
    relative(name.slice(1));
  }
  if (action === 'write') {
    const text = string(params.text, 'file text', 512 * 1024, true);
    if (text.includes('\0') || !Object.hasOwn(params, 'expectedRevision')) throw new DeliveryError('invalid_params', 'Text writes require a revision or explicit null for creation');
  }
  if (action === 'copy') { relative(params.destination); if (params.destination === params.path) throw new DeliveryError('invalid_params', 'Copy destination must differ'); }
  if ((action === 'write' && params.expectedRevision !== null) || action === 'copy' || action === 'remove' || action === 'download') {
    if (typeof params.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(params.expectedRevision)) throw new DeliveryError('invalid_params', 'Expected file revision is required');
  }
  if (action === 'remove' && (params.confirm !== true || params.recursive !== false)) throw new DeliveryError('invalid_params', 'Removal requires confirm:true and recursive:false');
  if (action === 'git/diff' && params.staged !== undefined && typeof params.staged !== 'boolean') throw new DeliveryError('invalid_params', 'Invalid staged diff choice');
  if (action === 'git/commit') {
    if (params.expectedHead !== null && (typeof params.expectedHead !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(params.expectedHead))) throw new DeliveryError('invalid_params', 'Select the current HEAD before committing');
    for (const key of ['expectedHeadRevision', 'expectedIndexRevision']) if (typeof params[key] !== 'string' || !/^[0-9a-f]{64}$/.test(params[key])) throw new DeliveryError('invalid_params', 'Select the current HEAD and index revisions');
    const author = object(params.author); onlyKeys(author, ['name', 'email']);
    for (const key of ['name', 'email']) { const value = string(author[key], 'commit author', key === 'name' ? 256 : 254); if (value.trim() !== value || /[\u0000-\u001f\u007f<>]/.test(value)) throw new DeliveryError('invalid_params', 'Invalid commit author'); }
    if (!/^[^\s@]+@[^\s@]+$/.test(String(author.email))) throw new DeliveryError('invalid_params', 'Invalid commit email');
    params.author = { ...author };
    const message = string(params.message, 'commit message', 65536); if (!message.trim() || message.includes('\0')) throw new DeliveryError('invalid_params', 'Commit message must be nonempty text');
  }
  if (action === 'operation/read') operationId(params.operationId);
  if (action === 'recovery/read') operationId(params.operationId);
  if (action === 'recovery/restore' || action === 'recovery/discard') operationId(params.recoveryOperationId);
  if (action === 'recovery/restore') {
    relative(params.path);
    if (!['before', 'next'].includes(String(params.slot)) || typeof params.sourceRevision !== 'string' || !/^[0-9a-f]{64}$/.test(params.sourceRevision) || !Object.hasOwn(params, 'expectedRevision') ||
        (params.expectedRevision !== null && (typeof params.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(params.expectedRevision)))) throw new DeliveryError('invalid_params', 'Restoring requires an exact source revision and current destination revision or null');
  }
  if (action === 'recovery/discard' && (params.confirm !== true || typeof params.expectedManifest !== 'string' || !/^[0-9a-f]{64}$/.test(params.expectedManifest))) throw new DeliveryError('invalid_params', 'Discarding recovery payloads requires the current manifest and explicit confirmation');
  const request: JsonObject = { version: 1, root: rootPath, action, params };
  if (action.startsWith('worktree/')) {
    if (action === 'worktree/create') {
      const ref = string(params.ref, 'Git ref', 300);
      if (!/^(?:HEAD|[0-9a-f]{40}|[0-9a-f]{64}|refs\/(?:heads|remotes|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255})$/.test(ref) || ref.includes('..') || ref.includes('//') || /(?:\/|\.|\.lock)$/.test(ref)) throw new DeliveryError('invalid_params', 'Select HEAD, a full ref or a commit id');
    } else {
      const worktreeId = operationId(params.worktreeId); const binding = root.worktreeBinding;
      if (!binding || binding.version !== 1 || binding.worktreeId !== worktreeId || binding.originRoot !== rootPath) throw new DeliveryError('worktree_unbound', 'A supervisor-owned worktree binding is required');
      onlyKeys(binding, ['version', 'worktreeId', 'originRoot', 'commonDir', 'commonDevice', 'commonInode', 'gitDir', 'gitDirDevice', 'gitDirInode', 'worktreeDevice', 'worktreeInode']);
      for (const key of ['commonDir', 'gitDir']) { const name = string(binding[key], 'bound Git directory', 4096); if (!name.startsWith('/') || path.posix.normalize(name) !== name || /[\u0000-\u001f\u007f]/.test(name)) throw new DeliveryError('worktree_unbound', 'Invalid bound Git directory'); }
      for (const key of ['commonDevice', 'commonInode', 'gitDirDevice', 'gitDirInode', 'worktreeDevice', 'worktreeInode']) if (typeof binding[key] !== 'number' || !Number.isSafeInteger(binding[key]) || binding[key] < 0) throw new DeliveryError('worktree_unbound', 'Invalid bound directory identity');
      request.binding = { ...binding };
      if (action !== 'worktree/read' && (typeof params.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(params.expectedRevision))) throw new DeliveryError('invalid_params', 'Read the current worktree revision before changing it');
      if ((action === 'worktree/archive' || action === 'worktree/restore') && params.confirm !== true) throw new DeliveryError('invalid_params', 'Worktree movement requires explicit confirmation');
    }
  }
  if (workspaceMutations.has(action)) request.operationId = operationId(context.operationId);
  jsonBytes(request, 1024 * 1024);
  return request;
}

export async function runWorkspace(config: LaunchConfig, root: WorkspaceRoot, action: string, params: JsonObject, context: CallContext, internal = false): Promise<JsonValue> {
  const request = workspaceRequest(root, action, params, context, internal);
  const mutation = workspaceMutations.has(action) || (internal && action === 'operation/ack');
  if (mutation && !context.beforeWrite) throw new DeliveryError('operation_required', 'Workspace mutations require the durable operation boundary');
  const body = jsonBytes(request, 1024 * 1024);
  const command = nativeCommand(config, 'workspace');
  return new Promise((resolve, reject) => {
    let dispatched = false;
    const child = execFile(command.bin, command.args, { cwd: command.cwd, env: command.env, windowsHide: true, timeout: action.startsWith('worktree/') || action === 'git/commit' || Object.hasOwn(indexFields, action) ? 90000 : 30000, maxBuffer: (action === 'download' ? 12 : 2) * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      try {
        if (!stdout) throw error ?? new Error('Missing workspace response');
        const response = object(JSON.parse(stdout));
        if (response.ok === true && Object.hasOwn(response, 'result')) { resolve(response.result!); return; }
        const failure = object(response.error);
        if (response.ok !== false || !['not_sent', 'unknown'].includes(String(failure.delivery))) throw new Error('Invalid workspace response');
        reject(new DeliveryError(string(failure.code, 'workspace error code', 128), string(failure.message, 'workspace error message'), failure.delivery as 'not_sent' | 'unknown'));
      } catch {
        reject(new DeliveryError('workspace_unavailable', 'Native workspace helper did not return a complete result; query the original operation', mutation && dispatched ? 'unknown' : 'not_sent'));
      }
    });
    child.stdin?.on('error', () => {});
    try {
      if (mutation) context.beforeWrite!();
      dispatched = true;
      child.stdin?.end(body);
    } catch (error) {
      child.stdin?.destroy(); child.kill('SIGTERM'); reject(error);
    }
  });
}
