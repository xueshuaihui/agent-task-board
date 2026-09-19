import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiException } from '../contract/errors';
import { PrismaService } from '../infra/prisma.service';
import { jwtSecret } from '../common/paths';
import { verifyJwt } from './jwt';
import { IS_PUBLIC_KEY, type RequestAuth } from './auth.scope';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { auth?: RequestAuth }>();
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!bearer) throw new ApiException('UNAUTHORIZED', '缺少凭证');

    const payload = verifyJwt(bearer, jwtSecret());
    if (!payload) throw new ApiException('UNAUTHORIZED', '凭证无效或已过期');

    const account = await this.prisma.cloudAccount.findUnique({ where: { id: payload.sub } });
    if (!account || account.status !== 'ACTIVE') {
      throw new ApiException('UNAUTHORIZED', '账号不可用，请重新登录');
    }
    req.auth = {
      accountId: account.id,
      username: account.username,
      role: account.role === 'ADMIN' ? 'ADMIN' : 'MEMBER',
    };
    return true;
  }
}
