import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 最小 HS256 JWT：不引依赖，header/payload/baseurl signature 三段。
 * payload 只装 UI 会话需要的字段，敏感值（mustChangePassword）以库行为准（守卫每次重读账号）。
 */
export interface JwtPayload {
  sub: string;
  username: string;
  role: string;
  exp: number;
}

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
/** UI 会话有效期：桌面单机场景放宽到 30 天，多账号切换不重新登录。 */
const TTL_SECONDS = 30 * 24 * 3600;

function hmac(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function signJwt(payload: Omit<JwtPayload, 'exp'>, secret: string): string {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS }),
  ).toString('base64url');
  return `${HEADER}.${body}.${hmac(`${HEADER}.${body}`, secret)}`;
}

/** 签名或结构非法返回 null；过期同样按 null 处理（守卫统一回 401）。 */
export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return null;
  const expected = hmac(`${parts[0]}.${parts[1]}`, secret);
  const given = parts[2]!;
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as JwtPayload;
    if (!payload.sub || typeof payload.exp !== 'number') return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
