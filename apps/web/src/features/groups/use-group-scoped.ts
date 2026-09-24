import { useQueries, useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { api } from '@/api';
import { qk } from '@/api/keys';
import type {
  BoardQuery,
  BoardResponse,
  ListSortField,
  Page,
  TaskListItem,
  TaskListQuery,
} from '@/api/types';
import { useFilterStore } from '@/app/store/filters';

/**
 * 7.8 / 4.5「多分组切换」的数据层接缝。
 *
 * B15-①：`GET /board` 的 `groups` 已是多值（维内 OR），看板不再按分组扇出合并。
 * B15-②b：分组作用域并入统一过滤 store（`useFilterStore.groups`），旧的
 * `useGroupingStore/groupIds` 随之下线。`GET /tasks` 的 `group_id` 仍是单值契约——
 * 列表页多选分组继续走「每分组一请求 + 前端按列/按页合并」，N = 已选分组数
 * （本地单用户可忽略）。单选与全选（未选 = 全部）不多花一个 RTT。
 */

type Options<TData> = Pick<UseQueryOptions<TData, Error, TData>, 'enabled' | 'placeholderData'>;

/** 统一过滤 store 里的分组多选（7.8：空数组 = 全部分组；`none` = 未归属）。 */
export function useSelectedGroupIds(): string[] {
  return useFilterStore((state) => state.groups);
}

/**
 * 看板数据源：`groups` 的 URL 读写与查询派发已整体归列表路由——
 * `toBoardQuery` **恒不带出 groups**（§19.14：store 的 groups 键只服务列表作用域），
 * 看板请求因此永不发 `groups=`。本包装对 `GET /board` 只是单请求直传的历史壳，
 * 「WithGroups」之名是 B15 多分组扇出时代的遗留，保留以稳住调用点
 * （features/board/index.tsx 在禁改面内）。
 */
export function useBoardWithGroups(params: BoardQuery, options?: Options<BoardResponse>) {
  return useQuery({
    queryKey: qk.board(params),
    queryFn: () => api.board.get(params),
    enabled: options?.enabled,
    placeholderData: options?.placeholderData,
  });
}

/** 列表页数据源：多选时同样每分组一请求；分页语义见文件头的方案说明。 */
export function useTaskListWithGroups(params: TaskListQuery, options?: Options<Page<TaskListItem>>) {
  const groupIds = useSelectedGroupIds();
  const multi = groupIds.length > 1;

  const single = useQuery({
    queryKey: qk.tasks(multi ? params : withGroup(params, groupIds[0])),
    queryFn: () => api.tasks.list(multi ? params : withGroup(params, groupIds[0])),
    enabled: multi ? false : options?.enabled,
    placeholderData: options?.placeholderData,
  });

  const results = useQueries({
    queries: multi
      ? groupIds.map((id) => ({
          queryKey: qk.tasks(withGroup(params, id)),
          queryFn: () => api.tasks.list(withGroup(params, id)),
        }))
      : [],
  });

  if (!multi) return single;

  const pending = results.some((result) => result.isPending);
  const failed = results.find((result) => result.isError);
  const data =
    pending || failed
      ? undefined
      : mergePages(results.map((result) => result.data).filter(isPage), params);
  return {
    ...single,
    data,
    isPending: pending,
    isError: Boolean(failed),
    error: failed?.error ?? null,
    refetch: async () => {
      await Promise.all(results.map((result) => result.refetch()));
    },
  };
}

/* ------------------------------------------------------------------ 合并（列表页专用，见文件头） */

function withGroup<T extends { group_id?: string }>(params: T, groupId?: string): T {
  return groupId ? { ...params, group_id: groupId } : params;
}

function isPage(value: unknown): value is Page<import('@/api/types').TaskListItem> {
  return typeof value === 'object' && value !== null && 'items' in value;
}

/**
 * 分页合并：每分组各取一页，items 拼接后按当前排序键重排，total 求和。
 * 深翻页时页界不再严格等于全集的第 N 页（每分组先各截一页），这是单值接口下的取舍。
 */
function mergePages(
  pages: Page<import('@/api/types').TaskListItem>[],
  params: TaskListQuery,
): Page<import('@/api/types').TaskListItem> {
  const items = pages.flatMap((page) => page.items);
  sortItems(items, params.sort ?? 'updated_at', params.order ?? 'desc');
  return {
    items,
    total: pages.reduce((sum, page) => sum + page.total, 0),
    page: params.page ?? 1,
    page_size: params.page_size ?? 50,
  };
}

type SortableRow = { id: string; priority: number; status: string; created_at?: string | null; updated_at?: string | null };

function sortItems(items: SortableRow[], field: ListSortField, order: 'asc' | 'desc'): void {
  const dir = order === 'asc' ? 1 : -1;
  items.sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
  });
}
