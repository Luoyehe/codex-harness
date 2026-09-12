import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * Crash-resistant same-directory replacement for small gateway metadata.
 * The temporary file is flushed before rename and the parent directory is
 * flushed afterwards where the platform supports directory handles.
 */
export function atomicWriteFileSync(target: string, data: string | Buffer, mode = 0o600): void {
  const dir = path.dirname(target);
  const nonce = `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
  const temp = path.join(dir, `.${path.basename(target)}.${nonce}.tmp`);
  const backup = path.join(dir, `.${path.basename(target)}.${nonce}.bak`);
  let fd: number | null = null;
  let movedOld = false;
  try {
    fd = openSync(temp, "wx", mode);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    try {
      renameSync(temp, target);
    } catch (err: any) {
      // POSIX rename replaces atomically. Some Windows filesystems reject an
      // existing destination; move it aside so replacement is recoverable.
      if (!existsSync(target) || !["EEXIST", "EPERM", "EACCES"].includes(err?.code)) throw err;
      renameSync(target, backup);
      movedOld = true;
      try {
        renameSync(temp, target);
      } catch (replaceErr) {
        renameSync(backup, target);
        movedOld = false;
        throw replaceErr;
      }
      rmSync(backup, { force: true });
      movedOld = false;
    }
    // Persist the directory entry on POSIX. Windows does not allow opening a
    // directory this way, so failure is intentionally non-fatal there.
    try {
      const dirFd = openSync(dir, "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch { /* unsupported platform/filesystem */ }
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    if (movedOld && !existsSync(target)) {
      try { renameSync(backup, target); } catch { /* caller receives original failure */ }
    }
    if (!movedOld) {
      try { rmSync(backup, { force: true }); } catch { /* best effort */ }
    }
  }
}
