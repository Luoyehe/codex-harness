import { object } from './types';
import { validRevision } from './workspace';
export type CommitState = { head: string | null; symbolicTarget: string | null; headRevision: string; indexRevision: string };
export function commitState(value: unknown): CommitState {
  const record = object(value), state = object(record.commitState);
  if (record.complete !== true || state.head !== null && (typeof state.head !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(state.head)) || !validRevision(state.headRevision) || !validRevision(state.indexRevision) || state.symbolicTarget !== null && typeof state.symbolicTarget !== 'string') throw new Error('Git HEAD 或索引版本尚未完整读取。');
  return state as CommitState;
}
export const indexVersions = (state: CommitState) => ({ expectedHead: state.head, expectedHeadRevision: state.headRevision, expectedIndexRevision: state.indexRevision });
