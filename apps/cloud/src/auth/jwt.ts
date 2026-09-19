import { createHmac, timingSafeEqual } from 'node:crypto';

/** 最小 HS256 JWT（无依赖），与 apps/api/src/auth/jwt.ts 同一实现；secret 来自 CLOUD_JWT_SECRET。 */
export interface JwtPayload {
  sub: string;
  username: string;
  role: string;
  exp: number;
}

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
/** 服务端会话 7 天：跨设备登录场景，比桌面单机的 30 天收紧。 */
const TTL_SECONDS = 7 * 24 * 3600;

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
