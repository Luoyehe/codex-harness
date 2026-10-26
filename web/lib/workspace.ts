import { object } from './types';
export const FILE_LIMIT = 512 * 1024;
export type WorkspaceEntry = {
  name: string;
  kind: 'file' | 'directory' | 'unsupported';
  bytes: number;
  accessible: boolean;
};
export type DirectoryListing = { path: string; entries: WorkspaceEntry[]; truncated: boolean };
export type FileSnapshot = {
  path: string;
  kind: 'file';
  bytes: number;
  revision?: string;
  editable?: boolean;
  downloadable?: boolean;
  binary?: boolean;
  text?: string;
  reason?: string;
};
export type DirectorySnapshot = { path: string; kind: 'directory'; revision: string };
export type WorkspaceSnapshot = FileSnapshot | DirectorySnapshot;
export type GitEntry = { index: string; worktree: string; path: string; originalPath?: string };
export type GitRef = { name: string; objectId: string; symbolicTarget: string | null };
export const byteLength = (text: string) => new TextEncoder().encode(text).length;
export function workspacePath(path: string, allowRoot = false) {
  if (
    typeof path !== 'string' ||
    (!allowRoot && !path) ||
    byteLength(path) > 4096 ||
    path.startsWith('/') ||
    /[\\\x00-\x1f\x7f]/.test(path) ||
    (path &&
      path
        .split('/')
        .some(
          (part) =>
            !part ||
            ['.', '..', '.git', '.harness-workspace'].includes(part) ||
            byteLength(part) > 255,
        ))
  )
    throw new Error('请输入项目内的相对路径；不支持绝对路径、..、反斜杠或受保护目录。');
  return path;
}
export const joinPath = (directory: string, name: string) =>
  workspacePath(directory ? `${directory}/${name}` : name);
export const parentPath = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export function validRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
export function checkedSnapshot(value: unknown, path: string): WorkspaceSnapshot {
  const snapshot = object(value);
  if (snapshot.path !== path || !['file', 'directory'].includes(String(snapshot.kind)))
    throw new Error('文件响应与当前路径不匹配。');
  if (snapshot.kind === 'directory') {
    if (!validRevision(snapshot.revision)) throw new Error('目录版本无效。');
    return snapshot as DirectorySnapshot;
  }
  if (
    !Number.isSafeInteger(snapshot.bytes) ||
    Number(snapshot.bytes) < 0 ||
    (snapshot.revision !== undefined && !validRevision(snapshot.revision))
  )
    throw new Error('文件元数据无效。');
  if (
    snapshot.text !== undefined &&
    (typeof snapshot.text !== 'string' ||
      byteLength(snapshot.text) > FILE_LIMIT ||
      snapshot.text.includes('\0') ||
      !validRevision(snapshot.revision) ||
      snapshot.editable !== true ||
      snapshot.binary !== false)
  )
    throw new Error('文本预览超出范围或格式无效。');
  return snapshot as FileSnapshot;
}
export function checkedDirectory(value: unknown, path: string): DirectoryListing {
  const result = object(value);
  if (
    result.path !== path ||
    !Array.isArray(result.entries) ||
    result.entries.length > 1000 ||
    typeof result.truncated !== 'boolean'
  )
    throw new Error('目录响应无效或超过显示上限。');
  const names = new Set<string>();
  for (const item of result.entries) {
    const entry = object(item);
    if (
      typeof entry.name !== 'string' ||
      names.has(entry.name) ||
      !['file', 'directory', 'unsupported'].includes(String(entry.kind)) ||
      typeof entry.accessible !== 'boolean' ||
      !Number.isSafeInteger(entry.bytes) ||
      Number(entry.bytes) < 0
    )
      throw new Error('目录条目无效。');
    names.add(entry.name);
  }
  return result as DirectoryListing;
}
export function fileTextError(text: string) {
  return text.includes('\0')
    ? '文本包含 NUL，不能作为普通文本保存。'
    : byteLength(text) > FILE_LIMIT
      ? '文本超过 512 KiB，保存前请缩小内容。'
      : '';
}
export function gitStatusLabel(entry: GitEntry) {
  const labels: Record<string, string> = {
    M: '修改',
    A: '新增',
    D: '删除',
    R: '重命名',
    C: '复制',
    U: '冲突',
    '?': '未跟踪',
    '!': '忽略',
    T: '类型变化',
  };
  return entry.index === '?' && entry.worktree === '?'
    ? '未跟踪'
    : [
        entry.index !== ' ' ? `暂存区：${labels[entry.index] ?? entry.index}` : '',
        entry.worktree !== ' ' ? `工作区：${labels[entry.worktree] ?? entry.worktree}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
}
