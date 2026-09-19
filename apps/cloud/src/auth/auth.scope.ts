import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

/** 服务端鉴权：`@Public()` 标注的接口匿名可访问，其余一律要 Bearer JWT。 */
export const IS_PUBLIC_KEY = 'cloud:public';
export const Public = (): MethodDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export interface RequestAuth {
  accountId: string;
  username: string;
  role: 'MEMBER' | 'ADMIN';
}

/**
 * 参数装饰器：`@Auth() auth: RequestAuth`，取守卫写在 req.auth 上的会话。
 * 公开接口（@Public）可匿名，此时值为 undefined——是否要求登录由守卫按 @Public 判定，
 * 这里不抛错，避免公开端点上「可选会话」写法被迫 try/catch。
 */
export const Auth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestAuth | undefined => {
    const req = ctx.switchToHttp().getRequest<Request & { auth?: RequestAuth }>();
    return req.auth;
  },
);
