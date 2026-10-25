import { uuid } from './ids';
import type { Options } from './types';
import { contextProblem, type ContextNote, type DraftReference } from './input-context';
export type DraftAttachment = { attachmentId: string; name: string; size: number; mimeType: string };
export type Draft = { key: string; revision: string; text: string; options: Options; attachments: DraftAttachment[]; references: DraftReference[]; extraContext: ContextNote[]; outputSchema: string; updatedAt: number };
const prefix = 'harness.draft.v1.';
const storageKey = (key: string) => prefix + encodeURIComponent(key);
const validEnvironments = (value: unknown) => value === undefined || Array.isArray(value) && value.length <= 8 && new Set(value).size === value.length && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 36);
export const emptyDraft = (key: string): Draft => ({ key, revision: uuid(), text: '', options: {}, attachments: [], references: [], extraContext: [], outputSchema: '', updatedAt: Date.now() });
export function readDraft(key: string, storage: Storage = sessionStorage): Draft {
  const raw = storage.getItem(storageKey(key));
  if (raw === null) return emptyDraft(key);
  const draft = JSON.parse(raw) as Draft;
  draft.references ??= []; draft.extraContext ??= []; draft.outputSchema ??= '';
  if (draft.key !== key || typeof draft.revision !== 'string' || typeof draft.text !== 'string' || draft.text.length > 100_000 || !draft.options || typeof draft.options !== 'object' || !Array.isArray(draft.attachments) || draft.attachments.length > 8 || draft.attachments.some(a => typeof a.attachmentId !== 'string' || typeof a.name !== 'string' || typeof a.mimeType !== 'string' || typeof a.size !== 'number')) throw new Error('本地草稿格式损坏，尚未自动覆盖。');
  if (contextProblem(draft.references, draft.extraContext) || typeof draft.outputSchema !== 'string' || draft.outputSchema.length > 65_536) throw new Error('本地引用或结构化输出草稿损坏，尚未自动覆盖。');
  if (!validEnvironments(draft.options.environments)) throw new Error('草稿中的执行环境选择无效，未自动覆盖。');
  return draft;
}
export function writeDraft(draft: Draft, storage: Storage = sessionStorage) {
  if (draft.text.length > 100_000) throw new Error('草稿超过 100,000 字符上限。');
  const problem = contextProblem(draft.references, draft.extraContext); if (problem) throw new Error(problem);
  if (typeof draft.outputSchema !== 'string' || draft.outputSchema.length > 65_536) throw new Error('结构化输出草稿超过容量上限。');
  if (!validEnvironments(draft.options.environments)) throw new Error('最多选择 8 个不同的已登记执行环境。');
  const key = storageKey(draft.key), value = JSON.stringify(draft); let chars = value.length, count = 1;
  for (let i = 0; i < storage.length; i++) { const other = storage.key(i); if (other?.startsWith(prefix) && other !== key) { count++; chars += (storage.getItem(other) ?? '').length; } }
  if (count > 50 || chars > 1_000_000) throw new Error('本地草稿达到 50 份或 1,000,000 字符的容量上限。请先处理已有草稿。');
  storage.setItem(key, value);
  if (storage.getItem(key) !== value) throw new Error('浏览器未能保存草稿。');
}
export function clearDraftSnapshot(key: string, revision: string, storage: Storage = sessionStorage) {
  if (readDraft(key, storage).revision === revision) { storage.removeItem(storageKey(key)); draftChanged(key); }
}
export function draftChanged(key: string) { window.dispatchEvent(new CustomEvent('harness-drafts', { detail: { key } })); }
export function listDrafts(storage: Storage = sessionStorage): Draft[] {
  const drafts: Draft[] = [];
  for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key?.startsWith(prefix)) drafts.push(readDraft(decodeURIComponent(key.slice(prefix.length)), storage)); }
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
}
export function discardDraft(key: string, storage: Storage = sessionStorage) { storage.removeItem(storageKey(key)); draftChanged(key); }
export const branchDraftKey = (threadId: string, turnId: string) => `branch:${encodeURIComponent(JSON.stringify([threadId, turnId]))}`;
export function branchDraftSource(key: string): { threadId: string; turnId: string } | undefined {
  if (!key.startsWith('branch:')) return;
  try { const value: unknown = JSON.parse(decodeURIComponent(key.slice(7))); if (Array.isArray(value) && value.length === 2 && value.every(part => typeof part === 'string' && part.length > 0 && part.length <= 256)) return { threadId: value[0], turnId: value[1] }; } catch { /* Not a recognized branch draft. */ }
}
