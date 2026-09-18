import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// 密码口径：scrypt(N=16384) + 16 字节随机盐，存 hex。algo 列留扩展位。
const KEYLEN = 64;

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, KEYLEN).toString('hex');
  return { salt, hash, algo: 'scrypt' };
}

export function verifyPassword(password: string, salt: string, expected: string): boolean {
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, KEYLEN);
  const target = Buffer.from(expected, 'hex');
  if (actual.length !== target.length) return false;
  return timingSafeEqual(actual, target);
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
