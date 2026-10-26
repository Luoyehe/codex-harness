import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { HarnessError } from '../core/errors.js';

export interface PasswordHash { algorithm: 'scrypt'; salt: string; hash: string; N: 32768; r: 8; p: 3 }
const parameters = { N: 32768 as const, r: 8 as const, p: 3 as const };
let hashing = 0;
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export function username(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(value)) throw new HarnessError('invalid_input', '用户名须为 1–64 位字母、数字、下划线、点或连字符。');
  return value;
}
export function password(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || Array.from(value).length < 12 || Array.from(value).length > 256 || Buffer.byteLength(value) > 1024 || value.includes('\0')) throw new HarnessError('invalid_input', '密码须为 12–256 个字符。');
  return value;
}
export function parsePassword(value: unknown): PasswordHash {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid password record');
  const row = value as Record<string, unknown>;
  if (row.algorithm !== 'scrypt' || row.N !== parameters.N || row.r !== parameters.r || row.p !== parameters.p || typeof row.salt !== 'string' || !/^[a-f0-9]{64}$/.test(row.salt) || typeof row.hash !== 'string' || !/^[a-f0-9]{128}$/.test(row.hash)) throw new Error('Invalid password record');
  return row as unknown as PasswordHash;
}
async function derive(value: string, salt: string): Promise<Buffer> {
  if (hashing >= 2) throw new HarnessError('rate_limited', '认证请求繁忙，请稍后重试。');
  hashing++;
  try { return await new Promise<Buffer>((resolve, reject) => scrypt(value, Buffer.from(salt, 'hex'), 64, { ...parameters, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key))); }
  finally { hashing--; }
}
export async function hashPassword(value: unknown): Promise<PasswordHash> {
  const plain = password(value), salt = randomBytes(32).toString('hex');
  return { algorithm: 'scrypt', ...parameters, salt, hash: (await derive(plain, salt)).toString('hex') };
}
export async function verifyPassword(value: unknown, record: PasswordHash): Promise<boolean> {
  if (typeof value !== 'string' || !value.isWellFormed() || Array.from(value).length > 256 || Buffer.byteLength(value) > 1024) return false;
  const actual = await derive(value, record.salt); return timingSafeEqual(actual, Buffer.from(record.hash, 'hex'));
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret(): string {
  let bits = 0, buffer = 0, result = '';
  for (const byte of randomBytes(20)) { buffer = (buffer << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; result += alphabet[(buffer >>> bits) & 31]; } }
  return result;
}
export function totp(secret: string, counter: number): string {
  if (!/^[A-Z2-7]{32}$/.test(secret) || !Number.isSafeInteger(counter) || counter < 0) throw new Error('Invalid TOTP state');
  let bits = 0, buffer = 0; const bytes: number[] = [];
  for (const char of secret) { buffer = (buffer << 5) | alphabet.indexOf(char); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); } }
  const count = Buffer.alloc(8); count.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(count).digest(), offset = mac[mac.length - 1]! & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
export function matchTotp(secret: string, code: unknown, now: number, previous: number): number | null {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const counter = Math.floor(now / 30_000);
  for (const candidate of [counter, counter - 1, counter + 1]) if (candidate >= 0 && candidate > previous && timingSafeEqual(Buffer.from(totp(secret, candidate)), Buffer.from(code))) return candidate;
  return null;
}
