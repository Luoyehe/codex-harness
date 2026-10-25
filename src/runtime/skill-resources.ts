import path from 'node:path';
import { runWorkspace, type WorkspaceRoot } from './workspace.js';
import type { LaunchConfig } from './native-launch.js';
import { DeliveryError, object, onlyKeys, string, type CallContext, type JsonObject } from './types.js';

// Internal adapters only. The extension host must select the skill from a fresh
// skills/list result and resolve root from its project registry, never browser paths.
export async function readSkillResource(config: LaunchConfig, root: WorkspaceRoot, catalogSkill: JsonObject, context: CallContext): Promise<JsonObject> {
  const requested = string(catalogSkill.path, 'catalog skill path', 4096);
  const result = object(await runWorkspace(config, root, 'resource/skill/read', { path: requested }, context));
  onlyKeys(result, ['path', 'text', 'bytes', 'revision']);
  const text = string(result.text, 'skill text', 512 * 1024, true);
  if (result.path !== requested || text.includes('\0') || result.bytes !== Buffer.byteLength(text) || typeof result.revision !== 'string' || !/^[0-9a-f]{64}$/.test(result.revision)) throw new DeliveryError('invalid_native_response', 'Invalid bounded skill resource');
  return result;
}

// This is a bounded descriptor-based preflight. A later native RPC reopens its
// returned path; this is not a lease or isolation from concurrent same-UID writes.
export async function resolveProjectDirectory(config: LaunchConfig, root: WorkspaceRoot, relativePath: string, context: CallContext): Promise<JsonObject> {
  const result = object(await runWorkspace(config, root, 'resource/directory/resolve', { path: relativePath }, context));
  onlyKeys(result, ['path', 'device', 'inode']);
  if (result.path !== path.posix.join(root.path, relativePath) || ![result.device, result.inode].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) throw new DeliveryError('invalid_native_response', 'Directory escaped its registered project');
  return result;
}

export async function previewProjectPlugin(config: LaunchConfig, root: WorkspaceRoot, relativePath: string, context: CallContext): Promise<JsonObject> {
  const result = object(await runWorkspace(config, root, 'resource/plugin/preview', { path: relativePath }, context));
  onlyKeys(result, ['path', 'revision', 'files', 'totalBytes']);
  if (result.path !== path.posix.join(root.path, relativePath) || typeof result.revision !== 'string' || !/^[0-9a-f]{64}$/.test(result.revision) || !Array.isArray(result.files) || result.files.length > 512) throw new DeliveryError('invalid_native_response', 'Invalid scoped plugin preview');
  const seen = new Set<string>(); let total = 0;
  for (const value of result.files) {
    const file = object(value); onlyKeys(file, ['path', 'bytes', 'sha256']); const name = string(file.path, 'plugin relative file', 4096);
    if (name.startsWith('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name) || name.split('/').some(part => !part || ['.', '..', '.git', '.harness-workspace'].includes(part)) || seen.has(name) || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 2 * 1024 * 1024 || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new DeliveryError('invalid_native_response', 'Invalid plugin file inventory');
    seen.add(name); total += file.bytes;
  }
  if (result.totalBytes !== total || total > 16 * 1024 * 1024) throw new DeliveryError('invalid_native_response', 'Invalid plugin aggregate size');
  return result;
}
