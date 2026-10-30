import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, parse } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { JsonObject, JsonValue } from '../core/contracts.js';
import { HarnessError } from '../core/errors.js';
import { object, safeJson } from '../core/validation.js';

export interface ManagerPort { call(method: string, params: JsonObject, operationId?: string, beforeWrite?: () => void): Promise<JsonValue> }
interface Pending {
  payload: string | null; bytes: number; beforeWrite: (() => void) | undefined; deadline: number;
  timer?: NodeJS.Timeout; child?: ChildProcessByStdio<Writable, Readable, null>; wrote: boolean; settled: boolean; released: boolean;
  resolve(value: JsonValue): void; reject(error: unknown): void;
}
const MAX_PENDING = 32, MAX_RETAINED_BYTES = 8 * 1024 * 1024, DEADLINE_MS = 120000;
export class ManagerClient implements ManagerPort {
  // Every root RPC takes the same nonblocking instance lock, including reads.
  // Serialize our own helpers without retrying a dispatched management request.
  private queue: Pending[] = [];
  private active: Pending | undefined;
  private retainedBytes = 0;
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
    const bytes = Buffer.byteLength(payload);
    if (bytes > 1024 * 1024) return Promise.reject(new HarnessError('capacity', '管理参数过大。'));
    if (this.queue.length + Number(!!this.active) >= MAX_PENDING || this.retainedBytes + bytes > MAX_RETAINED_BYTES)
      return Promise.reject(new HarnessError('capacity', '管理请求正在等待处理，请稍后重试。'));
    return new Promise((resolve, reject) => {
      const entry: Pending = { payload, bytes, beforeWrite, deadline: performance.now() + DEADLINE_MS, wrote: false, settled: false, released: false, resolve, reject };
      this.retainedBytes += bytes; this.queue.push(entry);
      entry.timer = setTimeout(() => {
        this.settle(entry, new HarnessError('manager_timeout', entry.wrote
          ? '管理操作未得到完整确认，请查询操作记录与服务状态。' : '管理请求等待超时，本次请求尚未发送。', entry.wrote ? 'unknown' : 'not_sent'));
        if (this.active === entry) this.terminate(entry);
        else { this.queue = this.queue.filter(value => value !== entry); this.release(entry); }
      }, DEADLINE_MS);
      this.pump();
    });
  }
  private settle(entry: Pending, error?: unknown, value?: JsonValue): void {
    if (entry.settled) return;
    entry.settled = true; clearTimeout(entry.timer); entry.payload = null; entry.beforeWrite = undefined;
    if (error) entry.reject(error); else entry.resolve(value ?? null);
  }
  private terminate(entry: Pending): void {
    try { entry.child?.kill('SIGTERM'); } catch { /* Only close can release the live helper slot. */ }
  }
  private release(entry: Pending): void {
    if (entry.released) return;
    entry.released = true; this.retainedBytes -= entry.bytes;
    if (this.active === entry) this.active = undefined;
    this.pump();
  }
  private pump(): void {
    if (this.active) return;
    const entry = this.queue.shift(); if (!entry) return;
    this.active = entry;
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      child = spawn('/usr/bin/sudo', ['-n', this.command!, 'rpc'], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
      });
      entry.child = child;
    } catch {
      this.settle(entry, new HarnessError('manager_unavailable', '管理程序尚未启动，本次请求未发送。'));
      this.release(entry); return;
    }
    let bytes = 0; const chunks: Buffer[] = [];
    const fail = (code: string) => {
      this.settle(entry, new HarnessError(code, '管理操作未得到完整确认，请查询操作记录与服务状态。', entry.wrote ? 'unknown' : 'not_sent'));
      this.terminate(entry);
    };
    child.on('error', () => fail('manager_unavailable'));
    child.stdin.on('error', () => fail('manager_input'));
    child.stdout.on('error', () => fail('manager_protocol'));
    child.stdout.on('data', (chunk: Buffer) => {
        if (entry.settled) return;
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) fail('manager_capacity'); else chunks.push(chunk);
    });
    child.on('close', () => {
      try {
        if (!entry.settled) {
          const result = safeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), 2 * 1024 * 1024); object(result);
          if (result.ok === true && Object.hasOwn(result, 'result')) this.settle(entry, undefined, result.result);
          else {
            object(result.error);
            if (typeof result.error.code !== 'string' || typeof result.error.message !== 'string') throw new Error('Invalid management error');
            this.settle(entry, new HarnessError(result.error.code.slice(0, 128), result.error.message.slice(0, 4096), result.error.delivery === 'not_sent' ? 'not_sent' : 'unknown'));
          }
        }
      } catch { this.settle(entry, new HarnessError('manager_protocol', '管理操作未得到完整确认，请查询操作记录与服务状态。', entry.wrote ? 'unknown' : 'not_sent')); }
      finally { this.release(entry); }
    });
    child.once('spawn', () => {
      if (entry.settled) { this.terminate(entry); return; }
      if (performance.now() >= entry.deadline) {
        this.settle(entry, new HarnessError('manager_timeout', '管理请求等待超时，本次请求尚未发送。'));
        this.terminate(entry); return;
      }
      try { entry.beforeWrite?.(); }
      catch (error) { this.settle(entry, error); this.terminate(entry); return; }
      const payload = entry.payload; entry.payload = null; entry.beforeWrite = undefined; entry.wrote = true;
      try { child.stdin.end(payload + '\n'); } catch { fail('manager_input'); }
    });
  }
}
