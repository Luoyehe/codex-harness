import { DeliveryError, object, onlyKeys, string, type JsonObject, type JsonValue } from './types.js';

const versions = ['expectedHead', 'expectedHeadRevision', 'expectedIndexRevision'];
export const indexFields: Record<string, readonly string[]> = {
  'git/stage': [...versions, 'files'], 'git/unstage': [...versions, 'paths'],
  'git/index/recovery/list': [], 'git/index/recovery/read': ['operationId'],
  'git/index/recovery/restore': [...versions, 'recoveryOperationId', 'slot', 'sourceRevision'],
  'git/index/recovery/discard': ['recoveryOperationId', 'expectedManifest', 'confirm'],
};
export const indexMutations = ['git/stage', 'git/unstage', 'git/index/recovery/restore', 'git/index/recovery/discard'];
const revision = (value: JsonValue | undefined): void => { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new DeliveryError('invalid_params', 'Select the current index/file revision'); };
function operation(value: JsonValue | undefined): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new DeliveryError('invalid_params', 'Select the original recovery operation');
}
function relative(value: JsonValue | undefined): string {
  const name = string(value, 'index file path', 4096);
  if (name.startsWith('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name) || name.split('/').some(part => !part || ['.', '..', '.git', '.harness-workspace'].includes(part) || Buffer.byteLength(part) > 255)) throw new DeliveryError('invalid_params', 'Index paths must be explicit relative files');
  return name;
}
export function validateIndexAction(action: string, params: JsonObject): void {
  onlyKeys(params, [...indexFields[action]!]);
  if (['git/stage', 'git/unstage', 'git/index/recovery/restore'].includes(action)) {
    if (params.expectedHead !== null && (typeof params.expectedHead !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(params.expectedHead))) throw new DeliveryError('invalid_params', 'Select the current HEAD');
    revision(params.expectedHeadRevision); revision(params.expectedIndexRevision);
  }
  if (action === 'git/stage' || action === 'git/unstage') {
    const choices = params[action === 'git/stage' ? 'files' : 'paths'];
    if (!Array.isArray(choices) || !choices.length || choices.length > 32) throw new DeliveryError('invalid_params', 'Select between one and 32 explicit files');
    const seen = new Set<string>();
    const cloned = choices.map(value => {
      const item = action === 'git/stage' ? object(value) : undefined;
      if (item) {
        onlyKeys(item, ['path', 'expectedRevision', 'deleted']);
        if (typeof item.deleted !== 'boolean') throw new DeliveryError('invalid_params', 'Confirm whether the selected file was deleted');
        if (item.deleted) { if (item.expectedRevision !== null) throw new DeliveryError('invalid_params', 'Deletion must select an absent file'); }
        else revision(item.expectedRevision);
      }
      const name = relative(item ? item.path : value);
      if (seen.has(name)) throw new DeliveryError('invalid_params', 'Duplicate selected file');
      seen.add(name); return item ? { ...item } : name;
    });
    params[action === 'git/stage' ? 'files' : 'paths'] = cloned;
  }
  if (action === 'git/index/recovery/read') operation(params.operationId);
  if (action === 'git/index/recovery/restore' || action === 'git/index/recovery/discard') operation(params.recoveryOperationId);
  if (action === 'git/index/recovery/restore') {
    if (!['before', 'captured', 'next'].includes(String(params.slot))) throw new DeliveryError('invalid_params', 'Select a retained index slot');
    revision(params.sourceRevision);
  }
  if (action === 'git/index/recovery/discard') {
    revision(params.expectedManifest); if (params.confirm !== true) throw new DeliveryError('invalid_params', 'Explicit index backup discard confirmation is required');
  }
}
