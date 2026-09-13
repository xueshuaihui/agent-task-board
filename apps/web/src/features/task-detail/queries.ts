import { useQueries, useQuery } from '@tanstack/react-query';
import { api, artifactSrc, qk, useTaskOverview, useTaskTab } from '@/api';
import type { CommentType, DependenciesResult, Page, ReviewsResult, RunsResult } from '@/api';
import type { ArtifactMetaView, AuditEntryView } from './types';

/**
 * 抽屉的读取层（13 章读取模型）。
 *
 * 规则：
 * - 概览走基座的 `useTaskOverview`，其余每个 Tab 一条 `useTaskTab(id, tab, fetcher, …局部参数)`，
 *   于是缓存键恒为 `['task', id, tab, …]`，切走再切回来不重复请求，
 *   WS 事件（`src/ws/invalidate.ts` 打 `qk.taskRoot(id)`）能一次清掉整抽屉。
 * - 分页类 Tab（评论、审计）与日志是「已加载页的并集」，所以每个页码一条查询，
 *   key 仍从 `qk` 出：`qk.taskTab(..., {page})` / `qk.taskRunLogs(...)`。
 */

export { useTaskOverview };

/** 抽屉只读概览之外的东西都按需加载，所以每个 hook 都被 `enabled: Boolean(id)` 钉住。 */
export function useTaskRuns(id: string | null) {
  return useTaskTab(id, 'runs', (taskId) => api.tasks.runs(taskId));
}

export function useTaskReviews(id: string | null) {
  return useTaskTab(id, 'reviews', (taskId) => api.tasks.reviews(taskId));
}

export function useTaskDependencies(id: string | null) {
  return useTaskTab(id, 'dependencies', (taskId) => api.tasks.dependencies(taskId));
}

export const COMMENTS_PAGE_SIZE = 100;
export const LOG_PAGE_SIZE = 200;
/** 13 章审计 `page_size` 固定 50，服务端不接这个参数，前端只是知道一页多少条。 */
export const AUDIT_PAGE_SIZE = 50;

/** 评论 Tab 默认只取人的评论 + 系统的状态变更（4.8：Agent 的 log 行属于执行 Tab）。 */
export const DEFAULT_COMMENT_TYPES: CommentType[] = ['comment', 'status_change'];

export function useTaskCommentPages(
  id: string | null,
  types: CommentType[],
  pages: number,
) {
  return useQueries({
    queries: Array.from({ length: Math.max(1, pages) }, (_, index) => {
      const page = index + 1;
      return {
        queryKey: qk.taskTab(id ?? '', 'comments' as const, {
          type: types,
          page,
          page_size: COMMENTS_PAGE_SIZE,
        }),
        queryFn: () =>
          api.tasks.comments(id as string, { type: types, page, page_size: COMMENTS_PAGE_SIZE }),
        enabled: Boolean(id),
      };
    }),
  });
}

/**
 * 评论计数徽标（原型 4.3）按默认两类算。
 *
 * 代价说清楚：13 章「抽屉打开只请求概览」，而 4.3 又要求 Tab 上带条数徽标，
 * 所以这条查询用 `page_size: 1` 只换 `total` 一个数字，不进分页序列（key 里带 page_size 以免撞车）。
 */
export function useTaskCommentCount(id: string | null) {
  return useTaskTab(
    id,
    'comments',
    (taskId) =>
      api.tasks.comments(taskId, {
        type: DEFAULT_COMMENT_TYPES,
        page: 1,
        page_size: 1,
      }),
    { type: DEFAULT_COMMENT_TYPES, page: 1, page_size: 1 },
  );
}

export function useTaskAuditPages(id: string | null, pages: number) {
  return useQueries({
    queries: Array.from({ length: Math.max(1, pages) }, (_, index) => {
      const page = index + 1;
      return {
        queryKey: qk.taskAudit(id ?? '', page),
        queryFn: async (): Promise<Page<AuditEntryView>> => {
          const result = await api.audit.list({
            target_type: 'task',
            target_id: id as string,
            page,
          });
          return { ...result, items: result.items as AuditEntryView[] };
        },
        enabled: Boolean(id),
      };
    }),
  });
}

/** 「加载更早」= page 递增（13 章）；这里把已加载页一次取齐，未展开的 Run 不发请求。 */
export function useRunLogPages(taskId: string | null, runId: string | null, pages: number) {
  return useQueries({
    queries: Array.from({ length: Math.max(1, pages) }, (_, index) => {
      const page = index + 1;
      return {
        queryKey: qk.taskRunLogs(taskId ?? '', runId ?? '', page),
        queryFn: () => api.runs.logs(runId as string, { page, page_size: LOG_PAGE_SIZE }),
        enabled: Boolean(taskId && runId),
      };
    }),
  });
}

/**
 * 产物元信息：`missing` 决定灰态、`preview` 决定这一行给「预览」还是「下载」
 * （6.10.1：类型由服务端按 mime_type + 扩展名推导，前端不再自己判扩展名）。
 */
export function useArtifactMeta(artifactId: string | null) {
  return useQuery({
    queryKey: qk.artifact(artifactId ?? ''),
    queryFn: async (): Promise<ArtifactMetaView> =>
      (await api.artifacts.meta(artifactId as string)) as ArtifactMetaView,
    enabled: Boolean(artifactId),
    staleTime: 30_000,
  });
}

export { artifactSrc };
export type { DependenciesResult, Page, ReviewsResult, RunsResult };
