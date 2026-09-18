import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { hashToken } from '../contract/ids';
import { ApiException } from '../contract/errors';
import { PrismaService } from '../infra/prisma.service';
import { constantTimeEqual } from '../common/ui-token';
import { BUILTIN_ACCOUNT_ID } from './accounts.service';
import { verifyJwt } from './jwt';
import { AUTH_SCOPE_KEY, type AuthGroup, type RequestAuth } from './auth.scope';

/** `last_used_at` 每次请求都写会把审计变成轮询日志；同一 Token 一小时内最多落一次。 */
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000;

/** mustChangePassword 期间唯一放行的 UI 端点（其余一律 403 MUST_CHANGE_PASSWORD）。 */
const ALLOWED_WHILE_PASSWORD_PENDING = [
  '/api/v1/auth/me',
  '/api/v1/auth/change-password',
  '/api/v1/auth/logout',
];

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly lastWritten = new Map<string, number>();

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope =
      this.reflector.getAllAndOverride<AuthGroup>(AUTH_SCOPE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'ui';
    if (scope === 'public') return true;

    const req = context.switchToHttp().getRequest<Request & { auth?: RequestAuth }>();
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!bearer) throw new ApiException('UNAUTHORIZED', '缺少凭证');

    // 1) Agent Token：api_tokens 表（绑定 accountId，按账号隔离数据）。
    const token = await this.prisma.apiToken.findUnique({
      where: { tokenHash: hashToken(bearer) },
    });
    if (token) {
      if (token.enabled === 0) throw new ApiException('UNAUTHORIZED', 'Token 已吊销');
      if (scope === 'ui') {
        throw new ApiException('FORBIDDEN', 'Agent Token 不能调用用户接口');
      }
      req.auth = {
        kind: 'agent',
        accountId: token.accountId,
        tokenId: token.id,
        tokenName: token.name,
        capabilities: parseJsonArray(token.capabilities),
      };
      await this.touchToken(token.id);
      return true;
    }

    // 2) UI 会话 JWT（HS256）：账号必须存在且未禁用；mustChangePassword 由库行重算，不信任旧 token。
    // secret 尚未生成（全新库且未配 env）时整段跳过，不接受空密钥签名。
    const jwtSecret = process.env.ATB_JWT_SECRET ?? (await this.accountsJwtSecret());
    const payload = jwtSecret ? verifyJwt(bearer, jwtSecret) : null;
    if (payload) {
      if (scope === 'agent') {
        throw new ApiException('FORBIDDEN', 'UI 会话 Token 不能调用 Agent 写回接口');
      }
      const account = await this.prisma.account.findUnique({ where: { id: payload.sub } });
      if (!account || account.status !== 'ACTIVE') {
        throw new ApiException('UNAUTHORIZED', '账号不可用，请重新登录');
      }
      const mustChangePassword = account.mustChangePassword === 1;
      if (mustChangePassword && !ALLOWED_WHILE_PASSWORD_PENDING.includes(req.path)) {
        throw new ApiException('MUST_CHANGE_PASSWORD', '首次登录请先修改密码', undefined, {
          account_id: account.id,
        });
      }
      req.auth = {
        kind: 'ui',
        accountId: account.id,
        username: account.username,
        role: account.role === 'ADMIN' ? 'ADMIN' : 'MEMBER',
        mustChangePassword,
      };
      return true;
    }

    // 3) ATB_UI_TOKEN 兼容路径：映射到内置账号（迁移保证存在）。仅当与 ATB_UI_TOKEN 完全一致。
    const uiToken = process.env.ATB_UI_TOKEN ?? '';
    if (uiToken && constantTimeEqual(bearer, uiToken)) {
      if (scope === 'agent') {
        throw new ApiException('FORBIDDEN', 'UI 会话 Token 不能调用 Agent 写回接口');
      }
      req.auth = {
        kind: 'ui',
        accountId: BUILTIN_ACCOUNT_ID,
        username: '__local__',
        role: 'ADMIN',
        mustChangePassword: false,
      };
      return true;
    }

    throw new ApiException('UNAUTHORIZED', '凭证无效');
  }

  /** 守卫不依赖 AccountsService 的写路径，只在没配 env secret 时惰性读一次 settings。 */
  private async accountsJwtSecret(): Promise<string> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'jwt_secret' } });
    return row?.value ?? '';
  }

  private async touchToken(tokenId: string): Promise<void> {
    const now = Date.now();
    if (now - (this.lastWritten.get(tokenId) ?? 0) < LAST_USED_THROTTLE_MS) return;
    this.lastWritten.set(tokenId, now);
    await this.prisma.$executeRawUnsafe(
      `UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?`,
      tokenId,
    );
  }
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
