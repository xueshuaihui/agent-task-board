import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';

export type AuthGroup = 'ui' | 'agent' | 'any';

export type RequestAuth =
  | { kind: 'ui' }
  | { kind: 'agent'; tokenId: string; tokenName: string; capabilities: string[] };

export const AUTH_SCOPE_KEY = 'atb:auth-scope';

/**
 * 未标注的接口一律按 `ui` 处理（13 章「跨组拒绝」的默认方向：Agent Token 什么用户接口都调不到）。
 */
export const AuthScope = (scope: AuthGroup) => SetMetadata(AUTH_SCOPE_KEY, scope);

export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<{ auth?: RequestAuth }>().auth;
});
