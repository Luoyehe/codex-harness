import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, parse } from 'node:path';
import type { JsonObject, JsonValue } from '../core/contracts.js';
import { HarnessError } from '../core/errors.js';
import { object, safeJson } from '../core/validation.js';

export interface ManagerPort { call(method: string, params: JsonObject, operationId?: string, beforeWrite?: () => void): Promise<JsonValue> }
export class ManagerClient implements ManagerPort {
  constructor(readonly command: string | undefined) {
    if (!command) return;
    if (process.platform !== 'linux' || !isAbsolute(command)) throw new Error('Management requires an installed Linux helper');
    for (let current = command; ; current = dirname(current)) {
      const st = lstatSync(current);
      if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) !== 0 || current === command && !st.isFile())
        throw new Error('Management helper and its ancestors must be root owned and immutable to service users');
      if (current === parse(current).root) break;
    }
  }
  call(method: string, params: JsonObject, operationId?: string, beforeWrite?: () => void): Promise<JsonValue> {
    if (!this.command) return Promise.reject(new HarnessError('not_installed', '服务器管理仅在安装后的 Linux 服务中可用。'));
    const payload = JSON.stringify({ method, params, ...(operationId ? { operationId } : {}) });
    if (Buffer.byteLength(payload) > 1024 * 1024) return Promise.reject(new HarnessError('capacity', '管理参数过大。'));
    return new Promise((resolve, reject) => {
      let wrote = false; let settled = false; let bytes = 0; const chunks: Buffer[] = [];
      const child = spawn('/usr/bin/sudo', ['-n', this.command!, 'rpc'], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
      });
      const end = (error?: unknown, value?: JsonValue) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value ?? null);
      };
      const fail = (code: string) => end(new HarnessError(code, '管理操作未得到完整确认，请查询操作记录与服务状态。', wrote ? 'unknown' : 'not_sent'));
      const timer = setTimeout(() => { child.kill('SIGTERM'); fail('manager_timeout'); }, 120000);
      child.on('error', () => fail('manager_unavailable'));
      child.stdin.on('error', () => fail('manager_input'));
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { child.kill('SIGTERM'); fail('manager_capacity'); } else chunks.push(chunk);
      });
      child.on('close', () => {
        if (settled) return;
        try {
          const result = safeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), 2 * 1024 * 1024); object(result);
          if (result.ok === true && Object.hasOwn(result, 'result')) end(undefined, result.result);
          else {
            object(result.error);
            if (typeof result.error.code !== 'string' || typeof result.error.message !== 'string') throw new Error('Invalid management error');
            end(new HarnessError(result.error.code.slice(0, 128), result.error.message.slice(0, 4096), result.error.delivery === 'not_sent' ? 'not_sent' : 'unknown'));
          }
        } catch { fail('manager_protocol'); }
      });
      child.once('spawn', () => {
        try { beforeWrite?.(); wrote = true; child.stdin.end(payload + '\n'); }
        catch (error) { child.kill('SIGTERM'); end(error); }
      });
    });
  }
}
