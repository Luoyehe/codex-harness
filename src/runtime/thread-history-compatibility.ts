import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeRpc, NativeConfig } from './native.js';
import { nativeCommand } from './native-launch.js';
import { DeliveryError, jsonBytes, object, string, type JsonObject } from './types.js';

export type ReasoningCompatibility = 'foreign' | 'plaintext';

/** The helper runs as the actual native identity, never as the supervisor. */
export async function historyHelper(config: NativeConfig, request: JsonObject, mutating = false,
  beforeWrite?: () => void): Promise<JsonObject> {
  const command = config.launcher ? nativeCommand(config, 'thread-history') : (() => {
    if (!config.dev) throw new DeliveryError('history_compatibility_unavailable', '历史兼容检查需要原生身份启动器。');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = [path.resolve(here, '../..'), path.resolve(here, '../../..')].find(root => existsSync(path.join(root, 'deploy', 'thread_history.py')));
    if (!root) throw new DeliveryError('history_compatibility_unavailable', '找不到历史兼容检查工具。');
    return { bin: config.env.HARNESS_DEV_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
      args: ['-B', '-m', 'deploy.thread_history', '--home', config.home], cwd: root, env: config.env };
  })();
    const body = jsonBytes(request, 8192);
    return new Promise((resolve, reject) => {
      // Do not dispatch a helper after the operation's caller/epoch was revoked.
      try { if (mutating) beforeWrite?.(); } catch (error) { reject(error); return; }
      const child = execFile(command.bin, command.args, { cwd: command.cwd, env: command.env, windowsHide: true,
        timeout: mutating ? 60000 : 15000, maxBuffer: request.action === 'copy-inspect' ? 2 * 1024 * 1024 + 8192 : 8192, encoding: 'utf8' }, (error, stdout) => {
        try {
          const result = object(JSON.parse(stdout));
          if (error || result.error !== undefined) {
            const fault = object(result.error);
            if (typeof fault.code === 'string' && /^thread_history_[a-z_]+$/.test(fault.code) && fault.delivery === 'not_sent')
              throw new DeliveryError(fault.code, string(fault.message, 'history error', 2048));
            throw new Error('Unconfirmed helper result');
          }
          resolve(result);
        } catch (failure) {
          reject(failure instanceof DeliveryError ? failure : new DeliveryError('history_compatibility_unconfirmed',
            mutating ? '历史兼容转换尚未确认；本次消息未发送，请检查原操作状态。' : '无法完成历史兼容检查；本次消息未发送。', mutating ? 'unknown' : 'not_sent', { inputSent: false }));
        }
      });
      child.stdin?.on('error', () => {}); child.stdin?.end(body);
    });
}

/** Inspection only; conversion writes belong to the verified recovery-copy flow. */
export async function historyCompatibility(config: NativeConfig, thread: JsonObject, mode: ReasoningCompatibility): Promise<boolean | undefined> {
  if (thread.ephemeral === true || thread.path == null) return false;
  const input: JsonObject = { action: 'inspect', threadId: string(thread.id, 'threadId'), path: string(thread.path, 'rollout path'), mode };
  const inspected = await historyHelper(config, input);
  if (typeof inspected.needsRepair !== 'boolean' || typeof inspected.hasHistoryBase !== 'boolean' || typeof inspected.hasOpaqueCompaction !== 'boolean' ||
      inspected.inspectionUnsupported !== true && !inspected.expected || typeof inspected.changedItems !== 'number')
    throw new DeliveryError('history_compatibility_unconfirmed', '历史兼容检查返回无效结果。');
  if (mode === 'foreign' && (inspected.hasHistoryBase || inspected.hasOpaqueCompaction) ||
      mode === 'plaintext' && inspected.hasHistoryBase && (inspected.needsRepair || inspected.hasInheritedPlaintext === true))
    throw new DeliveryError('history_conversion_unsupported', '此会话包含继承的历史或供应商加密压缩上下文，暂不能安全转换；请继续使用原供应商。');
  if (inspected.inspectionUnsupported === true) {
    if (mode === 'foreign') throw new DeliveryError('history_conversion_unsupported', '此历史格式暂不能安全转换；请继续使用原供应商。');
    // Preserve ordinary native loading, but do not mint a compatibility proof.
    // A native append may materialize compressed history for the next check.
    return undefined;
  }
  return inspected.needsRepair === true;
}

/** Install before unsubscribe: its positive response is not a writer-close proof. */
export function awaitThreadClosed(native: NativeRpc, threadId: string, timeoutMs = 15000): { wait: Promise<void>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  let finish!: (error?: Error) => void;
  const notification = (message: JsonObject): void => {
    if (message.method === 'thread/closed' && object(message.params).threadId === threadId) finish();
  };
  const fatal = (): void => finish(new DeliveryError('runtime_lost', '原生运行时已断开，未转换历史。', 'unknown'));
  const cleanup = (): void => { if (timer) clearTimeout(timer); native.off('notification', notification); native.off('fatal', fatal); };
  const wait = new Promise<void>((resolve, reject) => {
    finish = error => { cleanup(); if (error) reject(error); else resolve(); };
    native.on('notification', notification); native.on('fatal', fatal);
    timer = setTimeout(() => finish(new DeliveryError('history_writer_busy', '会话尚未确认卸载，未转换历史。', 'unknown', { inputSent: false })), timeoutMs);
  });
  // A failed unsubscribe can finish before its waiter is consumed.
  void wait.catch(() => {});
  return { wait, cancel: () => finish() };
}
