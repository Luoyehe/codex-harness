import path from 'node:path';
import { DeliveryError } from './types.js';

type Lease = { cwd: string | undefined; exclusive: boolean; identity?: string };
const busy = () => new DeliveryError('activity_busy', '此仓库或同源工作树仍有活动，或活动的仓库归属尚未确认。请等待相关任务结束后重试。');

/** Admission is serialized only during identity verification. Independent work then runs concurrently. */
export class RepositoryLeases {
  private readonly held = new Set<Lease>();
  private gate = Promise.resolve();
  private waiting = 0;
  constructor(private readonly identity: (cwd: string) => Promise<string>, private readonly liveRoots: () => (string | undefined)[]) {}

  async run<T>(cwd: string | undefined, exclusive: boolean, work: (check: () => void, identity?: string) => Promise<T>): Promise<T> {
    const lease: Lease = { cwd, exclusive };
    if (!exclusive && !this.waiting && ![...this.held].some(other => other.exclusive)) {
      this.held.add(lease);
      try { return await work(() => {}); } finally { this.held.delete(lease); }
    }
    if (this.waiting >= 128) throw busy();
    this.waiting++;
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>(done => { release = done; });
    let key: string | undefined;
    const proven = new Set<string | undefined>();
    const check = () => {
      if (exclusive && this.liveRoots().some(path => !proven.has(path))) throw busy();
    };
    try {
      await previous;
      const conflicts = [...this.held].filter(other => exclusive || other.exclusive);
      const others = new Set([...conflicts.map(other => other.cwd), ...(exclusive ? this.liveRoots() : [])]);
      if (exclusive || others.size) {
        if (!cwd || others.size > 64 || others.has(undefined) || others.has(cwd)) throw busy();
        key = await this.identity(cwd);
        if (conflicts.some(other => other.identity === key)) throw busy();
        lease.identity = key;
        // Use a bounded number of native helper processes even for a large activity snapshot.
        const paths = [...others] as string[];
        let index = 0;
        const worker = async () => {
          while (index < paths.length) {
            const other = paths[index++]!;
            if (other.startsWith(cwd + path.sep) || cwd.startsWith(other + path.sep) || await this.identity(other) === key) throw busy();
            proven.add(other);
          }
        };
        const checks = await Promise.allSettled(Array.from({length: Math.min(3, paths.length)}, worker));
        if (checks.some(result => result.status === 'rejected')) throw busy();
      }
      check();
      this.held.add(lease);
    } finally { this.waiting--; release(); }
    try { return await work(check, key); } finally { this.held.delete(lease); }
  }

  get writing(): boolean { return [...this.held].some(lease => lease.exclusive); }
}
