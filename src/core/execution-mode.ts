import type { JsonObject, JsonValue } from './contracts.js';
import { HarnessError } from './errors.js';
import { object } from './validation.js';

/** The browser can choose a fixed execution mode, never grant host permission or select a UID. */
export function validateExecutionModeWrite(params: JsonObject): void {
  const fields = ['mode', 'expectedRevision', 'confirmRestart', 'confirmRoot'];
  if (Object.keys(params).length !== fields.length || Object.keys(params).some(key => !fields.includes(key)) ||
      !['native', 'root'].includes(String(params.mode)) || typeof params.mode !== 'string' ||
      typeof params.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(params.expectedRevision) ||
      params.confirmRestart !== true || params.confirmRoot !== (params.mode === 'root'))
    throw new HarnessError('invalid', '请读取当前执行权限，并明确确认所选模式及服务重启；服务器授权只能通过运维脚本修改。');
}

export function executionModeState(input: JsonValue): JsonObject {
  object(input);
  if ((input.mode !== 'native' && input.mode !== 'root') ||
      !Number.isSafeInteger(input.effectiveUid) || (input.effectiveUid as number) < 0 ||
      (input.mode === 'root') !== (input.effectiveUid === 0) ||
      typeof input.rootAllowed !== 'boolean' || input.mode === 'root' && !input.rootAllowed ||
      typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision) || input.requiresRestart !== true)
    throw new HarnessError('execution_mode_unconfirmed', '执行权限状态尚未确认，请重新读取服务状态。');
  return { mode: input.mode, effectiveUid: input.effectiveUid!, rootAllowed: input.rootAllowed,
    revision: input.revision, requiresRestart: true };
}
