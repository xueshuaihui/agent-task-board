import { ApiException } from '../contract/errors';
import type { RequestAuth } from '../auth/auth.scope';

export type AgentAuth = Extract<RequestAuth, { kind: 'agent' }>;

/**
 * 路由都标了 `@AuthScope('agent')`，正常路径下不可能拿到 UI 凭证；
 * 这里显式判断而不是 `as`，是因为 MCP 工具与定时回收都可能被别的入口复用，
 * 凭证组越界必须是 401/403，不能变成 500。
 */
export function agentOf(auth: RequestAuth | undefined): AgentAuth {
  if (!auth) throw new ApiException('UNAUTHORIZED', '缺少 Agent 凭证');
  if (auth.kind !== 'agent') {
    throw new ApiException('FORBIDDEN', 'UI 会话 Token 不能调用 Agent 写回接口');
  }
  return auth;
}
