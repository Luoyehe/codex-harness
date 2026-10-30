import { object } from './types';

export type ExecutionIdentity = { mode: 'native' | 'root'; effectiveUid: number };
export type ExecutionMode = ExecutionIdentity & { revision: string; requiresRestart: true; rootAllowed: boolean };

export function executionIdentity(value: unknown): ExecutionIdentity | undefined {
  const data = object(value);
  if (!Number.isSafeInteger(data.effectiveUid) || (data.effectiveUid as number) < 0) return;
  if (data.mode !== 'native' && data.mode !== 'root') return;
  if ((data.mode === 'root') !== (data.effectiveUid === 0)) return;
  return { mode: data.mode, effectiveUid: data.effectiveUid as number };
}

export function executionMode(value: unknown): ExecutionMode | undefined {
  const data = object(value), identity = executionIdentity(value);
  if (!identity || typeof data.revision !== 'string' || !/^[a-f0-9]{64}$/.test(data.revision) || data.requiresRestart !== true || typeof data.rootAllowed !== 'boolean') return;
  if (identity.mode === 'root' && !data.rootAllowed) return;
  return { ...identity, revision: data.revision, requiresRestart: true, rootAllowed: data.rootAllowed };
}
