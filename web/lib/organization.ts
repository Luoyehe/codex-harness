export type { Project as NativeProject } from '../../protocol/ts/v2/Project';
export type { ThreadSection } from '../../protocol/ts/v2/ThreadSection';
export type { ThreadAttachment } from '../../protocol/ts/v2/ThreadAttachment';
export const normalizedRoot = (path: string) => path.replace(/\/+$/, '') || (path.startsWith('/') ? '/' : '');
export function sameRoot(a: string, b: string) {
  return Boolean(a && b) && normalizedRoot(a) === normalizedRoot(b);
}
