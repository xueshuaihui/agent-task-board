import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';

export type AuthGroup = 'ui' | 'agent' | 'any' | 'public';

/**
 * v0.0.4 W1a：账号体系移除后鉴权只回答「是不是合法 token」，不再有 accountId/角色语义。
 * UI 凭证 = 本地会话 Token（`ATB_UI_TOKEN`，Tauri 注入，本地 CSRF 防护）；
 * Agent 凭证 = `api_tokens` 表签发的 Bearer Token。本地单用户，无数据作用域。
 */
export interface UiAuth {
  kind: 'ui';
}

export interface AgentAuth {
  kind: 'agent';
  tokenId: string;
  tokenName: string;
  capabilities: string[];
}

export type RequestAuth = UiAuth | AgentAuth;

export const AUTH_SCOPE_KEY = 'atb:auth-scope';

/**
 * 未标注的接口一律按 `ui` 处理（13 章「跨组拒绝」的默认方向：Agent Token 什么用户接口都调不到）。
 */
export const AuthScope = (scope: AuthGroup) => SetMetadata(AUTH_SCOPE_KEY, scope);

export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<{ auth?: RequestAuth }>().auth;
});
