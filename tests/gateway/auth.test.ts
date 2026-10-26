import { describe, expect, it } from 'vitest';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Authentication } from '../../src/gateway/auth.js';
import { hashPassword, password, totp, verifyPassword } from '../../src/gateway/auth-crypto.js';

const credentials = { username: 'admin', password: 'isolated-test-password' };
const cookieOf = (cookie: string) => cookie.split(';')[0]!;
const revision = (auth: Authentication, cookie: string) => auth.security(auth.require(cookie)).revision;
async function fixture(now: () => number = Date.now) {
  const token = randomBytes(32).toString('hex'), auth = new Authentication(token, 'https://harness.example', now);
  const login = await auth.setup({ token, ...credentials }, 'peer', 'Test Browser');
  return { token, auth, login, cookie: cookieOf(login.cookie) };
}
describe('single administrator authentication', () => {
  it('separates origin, password, CSRF, and browser-tab ownership', async () => {
    const { auth, login, cookie } = await fixture();
    try {
      expect(login.cookie).toContain('HttpOnly'); expect(login.cookie).toContain('SameSite=Strict'); expect(login.cookie).toContain('Secure');
      expect(() => auth.checkOrigin('https://attacker.example')).toThrow(); expect(() => auth.checkHost('evil.example')).toThrow();
      expect(auth.require(cookie, login.session.csrf)).toEqual(login.session);
      expect(() => auth.require(cookie, '')).toThrow(); expect(() => auth.require(undefined)).toThrow();
      const tab = randomUUID(); expect(auth.client(login.session, tab)).toBe(auth.client(login.session, tab));
      expect(auth.client(login.session, randomUUID())).not.toBe(auth.client(login.session, tab));
      expect(auth.session(cookie + '; ' + cookie)).toBeNull();
      auth.logout(cookie); expect(auth.session(cookie)).toBeNull();
    } finally { auth.close(); }
  });
  it('allows setup only once and never accepts the former bearer token for login', async () => {
    const { auth, token } = await fixture();
    try {
      expect(auth.status()).toMatchObject({ initialized: true, setupRequired: false, authenticationMode: 'account', authenticated: false });
      await expect(auth.setup({ token, ...credentials }, 'peer')).rejects.toMatchObject({ code: 'already_initialized' });
      await expect(auth.login({ token }, 'peer')).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(auth.login({ ...credentials, username: 'other' }, 'peer')).rejects.toMatchObject({ code: 'unauthorized' });
      expect((await auth.login(credentials, 'peer')).session.id).toBeTruthy();
    } finally { auth.close(); }
  });
  it('uses distinct cookies per origin, refuses public plaintext, and expires sessions', async () => {
    const token = randomBytes(32).toString('hex'); let now = 0;
    const auth = new Authentication(token, 'http://localhost:1234', () => now), other = new Authentication(token, 'http://localhost:1235');
    try {
      expect(auth.cookieName).not.toBe(other.cookieName); expect(() => new Authentication(token, 'http://server.example')).toThrow();
      const cookie = cookieOf((await auth.setup({ token, ...credentials }, 'peer')).cookie); now = 12 * 60 * 60_000;
      expect(auth.session(cookie)).toBeNull();
      const remembered = await auth.login({ ...credentials, remember: true }, 'peer');
      expect(remembered.session.expires).toBe(now + 30 * 24 * 60 * 60_000);
    } finally { auth.close(); other.close(); }
  });
  it('bounds failed attempts, recovers after the window, and persists the limit across restart', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'harness-auth-')), database = path.join(directory, 'auth.sqlite'), token = randomBytes(32).toString('hex'); let now = 0;
    let auth = new Authentication({ database, bootstrapToken: token }, 'https://harness.example', () => now);
    try {
      await auth.setup({ token, ...credentials }, 'peer');
      for (let i = 0; i < 8; i++) await expect(auth.login({ username: 'admin', password: 'wrong' }, 'peer')).rejects.toMatchObject({ code: 'unauthorized' });
      auth.close(); auth = new Authentication({ database }, 'https://harness.example', () => now);
      await expect(auth.login(credentials, 'peer')).rejects.toMatchObject({ code: 'rate_limited' });
      now += 60_000; expect((await auth.login(credentials, 'peer')).session.id).toBeTruthy();
    } finally { auth.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('persists sessions and owner identity without storing the browser bearer token or password', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'harness-auth-')), database = path.join(directory, 'auth.sqlite'), token = randomBytes(32).toString('hex');
    let auth = new Authentication({ database, bootstrapToken: token }, 'https://harness.example');
    try {
      const login = await auth.setup({ token, ...credentials }, 'peer'), cookie = cookieOf(login.cookie), tab = randomUUID(), owner = auth.client(login.session, tab);
      auth.close(); auth = new Authentication({ database }, 'https://harness.example');
      expect(auth.require(cookie)).toEqual(login.session); expect(auth.client(auth.require(cookie), tab)).toBe(owner);
      const bytes = readFileSync(database).toString('latin1'); expect(bytes).not.toContain(cookie.split('=')[1]!); expect(bytes).not.toContain(credentials.password);
      if (process.platform !== 'win32') expect(statSync(database).mode & 0o777).toBe(0o600);
    } finally { auth.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('changes passwords once, rejects stale revisions and revokes every session', async () => {
    const { auth, cookie } = await fixture();
    try {
      const second = cookieOf((await auth.login(credentials, 'second')).cookie), expectedRevision = revision(auth, cookie);
      await expect(auth.changePassword(auth.require(cookie), { currentPassword: 'wrong', password: 'new-test-password', expectedRevision }, 'peer')).rejects.toMatchObject({ code: 'credential_invalid' });
      expect(auth.session(cookie)).not.toBeNull();
      await expect(auth.changePassword(auth.require(cookie), { currentPassword: credentials.password, password: 'new-test-password', expectedRevision: randomUUID() }, 'peer')).rejects.toMatchObject({ code: 'account_changed' });
      await auth.changePassword(auth.require(cookie), { currentPassword: credentials.password, password: 'new-test-password', expectedRevision }, 'peer');
      expect(auth.session(cookie)).toBeNull(); expect(auth.session(second)).toBeNull();
      await expect(auth.login(credentials, 'peer')).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(auth.login({ ...credentials, password: 'new-test-password' }, 'peer')).resolves.toHaveProperty('session');
    } finally { auth.close(); }
  });
  it('keeps browser password changes across unchanged bootstrap and applies offline reset with a new revision', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'harness-auth-')), database = path.join(directory, 'auth.sqlite'), bootstrapFile = path.join(directory, 'bootstrap.json');
    const changedPassword = randomBytes(24).toString('base64url');
    let record = { schemaVersion: 1, revision: randomUUID(), username: 'admin', passwordHash: await hashPassword(credentials.password) };
    writeFileSync(bootstrapFile, JSON.stringify(record)); let auth = new Authentication({ database, bootstrapFile }, 'https://harness.example');
    try {
      let cookie = cookieOf((await auth.login(credentials, 'peer')).cookie);
      await auth.changePassword(auth.require(cookie), { currentPassword: credentials.password, password: changedPassword, expectedRevision: revision(auth, cookie) }, 'peer');
      auth.close(); auth = new Authentication({ database, bootstrapFile }, 'https://harness.example');
      cookie = cookieOf((await auth.login({ ...credentials, password: changedPassword }, 'peer')).cookie);
      record = { ...record, revision: randomUUID() }; writeFileSync(bootstrapFile, JSON.stringify(record));
      expect(auth.session(cookie)).toBeNull(); expect(auth.security((await auth.login(credentials, 'peer')).session).mfaEnabled).toBe(false);
      rmSync(bootstrapFile); expect(auth.session(cookie)).toBeNull(); expect(() => auth.status()).toThrow();
    } finally { auth.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('fails closed on malformed bootstrap and same-revision replacement without erasing the stored account', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'harness-auth-')), database = path.join(directory, 'auth.sqlite'), bootstrapFile = path.join(directory, 'bootstrap.json');
    const record = { schemaVersion: 1, revision: randomUUID(), username: 'admin', passwordHash: await hashPassword(credentials.password) }, raw = JSON.stringify(record);
    writeFileSync(bootstrapFile, raw); const auth = new Authentication({ database, bootstrapFile }, 'https://harness.example');
    try {
      const login = await auth.login(credentials, 'peer'), cookie = cookieOf(login.cookie);
      writeFileSync(bootstrapFile, '{bad'); expect(auth.session(cookie)).toBeNull();
      writeFileSync(bootstrapFile, JSON.stringify({ ...record, username: 'other' })); expect(auth.session(cookie)).toBeNull();
      writeFileSync(bootstrapFile, raw); expect(auth.session(cookie)).toEqual(login.session);
    } finally { auth.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('confirms TOTP ownership, rejects replay, uses recovery codes once, and revokes other devices', async () => {
    let now = 1_800_000; const { auth, cookie } = await fixture(() => now);
    try {
      const second = await auth.login(credentials, 'second'), secondCookie = cookieOf(second.cookie), expectedRevision = revision(auth, cookie);
      const pending = await auth.startTotp(auth.require(cookie), { password: credentials.password, expectedRevision }, 'peer');
      const code = totp(String(pending.secret), Math.floor(now / 30_000));
      expect(() => auth.confirmTotp(second.session, { expectedRevision, enrollmentId: pending.enrollmentId, code }, 'second')).toThrow();
      const recovery = auth.confirmTotp(auth.require(cookie), { expectedRevision, enrollmentId: pending.enrollmentId, code }, 'peer');
      expect(recovery).toHaveLength(10); expect(auth.session(secondCookie)).toBeNull(); expect(auth.session(cookie)).not.toBeNull();
      await expect(auth.login(credentials, 'peer')).rejects.toMatchObject({ code: 'mfa_required' });
      await expect(auth.login({ ...credentials, otp: code }, 'peer')).rejects.toMatchObject({ code: 'unauthorized' });
      now += 30_000; const fresh = totp(String(pending.secret), Math.floor(now / 30_000));
      const newLogin = await auth.login({ ...credentials, otp: fresh }, 'new-peer'); expect(newLogin.session.id).toBeTruthy();
      await expect(auth.login({ ...credentials, otp: fresh }, 'new-peer')).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(auth.login({ ...credentials, otp: recovery[0] }, 'new-peer')).resolves.toHaveProperty('session');
      await expect(auth.login({ ...credentials, otp: recovery[0] }, 'new-peer')).rejects.toMatchObject({ code: 'unauthorized' });
      expect(auth.security(auth.require(cookie)).recoveryCodesRemaining).toBe(9);
      await auth.disableTotp(auth.require(cookie), { expectedRevision: revision(auth, cookie), password: credentials.password, otp: recovery[1] }, 'disable-peer');
      expect(auth.session(cookieOf(newLogin.cookie))).toBeNull(); expect(auth.security(auth.require(cookie)).mfaEnabled).toBe(false);
      await expect(auth.login(credentials, 'peer')).resolves.toHaveProperty('session');
    } finally { auth.close(); }
  });
  it('replaces recovery codes with explicit password and second factor confirmation', async () => {
    const now = 1_800_000, { auth, cookie } = await fixture(() => now);
    try {
      const pending = await auth.startTotp(auth.require(cookie), { password: credentials.password, expectedRevision: revision(auth, cookie) }, 'peer');
      const old = auth.confirmTotp(auth.require(cookie), { expectedRevision: revision(auth, cookie), enrollmentId: pending.enrollmentId, code: totp(String(pending.secret), now / 30_000) }, 'peer');
      const next = await auth.replaceRecovery(auth.require(cookie), { expectedRevision: revision(auth, cookie), password: credentials.password, otp: old[0] }, 'peer');
      expect(next).toHaveLength(10); expect(next).not.toEqual(old);
      await expect(auth.login({ ...credentials, otp: old[1] }, 'peer')).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(auth.login({ ...credentials, otp: next[0] }, 'peer')).resolves.toHaveProperty('session');
    } finally { auth.close(); }
  });
  it('does not issue a session when an offline reset occurs during asynchronous verification', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'harness-auth-')), database = path.join(directory, 'auth.sqlite'), bootstrapFile = path.join(directory, 'bootstrap.json');
    const record = { schemaVersion: 1, revision: randomUUID(), username: 'admin', passwordHash: await hashPassword(credentials.password) };
    writeFileSync(bootstrapFile, JSON.stringify(record)); const auth = new Authentication({ database, bootstrapFile }, 'https://harness.example');
    try {
      const pending = auth.login(credentials, 'login-peer');
      writeFileSync(bootstrapFile, JSON.stringify({ ...record, revision: randomUUID() }));
      await expect(pending).rejects.toMatchObject({ code: 'unauthorized' });
      expect(auth.security((await auth.login(credentials, 'login-peer')).session).sessions).toHaveLength(1);
    } finally { auth.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('uses Unicode code-point password limits without silently accepting malformed text', () => {
    expect(password('😀'.repeat(12))).toBe('😀'.repeat(12)); expect(password('😀'.repeat(256))).toHaveLength(512);
    expect(() => password('😀'.repeat(257))).toThrow(); expect(() => password('x'.repeat(12) + '\ud800')).toThrow();
  });
  it('bounds simultaneous password work instead of creating an unbounded hash queue', async () => {
    const first = hashPassword('isolated-hash-one'), second = hashPassword('isolated-hash-two');
    await expect(hashPassword('isolated-hash-three')).rejects.toMatchObject({ code: 'rate_limited' });
    const [one, two] = await Promise.all([first, second]);
    expect(await verifyPassword('isolated-hash-one', one)).toBe(true); expect(await verifyPassword('isolated-hash-two', two)).toBe(true);
  });
  it('expires unfinished TOTP enrollment without enabling a secret', async () => {
    let now = 1_800_000; const { auth, cookie } = await fixture(() => now);
    try {
      const expectedRevision = revision(auth, cookie), pending = await auth.startTotp(auth.require(cookie), { password: credentials.password, expectedRevision }, 'peer');
      now += 5 * 60_000;
      expect(() => auth.confirmTotp(auth.require(cookie), { expectedRevision, enrollmentId: pending.enrollmentId, code: totp(String(pending.secret), now / 30_000) }, 'peer')).toThrow();
      expect(auth.security(auth.require(cookie)).mfaEnabled).toBe(false);
    } finally { auth.close(); }
  });
  it('matches the independently specified RFC 6238 SHA-1 vector', () => {
    // RFC secret is ASCII 12345678901234567890; Harness uses the standard six-digit truncation.
    expect(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1)).toBe('287082');
    expect(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', Math.floor(1111111109 / 30))).toBe('081804');
  });
  it('proves the gateway identity with a fresh origin-bound nonce without granting a session', () => {
    const token = randomBytes(32).toString('hex'), origin = 'https://harness.example', auth = new Authentication(token, origin), other = new Authentication(token, 'https://other.example');
    try {
      const nonce = randomBytes(32).toString('hex'), nextNonce = randomBytes(32).toString('hex'), response = auth.proof(nonce);
      const expected = createHmac('sha256', createHash('sha256').update(token, 'utf8').digest()).update('codex-harness-account-proof-v1\0' + origin + '\0' + nonce).digest('hex');
      expect(response).toEqual({ nonce, proof: expected }); expect(auth.proof(nextNonce).proof).not.toBe(response.proof); expect(other.proof(nonce).proof).not.toBe(response.proof);
      expect(() => auth.proof('bad')).toThrow(); expect(() => auth.proof('a'.repeat(65))).toThrow();
      expect(auth.status()).toMatchObject({ authenticated: false, initialized: false });
    } finally { auth.close(); other.close(); }
  });
  it('keeps authenticated account protection available after anonymous proxy login failures', async () => {
    const { auth, cookie } = await fixture();
    try {
      for (let i = 0; i < 8; i++) await expect(auth.login({ ...credentials, password: 'wrong' }, 'peer')).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(auth.login(credentials, 'peer')).rejects.toMatchObject({ code: 'rate_limited' });
      const pending = await auth.startTotp(auth.require(cookie), { expectedRevision: revision(auth, cookie), password: credentials.password }, 'peer');
      const codes = auth.confirmTotp(auth.require(cookie), { expectedRevision: revision(auth, cookie), enrollmentId: pending.enrollmentId, code: totp(String(pending.secret), Math.floor(Date.now() / 30_000)) }, 'peer');
      await auth.changePassword(auth.require(cookie), { expectedRevision: revision(auth, cookie), currentPassword: credentials.password, password: randomBytes(24).toString('base64url'), otp: codes[0] }, 'peer');
      expect(auth.session(cookie)).toBeNull();
    } finally { auth.close(); }
  });
});
