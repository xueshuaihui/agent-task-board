import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { hashToken } from '../contract/ids';
import { ApiException } from '../contract/errors';
import { PrismaService } from '../infra/prisma.service';
import { constantTimeEqual } from '../common/ui-token';
import { AUTH_SCOPE_KEY, type AuthGroup, type RequestAuth } from './auth.scope';

/** `last_used_at` 每次请求都写会把审计变成轮询日志；同一 Token 一小时内最多落一次。 */
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000;

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

    const req = context.switchToHttp().getRequest<Request & { auth?: RequestAuth }>();
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!bearer) throw new ApiException('UNAUTHORIZED', '缺少凭证');

    const uiToken = process.env.ATB_UI_TOKEN ?? '';
    if (uiToken && constantTimeEqual(bearer, uiToken)) {
      if (scope === 'agent') {
        throw new ApiException('FORBIDDEN', 'UI 会话 Token 不能调用 Agent 写回接口');
      }
      req.auth = { kind: 'ui' };
      return true;
    }

    const token = await this.prisma.apiToken.findUnique({
      where: { tokenHash: hashToken(bearer) },
    });
    if (!token) throw new ApiException('UNAUTHORIZED', '凭证无效');
    if (token.enabled === 0) throw new ApiException('UNAUTHORIZED', 'Token 已吊销');
    if (scope === 'ui') {
      throw new ApiException('FORBIDDEN', 'Agent Token 不能调用用户接口');
    }

    req.auth = {
      kind: 'agent',
      tokenId: token.id,
      tokenName: token.name,
      capabilities: parseJsonArray(token.capabilities),
    };
    await this.touchToken(token.id);
    return true;
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
