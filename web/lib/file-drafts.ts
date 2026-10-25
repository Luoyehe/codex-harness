import { uuid } from './ids';
import { byteLength, fileTextError, validRevision, workspacePath } from './workspace';
export type FileDraft = { projectId: string; path: string; baseRevision: string | null; baseText: string; text: string; revision: string; updatedAt: number; pending?: { operationId: string; submittedRevision: string; submittedText: string } };
const prefix = 'harness.file-draft.v1.';
export const fileDraftKey = (projectId: string, path: string) => JSON.stringify([projectId, path]);
const key = (projectId: string, path: string) => prefix + encodeURIComponent(fileDraftKey(projectId, path));
const valid = (value: unknown): value is FileDraft => {
  if (!value || typeof value !== 'object') return false; const draft = value as FileDraft;
  try { workspacePath(draft.path); } catch { return false; }
  return typeof draft.projectId === 'string' && Boolean(draft.projectId) && (draft.baseRevision === null || validRevision(draft.baseRevision)) && typeof draft.baseText === 'string' && typeof draft.text === 'string' && typeof draft.revision === 'string' && Number.isFinite(draft.updatedAt) && draft.baseText.length <= 524288 && draft.text.length <= 524288 && (!draft.pending || typeof draft.pending.operationId === 'string' && typeof draft.pending.submittedRevision === 'string' && typeof draft.pending.submittedText === 'string' && draft.pending.submittedText.length <= 524288);
};
export function readFileDraft(projectId: string, path: string, storage = sessionStorage) {
  const raw = storage.getItem(key(projectId, path)); if (raw === null) return undefined;
  const draft: unknown = JSON.parse(raw); if (!valid(draft) || draft.projectId !== projectId || draft.path !== path) throw new Error('文件草稿已损坏，未自动覆盖。'); return draft;
}
export function persistFileDraft(draft: FileDraft, storage = sessionStorage) {
  if (!valid(draft)) throw new Error('文件草稿格式无效。');
  const target = key(draft.projectId, draft.path), value = JSON.stringify(draft); let bytes = byteLength(value), count = 1;
  for (let i = 0; i < storage.length; i++) { const other = storage.key(i); if (other?.startsWith(prefix) && other !== target) { count++; bytes += byteLength(storage.getItem(other) ?? ''); } }
  if (count > 10 || bytes > 8 * 1024 * 1024) throw new Error('文件草稿达到 10 份或 8 MiB 上限，请先保存或放弃已有草稿。');
  storage.setItem(target, value); if (storage.getItem(target) !== value) throw new Error('浏览器未能保存文件草稿。');
}
export function discardFileDraft(projectId: string, path: string, storage = sessionStorage) { storage.removeItem(key(projectId, path)); }
export function listFileDrafts(storage = sessionStorage) {
  const drafts: FileDraft[] = [];
  for (let i = 0; i < storage.length; i++) { const entry = storage.key(i); if (!entry?.startsWith(prefix)) continue; const value: unknown = JSON.parse(storage.getItem(entry) ?? 'null'); if (!valid(value) || entry !== key(value.projectId, value.path)) throw new Error('文件草稿目录损坏，未覆盖原记录。'); drafts.push(value); if (drafts.length > 10) throw new Error('文件草稿数量超过上限。'); }
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
}
export function newFileDraft(projectId: string, path: string, revision: string | null, text: string): FileDraft { return { projectId, path, baseRevision: revision, baseText: revision ? text : '', text, revision: uuid(), updatedAt: Date.now() }; }
export function editFileDraft(draft: FileDraft, text: string): FileDraft { return { ...draft, text, revision: uuid(), updatedAt: Date.now() }; }
export function fileDraftProblem(draft: FileDraft) { return fileTextError(draft.text); }
