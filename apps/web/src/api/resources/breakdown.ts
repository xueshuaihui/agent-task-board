import { http } from '../client';
import type {
  BreakdownConfirmResult,
  BreakdownDraft,
  BreakdownDraftEdit,
  BreakdownSession,
  BreakdownSessionDetail,
} from '../types';

/**
 * v0.0.4 W7 §16.2「拆解」端点 + W7 遗留 b3 的用户侧草案写三件套（§7.4）。
 * begin/进度/完成是 Agent 面（MCP `board.*`）；确认页在 reviewing 期的
 * 添加/修改/删除草案走 POST|PATCH|DELETE /breakdown/sessions/{id}/drafts[/ref]，
 * 三条都回服务端最新的草案全集（以服务端为准）。
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

  /** §7.4 添加任务：ref 可省略（服务端取号）；仅 reviewing 可写，表外 409。回草案全集。 */
  createDraft: (id: string, input: BreakdownDraftEdit) =>
    http.post<BreakdownDraft[]>(`/breakdown/sessions/${enc(id)}/drafts`, input),

  /** §7.4 修改草案（数组字段整体替换）+ 条款 81 技能重选；成环 409、未知前置 422。 */
  updateDraft: (id: string, ref: string, patch: BreakdownDraftEdit) =>
    http.patch<BreakdownDraft[]>(`/breakdown/sessions/${enc(id)}/drafts/${encodeURIComponent(ref)}`, patch),

  /** §7.4 删除任务：服务端同事务级联清悬空 depends_on；未知草案 404。 */
  deleteDraft: (id: string, ref: string) =>
    http.del<BreakdownDraft[]>(`/breakdown/sessions/${enc(id)}/drafts/${encodeURIComponent(ref)}`),
};
