import { http } from '../client';
import type { BreakdownConfirmResult, BreakdownSession, BreakdownSessionDetail } from '../types';

/**
 * v0.0.4 W7 §16.2「拆解」四端点（§7.3 确认页的数据源与两个决策动作）。
 * begin/进度/草案/完成是 Agent 面（MCP `board.*`），REST 只有这四行——
 * 所以这里没有 create/update，写侧只有 confirm/cancel 两个状态迁移。
 */
function enc(id: string): string {
  return encodeURIComponent(id);
}

export const breakdownApi = {
  /** 会话列表：created_at 倒序，含六态全部会话（确认页顶部切换器的数据源）。 */
  list: () => http.get<BreakdownSession[]>('/breakdown/sessions'),

  /** 会话详情：`{ session, drafts, progress }`，§7.7 六态徽标 + §7.2 阶段 3/4 渲染都吃这一份。 */
  detail: (id: string) => http.get<BreakdownSessionDetail>(`/breakdown/sessions/${enc(id)}`),

  /** §7.8 单事务批量建父任务+子任务；表外状态 409 `BREAKDOWN_BAD_STATE`。 */
  confirm: (id: string) =>
    http.post<BreakdownConfirmResult>(`/breakdown/sessions/${enc(id)}/confirm`),

  /** receiving/reviewing → cancelled；其余状态同样 409。 */
  cancel: (id: string) => http.post<BreakdownSession>(`/breakdown/sessions/${enc(id)}/cancel`),
};
