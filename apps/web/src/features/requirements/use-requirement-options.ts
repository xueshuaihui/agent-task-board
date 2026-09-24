import { useMemo } from 'react';
import { useTaskList } from '@/api';
import { useGroups } from '@/features/groups/queries';
import type { Group } from '@/features/groups/types';
import type { TaskCreateInput, TaskListItem, TaskPatchInput } from '@/api/types';

/**
 * §19.14·86（v0.0.4 W2-a）：看板写入路径的「需求」候选。
 *
 * 看板 UI 上 Group 概念已整体下线（「分组」即「需求」），新建/移动的唯一归属选择
 * 是需求：选中需求 → 同写 `parent_task_id` + 回填该需求的 `group_id`；未选 →
 * 创建两字段都不发（服务端落默认分组兜底）、移动只置空 `parent_task_id`。
 *
 * 数据源走**既有** `GET /tasks?type=需求`（零服务端改动、不给 api 加参数），
 * query key 即 `qk.tasks({ type:['需求'], … })`——与
 * `features/task-detail/create-task-dialog.tsx` 的现成用法同形，共享缓存、
 * 同受 `tasksRoot` 的 WS 失效链覆盖。
 *
 * 候选必须排除归档分组下的需求：归档组只读，服务端 `assertGroup` 会 409；
 * 归档判定来自 `useGroups()`（固定 `archived=true` 的全量缓存），
 * `status !== 'ACTIVE'` 即归档（与 `useActiveGroups` 同一口径）。
 */

/** 需求候选：id 写进 `parent_task_id`，group_id 回填进 `group_id`。 */
export interface RequirementOption {
  id: string;
  title: string;
  group_id: string | null;
}

/** 需求 = type 为「需求」的父任务（§19.14 背景口径；parent_task_id 语义不动）。 */
export const REQUIREMENT_TYPE = '需求';

/**
 * 派生候选（纯函数，供单测直钉）：任务行 → `{ id, title, group_id }`，
 * 剔除归属分组已归档（`status !== 'ACTIVE'`）的需求。
 * `groups` 未就绪（undefined）时先全量放行——判定宁缺毋滥，加载中不把候选清空；
 * 归档组一旦在手就过滤掉（服务端 409 是最后防线，不该让用户撞到）。
 */
export function buildRequirementOptions(
  tasks: readonly TaskListItem[] | undefined,
  groups: readonly Group[] | undefined,
): RequirementOption[] {
  if (!tasks) return [];
  const archivedGroupIds = groups
    ? new Set(groups.filter((group) => group.status !== 'ACTIVE').map((group) => group.id))
    : null;
  return tasks
    .filter((task) => !(archivedGroupIds && task.group_id && archivedGroupIds.has(task.group_id)))
    .map((task) => ({ id: task.id, title: task.title, group_id: task.group_id }));
}

/** 看板两处的共享拉取：一次性全量需求（page_size 取服务端上限 200）。 */
export function useRequirementOptions() {
  const list = useTaskList({
    type: [REQUIREMENT_TYPE],
    archived: 'false',
    page: 1,
    page_size: 200,
  });
  const groups = useGroups();
  const options = useMemo(
    () => buildRequirementOptions(list.data?.items, groups.data?.items),
    [list.data, groups.data],
  );
  return { ...list, data: options };
}

/** 创建请求的归属字段（§19.14·86：选中同写两字段；未选两字段都不发）。 */
export function requirementCreateBody(
  option: RequirementOption | null,
): Partial<Pick<TaskCreateInput, 'parent_task_id' | 'group_id'>> {
  return option ? { parent_task_id: option.id, group_id: option.group_id } : {};
}

/**
 * 移动请求的归属字段（§19.14·86：一次 PATCH 原子写两字段；
 * 「脱离需求」仅置空 `parent_task_id`，`group_id` 不发、保持原组）。
 */
export function requirementMoveBody(
  option: RequirementOption | null,
): Pick<TaskPatchInput, 'parent_task_id'> & Partial<Pick<TaskPatchInput, 'group_id'>> {
  return option ? { parent_task_id: option.id, group_id: option.group_id } : { parent_task_id: null };
}

/**
 * 展示层反查（§19.14·84，W2-b 为 creation 确认卡补的纯派生）：`group_id` → 该组
 * 需求标题。拆解流程每需求开一组，组内正常只有一张需求卡，取首个命中即可；
 * 组内无需求（或需求所在组已归档被剔出候选）回 null，由调用方兜「未分配」文案。
 */
export function requirementTitleForGroup(
  options: readonly RequirementOption[],
  groupId: string | null | undefined,
): string | null {
  if (!groupId) return null;
  return options.find((option) => option.group_id === groupId)?.title ?? null;
}
