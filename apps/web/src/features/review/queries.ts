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

/**
 * 6.10.1 的产物分区口径：`artifacts.run_id NOT NULL`，产物只挂在被审核的那次 Run 上。
 * 但「驳回重跑 / 租约回收后重领」会让产物留在上一个 Run（复现见 beta.6 B8）：审核表单
 * 若只读目标 Run 的 artifacts 就显示 0，用户感知「明明有产物、审核里却没有」。
 * 展示层回退：目标 Run 无产物时取该任务最近一次有产物的 Run（items 已按 startedAt desc），
 * 由调用方标注归属。纯展示，不改写路径与审核提交口径。
 */
export function artifactsSourceRun(
  runs: readonly TaskRun[] | undefined,
  target: TaskRun | null,
): TaskRun | null {
  if (!target || target.artifacts.length > 0) return target;
  return runs?.find((run) => run.artifacts.length > 0) ?? target;
}

/** 6.5 第 5 条：`review_reuse_last_opinion` 预填的是「该任务上一次审核的三字段」。 */
export function lastReview(reviews: readonly Review[] | undefined): Review | null {
  return reviews && reviews.length > 0 ? (reviews[0] ?? null) : null;
}

/** 6.5 第 6 条：审核记录只增不改不删，历史按时间倒序全部可见（服务端已按 createdAt DESC）。 */
export function reviewHistory(reviews: readonly Review[] | undefined): Review[] {
  return [...(reviews ?? [])];
}
