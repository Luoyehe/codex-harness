import { expect } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { NativeRpc } from '../../src/runtime/native.js';

/** Assert the actual owned child reached close, never query its recycled PID. */
export function expectNativeClosed(native: NativeRpc): void {
  expect(native['exited']).toBe(true);
  expect(native['child'].exitCode !== null || native['child'].signalCode !== null).toBe(true);
  expect(native['child'].stdout.destroyed).toBe(true);
}

/** Capture before stopping. A missing process and a reused PID are both different identities. */
export async function processIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid fixture PID');
  if (process.platform === 'linux') {
    try {
      const text = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (fields.length < 20 || !/^\d+$/.test(fields[19]!)) throw new Error('Invalid fixture process stat');
      return fields[0] === 'Z' ? null : fields[19]!;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return null; throw error; }
  }
  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) => execFile('/bin/ps', ['-p', String(pid), '-o', 'state=,lstart=,comm='], { env: { LC_ALL: 'C', PATH: '/bin:/usr/bin' } }, (error, stdout) => {
      if (error && error.code === 1 && !stdout.trim()) { resolve(null); return; }
      if (error) { reject(error); return; }
      const row = stdout.trim(); resolve(row.startsWith('Z') ? null : row.slice(row.indexOf(' ') + 1).trim());
    }));
  }
  throw new Error('Unsupported process identity platform');
}

export async function captureProcesses(pids: number[]): Promise<{ pid: number; identity: string }[]> {
  return Promise.all(pids.map(async pid => { const identity = await processIdentity(pid); expect(identity).not.toBeNull(); return { pid, identity: identity! }; }));
}
export async function expectProcessesStopped(processes: { pid: number; identity: string }[]): Promise<void> {
  for (const { pid, identity } of processes) expect(await processIdentity(pid)).not.toBe(identity);
}
