import type { JsonValue } from '../core/contracts.js';
import { identifier, object, validText } from '../core/validation.js';
/** Native organizational bodies are re-read, never copied into operation receipts. */
export function organizationReceipt(method: string, input: JsonValue): JsonValue {
  object(input);
  if (['nativeProject/create', 'nativeProject/import', 'nativeProject/update'].includes(method)) { object(input.project); return { project: { id: identifier(input.project.id) } }; }
  if (method === 'threadSection/create' || method === 'threadSection/update') { object(input.section); return { section: { id: identifier(input.section.id) } }; }
  if (method === 'thread/project/set') { object(input.thread); return { thread: { id: identifier(input.thread.id), ...(typeof input.thread.cwd === 'string' ? { cwd: validText(input.thread.cwd, 4096) } : {}) } }; }
  if (method === 'thread/attachment/add') { object(input.attachment); if (!['created', 'existing'].includes(String(input.outcome))) throw new Error('Invalid attachment result'); return { outcome: input.outcome!, attachment: { id: identifier(input.attachment.id), attachmentType: validText(input.attachment.attachmentType, 128), identityKey: validText(input.attachment.identityKey, 4096), ...(typeof input.attachment.createdAt === 'number' ? { createdAt: input.attachment.createdAt } : {}) } }; }
  if (['nativeProject/move', 'nativeProject/delete', 'threadSection/delete', 'thread/section/move', 'thread/attachment/remove', 'thread/memoryMode/set'].includes(method)) return {};
  throw new Error('Unexpected organizational receipt');
}
