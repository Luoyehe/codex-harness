import { spawn } from 'node:child_process';

// One Git process serves the complete object inventory. Content is consumed in
// bounded chunks; callers never need to buffer a large blob to scan its tail.
export class GitObjectReader {
  constructor(root) {
    this.child = spawn('git', ['cat-file', '--batch'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.closed = new Promise(resolve => { this.child.once('error', () => resolve(false)); this.child.once('close', code => resolve(code === 0)); });
    this.child.stdin.on('error', error => { this.inputError = error; });
    this.iterator = this.child.stdout[Symbol.asyncIterator]();
    this.pending = Buffer.alloc(0);
  }
  async chunk() {
    const value = await this.iterator.next();
    if (value.done) throw Error('Incomplete Git object stream');
    return Buffer.isBuffer(value.value) ? value.value : Buffer.from(value.value);
  }
  async bytes(length) {
    const parts = []; let count = 0;
    for await (const part of this.stream(length)) { parts.push(part); count += part.length; }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, count);
  }
  async *stream(length) {
    if (!Number.isSafeInteger(length) || length < 0) throw Error('Invalid Git object size');
    while (length) {
      if (!this.pending.length) this.pending = await this.chunk();
      const size = Math.min(this.pending.length, length, 65536);
      const value = this.pending.subarray(0, size); this.pending = this.pending.subarray(size); length -= size;
      yield value;
    }
  }
  async object(id, type) {
    if (this.inputError) throw this.inputError;
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(id) || !['blob', 'commit', 'tag', 'tree'].includes(type)) throw Error('Invalid Git object request');
    await new Promise((resolve, reject) => this.child.stdin.write(id + '\n', error => error ? reject(error) : resolve()));
    const header = [];
    while (header.length < 160) { const byte = (await this.bytes(1))[0]; if (byte === 10) break; header.push(byte); }
    const match = /^([a-f0-9]{40,64}) (blob|commit|tag|tree) ([0-9]+)$/.exec(Buffer.from(header).toString('ascii'));
    if (!match || match[1] !== id || match[2] !== type || !Number.isSafeInteger(Number(match[3]))) throw Error('Mismatched Git object header');
    return this.stream(Number(match[3]));
  }
  async endObject() { if ((await this.bytes(1))[0] !== 10) throw Error('Invalid Git object terminator'); }
  async close() { this.child.stdin.end(); return await this.closed; }
  abort() { this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.kill(); }
}

export async function readTree(stream, hashBytes, onBytes) {
  const entries = []; let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    onBytes(chunk.length); pending = Buffer.concat([pending, chunk]);
    while (true) {
      const space = pending.indexOf(32), nul = pending.indexOf(0);
      if (space < 1 || nul < space || pending.length < nul + 1 + hashBytes) break;
      const mode = pending.subarray(0, space).toString('ascii'), name = pending.subarray(space + 1, nul).toString('latin1');
      if (!/^[0-7]{5,6}$/.test(mode) || !name || name.includes('/') || ['.', '..'].includes(name)) throw Error('Invalid Git tree entry');
      const type = mode === '40000' || mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
      const id = pending.subarray(nul + 1, nul + 1 + hashBytes).toString('hex');
      entries.push({ name, type, id, tree: type === 'tree' ? id : null });
      if (entries.length > 1_000_000) throw Error('Excessive Git tree inventory');
      pending = pending.subarray(nul + 1 + hashBytes);
    }
    if (pending.length > 1024 * 1024) throw Error('Excessive Git tree entry');
  }
  if (pending.length) throw Error('Incomplete Git tree');
  return entries;
}
