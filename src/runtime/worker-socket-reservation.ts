import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';

// flock is associated with the shared open file description. The short-lived
// helper applies it to Node's descriptor; the kernel releases it on worker exit.
const lockDescriptor = `import fcntl, sys
try:
    fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(75)`;

export async function reserveWorkerSocket(socketPath: string): Promise<() => void> {
  // Keep a stable lock inode across restarts. Removing it at shutdown would
  // allow simultaneous holders of the old and new inodes.
  const fd = openSync(socketPath + '.lock', constants.O_CREAT | constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const lock = fstatSync(fd);
    if (!lock.isFile() || lock.nlink !== 1 || lock.uid !== process.geteuid!() || (lock.mode & 0o077) !== 0) {
      throw new Error('Refusing to use unsafe worker socket lock');
    }
    const claim = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', lockDescriptor], {
      env: {}, stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 3000,
    });
    if (claim.status === 75) throw new Error('Worker socket is active or starting');
    if (claim.status !== 0 || claim.error) throw new Error('Could not lock worker socket');

    // Also respect a live listener started without this reservation.
    const existing = lstatSync(socketPath, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isSocket() || existing.uid !== process.geteuid!()) throw new Error('Refusing to replace worker socket');
      const active = await new Promise<boolean>(resolve => {
        const probe = createConnection(socketPath);
        probe.once('connect', () => { probe.destroy(); resolve(true); });
        probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code !== 'ECONNREFUSED'));
        probe.setTimeout(1000, () => { probe.destroy(); resolve(true); });
      });
      if (active) throw new Error('Worker socket is active or unavailable');
      const current = lstatSync(socketPath, { throwIfNoEntry: false });
      if (current) {
        if (current.dev !== existing.dev || current.ino !== existing.ino) throw new Error('Worker socket changed during startup');
        unlinkSync(socketPath);
      }
    }
    return () => closeSync(fd);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
