import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import { ArchiveHash } from '../lib/archive-hash';

test('archive SHA-256 matches the native digest across final block and chunk boundaries', () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 127, 128, 524305]) {
    const data = randomBytes(size), digest = new ArchiveHash();
    for (let index = 0; index < size; index += 37) digest.update(data.subarray(index, index + 37));
    expect(digest.finish()).toBe(createHash('sha256').update(data).digest('hex'));
  }
});
