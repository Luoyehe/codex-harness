import { randomUUID } from "node:crypto";

interface TerminalEntry { owner: string; ending: boolean }

/** PTYs belong to one browser connection, not to the shared app-server transport.
 * Keep closing entries counted until exec settles; a failed terminate must not
 * silently free capacity while its shell is still alive. */
export class Terminals {
  epoch = 0;
  private entries = new Map<string, TerminalEntry>();
  private owners = new Set<string>();
  constructor(private readonly stopProcess: (id: string) => Promise<unknown>, private readonly perOwner = 8, private readonly total = 32) {}

  connect(owner: string): void { this.owners.add(owner); }
  create(owner: string, requested?: unknown): string {
    if (!this.owners.has(owner)) throw new Error("terminal connection is closed");
    if (this.entries.size >= this.total || [...this.entries.values()].filter((entry) => entry.owner === owner).length >= this.perOwner) {
      throw new Error("terminal session limit reached");
    }
    const id = requested === undefined ? `term-${randomUUID()}` : requested;
    if (typeof id !== "string" || !/^(?:term-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("invalid terminal processId");
    if (this.entries.has(id)) throw new Error("terminal processId already exists");
    this.entries.set(id, { owner, ending: false });
    return id;
  }
  require(owner: string, id: string): void {
    const entry = this.entries.get(id);
    if (!this.owners.has(owner) || !entry || entry.owner !== owner || entry.ending) throw new Error("terminal is not active on this connection");
  }
  finish(id: string, epoch = this.epoch): void { if (epoch === this.epoch) this.entries.delete(id); }
  reset(): void { this.epoch++; this.entries.clear(); }
  async terminate(owner: string, id: string): Promise<unknown> {
    this.require(owner, id);
    const entry = this.entries.get(id)!;
    entry.ending = true;
    try { return await this.stopProcess(id); }
    catch (error) {
      if (this.entries.get(id) === entry) {
        entry.ending = false;
        if (!this.owners.has(owner)) this.stopDisconnected(id, entry);
      }
      throw error;
    }
  }
  disconnect(owner: string): void {
    this.owners.delete(owner);
    for (const [id, entry] of this.entries) {
      if (entry.owner !== owner || entry.ending) continue;
      this.stopDisconnected(id, entry);
    }
  }

  private stopDisconnected(id: string, entry: TerminalEntry, attempt = 0): void {
    entry.ending = true;
    void this.stopProcess(id).catch(() => undefined).then(() => {
      if (this.entries.get(id) !== entry) return;
      // Keep a bounded one-timer-per-terminal cleanup loop. RPC admission can
      // remain saturated longer than one second; stopping permanently after a
      // second refusal would orphan a shell. The exec settlement or generation
      // reset removes the entry and naturally terminates this retry chain.
      const timer = setTimeout(() => {
        if (this.entries.get(id) === entry) this.stopDisconnected(id, entry, attempt + 1);
      }, Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000));
      timer.unref();
    });
  }
}
