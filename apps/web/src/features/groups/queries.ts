import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { qk, useApiMutation } from '@/api';
import { useGroupingStore } from '@/features/board/grouping/useGroupingState';
import { groupsApi } from './groupsApi';
import type {
  Group,
  GroupCreateInput,
  GroupDeleteResult,
  GroupPatchInput,
} from './types';

export { groupsApi };
export type { Group, GroupCreateInput, GroupDeleteResult, GroupPatchInput };

/** 与 api/queries.ts 的 Options 同一形状（分组查询只会用到这几个键）。 */
type Options<TData> = Pick<UseQueryOptions<TData, Error, TData>, 'enabled' | 'staleTime' | 'placeholderData'>;

export function useGroups(options?: Options<{ items: Group[] }>) {
  return useQuery({
    queryKey: qk.groups(),
    queryFn: groupsApi.list,
    staleTime: 30_000,
    ...options,
  });
}

/** 归档分组不进切换器与新建表单候选（5.1「归档的分组不出现在默认视图」）。 */
export function useActiveGroups(options?: Options<{ items: Group[] }>) {
  const query = useGroups(options);
  const items = query.data?.items.filter((group) => group.status === 'ACTIVE');
  return { ...query, data: query.data ? { items } : undefined };
}

/**
 * 分组写操作。三个口径：
 * - 删除/迁移动了任务归属，所以除 `groupsRoot` 外还要打 `boardRoot` 与 `tasksRoot`；
 * - 编辑/归档会影响看板的分组过滤与泳道展示，同样带上 board/tasks 前缀（代价是一次重取，正确性优先）；
 * - 表单类（create/patch/remove）由对话框内联回显字段错误，把默认 Toast 关掉；archive/restore 走默认 Toast。
 */
export function useGroupMutations() {
  const create = useApiMutation<GroupCreateInput, Group>(groupsApi.create, {
    invalidate: [qk.groupsRoot],
    toastOnError: false,
  });

  const patch = useApiMutation<{ id: string; body: GroupPatchInput }, Group>(
    ({ id, body }) => groupsApi.patch(id, body),
    { invalidate: [qk.groupsRoot, qk.boardRoot, qk.tasksRoot], toastOnError: false },
  );

  const archive = useApiMutation<string, Group>(
    (id) => groupsApi.patch(id, { status: 'ARCHIVED' }),
    {
      invalidate: [qk.groupsRoot, qk.boardRoot, qk.tasksRoot],
      onSuccess: (_data, id) => dropFromScope(id),
    },
  );

  const restore = useApiMutation<string, Group>(
    (id) => groupsApi.patch(id, { status: 'ACTIVE' }),
    { invalidate: [qk.groupsRoot] },
  );

  const remove = useApiMutation<
    { id: string; strategy: 'migrate' | 'cascade'; targetGroupId?: string },
    GroupDeleteResult
  >(
    ({ id, strategy, targetGroupId }) =>
      groupsApi.remove(id, {
        strategy,
        ...(strategy === 'migrate' && targetGroupId ? { targetGroupId } : {}),
      }),
    {
      invalidate: [qk.groupsRoot, qk.boardRoot, qk.tasksRoot, qk.taskAny],
      toastOnError: false,
      onSuccess: (_data, vars) => dropFromScope(vars.id),
    },
  );

  return { create, patch, archive, restore, remove };
}

/**
 * 5.1「归档的分组不出现在默认视图」：归档/删除后，看板切换器与列表页的作用域里
 * 不该继续留着这个分组——否则看板会一直只显示一个已不存在（或已归档）分组下的任务。
 */
function dropFromScope(id: string): void {
  const { groupIds, update } = useGroupingStore.getState();
  if (!groupIds.includes(id)) return;
  update({ groupIds: groupIds.filter((value) => value !== id) });
}
