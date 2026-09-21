import { useRef } from 'react';
import { useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { api, qk, useApiMutation } from '@/api';
import type {
  BreakdownConfirmResult,
  BreakdownDraft,
  BreakdownSession,
  BreakdownSessionDetail,
} from '@/api/types';

/**
 * v0.0.4 W7 §7.3 确认页数据源：列表 + 单会话详情的读查询与 confirm/cancel 写操作。
 * key 一律走 `qk.breakdown*`（src/api/keys.ts），breakdown.* 五条 WS 事件的失效
 * 已由 `src/ws/invalidate.ts` 统一接进这张前缀表——事件只当失效信号，不做本地增量。
 */

type Options<TData> = Pick<UseQueryOptions<TData, Error, TData>, 'enabled' | 'staleTime'>;

/** 会话列表（GET /breakdown/sessions）。确认页切换器与浮标待处理数都读这一份缓存。 */
export function useBreakdownSessions(options?: Options<BreakdownSession[]>) {
  return useQuery({
    queryKey: qk.breakdownSessions(),
    queryFn: () => api.breakdown.list(),
    ...options,
  });
}

/** 会话详情 = `{ session, drafts, progress }`（§7.6 三张表的读侧聚合）。 */
export function useBreakdownSession(id: string | null, options?: Options<BreakdownSessionDetail>) {
  return useQuery({
    queryKey: qk.breakdownSession(id ?? ''),
    queryFn: () => api.breakdown.detail(id as string),
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
  const snapshot = useRef<BreakdownSessionDetail | null>(null);
  const write = useApiMutation<{ run: () => Promise<BreakdownDraft[]> }, BreakdownDraft[]>(
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
    commit(optimistic: BreakdownDraft[], run: () => Promise<BreakdownDraft[]>) {
      const previous = queryClient.getQueryData<BreakdownSessionDetail>(qk.breakdownSession(sessionId));
      snapshot.current = previous ?? null;
      if (previous) queryClient.setQueryData(qk.breakdownSession(sessionId), { ...previous, drafts: optimistic });
      write.mutate({ run });
    },
  };
}
