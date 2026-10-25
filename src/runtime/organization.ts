import path from 'node:path';
import { DeliveryError, integer, jsonBytes, LIMITS, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
import type { NativeOptions } from './native.js';
import type { WorkflowMutation } from './workflows.js';

export interface MetadataMutation { method: string; params: JsonObject; schema: string; responseSchema: string; threadIds?: string[]; idle?: boolean; preflight?: () => Promise<void>; beforeWrite?: () => void; project?: (value: JsonValue) => JsonValue }
interface Host {
  native(method: string, params: JsonValue, options?: NativeOptions): Promise<JsonValue>;
  mutate(operation: WorkflowMutation, context: CallContext): Promise<JsonValue>;
  metadata(operation: MetadataMutation, context: CallContext): Promise<JsonValue>;
  cwd(value: JsonValue): string;
}
const checked = (schema: string, value: JsonValue): JsonObject => { try { validateOfficial(schema, value); jsonBytes(value, LIMITS.historyBytes); return object(value); } catch { throw new DeliveryError('invalid_native_response', 'Native organization data was invalid or exceeded its budget'); } };
const samePath = (first: string, second: string): boolean => process.platform === 'win32' ? path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase() : path.resolve(first) === path.resolve(second);
function ids(value: JsonValue | undefined, max: number): string[] { if (!Array.isArray(value) || value.length > max) throw new DeliveryError('invalid_params', 'Invalid identity list'); const result = value.map(item => string(item, 'identity', 256)); if (new Set(result).size !== result.length) throw new DeliveryError('invalid_params', 'Duplicate identity'); return result; }
function page(params: JsonObject): JsonObject { const p: JsonObject = { ...params, limit: params.limit == null ? 50 : integer(params.limit, 'limit', 1, 100) }; if (p.cursor != null) string(p.cursor, 'cursor', LIMITS.cursorBytes, true); return p; }
function pageResult(schema: string, value: JsonValue, cursor: JsonValue | undefined): JsonObject { const result = checked(schema, value); if (!Array.isArray(result.data) || result.data.length > 100) throw new DeliveryError('invalid_native_response', 'Native page exceeded its record budget'); if (result.nextCursor !== null) { string(result.nextCursor, 'cursor', LIMITS.cursorBytes, true); if (result.nextCursor === cursor) throw new DeliveryError('cursor_loop', 'Native organization cursor did not advance'); } return result; }

/** Native project/section identities organize CLI metadata; they never grant filesystem authority. */
export class Organization {
  private writing = false;
  constructor(private host: Host) {}
  private async request(method: string, p: JsonObject, schema: string, responseSchema: string): Promise<JsonObject> { validateOfficial(schema, p); return checked(responseSchema, await this.host.native(method, p)); }
  private async project(id: string): Promise<JsonObject> { const result = await this.request('project/read', { projectId: id }, 'ProjectReadParams', 'ProjectReadResponse'); if (object(result.project).id !== id) throw new DeliveryError('invalid_native_response', 'Native project identity mismatch'); return object(result.project); }
  private async thread(id: string): Promise<JsonObject> { const result = object(await this.host.native('thread/read', { threadId: id })); const thread = object(result.thread); if (thread.id !== id) throw new DeliveryError('invalid_native_response', 'Thread identity mismatch'); string(thread.cwd, 'thread cwd'); return thread; }
  private roots(value: JsonValue): JsonValue[] { if (!Array.isArray(value) || !value.length || value.length > 32) throw new DeliveryError('invalid_params', 'Select between one and 32 registered project roots'); const roots = value.map(item => { const root = object(item); onlyKeys(root, ['path']); return { path: this.host.cwd(root.path!) }; }); if (roots.some((root, i) => roots.slice(0, i).some(other => samePath(root.path, other.path)))) throw new DeliveryError('invalid_params', 'Project roots must be distinct'); return roots; }
  private metadata(value: JsonValue): void { const fields = object(value, 'metadata'); if (Object.keys(fields).length > 64) throw new DeliveryError('capacity', 'Project metadata exceeds its field budget'); for (const [key, item] of Object.entries(fields)) { string(key, 'metadata key', 256); string(item, 'metadata value', 4096, true); } jsonBytes(fields, 64 * 1024); }
  async call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    const write = !method.endsWith('/list') && !method.endsWith('/read');
    if (write && this.writing) throw new DeliveryError('organization_busy', 'Another organization change is in progress');
    if (write) this.writing = true;
    try { return await this.dispatch(method, params, context); } finally { if (write) this.writing = false; }
  }
  private async dispatch(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    if (method.startsWith('nativeProject/')) return this.projects(method.slice('nativeProject/'.length), params, context);
    if (method.startsWith('threadSection/')) return this.sections(method.slice('threadSection/'.length), params, context);
    if (method === 'thread/attachmentOwner/list') {
      onlyKeys(params, ['cwd', 'attachmentType', 'identityKey', 'archived', 'cursor', 'limit']); const cwd = this.host.cwd(params.cwd!); const { cwd: _cwd, ...rest } = params; this.attachmentIdentity(rest);
      const p = page(rest); const result = pageResult('ThreadAttachmentOwnerListResponse', await this.request(method, p, 'ThreadAttachmentOwnerListParams', 'ThreadAttachmentOwnerListResponse'), p.cursor); const data: JsonValue[] = [];
      for (const item of result.data as JsonValue[]) { const owner = object(item); const thread = await this.thread(string(owner.threadId, 'threadId')); if (samePath(String(thread.cwd), cwd)) data.push(owner); } return { ...result, data };
    }
    const threadId = string(params.threadId, 'threadId');
    if (method === 'thread/attachment/list') { onlyKeys(params, ['threadId', 'cursor', 'limit']); const p = page(params); return pageResult('ThreadAttachmentListResponse', await this.request(method, p, 'ThreadAttachmentListParams', 'ThreadAttachmentListResponse'), p.cursor); }
    if (method === 'thread/attachment/add' || method === 'thread/attachment/remove') {
      const add = method.endsWith('/add'); onlyKeys(params, add ? ['threadId', 'attachmentType', 'identityKey', 'payload'] : ['threadId', 'attachmentType', 'identityKey']); this.attachmentIdentity(params); if (add) jsonBytes(params.payload, 64 * 1024);
      const prefix = add ? 'ThreadAttachmentAdd' : 'ThreadAttachmentRemove'; validateOfficial(prefix + 'Params', params);
      return this.host.mutate({ method, params, schema: prefix + 'Params', responseSchema: prefix + 'Response', threadId, mode: 'any', project: result => { const value = checked(prefix + 'Response', result); if (add) { const attachment = object(value.attachment); if (attachment.attachmentType !== params.attachmentType || attachment.identityKey !== params.identityKey) throw new Error('Attachment identity mismatch'); } return value; } }, context);
    }
    if (method === 'thread/project/set') {
      onlyKeys(params, ['threadId', 'nativeProjectId']); const projectId = params.nativeProjectId === null ? '' : string(params.nativeProjectId, 'nativeProjectId', 256); const p = { threadId, projectId };
      return this.host.mutate({ method: 'thread/metadata/update', params: p, schema: 'ThreadMetadataUpdateParams', responseSchema: 'ThreadMetadataUpdateResponse', threadId, mode: 'any', preflight: async () => { if (!projectId) return; const project = await this.project(projectId); const thread = await this.thread(threadId); if (!(project.roots as JsonValue[]).some(root => samePath(String(object(root).path), String(thread.cwd)))) throw new DeliveryError('project_mismatch', 'Native project roots must include this thread working directory'); } }, context);
    }
    if (method === 'thread/section/move') {
      onlyKeys(params, ['threadId', 'sectionId', 'beforeThreadId']); validateOfficial('ThreadSectionMoveParams', params);
      return this.host.mutate({ method, params, schema: 'ThreadSectionMoveParams', responseSchema: 'ThreadSectionMoveResponse', threadId, mode: 'any', preflight: async () => { if (params.beforeThreadId == null) return; const target = string(params.beforeThreadId, 'beforeThreadId'); if (target === threadId) throw new DeliveryError('invalid_params', 'A thread cannot be ordered before itself'); const [source, before] = await Promise.all([this.thread(threadId), this.thread(target)]); if (!samePath(String(source.cwd), String(before.cwd))) throw new DeliveryError('project_mismatch', 'Thread ordering target belongs to a different project'); } }, context);
    }
    if (method === 'thread/memoryMode/set') { onlyKeys(params, ['threadId', 'mode']); validateOfficial('ThreadMemoryModeSetParams', params); return this.host.mutate({ method, params, schema: 'ThreadMemoryModeSetParams', responseSchema: 'ThreadMemoryModeSetResponse', threadId, mode: 'idle', history: true }, context); }
    throw new DeliveryError('method_not_found', 'Unsupported organization workflow');
  }
  private attachmentIdentity(params: JsonObject): void { string(params.attachmentType, 'attachmentType', 128); string(params.identityKey, 'identityKey', 4096); }
  private async projects(action: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    if (action === 'list') { onlyKeys(params, ['cursor', 'limit', 'sortKey', 'sortDirection']); const p = page(params); return pageResult('ProjectListResponse', await this.request('project/list', p, 'ProjectListParams', 'ProjectListResponse'), p.cursor); }
    if (action === 'read') { onlyKeys(params, ['nativeProjectId']); return { project: await this.project(string(params.nativeProjectId, 'nativeProjectId', 256)) }; }
    const keys: Record<string, string[]> = { create: ['name', 'roots', 'metadata', 'idempotencyKey'], import: ['name', 'roots', 'metadata', 'idempotencyKey', 'threadIds'], update: ['nativeProjectId', 'name', 'roots', 'metadata'], move: ['nativeProjectId', 'beforeNativeProjectId'], delete: ['nativeProjectId'] };
    if (!keys[action]) throw new DeliveryError('method_not_found', 'Unsupported native project action'); onlyKeys(params, keys[action]!);
    const p: JsonObject = { ...params }; if (p.nativeProjectId !== undefined) { p.projectId = string(p.nativeProjectId, 'nativeProjectId', 256); delete p.nativeProjectId; }
    if (p.beforeNativeProjectId !== undefined) { p.beforeProjectId = p.beforeNativeProjectId === null ? null : string(p.beforeNativeProjectId, 'beforeNativeProjectId', 256); delete p.beforeNativeProjectId; }
    if (p.name !== undefined && p.name !== null) string(p.name, 'name', 256); if (p.metadata != null) this.metadata(p.metadata); if (p.idempotencyKey !== undefined) string(p.idempotencyKey, 'idempotencyKey', 256);
    if (p.roots !== undefined) p.roots = this.roots(p.roots);
    const threadIds = action === 'import' ? ids(p.threadIds ?? [], 100) : []; delete p.threadIds; if (action === 'import') p.threads = threadIds;
    const prefix = 'Project' + action[0]!.toUpperCase() + action.slice(1); validateOfficial(prefix + 'Params', p);
    return this.host.metadata({ method: 'project/' + action, params: p, schema: prefix + 'Params', responseSchema: prefix + 'Response', threadIds, idle: action === 'import', preflight: async () => {
      for (const threadId of threadIds) { const thread = await this.thread(threadId); if (!(p.roots as JsonValue[]).some(root => samePath(String(object(root).path), String(thread.cwd)))) throw new DeliveryError('project_mismatch', 'Imported threads must belong to the selected registered roots'); }
    }, project: result => { const value = checked(prefix + 'Response', result); if (value.project && p.projectId && object(value.project).id !== p.projectId) throw new Error('Native project identity mismatch'); return value; } }, context);
  }
  private async sections(action: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    if (action === 'list') { onlyKeys(params, ['cursor', 'limit']); const p = page(params); return pageResult('ThreadSectionListResponse', await this.request('threadSection/list', p, 'ThreadSectionListParams', 'ThreadSectionListResponse'), p.cursor); }
    const keys: Record<string, string[]> = { create: ['name', 'appearance'], update: ['sectionId', 'name', 'appearance'], delete: ['sectionId'] }; if (!keys[action]) throw new DeliveryError('method_not_found', 'Unsupported section action'); onlyKeys(params, keys[action]!);
    if (params.name !== undefined) string(params.name, 'name', 256); if (params.sectionId !== undefined) string(params.sectionId, 'sectionId', 256); if (params.appearance != null) { const a = object(params.appearance); onlyKeys(a, ['icon', 'color']); for (const key of ['icon', 'color']) if (a[key] !== null) string(a[key], key, 128); }
    const prefix = 'ThreadSection' + action[0]!.toUpperCase() + action.slice(1); validateOfficial(prefix + 'Params', params);
    return this.host.metadata({ method: 'threadSection/' + action, params, schema: prefix + 'Params', responseSchema: prefix + 'Response', project: result => { const value = checked(prefix + 'Response', result); if (value.section && params.sectionId && object(value.section).id !== params.sectionId) throw new Error('Native section identity mismatch'); return value; } }, context);
  }
}
