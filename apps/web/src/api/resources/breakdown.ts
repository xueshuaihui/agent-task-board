import { http } from '../client';
import type {
  BreakdownConfirmResult,
  BreakdownDraft,
  BreakdownDraftEdit,
  BreakdownListQuery,
  BreakdownSession,
  BreakdownSessionDetail,
} from '../types';

/**
 * v0.0.4 W7 §16.2「拆解」端点 + W7 遗留 b3 的用户侧草案写三件套（§7.4）
 * + #4 的历史过滤/keyset 分页与两级「重新生成」。
 * begin/进度/完成是 Agent 面（MCP `board.*`）；确认页在 reviewing 期的
 * 添加/修改/删除草案走 POST|PATCH|DELETE /breakdown/sessions/{id}/drafts[/ref]，
 * 三条都回服务端最新的草案全集（以服务端为准）。
 */
function enc(id: string): string {
  return encodeURIComponent(id);
}

/**
 * #4 会话列表的查询串：只发有值的键（undefined / 空串不发，让服务端走默认值）。
 * `include_archived` 的 false 是**显式值**（default false 与「用户选择不含归档」语义相同），
 * 因此照样发送，避免调用方以为过滤条件被吞掉。
 * 独立导出成纯函数，便于 vitest 直接钉查询串（web 无 jsdom）。
 */
export function breakdownListPath(query?: BreakdownListQuery): string {
  const search = new URLSearchParams();
  if (query?.scope) search.set('scope', query.scope);
  if (query?.include_archived !== undefined) {
    search.set('include_archived', String(query.include_archived));
  }
  const requirementId = query?.requirement_id?.trim();
  if (requirementId) search.set('requirement_id', requirementId);
  if (query?.limit !== undefined) search.set('limit', String(query.limit));
  if (query?.cursor) search.set('cursor', query.cursor);
  const qs = search.toString();
  return `/breakdown/sessions${qs ? `?${qs}` : ''}`;
}

/** `{ note? }` 请求体：空说明不落一个空串字段（服务端 zod trim 后等价，但少一处噪声）。 */
function regenerationBody(note?: string): { note?: string } {
  const trimmed = note?.trim();
  return trimmed ? { note: trimmed } : {};
}

export const breakdownApi = {
  /** 会话列表：默认 all；#4 起支持 scope/include_archived/requirement_id/limit/cursor。 */
  list: (query?: BreakdownListQuery) =>
    http.get<BreakdownSession[]>(breakdownListPath(query)),

  /** 会话详情：`{ session, drafts, progress, skill_resolution }`，§7.7 六态徽标 + §7.2 阶段 3/4 渲染都吃这一份。 */
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

  /**
   * §7.4 单条「重新生成」（条款 81 + #4）：重置草案待 Agent 重报，
   * `note` 是用户想改什么（≤2000 字，可空）。
   */
  regenerateDraft: (id: string, ref: string, note?: string) =>
    http.post<BreakdownDraft[]>(
      `/breakdown/sessions/${enc(id)}/drafts/${encodeURIComponent(ref)}/regenerate`,
      regenerationBody(note),
    ),

  /**
   * #4 整份「重新生成」：reviewing → receiving，所有草案挂待重报；
   * 响应是完整的会话详情（含刷新后的 session/drafts/progress）。
   */
  regenerateSession: (id: string, note?: string) =>
    http.post<BreakdownSessionDetail>(
      `/breakdown/sessions/${enc(id)}/regenerate`,
      regenerationBody(note),
    ),
};
