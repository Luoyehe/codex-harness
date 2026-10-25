import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { HarnessError } from '../core/errors.js';
import { uuid } from '../core/validation.js';

interface Session { id: string; csrf: string; expires: number }
export class Authentication {
  readonly #tokenHash: Buffer;
  readonly #sessions = new Map<string, Session>();
  readonly #attempts = new Map<string, { count: number; reset: number }>();
  readonly origin: URL;
  readonly cookieName: string;
  constructor(token: string, origin: string, readonly now: () => number = Date.now) {
    if (token.length < 32 || token.length > 4096) throw new Error('Gateway token must contain 32–4096 characters');
    this.#tokenHash = createHash('sha256').update(token).digest();
    this.origin = new URL(origin);
    if (!['http:', 'https:'].includes(this.origin.protocol) || this.origin.username || this.origin.password || this.origin.pathname !== '/' || this.origin.search || this.origin.hash)
      throw new Error('HARNESS_ORIGIN must be an exact HTTP(S) origin');
    if (this.origin.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(this.origin.hostname))
      throw new Error('Plain HTTP is only supported through a loopback origin');
    this.cookieName = 'harness_' + createHash('sha256').update(this.origin.origin).digest('hex').slice(0, 16);
  }
  checkHost(host: string | undefined): void {
    if (host?.toLowerCase() !== this.origin.host.toLowerCase()) throw new HarnessError('host', '访问地址与服务配置不匹配。');
  }
  checkOrigin(origin: string | undefined): void {
    if (origin !== this.origin.origin) throw new HarnessError('origin', '请求来源与服务地址不匹配。');
  }
  login(token: unknown, peer: string): { session: Session; cookie: string } {
    const now = this.now();
    for (const [key, session] of this.#sessions) if (session.expires <= now) this.#sessions.delete(key);
    for (const [key, entry] of this.#attempts) if (entry.reset <= now) this.#attempts.delete(key);
    const attempts = this.#attempts.get(peer) ?? { count: 0, reset: now + 60_000 };
    if (attempts.count >= 8 || this.#attempts.size >= 1024 && !this.#attempts.has(peer)) throw new HarnessError('rate_limited', '登录尝试过多，请稍后重试。');
    attempts.count++; this.#attempts.set(peer, attempts);
    if (typeof token !== 'string' || token.length > 4096 || !timingSafeEqual(this.#tokenHash, createHash('sha256').update(token).digest()))
      throw new HarnessError('unauthorized', '管理令牌不正确。');
    if (this.#sessions.size >= 64) throw new HarnessError('capacity', '登录会话数量已达上限，请稍后重试。');
    const key = randomBytes(32).toString('base64url');
    const session = { id: randomUUID(), csrf: randomBytes(24).toString('base64url'), expires: now + 12 * 60 * 60_000 };
    this.#sessions.set(key, session); this.#attempts.delete(peer);
    return { session, cookie: this.cookie(key, 12 * 60 * 60) };
  }
  session(cookie: string | undefined): Session | null {
    const key = this.key(cookie); if (!key) return null;
    const session = this.#sessions.get(key);
    if (!session || session.expires <= this.now()) { this.#sessions.delete(key); return null; }
    return session;
  }
  require(cookie: string | undefined, csrf?: string): Session {
    const session = this.session(cookie);
    if (!session) throw new HarnessError('unauthorized', '请先登录管理入口。');
    if (csrf !== undefined && csrf !== session.csrf) throw new HarnessError('csrf', '会话已过期，请重新加载页面。');
    return session;
  }
  client(session: Session, clientId: unknown): string {
    return createHash('sha256').update(session.id + '\0' + uuid(clientId)).digest('hex');
  }
  logout(cookie: string | undefined): string {
    const key = this.key(cookie); if (key) this.#sessions.delete(key);
    return this.cookie('', 0);
  }
  private key(cookie: string | undefined): string | null {
    if (!cookie || cookie.length > 8192) return null;
    const values = cookie.split(';').map(item => item.trim()).filter(item => item.startsWith(this.cookieName + '='));
    if (values.length !== 1) return null;
    const key = values[0]!.slice(this.cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(key) ? key : null;
  }
  private cookie(value: string, maxAge: number): string {
    return `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.origin.protocol === 'https:' ? '; Secure' : ''}`;
  }
}
