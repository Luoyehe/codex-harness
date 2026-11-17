import { expect, test, vi } from 'vitest';
import { captureProcesses, expectProcessesStopped, processIdentity } from './process-identity.js';

test.runIf(process.platform === 'win32' || process.platform === 'linux')('a recycled numeric PID differs from the captured original identity without sending a signal', async () => {
  const signal = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('Identity checks must never signal a process'); });
  try {
    const current = await captureProcesses([process.pid]);
    await expect(expectProcessesStopped(current)).rejects.toThrow();
    // Model reuse using a different captured birth identity at the same live
    // numeric PID. We do not claim the kernel actually reused this PID here.
    await expect(expectProcessesStopped([{ pid: process.pid, identity: current[0]!.identity + '-predecessor' }])).resolves.toBeUndefined();
    expect(await processIdentity(process.pid)).toBe(current[0]!.identity); expect(signal).not.toHaveBeenCalled();
  } finally { signal.mockRestore(); }
});

test('invalid process identifiers cannot reach a platform lookup', async () => {
  for (const pid of [0, -1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) await expect(processIdentity(pid)).rejects.toThrow('Invalid fixture PID');
});
