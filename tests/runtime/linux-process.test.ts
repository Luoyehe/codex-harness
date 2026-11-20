import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { linuxProcessJob } from '../../src/runtime/linux-process.js';

test.skipIf(process.platform !== 'linux')('concurrent controllers use inherited pipes, keep streams private and clean up on input closure', async () => {
  const start = (message: string) => {
    const output: string[] = [];
    const pipe = linuxProcessJob(['/usr/bin/python3', '-u', '-c', 'import sys,time; print(sys.argv[1]); time.sleep(30)', message],
      '/tmp', { tty: false, stdin: false, cap: 500 },
      (bytes, guard) => { guard?.(); return new Promise((resolve, reject) => child.stdin.write(Buffer.from(bytes, 'base64'), error => error ? reject(error) : resolve())); },
      (_stream, bytes) => output.push(Buffer.from(bytes, 'base64').toString()));
    const runAs = process.env.HARNESS_TEST_PIPE_UID === '1000' ? ['/usr/bin/setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', '--', ...pipe.command] : pipe.command;
    const child = spawn(runAs[0]!, runAs.slice(1), { env: { ...process.env, ...pipe.env }, stdio: 'pipe' });
    child.stdout.on('data', chunk => pipe.feed(chunk)); child.stderr.resume(); child.on('close', () => pipe.endNative());
    const closed = new Promise<number | null>(resolve => child.once('close', resolve));
    return { child, pipe, output, closed };
  };
  const late = start('discard-before-handshake');
  try {
    late.child.stdin.end();
    expect(await late.closed).toBe(0);
    expect(await late.pipe.exited).toBeLessThan(0);
  } finally { late.pipe.dispose(); }
  const a = start('first-controller'), b = start('second-controller');
  try {
    const [pidA, pidB] = await Promise.all([a.pipe.started, b.pipe.started]); expect(pidA).not.toBe(pidB);
    expect(Object.keys(JSON.parse(a.pipe.env.HARNESS_LINUX_PROCESS_COMMAND!)).sort()).toEqual(['cap', 'command', 'cwd', 'stdin', 'tty']);
    await expect.poll(() => a.output.join('')).toBe('first-controller\n');
    await expect.poll(() => b.output.join('')).toBe('second-controller\n');
    a.child.stdin.end(); await b.pipe.signal();
    expect(await Promise.all([a.closed, b.closed])).toEqual([0, 0]);
    expect(await a.pipe.exited).toBeLessThan(0); expect(await b.pipe.exited).toBeLessThan(0);
  } finally { a.child.stdin.end(); b.child.stdin.end(); await Promise.all([a.closed, b.closed]); a.pipe.dispose(); b.pipe.dispose(); }
});
