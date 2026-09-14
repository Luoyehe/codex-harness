import {
  closeSync,
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
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", mode);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    // Native same-directory rename replaces the destination atomically. If the
    // platform refuses replacement, preserve the old file and fail closed: moving
    // it aside first would leave a crash window with no authoritative record.
    renameSync(temp, target);
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
  }
}
