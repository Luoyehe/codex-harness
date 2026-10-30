export type { Project as NativeProject } from '../../protocol/ts/v2/Project';
export type { ThreadSection } from '../../protocol/ts/v2/ThreadSection';
export type { ThreadAttachment } from '../../protocol/ts/v2/ThreadAttachment';
const windowsRoot = (path: string) => /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\/]+[\\/]+[^\\/]+/.test(path);
export const normalizedRoot = (path: string) => {
  const windows = windowsRoot(path), normalized = windows ? path.replaceAll('\\', '/') : path;
  // POSIX backslashes are filename characters, and a slash-only root is never empty.
  const trimmed = normalized.replace(/\/+$/, '') || (normalized.startsWith('/') ? '/' : '');
  if (!windows) return trimmed;
  return (/^[a-z]:\/+$/i.test(normalized) ? normalized.slice(0, 2) + '/' : trimmed).toLowerCase();
};
export function sameRoot(a: string, b: string) {
  return Boolean(a && b) && windowsRoot(a) === windowsRoot(b) && normalizedRoot(a) === normalizedRoot(b);
}
