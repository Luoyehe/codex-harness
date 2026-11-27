import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function workerSocketPath(value: string, development: boolean): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || !path.basename(value) || value.includes('\0')) {
    throw new Error('Worker requires an absolute normalized Unix socket path');
  }
  let socket = value;
  if (development) {
    const uid = process.geteuid!();
    const directory = realpathSync(path.dirname(value));
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o777) !== 0o700) {
      throw new Error('Development worker socket requires an owner-only directory (0700)');
    }
    // A private directory can still be replaced through a writable ancestor.
    // A sticky temporary root protects entries owned by this process or root.
    for (let current = path.dirname(directory); ; current = path.dirname(current)) {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) ||
          ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) {
        throw new Error('Development worker socket has an unsafe ancestor');
      }
      if (current === path.dirname(current)) break;
    }
    socket = path.join(directory, path.basename(value));
    const existing = lstatSync(socket, { throwIfNoEntry: false });
    if (existing && (!existing.isSocket() || existing.uid !== uid)) throw new Error('Refusing to use unsafe worker socket');
  }
  if (Buffer.byteLength(socket) > (process.platform === 'darwin' ? 103 : 107)) {
    throw new Error('Worker socket path is too long');
  }
  return socket;
}
