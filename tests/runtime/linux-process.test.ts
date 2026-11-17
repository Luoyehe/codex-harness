import { expect, test } from 'vitest';
import { connect } from 'node:net';
import { once } from 'node:events';
import { linuxProcessJob } from '../../src/runtime/linux-process.js';

test('unauthenticated Linux control connections cannot consume the legitimate controller handshake', async () => {
  // This exercises the real loopback handshake on every host; Linux descendant
  // cleanup is separately exercised by process-native with the actual controller.
  const job = await linuxProcessJob(['/fixture/command'], '/fixture');
  const spec = JSON.parse(job.env.HARNESS_LINUX_PROCESS_COMMAND!) as { port: number; token: string };
  const wrong = connect(spec.port, '127.0.0.1'), idle = connect(spec.port, '127.0.0.1'); wrong.on('error', () => {}); idle.on('error', () => {});
  try {
    await once(wrong, 'connect'); const rejected = once(wrong, 'close'); wrong.write(JSON.stringify({ token: 'invalid-fixture', type: 'started', pid: 1 }) + '\n'); await rejected;
    const real = connect(spec.port, '127.0.0.1'); real.on('error', () => {});
    try {
      await once(real, 'connect'); real.write(JSON.stringify({ token: spec.token, type: 'started', pid: 123 }) + '\n');
      expect(await job.started).toBe(123); real.write(JSON.stringify({ token: spec.token, type: 'exited', exitCode: 0 }) + '\n'); expect(await job.exited).toBe(0);
    } finally { real.destroy(); }
  } finally { wrong.destroy(); idle.destroy(); job.dispose(); }
});
