import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { lstat, open } from "node:fs/promises";
import { TextDecoder } from "node:util";

const CHUNK_BYTES = 64 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function regularIdentity(info: Stats, maxBytes: number): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size >= 0 && info.size <= maxBytes;
}

function sameIdentity(one: Stats, two: Stats): boolean {
  return one.dev === two.dev && one.ino === two.ino;
}

function sameReadSnapshot(one: Stats, two: Stats, bytesRead: number): boolean {
  return sameIdentity(one, two)
    && one.size === two.size
    && bytesRead === two.size
    && one.mtimeMs === two.mtimeMs
    && one.ctimeMs === two.ctimeMs;
}

function guardedReadFlags(): number {
  return process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
}

/** Read a bounded regular file without following a leaf symlink or
 * trusting a check-then-open pathname. Reads are capped even if another
 * process grows the already-open inode. Atomic same-directory replacements
 * therefore yield either one complete inode or a conservative retryable
 * failure, never an unbounded/special-file read. */
export function readBoundedRegularFileSync(
  file: string,
  maxBytes: number,
  beforeClose?: (fd: number) => void,
): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024) {
    throw new Error("invalid bounded file size");
  }
  const before = lstatSync(file);
  if (!regularIdentity(before, maxBytes)) throw new Error("metadata path is not a bounded singly-linked regular file");
  let fd: number | null = null;
  try {
    // O_NONBLOCK matters before fstat: a writable-directory race that swaps
    // the checked leaf for a FIFO must not be able to hang the gateway in
    // open(2). Regular files ignore this flag.
    fd = openSync(file, guardedReadFlags());
    const opened = fstatSync(fd);
    const current = lstatSync(file);
    if (!regularIdentity(opened, maxBytes) || !regularIdentity(current, maxBytes)
        || !sameIdentity(before, opened) || !sameIdentity(opened, current)) {
      throw new Error("metadata file identity changed while opening");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, remaining));
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
    }
    const afterRead = fstatSync(fd);
    if (total > maxBytes || !regularIdentity(afterRead, maxBytes) || !sameReadSnapshot(opened, afterRead, total)) {
      throw new Error("metadata file changed or exceeded its size limit while reading");
    }
    beforeClose?.(fd);
    const after = fstatSync(fd);
    const finalPath = lstatSync(file);
    if (!regularIdentity(after, maxBytes) || !regularIdentity(finalPath, maxBytes)
        || !sameIdentity(afterRead, after) || !sameIdentity(after, finalPath)) {
      throw new Error("metadata file changed or exceeded its size limit while reading");
    }
    return Buffer.concat(chunks, total);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Async counterpart for bounded history scans; uses the same no-follow,
 * nonblocking, identity and stable-snapshot contract without blocking the JS
 * event loop on ordinary file IO. */
export async function readBoundedRegularFile(file: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024) {
    throw new Error("invalid bounded file size");
  }
  const before = await lstat(file);
  if (!regularIdentity(before, maxBytes)) throw new Error("metadata path is not a bounded singly-linked regular file");
  const handle = await open(file, guardedReadFlags());
  try {
    const opened = await handle.stat();
    const current = await lstat(file);
    if (!regularIdentity(opened, maxBytes) || !regularIdentity(current, maxBytes)
        || !sameIdentity(before, opened) || !sameIdentity(opened, current)) {
      throw new Error("metadata file identity changed while opening");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    const after = await handle.stat();
    const finalPath = await lstat(file);
    if (total > maxBytes || !regularIdentity(after, maxBytes) || !regularIdentity(finalPath, maxBytes)
        || !sameReadSnapshot(opened, after, total) || !sameIdentity(after, finalPath)) {
      throw new Error("metadata file changed or exceeded its size limit while reading");
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export async function readBoundedRegularTextFile(file: string, maxBytes: number): Promise<string> {
  return UTF8.decode(await readBoundedRegularFile(file, maxBytes));
}

export function readBoundedRegularTextFileSync(
  file: string,
  maxBytes: number,
  beforeClose?: (fd: number) => void,
): string {
  return UTF8.decode(readBoundedRegularFileSync(file, maxBytes, beforeClose));
}
