import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';

export type AuthGroup = 'ui' | 'agent' | 'any' | 'public';

/** UI 会话：JWT 解出；ATB_UI_TOKEN 兼容路径映射到内置账号（见 accounts.service）。 */
export interface UiAuth {
  kind: 'ui';
  accountId: string;
  username: string;
  role: 'ADMIN' | 'MEMBER';
  mustChangePassword: boolean;
}

export interface AgentAuth {
  kind: 'agent';
  accountId: string;
  tokenId: string;
  tokenName: string;
  capabilities: string[];
}

export type RequestAuth = UiAuth | AgentAuth;

export const AUTH_SCOPE_KEY = 'atb:auth-scope';

/**
 * 未标注的接口一律按 `ui` 处理（13 章「跨组拒绝」的默认方向：Agent Token 什么用户接口都调不到）。
 * `public`：登录/初始化这类无凭证可达的端点，全局守卫直接放行。
 */
export const AuthScope = (scope: AuthGroup) => SetMetadata(AUTH_SCOPE_KEY, scope);

export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<{ auth?: RequestAuth }>().auth;
});
