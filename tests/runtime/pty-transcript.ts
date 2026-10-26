import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';

// This fixture records output, not a terminal screen. Each interaction checks
// newly emitted menu content and its actionable footer before sending a key.
export class PtyTranscript {
  private readonly decoder = new StringDecoder('utf8');
  private queryPrefix = '';
  private output = '';
  private length = 0;

  append(bytes: Buffer): number {
    const chunk = this.decoder.write(bytes);
    this.length += chunk.length;
    this.output = (this.output + chunk).slice(-400000);
    const query = '\x1b[6n';
    let queries = 0;
    // A PTY chunk is not a protocol frame: even a four-byte DSR query may
    // arrive in several chunks. Retain only a possible incomplete prefix.
    for (const char of chunk) {
      this.queryPrefix += char;
      while (this.queryPrefix && !query.startsWith(this.queryPrefix)) this.queryPrefix = this.queryPrefix.slice(1);
      if (this.queryPrefix === query) { queries++; this.queryPrefix = ''; }
    }
    return queries;
  }

  mark(): number { return this.length; }
  get tail(): string { return this.output; }
  since(mark: number): string {
    const start = mark - (this.length - this.output.length);
    if (start < 0 || start > this.output.length) throw new Error('PTY interaction output exceeded the bounded transcript');
    return stripVTControlCharacters(this.output.slice(start));
  }
}
