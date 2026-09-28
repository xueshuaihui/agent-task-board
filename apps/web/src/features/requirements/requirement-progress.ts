/**
 * §19.15·88 追加段（v0.0.4 r6 · R1a）：需求页行上的「子任务完成度 x/y」聚合。
 *
 * 列表 DTO `TaskListItem extends TaskCard` **不带** `aggregate`/`children`
 * （那两字段只在 `GET /tasks/{id}` 的 `familyFields()` 上回），完成度由第二条
 * 既有请求 `GET /tasks?type=子任务&page_size=200` 在前端按 `card.parent.id`
 * 聚合得出——子卡 DTO 自带 `parent?: {id,title,done,total}`，直读即可，
 * **不为需求页给 api 加字段/端点/参数**。
 *
 * 覆盖边界如实处理（本文件的纯函数就是这条边界的闸）：
 * - 命中的需求 → `Map` 里有 `{done,total}`；
 * - 未命中的需求（含「子任务总量超 200、本页没捞到它的任何子卡」）→ **不进
 *   `Map`**，渲染层据此整块留空，**不得**显示 `0/0` 或猜测值（§19.15·88）。
 */

/** 需求行：只用 `id`（真实入参为 `TaskListItem`）。 */
export interface RequirementRowLike {
  id: string;
}

/** 子任务行：只读 `parent` 摘要（真实入参为 `TaskListItem`，父摘要在 `TaskCard.parent` 上）。 */
export interface SubtaskRowLike {
  parent?: { id: string; done: number; total: number } | null;
}

/** 需求完成度：done/total 均取自服务端算好的 `parent` 摘要，前端不再计数。 */
export interface RequirementProgress {
  done: number;
  total: number;
}

/** 子任务行请求的 `type` 过滤值（§19.15·88 的第二条既有请求）。 */
export const SUBTASK_TYPE = '子任务';

/**
 * 纯聚合（供单测直钉）：需求行 + 子任务行 → `Map<requirementId, {done,total}>`。
 * 同一需求的多张子卡带的是同一份 `parent` 摘要，取首个命中即可，后续行不覆盖
 * （分页截断时两份快照若不一致，宁用先到的也不猜）。
 * `parent` 缺失或指向不在本页需求行里的父任务 → 跳过。
 */
export function aggregateRequirementProgress(
  requirements: readonly RequirementRowLike[],
  subtasks: readonly SubtaskRowLike[],
): Map<string, RequirementProgress> {
  const ids = new Set(requirements.map((requirement) => requirement.id));
  const progress = new Map<string, RequirementProgress>();
  for (const subtask of subtasks) {
    const parent = subtask.parent;
    if (!parent || !ids.has(parent.id)) continue;
    if (!progress.has(parent.id)) {
      progress.set(parent.id, { done: parent.done, total: parent.total });
    }
  }
  return progress;
}

/**
 * 进度条百分比：`Progress` 语义下 `null` = 整条不渲染。
 * 只有 Map 命中（total 恒 ≥1）才谈得上百分比；未命中由渲染层整块隐藏，
 * 这里对 `undefined`/`total<=0` 一律回 `null`，绝不回 `0` 冒充「未完成」。
 */
export function requirementProgressPercent(
  progress: RequirementProgress | undefined,
): number | null {
  if (!progress || progress.total <= 0) return null;
  return Math.round((progress.done / progress.total) * 100);
}
