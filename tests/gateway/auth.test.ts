import { describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Authentication } from '../../src/gateway/auth.js';

describe('control-plane authentication', () => {
  it('separates origin, authentication, csrf, and browser-tab ownership', () => {
    const token = randomBytes(32).toString('hex'); const auth = new Authentication(token, 'http://127.0.0.1:8787');
    const login = auth.login(token, 'peer'); const cookie = login.cookie.split(';')[0]!;
    expect(login.cookie).toContain('HttpOnly'); expect(login.cookie).toContain('SameSite=Strict');
    expect(() => auth.checkOrigin('https://attacker.example')).toThrow(); expect(() => auth.checkHost('evil.example')).toThrow();
    expect(auth.require(cookie, login.session.csrf)).toBe(login.session);
    expect(() => auth.require(cookie, '')).toThrow(); expect(() => auth.require(undefined)).toThrow();
    const tab = randomUUID(); expect(auth.client(login.session, tab)).toBe(auth.client(login.session, tab));
    expect(auth.client(login.session, randomUUID())).not.toBe(auth.client(login.session, tab));
    auth.logout(cookie); expect(auth.session(cookie)).toBe(null);
  });
  it('uses distinct cookies per configured port, refuses public plaintext, expires sessions', () => {
    const token = randomBytes(32).toString('hex'); let now = 0;
    const auth = new Authentication(token, 'http://localhost:1234', () => now);
    const other = new Authentication(token, 'http://localhost:1235');
    expect(auth.cookieName).not.toBe(other.cookieName);
    expect(() => new Authentication(token, 'http://server.example')).toThrow();
    const cookie = auth.login(token, 'peer').cookie.split(';')[0]!; now = 12 * 60 * 60_000;
    expect(auth.session(cookie)).toBe(null);
  });
  it('bounds repeated login attempts without logging the submitted token', () => {
    const token = randomBytes(32).toString('hex'); const auth = new Authentication(token, 'https://harness.example');
    for (let i = 0; i < 8; i++) expect(() => auth.login('wrong', 'peer')).toThrow('管理令牌不正确');
    expect(() => auth.login(token, 'peer')).toThrow('登录尝试过多');
  });
});
