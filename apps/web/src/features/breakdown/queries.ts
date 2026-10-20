import { useRef } from 'react';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { api, qk, useApiMutation } from '@/api';
import type {
  BreakdownConfirmResult,
  BreakdownDraft,
  BreakdownListQuery,
  BreakdownSession,
  BreakdownSessionDetail,
} from '@/api/types';
import type { AnnotatedDraft, BreakdownDetailAnnotated } from './skill-status';

/**
 * v0.0.4 W7 §7.3 确认页数据源：列表 + 单会话详情的读查询与 confirm/cancel 写操作。
 * key 一律走 `qk.breakdown*`（src/api/keys.ts），breakdown.* 六条 WS 事件（含 #4
 * `breakdown.revision_requested`）的失效已由 `src/ws/invalidate.ts` 统一接进这张前缀表
 * ——事件只当失效信号，不做本地增量。
 */

type Options<TData> = Pick<UseQueryOptions<TData, Error, TData>, 'enabled' | 'staleTime'>;

/**
 * 会话列表（GET /breakdown/sessions）。
 * - 浮标/覆盖层：`{ scope: 'active' }`，只数未终结会话；
 * - 拆解二级页：active 段 `{ scope: 'active', requirement_id? }`，
 *   历史段走 `useBreakdownHistory`（cursor 分页）。
 * 参数整体进 queryKey——active/history 的缓存互不覆盖。
 */
export function useBreakdownSessions(
  query?: BreakdownListQuery,
  options?: Options<BreakdownSession[]>,
) {
  return useQuery({
    queryKey: qk.breakdownSessions(query),
    queryFn: () => api.breakdown.list(query),
    ...options,
  });
}

/**
 * #4 历史会话的 keyset 分页（cursor = 上一页最后一条会话 id）。
 * 响应仍是数组；`getNextPageParam` 只在整页取满时给下一页游标，避免多发一次空请求。
 */
export function useBreakdownHistory(
  query: Omit<BreakdownListQuery, 'cursor'>,
  options?: { enabled?: boolean },
) {
  const limit = query.limit ?? 100;
  return useInfiniteQuery({
    queryKey: qk.breakdownSessions(query),
    queryFn: ({ pageParam }) =>
      api.breakdown.list(pageParam ? { ...query, cursor: pageParam } : query),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.length >= limit ? (lastPage[lastPage.length - 1]?.id ?? null) : null,
    ...options,
  });
}

/**
 * 会话详情 = `{ session, drafts, progress }`（§7.6 三张表的读侧聚合）。
 * 返回值按本片局部镜像 `BreakdownDetailAnnotated` 标注：条款 81 起服务端逐条
 * 草案带 `skills_status`、会话级带 `skill_resolution`（全局 types 未收录，
 * 形状兼容纯结构扩展，无需改共享 DTO 文件）。
 */
export function useBreakdownSession(id: string | null, options?: Options<BreakdownDetailAnnotated>) {
  return useQuery({
    queryKey: qk.breakdownSession(id ?? ''),
    queryFn: async (): Promise<BreakdownDetailAnnotated> =>
      api.breakdown.detail(id as string),
    enabled: Boolean(id) && (options?.enabled ?? true),
    ...options,
  });
}

/** 确认创建：§7.8 单事务全成或全滚；成功后会话根、看板与任务列表一起失效。 */
export function useBreakdownConfirm() {
  return useApiMutation<string, BreakdownConfirmResult>(
    (sessionId) => api.breakdown.confirm(sessionId),
    { invalidate: [qk.breakdownRoot, qk.boardRoot, qk.tasksRoot] },
  );
}

/** 取消会话（receiving/reviewing → cancelled，§7.7）。 */
export function useBreakdownCancel() {
  return useApiMutation<string, BreakdownSession>(
    (sessionId) => api.breakdown.cancel(sessionId),
    { invalidate: [qk.breakdownRoot] },
  );
}

/** #4 单条重新生成：`{ note? }`（≤2000 字），成功后会话/草案/列表一起失效。 */
export function useBreakdownRegenerateDraft() {
  return useApiMutation<
    { id: string; ref: string; note?: string },
    BreakdownDraft[]
  >(
    ({ id, ref, note }) => api.breakdown.regenerateDraft(id, ref, note),
    { invalidate: [qk.breakdownRoot] },
  );
}

/** #4 整份重新生成：`{ note? }`，返回刷新后的会话详情；成功后整体失效。 */
export function useBreakdownRegenerateSession() {
  return useApiMutation<{ id: string; note?: string }, BreakdownSessionDetail>(
    ({ id, note }) => api.breakdown.regenerateSession(id, note),
    { invalidate: [qk.breakdownRoot] },
  );
}

/**
 * W7 遗留 b3（§7.4）：用户侧草案写的乐观更新封装。
 *
 * commit 先把调用方（overlay 用 draft-edit.ts 的纯归约）算好的乐观草案集覆盖进
 * 会话详情缓存，再打服务端写端点；成功走 `qk.breakdownRoot` 失效——**确认页数据
 * 以服务端为准**；失败回滚进 commit 前的快照，错误 Toast 由 useApiMutation 弹。
 * 本地暂存层（旧「暂存于本页」黄色提示）随之退役。
 */
export function useBreakdownDraftWrite(sessionId: string) {
  const queryClient = useQueryClient();
  const snapshot = useRef<BreakdownDetailAnnotated | null>(null);
  const write = useApiMutation<{ run: () => Promise<BreakdownDraft[]> }, AnnotatedDraft[]>(
    (vars) => vars.run(),
    {
      invalidate: [qk.breakdownRoot],
      onSettled: (_data, error) => {
        if (error && snapshot.current) {
          queryClient.setQueryData(qk.breakdownSession(sessionId), snapshot.current);
        }
        snapshot.current = null;
      },
    },
  );
  return {
    pending: write.isPending,
    commit(optimistic: AnnotatedDraft[], run: () => Promise<BreakdownDraft[]>) {
      const previous = queryClient.getQueryData<BreakdownDetailAnnotated>(
        qk.breakdownSession(sessionId),
      );
      snapshot.current = previous ?? null;
      if (previous) queryClient.setQueryData(qk.breakdownSession(sessionId), { ...previous, drafts: optimistic });
      write.mutate({ run });
    },
  };
}
