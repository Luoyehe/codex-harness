import { uuid } from './ids';
import type { Options } from './types';
import { contextProblem, type ContextNote, type DraftReference } from './input-context';
export type DraftAttachment = {
  attachmentId: string;
  name: string;
  size: number;
  mimeType: string;
};
export type Draft = {
  key: string;
  revision: string;
  text: string;
  options: Options;
  attachments: DraftAttachment[];
  references: DraftReference[];
  extraContext: ContextNote[];
  outputSchema: string;
  updatedAt: number;
};
export type DraftChange =
  | { type: 'snapshot-cleared'; revision: string }
  | { type: 'attachment-removed'; attachmentId: string };
const prefix = 'harness.draft.v1.';
const storageKey = (key: string) => prefix + encodeURIComponent(key);
// Each window owns its writes. Other same-session documents invalidate their
// snapshots through storage events. Failed writes never alter the cached budget.
const draftLengths = new WeakMap<Storage, { lengths: Map<string, number>; storageLength: number }>();
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.storageArea && (!event.key || event.key.startsWith(prefix))) draftLengths.delete(event.storageArea);
});
function lengthsFor(storage: Storage) {
  const cached = draftLengths.get(storage);
  if (cached?.storageLength === storage.length) return cached.lengths;
  const lengths = new Map<string, number>();
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) lengths.set(key, (storage.getItem(key) ?? '').length);
  }
  draftLengths.set(storage, { lengths, storageLength: storage.length });
  return lengths;
}
function removeStoredDraft(storage: Storage, key: string) {
  draftLengths.delete(storage);
  storage.removeItem(key);
}
export type DraftMode = 'native' | 'root';
export const executionDraftKey = (key: string, mode: DraftMode = 'native') => mode === 'root' ? `root:${key}` : key;
export const executionDraftContext = (key: string): { mode: DraftMode; key: string } =>
  key.startsWith('root:') ? { mode: 'root', key: key.slice(5) } : { mode: 'native', key };
const validEnvironments = (value: unknown) =>
  value === undefined ||
  (Array.isArray(value) &&
    value.length <= 8 &&
    new Set(value).size === value.length &&
    value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 36));
export const emptyDraft = (key: string): Draft => ({
  key,
  revision: uuid(),
  text: '',
  options: {},
  attachments: [],
  references: [],
  extraContext: [],
  outputSchema: '',
  updatedAt: Date.now(),
});
export function readDraft(key: string, storage: Storage = sessionStorage): Draft {
  const raw = storage.getItem(storageKey(key));
  if (raw === null) return emptyDraft(key);
  const draft = JSON.parse(raw) as Draft;
  draft.references ??= [];
  draft.extraContext ??= [];
  draft.outputSchema ??= '';
  if (
    draft.key !== key ||
    typeof draft.revision !== 'string' ||
    typeof draft.text !== 'string' ||
    draft.text.length > 100_000 ||
    !draft.options ||
    typeof draft.options !== 'object' ||
    !Array.isArray(draft.attachments) ||
    draft.attachments.length > 8 ||
    draft.attachments.some(
      (a) =>
        typeof a.attachmentId !== 'string' ||
        typeof a.name !== 'string' ||
        typeof a.mimeType !== 'string' ||
        typeof a.size !== 'number',
    )
  )
    throw new Error('本地草稿格式损坏，尚未自动覆盖。');
  if (
    contextProblem(draft.references, draft.extraContext) ||
    typeof draft.outputSchema !== 'string' ||
    draft.outputSchema.length > 65_536
  )
    throw new Error('本地引用或结构化输出草稿损坏，尚未自动覆盖。');
  if (!validEnvironments(draft.options.environments))
    throw new Error('草稿中的执行环境选择无效，未自动覆盖。');
  return draft;
}
export function writeDraft(draft: Draft, storage: Storage = sessionStorage) {
  if (draft.text.length > 100_000) throw new Error('草稿超过 100,000 字符上限。');
  const problem = contextProblem(draft.references, draft.extraContext);
  if (problem) throw new Error(problem);
  if (typeof draft.outputSchema !== 'string' || draft.outputSchema.length > 65_536)
    throw new Error('结构化输出草稿超过容量上限。');
  if (!validEnvironments(draft.options.environments))
    throw new Error('最多选择 8 个不同的已登记执行环境。');
  const key = storageKey(draft.key),
    value = JSON.stringify(draft);
  const lengths = lengthsFor(storage);
  let chars = value.length;
  for (const [entry, length] of lengths) if (entry !== key) chars += length;
  const count = lengths.size + (lengths.has(key) ? 0 : 1);
  if (count > 50 || chars > 1_000_000)
    throw new Error('本地草稿达到 50 份或 1,000,000 字符的容量上限。请先处理已有草稿。');
  try {
    storage.setItem(key, value);
    if (storage.getItem(key) !== value) throw new Error('浏览器未能保存草稿。');
  } catch (error) {
    // The write may have succeeded even if its verification read failed.
    draftLengths.delete(storage);
    throw error;
  }
  lengths.set(key, value.length);
  draftLengths.set(storage, { lengths, storageLength: storage.length });
}
export function clearDraftSnapshot(
  key: string,
  revision: string,
  storage: Storage = sessionStorage,
) {
  if (readDraft(key, storage).revision === revision) {
    removeStoredDraft(storage, storageKey(key));
    draftChanged(key, { type: 'snapshot-cleared', revision });
  }
}
export function draftChanged(key: string, change?: DraftChange) {
  window.dispatchEvent(new CustomEvent('harness-drafts', { detail: { key, change } }));
}
export function listDrafts(storage: Storage = sessionStorage): Draft[] {
  const drafts: Draft[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(prefix)) {
      try { drafts.push(readDraft(decodeURIComponent(key.slice(prefix.length)), storage)); }
      catch { /* Keep damaged bytes untouched; the recovery catalog exposes them. */ }
    }
  }
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
}
export function damagedDrafts(storage: Storage = sessionStorage) {
  const damaged: { storageKey: string; raw: string }[] = [];
  for (const storageKey of Object.keys(storage).filter(key => key.startsWith(prefix))) {
    try { readDraft(decodeURIComponent(storageKey.slice(prefix.length)), storage); }
    catch { damaged.push({ storageKey, raw: storage.getItem(storageKey) ?? '' }); }
  }
  return damaged;
}
export function discardDamagedDraft(storageKey: string, expectedRaw: string, storage: Storage = sessionStorage) {
  if (!storageKey.startsWith(prefix) || storage.getItem(storageKey) !== expectedRaw)
    throw new Error('草稿已变化，请重新检查后再处理。');
  removeStoredDraft(storage, storageKey);
  try { draftChanged(decodeURIComponent(storageKey.slice(prefix.length))); }
  catch { window.dispatchEvent(new Event('harness-drafts')); }
}
export function discardDraft(key: string, storage: Storage = sessionStorage) {
  removeStoredDraft(storage, storageKey(key));
  draftChanged(key);
}
export const branchDraftKey = (threadId: string, turnId: string, mode: DraftMode = 'native') =>
  executionDraftKey(`branch:${encodeURIComponent(JSON.stringify([threadId, turnId]))}`, mode);
export function branchDraftSource(key: string): { threadId: string; turnId: string } | undefined {
  if (!key.startsWith('branch:')) return;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(key.slice(7)));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((part) => typeof part === 'string' && part.length > 0 && part.length <= 256)
    )
      return { threadId: value[0], turnId: value[1] };
  } catch {
    /* Not a recognized branch draft. */
  }
}
