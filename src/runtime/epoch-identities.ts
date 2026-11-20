import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

/** Keep historical idempotency fingerprints out of the live-object cache.
 * SQLite's private temporary database has a bounded page cache and is deleted
 * on close. No native payload, credential or user's response is stored here. */
export class EpochIdentities {
  private database: DatabaseSync | undefined;
  private key(id: string): string { return createHash('sha256').update(id).digest('hex'); }
  private open(): DatabaseSync {
    if (!this.database) {
      this.database = new DatabaseSync('');
      this.database.exec('PRAGMA cache_size=-256; PRAGMA auto_vacuum=FULL; CREATE TABLE identities(scope TEXT, id TEXT, fingerprint TEXT NOT NULL, PRIMARY KEY(scope,id)) WITHOUT ROWID');
    }
    return this.database;
  }
  read(scope: string, id: string): string | undefined {
    return this.database?.prepare('SELECT fingerprint FROM identities WHERE scope=? AND id=?').get(this.key(scope), this.key(id))?.fingerprint as string | undefined;
  }
  add(scope: string, id: string, fingerprint: string): void {
    this.open().prepare('INSERT OR IGNORE INTO identities VALUES(?,?,?)').run(this.key(scope), this.key(id), fingerprint);
  }
  remove(scope: string, id: string): void { this.database?.prepare('DELETE FROM identities WHERE scope=? AND id=?').run(this.key(scope), this.key(id)); }
  forgetThread(scope: string): void { this.database?.prepare('DELETE FROM identities WHERE scope=?').run(this.key(scope)); }
  clear(): void { this.database?.close(); this.database = undefined; }
}
