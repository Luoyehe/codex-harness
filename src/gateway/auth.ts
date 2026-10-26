import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HarnessError } from '../core/errors.js';
import { uuid } from '../core/validation.js';
import { digest, hashPassword, matchTotp, newTotpSecret, parsePassword, username, verifyPassword } from './auth-crypto.js';

export interface Session { id: string; csrf: string; expires: number }
export interface AuthOptions { database: string; bootstrapToken?: string; bootstrapFile?: string; strictFiles?: boolean }
type Account = { username: string; password: string; version: string; totp_secret: string | null; totp_counter: number; bootstrap_revision: string | null; bootstrap_digest: string | null };
type Input = Record<string, unknown>;
const unauthorized = () => new HarnessError('unauthorized', '用户名、密码或验证码不正确。');

/** Only the gateway identity can access this database. Passwords and bearer tokens are never persisted in plaintext. */
export class Authentication extends EventEmitter {
  readonly #db: DatabaseSync;
  readonly #options: AuthOptions;
  readonly #tokenHash: Buffer | undefined;
  readonly origin: URL;
  readonly cookieName: string;
  constructor(options: AuthOptions | string, origin: string, readonly now: () => number = Date.now) {
    super();
    this.#options = typeof options === 'string' ? { database: ':memory:', bootstrapToken: options } : options;
    const token = this.#options.bootstrapToken;
    if (token !== undefined && (token.length < 32 || token.length > 4096)) throw new Error('Invalid initialization token');
    this.#tokenHash = token === undefined ? undefined : Buffer.from(digest(token), 'hex');
    this.origin = new URL(origin);
    if (!['http:', 'https:'].includes(this.origin.protocol) || this.origin.username || this.origin.password || this.origin.pathname !== '/' || this.origin.search || this.origin.hash) throw new Error('HARNESS_ORIGIN must be an exact HTTP(S) origin');
    if (this.origin.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(this.origin.hostname)) throw new Error('Plain HTTP is only supported through a loopback origin');
    this.cookieName = 'harness_' + digest(this.origin.origin).slice(0, 16);
    if (this.#options.database !== ':memory:') {
      mkdirSync(dirname(this.#options.database), { recursive: true, mode: 0o700 });
      for (const name of ['', '-wal', '-shm']) {
        try { const info = lstatSync(this.#options.database + name); if (!info.isFile() || info.isSymbolicLink() || this.#options.strictFiles && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw new Error('Invalid authentication database'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    this.#db = new DatabaseSync(this.#options.database, { timeout: 5000, allowExtension: false });
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS auth_account(id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password TEXT NOT NULL, version TEXT NOT NULL, totp_secret TEXT, totp_counter INTEGER NOT NULL DEFAULT -1, bootstrap_revision TEXT, bootstrap_digest TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, csrf TEXT NOT NULL, version TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, label TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS auth_recovery(hash TEXT PRIMARY KEY) STRICT;
      CREATE TABLE IF NOT EXISTS auth_pending(session_id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, secret TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS auth_attempts(peer TEXT PRIMARY KEY, count INTEGER NOT NULL, reset INTEGER NOT NULL) STRICT;`);
    if (this.#options.database !== ':memory:') for (const suffix of ['', '-wal', '-shm']) {
      try { chmodSync(this.#options.database + suffix, 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try { this.refresh(); } catch (error) { this.#db.close(); throw error; }
  }
  close(): void { this.#db.close(); }
  checkHost(host: string | undefined): void { if (host?.toLowerCase() !== this.origin.host.toLowerCase()) throw new HarnessError('host', '访问地址与服务配置不匹配。'); }
  checkOrigin(origin: string | undefined): void { if (origin !== this.origin.origin) throw new HarnessError('origin', '请求来源与服务地址不匹配。'); }
  proof(nonce: unknown): { nonce: string; proof: string } {
    if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)) throw new HarnessError('invalid_input', '认证探测需要新的随机挑战。');
    if (!this.#tokenHash) throw new HarnessError('authentication_unavailable', '认证探测尚未配置。');
    return { nonce, proof: createHmac('sha256', this.#tokenHash).update('codex-harness-account-proof-v1\0' + this.origin.origin + '\0' + nonce).digest('hex') };
  }
  private account(): Account | undefined { return this.#db.prepare('SELECT * FROM auth_account WHERE id=1').get() as Account | undefined; }
  private transaction<T>(operation: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  private refresh(): void {
    const file = this.#options.bootstrapFile; if (!file) return;
    let descriptor: number;
    try { descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.account()?.bootstrap_revision) return; throw new HarnessError('authentication_unavailable', '管理员认证配置不可用，请通过服务器检查或恢复。'); }
    let raw: string;
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.size > 8192 || this.#options.strictFiles && (info.uid !== 0 || info.gid !== process.getgid?.() || info.nlink !== 1 || (info.mode & 0o027) !== 0)) throw new Error('Invalid bootstrap permissions');
      raw = readFileSync(descriptor, 'utf8');
    } finally { closeSync(descriptor); }
    const value = JSON.parse(raw) as Input;
    if (value.schemaVersion !== 1) throw new Error('Invalid bootstrap schema');
    const revision = uuid(value.revision), name = username(value.username), passwordHash = parsePassword(value.passwordHash), fingerprint = digest(raw), account = this.account();
    if (account?.bootstrap_revision === revision) { if (account.bootstrap_digest !== fingerprint) throw new Error('Bootstrap revision changed content'); return; }
    this.transaction(() => {
      this.#db.prepare('INSERT INTO auth_account(id,username,password,version,totp_secret,totp_counter,bootstrap_revision,bootstrap_digest) VALUES(1,?,?,?,NULL,-1,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,password=excluded.password,version=excluded.version,totp_secret=NULL,totp_counter=-1,bootstrap_revision=excluded.bootstrap_revision,bootstrap_digest=excluded.bootstrap_digest').run(name, JSON.stringify(passwordHash), randomUUID(), revision, fingerprint);
      this.#db.exec('DELETE FROM auth_sessions; DELETE FROM auth_recovery; DELETE FROM auth_pending; DELETE FROM auth_attempts;');
    });
    this.emit('revoked');
  }
  private cleanup(): void {
    const now = this.now(); this.#db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(now);
    this.#db.prepare('DELETE FROM auth_attempts WHERE reset<=?').run(now);
    this.#db.exec("DELETE FROM auth_attempts WHERE peer LIKE 'session:%' AND substr(peer,9) NOT IN (SELECT id FROM auth_sessions)");
    this.#db.prepare('DELETE FROM auth_pending WHERE expires_at<=? OR session_id NOT IN (SELECT id FROM auth_sessions)').run(now);
  }
  private attempt(peer: string, session?: Session): void {
    this.cleanup(); const key = session ? 'session:' + session.id : 'anonymous:' + digest(peer), row = this.#db.prepare('SELECT count FROM auth_attempts WHERE peer=?').get(key);
    // A trusted session has its own bounded bucket. Anonymous failures through a
    // loopback reverse proxy cannot prevent an existing administrator securing the account.
    if (row && Number(row.count) >= 8 || !session && !row && Number(this.#db.prepare("SELECT count(*) AS n FROM auth_attempts WHERE peer NOT LIKE 'session:%'").get()!.n) >= 1024) throw new HarnessError('rate_limited', '认证尝试过多，请稍后重试。');
    this.#db.prepare('INSERT INTO auth_attempts(peer,count,reset) VALUES(?,1,?) ON CONFLICT(peer) DO UPDATE SET count=count+1').run(key, this.now() + 60_000);
  }
  status(cookie?: string): Input {
    this.refresh(); const account = this.account(), session = this.session(cookie);
    return { authenticationMode: 'account', initialized: !!account, setupRequired: !account, authenticated: !!session, ...(session && account ? { username: account.username, csrf: session.csrf } : {}) };
  }
  async setup(input: Input, peer: string, label = ''): Promise<{ session: Session; cookie: string }> {
    this.refresh(); this.attempt(peer);
    if (this.account()) throw new HarnessError('already_initialized', '管理员已创建，请使用账号登录。');
    const token = typeof input.token === 'string' && input.token.length <= 4096 ? input.token : '';
    if (!this.#tokenHash || !timingSafeEqual(this.#tokenHash, Buffer.from(digest(token), 'hex'))) throw unauthorized();
    const name = username(input.username), passwordHash = await hashPassword(input.password);
    this.refresh();
    this.transaction(() => {
      if (this.account()) throw new HarnessError('already_initialized', '管理员已创建，请使用账号登录。');
      this.#db.prepare('INSERT INTO auth_account(id,username,password,version) VALUES(1,?,?,?)').run(name, JSON.stringify(passwordHash), randomUUID());
    });
    return this.issue(this.account()!, false, label, peer);
  }
  async login(input: Input, peer: string, label = ''): Promise<{ session: Session; cookie: string }> {
    this.refresh(); this.attempt(peer); const account = this.account();
    if (!account) throw new HarnessError('setup_required', '请先创建管理员账号。');
    const valid = await verifyPassword(input.password, parsePassword(JSON.parse(account.password)));
    this.refresh(); if (this.account()?.version !== account.version) throw unauthorized();
    if (!valid || input.username !== account.username) throw unauthorized();
    this.capacity();
    if (account.totp_secret) {
      if (input.otp === undefined || input.otp === '') throw new HarnessError('mfa_required', '请输入两步验证码或恢复码。');
      this.secondFactor(account, input.otp, 'unauthorized');
    }
    return this.issue(account, input.remember === true, label, peer);
  }
  private capacity(): void { this.cleanup(); if (Number(this.#db.prepare('SELECT count(*) AS n FROM auth_sessions').get()!.n) >= 64) throw new HarnessError('capacity', '登录设备数量已达上限，请先撤销已有登录。'); }
  private issue(account: Account, remember: boolean, label: string, peer: string): { session: Session; cookie: string } {
    this.capacity(); const now = this.now(), seconds = remember ? 30 * 24 * 60 * 60 : 12 * 60 * 60, key = randomBytes(32).toString('base64url');
    const session = { id: randomUUID(), csrf: randomBytes(24).toString('base64url'), expires: now + seconds * 1000 };
    this.#db.prepare('INSERT INTO auth_sessions(token_hash,id,csrf,version,created_at,last_seen_at,expires_at,label) VALUES(?,?,?,?,?,?,?,?)').run(digest(key), session.id, session.csrf, account.version, now, now, session.expires, label.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200));
    this.#db.prepare('DELETE FROM auth_attempts WHERE peer=?').run('anonymous:' + digest(peer)); return { session, cookie: this.cookie(key, seconds) };
  }
  session(cookie: string | undefined): Session | null {
    try { this.refresh(); } catch { return null; }
    const key = this.key(cookie); if (!key) return null;
    const row = this.#db.prepare('SELECT s.* FROM auth_sessions s JOIN auth_account a ON s.version=a.version WHERE s.token_hash=?').get(digest(key));
    if (!row) return null;
    if (Number(row.expires_at) <= this.now()) { this.#db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(digest(key)); return null; }
    if (Number(row.last_seen_at) + 60_000 <= this.now()) this.#db.prepare('UPDATE auth_sessions SET last_seen_at=? WHERE token_hash=?').run(this.now(), digest(key));
    return { id: String(row.id), csrf: String(row.csrf), expires: Number(row.expires_at) };
  }
  require(cookie: string | undefined, csrf?: string): Session {
    const session = this.session(cookie); if (!session) throw new HarnessError('unauthorized', '请先登录管理入口。');
    if (csrf !== undefined && csrf !== session.csrf) throw new HarnessError('csrf', '会话已过期，请重新加载页面。'); return session;
  }
  client(session: Session, clientId: unknown): string { return digest(session.id + '\0' + uuid(clientId)); }
  logout(cookie: string | undefined): string {
    const key = this.key(cookie); if (key) this.#db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(digest(key));
    this.emit('revoked'); return this.cookie('', 0);
  }
  security(session: Session): Input {
    const account = this.current(session); this.cleanup();
    return { username: account.username, revision: account.version, mfaEnabled: !!account.totp_secret, recoveryCodesRemaining: Number(this.#db.prepare('SELECT count(*) AS n FROM auth_recovery').get()!.n),
      sessions: this.#db.prepare('SELECT * FROM auth_sessions WHERE version=? ORDER BY created_at DESC').all(account.version).map(row => ({ id: row.id, label: row.label || '浏览器', createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, current: row.id === session.id })) };
  }
  private current(session: Session, revision?: unknown): Account {
    this.refresh(); const account = this.account();
    if (!account || !this.#db.prepare('SELECT 1 FROM auth_sessions WHERE id=? AND version=? AND expires_at>?').get(session.id, account.version, this.now())) throw new HarnessError('unauthorized', '请重新登录管理入口。');
    if (revision !== undefined && revision !== account.version) throw new HarnessError('account_changed', '账号安全设置已变化，请重新读取后操作。'); return account;
  }
  private expected(input: Input): string { if (typeof input.expectedRevision !== 'string') throw new HarnessError('account_changed', '请重新读取账号安全设置后操作。'); return input.expectedRevision; }
  private async challenge(session: Session, input: Input, peer: string): Promise<Account> {
    const account = this.current(session, this.expected(input)); this.attempt(peer, session);
    const valid = await verifyPassword(input.currentPassword ?? input.password, parsePassword(JSON.parse(account.password)));
    this.current(session, account.version);
    if (!valid) throw new HarnessError('credential_invalid', '当前密码不正确。');
    if (account.totp_secret) this.secondFactor(account, input.otp, 'mfa_invalid');
    return account;
  }
  private secondFactor(account: Account, value: unknown, errorCode: string): void {
    const counter = matchTotp(account.totp_secret!, value, this.now(), account.totp_counter);
    if (counter !== null) {
      const result = this.#db.prepare('UPDATE auth_account SET totp_counter=? WHERE version=? AND totp_counter<?').run(counter, account.version, counter);
      if (Number(result.changes) === 1) return;
    } else if (typeof value === 'string' && /^[a-fA-F0-9-]{20,24}$/.test(value)) {
      const normalized = value.replaceAll('-', '').toLowerCase();
      if (/^[a-f0-9]{20}$/.test(normalized) && Number(this.#db.prepare('DELETE FROM auth_recovery WHERE hash=?').run(digest('recovery\0' + normalized)).changes) === 1) return;
    }
    throw new HarnessError(errorCode, errorCode === 'unauthorized' ? '用户名、密码或验证码不正确。' : '两步验证码或恢复码无效，已使用的验证码不能重复使用。');
  }
  async changePassword(session: Session, input: Input, peer: string): Promise<void> {
    const account = await this.challenge(session, input, peer), next = await hashPassword(input.password);
    this.current(session, account.version);
    this.transaction(() => { this.#db.prepare('UPDATE auth_account SET password=?,version=? WHERE id=1').run(JSON.stringify(next), randomUUID()); this.#db.exec('DELETE FROM auth_sessions; DELETE FROM auth_pending;'); }); this.emit('revoked');
  }
  revoke(session: Session, input: Input): boolean {
    this.current(session, this.expected(input)); const id = uuid(input.sessionId);
    this.#db.prepare('DELETE FROM auth_sessions WHERE id=?').run(id); this.#db.prepare('DELETE FROM auth_pending WHERE session_id=?').run(id); this.emit('revoked'); return id !== session.id;
  }
  async startTotp(session: Session, input: Input, peer: string): Promise<Input> {
    const account = await this.challenge(session, input, peer); this.current(session, account.version); if (account.totp_secret) throw new HarnessError('already_enabled', '两步验证已启用。');
    const secret = newTotpSecret(), enrollmentId = randomUUID(), expiresAt = this.now() + 5 * 60_000;
    this.#db.prepare('INSERT INTO auth_pending(session_id,enrollment_id,secret,expires_at) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET enrollment_id=excluded.enrollment_id,secret=excluded.secret,expires_at=excluded.expires_at').run(session.id, enrollmentId, secret, expiresAt);
    const issuer = 'Codex Harness'; return { enrollmentId, secret, expiresAt, uri: `otpauth://totp/${encodeURIComponent(issuer + ':' + account.username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30` };
  }
  confirmTotp(session: Session, input: Input, peer: string): string[] {
    const account = this.current(session, this.expected(input)); this.attempt(peer, session);
    const pending = this.#db.prepare('SELECT * FROM auth_pending WHERE session_id=? AND enrollment_id=? AND expires_at>?').get(session.id, uuid(input.enrollmentId), this.now());
    if (account.totp_secret || !pending) throw new HarnessError('enrollment_expired', '两步验证设置已过期或已完成，请重新读取状态。');
    const counter = matchTotp(String(pending.secret), input.code, this.now(), -1); if (counter === null) throw new HarnessError('mfa_invalid', '验证码不正确。');
    const codes = this.transaction(() => {
      this.#db.prepare('UPDATE auth_account SET totp_secret=?,totp_counter=? WHERE id=1').run(String(pending.secret), counter);
      const result = this.recoveryCodes(); this.securityChanged(session); return result;
    }); this.emit('revoked'); return codes;
  }
  async disableTotp(session: Session, input: Input, peer: string): Promise<void> {
    const account = await this.challenge(session, input, peer); this.current(session, account.version); if (!account.totp_secret) throw new HarnessError('already_disabled', '两步验证尚未启用。');
    this.transaction(() => { this.#db.exec('UPDATE auth_account SET totp_secret=NULL,totp_counter=-1 WHERE id=1; DELETE FROM auth_recovery;'); this.securityChanged(session); }); this.emit('revoked');
  }
  async replaceRecovery(session: Session, input: Input, peer: string): Promise<string[]> {
    const account = await this.challenge(session, input, peer); this.current(session, account.version); if (!account.totp_secret) throw new HarnessError('mfa_not_enabled', '请先启用两步验证。');
    const codes = this.transaction(() => { const result = this.recoveryCodes(); this.securityChanged(session); return result; }); this.emit('revoked'); return codes;
  }
  private recoveryCodes(): string[] {
    this.#db.exec('DELETE FROM auth_recovery;'); const result: string[] = [];
    for (let index = 0; index < 10; index++) { const code = randomBytes(10).toString('hex'); this.#db.prepare('INSERT INTO auth_recovery(hash) VALUES(?)').run(digest('recovery\0' + code)); result.push(code.match(/.{4}/g)!.join('-')); } return result;
  }
  private securityChanged(session: Session): void {
    const revision = randomUUID(); this.#db.prepare('UPDATE auth_account SET version=? WHERE id=1').run(revision);
    this.#db.prepare('DELETE FROM auth_sessions WHERE id<>?').run(session.id); this.#db.prepare('UPDATE auth_sessions SET version=? WHERE id=?').run(revision, session.id); this.#db.exec('DELETE FROM auth_pending;');
  }
  private key(cookie: string | undefined): string | null {
    if (!cookie || cookie.length > 8192) return null;
    const values = cookie.split(';').map(item => item.trim()).filter(item => item.startsWith(this.cookieName + '='));
    if (values.length !== 1) return null; const key = values[0]!.slice(this.cookieName.length + 1); return /^[A-Za-z0-9_-]{43}$/.test(key) ? key : null;
  }
  private cookie(value: string, maxAge: number): string { return `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.origin.protocol === 'https:' ? '; Secure' : ''}`; }
}
