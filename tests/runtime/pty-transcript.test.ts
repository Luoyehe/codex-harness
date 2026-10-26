import { expect, test } from 'vitest';
import { PtyTranscript } from './pty-transcript.js';

test('cursor-position queries survive every chunk boundary and are answered exactly once', () => {
  const query = '\x1b[6n';
  for (let split = 0; split <= query.length; split++) {
    const transcript = new PtyTranscript();
    const counts = [transcript.append(Buffer.from(`banner${query.slice(0, split)}`)), transcript.append(Buffer.from(query.slice(split))), transcript.append(Buffer.from('footer'))];
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
  }
  const transcript = new PtyTranscript();
  expect([...`\x1b[?6n\x1b[6x\x1b[6n\x1b[6n`].map(char => transcript.append(Buffer.from(char))).reduce((sum, count) => sum + count, 0)).toBe(2);
});

test('a fresh interaction cannot reuse old menus and preserves fragmented UTF-8 and styled footers', () => {
  const transcript = new PtyTranscript();
  transcript.append(Buffer.from('Hooks need review\x1b[1menter\x1b[22m confirm · esc skip'));
  const mark = transcript.mark();
  expect(transcript.since(mark)).toBe('');
  const next = Buffer.from('\x1b]7501;state=idle:app=codex\x1b\\Hooks ⚠\x1b[1mt\x1b[22m trust all · enter review · esc close');
  for (const byte of next) transcript.append(Buffer.from([byte]));
  expect(transcript.since(mark)).toBe('Hooks ⚠t trust all · enter review · esc close');
  expect(transcript.since(mark)).not.toContain('Hooks need review');
});

test('bounded output rejects a stale interaction mark instead of matching unrelated output', () => {
  const transcript = new PtyTranscript();
  const mark = transcript.mark();
  transcript.append(Buffer.alloc(400001, 'a'));
  expect(transcript.tail).toHaveLength(400000);
  expect(() => transcript.since(mark)).toThrow('exceeded the bounded transcript');
  expect(transcript.since(transcript.mark())).toBe('');
});
