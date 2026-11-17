import { uuid } from './ids';
import { byteLength, fileTextError, validRevision, workspacePath } from './workspace';
export type FileDraft = {
  projectId: string;
  path: string;
  baseRevision: string | null;
  baseText: string;
  text: string;
  revision: string;
  updatedAt: number;
  pending?: { operationId: string; submittedRevision: string; submittedText: string };
};
const prefix = 'harness.file-draft.v1.';
// Always read current storage bytes; cache only UTF-8 lengths of unchanged
// values, so another writer cannot bypass the combined budget.
const sizeCache = new WeakMap<Storage, Map<string, { raw: string; bytes: number }>>();
function storedBytes(storage: Storage, key: string, raw: string) {
  let cache = sizeCache.get(storage);
  if (!cache) { cache = new Map(); sizeCache.set(storage, cache); }
  const previous = cache.get(key);
  if (previous?.raw === raw) return previous.bytes;
  const bytes = byteLength(raw);
  if (cache.size >= 10) cache.delete(cache.keys().next().value!);
  cache.set(key, { raw, bytes });
  return bytes;
}
export const fileDraftKey = (projectId: string, path: string) => JSON.stringify([projectId, path]);
const key = (projectId: string, path: string) =>
  prefix + encodeURIComponent(fileDraftKey(projectId, path));
const valid = (value: unknown): value is FileDraft => {
  if (!value || typeof value !== 'object') return false;
  const draft = value as FileDraft;
  try {
    workspacePath(draft.path);
  } catch {
    return false;
  }
  return (
    typeof draft.projectId === 'string' &&
    Boolean(draft.projectId) &&
    (draft.baseRevision === null || validRevision(draft.baseRevision)) &&
    typeof draft.baseText === 'string' &&
    typeof draft.text === 'string' &&
    typeof draft.revision === 'string' &&
    Number.isFinite(draft.updatedAt) &&
    draft.baseText.length <= 524288 &&
    draft.text.length <= 524288 &&
    (!draft.pending ||
      (typeof draft.pending.operationId === 'string' &&
        typeof draft.pending.submittedRevision === 'string' &&
        typeof draft.pending.submittedText === 'string' &&
        draft.pending.submittedText.length <= 524288))
  );
};
export function readFileDraft(projectId: string, path: string, storage = sessionStorage) {
  const raw = storage.getItem(key(projectId, path));
  if (raw === null) return undefined;
  let draft: unknown;
  try { draft = JSON.parse(raw); }
  catch { throw new Error('文件草稿格式损坏。请到设置 → 本地草稿导出原始内容或仅移除此条损坏记录。'); }
  if (!valid(draft) || draft.projectId !== projectId || draft.path !== path)
    throw new Error('文件草稿已损坏，未自动覆盖。请到设置 → 本地草稿处理此条记录。');
  return draft;
}
export function persistFileDraft(draft: FileDraft, storage = sessionStorage) {
  if (!valid(draft)) throw new Error('文件草稿格式无效。');
  if (!draft.pending && draft.baseRevision !== null && draft.text === draft.baseText) {
    discardFileDraft(draft.projectId, draft.path, storage);
    return;
  }
  const target = key(draft.projectId, draft.path),
    value = JSON.stringify(draft);
  let bytes = byteLength(value),
    count = 1;
  for (let i = 0; i < storage.length; i++) {
    const other = storage.key(i);
    if (other?.startsWith(prefix) && other !== target) {
      count++;
      bytes += storedBytes(storage, other, storage.getItem(other) ?? '');
    }
  }
  if (count > 10 || bytes > 8 * 1024 * 1024)
    throw new Error('文件草稿达到 10 份或 8 MiB 上限，请先保存或放弃已有草稿。');
  storage.setItem(target, value);
  if (storage.getItem(target) !== value) throw new Error('浏览器未能保存文件草稿。');
}
export function discardFileDraft(projectId: string, path: string, storage = sessionStorage) {
  storage.removeItem(key(projectId, path));
}
export function listFileDrafts(storage = sessionStorage) {
  const drafts: FileDraft[] = [];
  for (let i = 0; i < storage.length; i++) {
    const entry = storage.key(i);
    if (!entry?.startsWith(prefix)) continue;
    try {
      const raw = storage.getItem(entry) ?? 'null';
      const value: unknown = JSON.parse(raw);
      if (!valid(value) || entry !== key(value.projectId, value.path)) continue;
      if (!value.pending && value.baseRevision !== null && value.text === value.baseText) {
        if (storage.getItem(entry) === raw) { storage.removeItem(entry); i--; }
        continue;
      }
      drafts.push(value);
    } catch { /* Damage is isolated and remains exportable in draft settings. */ }
    if (drafts.length > 10) throw new Error('文件草稿数量超过上限。');
  }
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
}
export function damagedFileDrafts(storage = sessionStorage) {
  const damaged: { storageKey: string; raw: string }[] = [];
  for (const storageKey of Object.keys(storage).filter(value => value.startsWith(prefix))) {
    const raw = storage.getItem(storageKey) ?? '';
    try {
      const value: unknown = JSON.parse(raw);
      if (!valid(value) || storageKey !== key(value.projectId, value.path)) throw new Error();
    } catch { damaged.push({ storageKey, raw }); }
  }
  return damaged;
}
export function discardDamagedFileDraft(storageKey: string, expectedRaw: string, storage = sessionStorage) {
  if (!storageKey.startsWith(prefix) || storage.getItem(storageKey) !== expectedRaw)
    throw new Error('文件草稿已变化，请重新检查后再处理。');
  storage.removeItem(storageKey);
  window.dispatchEvent(new Event('harness-drafts'));
}
export function newFileDraft(
  projectId: string,
  path: string,
  revision: string | null,
  text: string,
): FileDraft {
  return {
    projectId,
    path,
    baseRevision: revision,
    baseText: revision ? text : '',
    text,
    revision: uuid(),
    updatedAt: Date.now(),
  };
}
export function editFileDraft(draft: FileDraft, text: string): FileDraft {
  return { ...draft, text, revision: uuid(), updatedAt: Date.now() };
}
export function fileDraftProblem(draft: FileDraft) {
  return fileTextError(draft.text);
}
