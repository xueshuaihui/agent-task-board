import type { BreakdownSession } from '@/api/types';

/**
 * #4 历史会话面板的「已加载记录内搜索」。
 *
 * 后端 `GET /breakdown/sessions` 没有 q 参数（只有 scope/requirement/archived/cursor），
 * 因此这里只在**当前已加载的分页**里过滤标题 / 需求原文 / Agent 名，
 * 占位文案必须说清不是全库搜索（页面侧 `historySearchHint` 同口径）。
 */
export function filterLoadedSessions(
  sessions: readonly BreakdownSession[],
  keyword: string,
): BreakdownSession[] {
  const query = keyword.trim().toLowerCase();
  if (!query) return [...sessions];
  return sessions.filter((session) =>
    [session.parent_title, session.requirement_text, session.agent_name ?? ''].some((value) =>
      value.toLowerCase().includes(query),
    ),
  );
}

/** 历史面板的搜索占位/说明文案（与后端能力对齐：只过滤已加载记录）。 */
export const HISTORY_SEARCH_PLACEHOLDER = '在当前已加载的历史中搜索标题 / 需求 / Agent';
export function historySearchHint(loaded: number): string {
  return `仅过滤已加载的 ${loaded} 条记录，不是全库搜索`;
}
