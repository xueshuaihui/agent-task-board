import { api, useTaskTab } from '@/api';
import type { Review, ReviewsResult, RunStatus, RunsResult, TaskRun } from '@/api/types';

/**
 * 审核页与审核表单的私有读查询。key 仍走 `qk.taskTab(id, 'reviews' | 'runs')`
 * （经由 `useTaskTab`），与详情抽屉共用同一份缓存，不现写第三种 key 形状。
 */

export function useTaskReviews(taskId: string | null) {
  return useTaskTab<ReviewsResult>(taskId, 'reviews', (id) => api.tasks.reviews(id));
}

export function useTaskRuns(taskId: string | null) {
  return useTaskTab<RunsResult>(taskId, 'runs', (id) => api.tasks.runs(id));
}

function isRunStatus(value: string): value is RunStatus {
  return value === 'RUNNING' || value === 'SUCCESS' || value === 'FAILED' || value === 'ABANDONED';
}

/**
 * 原型 5.1：右列取「待审核对应的这一次 Run」（`run.status === 'SUCCESS'`）——
 * 摘要与产物都挂在这次 Run 上。`current_run_id` 是最可靠的锚点，
 * 拿不到（列表 DTO 不带该字段）时退回「最近一次尚未被判的 SUCCESS」，再退回最近一次 SUCCESS。
 */
export function reviewTargetRun(
  runs: readonly TaskRun[] | undefined,
  currentRunId: string | null | undefined,
): TaskRun | null {
  const list = runs ?? [];
  if (currentRunId) {
    const pinned = list.find((run) => run.id === currentRunId);
    if (pinned) return pinned;
  }
  return (
    list.find((run) => run.status === 'SUCCESS' && run.review === null) ??
    list.find((run) => run.status === 'SUCCESS') ??
    list.find((run) => isRunStatus(run.status) && run.status === 'RUNNING') ??
    null
  );
}

/** 6.5 第 5 条：`review_reuse_last_opinion` 预填的是「该任务上一次审核的三字段」。 */
export function lastReview(reviews: readonly Review[] | undefined): Review | null {
  return reviews && reviews.length > 0 ? (reviews[0] ?? null) : null;
}

/** 6.5 第 6 条：审核记录只增不改不删，历史按时间倒序全部可见（服务端已按 createdAt DESC）。 */
export function reviewHistory(reviews: readonly Review[] | undefined): Review[] {
  return [...(reviews ?? [])];
}
