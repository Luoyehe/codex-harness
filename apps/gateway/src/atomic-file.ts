import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  open as openAsync,
  rename as renameAsync,
  rm as rmAsync,
} from "node:fs/promises";
import path from "node:path";

/** Flush directory-entry changes where the host filesystem exposes a
 * fsync-able directory handle. Windows and a few filesystems reject opening or
 * syncing directories; the data file itself is still flushed before publish
 * and callers retain their fail-closed replacement semantics there. */
export function fsyncDirectorySync(dir: string): void {
  try {
    const dirFd = openSync(dir, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (error: any) {
    // Windows does not expose a portable fsync-able directory handle. On
    // Linux, only explicit "operation unsupported" results may degrade; I/O,
    // quota and permission failures are durability failures and must reach the
    // caller's fail-closed path.
    if (process.platform === "win32") return;
    if (["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) return;
    throw error;
  }
}

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
    fsyncDirectorySync(dir);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
}

/** Async counterpart used by request-path metadata stores. Keeping every
 * write, flush and rename off the JavaScript thread prevents a slow local or
 * network-backed CODEX_HOME from freezing unrelated WebSocket controls. */
export async function atomicWriteFile(target: string, data: string | Buffer, mode = 0o600): Promise<void> {
  const dir = path.dirname(target);
  const nonce = `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
  const temp = path.join(dir, `.${path.basename(target)}.${nonce}.tmp`);
  let handle: Awaited<ReturnType<typeof openAsync>> | null = null;
  try {
    handle = await openAsync(temp, "wx", mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameAsync(temp, target);
    try {
      const directory = await openAsync(dir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error: any) {
      if (process.platform !== "win32" && !["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) throw error;
    }
  } finally {
    if (handle !== null) {
      try { await handle.close(); } catch { /* already closed */ }
    }
    try { await rmAsync(temp, { force: true }); } catch { /* best effort */ }
  }
}
