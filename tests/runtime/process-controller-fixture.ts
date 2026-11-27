import { vi } from 'vitest';
import type { linuxProcessJob } from '../../src/runtime/linux-process.js';

type ControllerArgs = Parameters<typeof linuxProcessJob>;
export function processControllerFixture(write: ControllerArgs[3], output: ControllerArgs[4]) {
  let finish!: (code: number) => void, fail!: (error: Error) => void;
  const exited = new Promise<number>((resolve, reject) => { finish = resolve; fail = reject; });
  void exited.catch(() => {});
  return {
    command: ['fixture-controller'], env: {}, started: Promise.resolve(42), exited, finish,
    fail: () => fail(new Error('Missing independent cleanup proof')), signal: vi.fn(async () => {}), dispose: vi.fn(),
    feed: (bytes: Buffer) => output('stdout', bytes.toString('base64'), false), endNative() {}, drainTimedOut: false,
    control: async (_type: string, data: unknown, beforeWrite: () => void) => write(Buffer.from(JSON.stringify(data)).toString('base64'), beforeWrite),
    output,
  };
}
