export type { Project as NativeProject } from '../../protocol/ts/v2/Project';
export type { ThreadSection } from '../../protocol/ts/v2/ThreadSection';
export type { ThreadAttachment } from '../../protocol/ts/v2/ThreadAttachment';
export const normalizedRoot = (path: string) => { const normalized = path.replaceAll('\\', '/').replace(/\/+$/, ''); return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized; };
export function sameRoot(a: string, b: string) { return normalizedRoot(a) === normalizedRoot(b); }
