import { useQueries, useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { api } from '@/api';
import { qk } from '@/api/keys';
import type {
  BoardColumn,
  BoardQuery,
  BoardResponse,
  ListSortField,
  Page,
  TaskListItem,
  TaskListQuery,
} from '@/api/types';
import { useGroupingStore } from '@/features/board/grouping/useGroupingState';

/**
 * 7.8 / 4.5「多项目切换」的数据层接缝。
 *
 * 服务端 `GET /board` 与 `GET /tasks` 的 `project_id` 都是**单值**（契约见
 * `apps/api/src/contract/schemas.ts` 的 boardQuerySchema/listQuerySchema），而切换器是
 * 多选。方案对比：
 * - 拉全量后前端过滤——列表分页会被打穿（页内过滤后条数不齐），看板列上限
 *   `board_column_limit` 也会先截断再过滤，直接错；
 * - **每个选中项目各发一次请求、前端按列合并（本实现）**——服务端过滤与列上限都对
 *   每个项目独立生效，N = 已选项目数（本地单用户、并发请求开销可忽略）。
 * 单选与全选（未选 = 全部）仍走原来的单请求，不多花一个 RTT。
 */

type Options<TData> = Pick<UseQueryOptions<TData, Error, TData>, 'enabled' | 'placeholderData'>;

/** 分组 store 里的项目多选（7.8：空数组 = 全部项目）。 */
export function useSelectedProjectIds(): string[] {
  return useGroupingStore((state) => state.projectIds);
}

/**
 * 看板数据源：0/1 个选中项目时走 `useBoard` 的单请求语义（key 仍是 `qk.board(params)`），
 * 多选时拆成每项目一个 `qk.board({...params, project_id})`，按六列对齐合并。
 */
export function useBoardWithProjects(params: BoardQuery, options?: Options<BoardResponse>) {
  const projectIds = useSelectedProjectIds();
  const multi = projectIds.length > 1;

  const single = useQuery({
    queryKey: qk.board(multi ? params : withProject(params, projectIds[0])),
    queryFn: () => api.board.get(multi ? params : withProject(params, projectIds[0])),
    // 多选时单请求不发货（结果不进返回值），只保留 hook 的形状给调用方。
    enabled: multi ? false : options?.enabled,
    placeholderData: options?.placeholderData,
  });

  const results = useQueries({
    queries: multi
      ? projectIds.map((id) => ({
          queryKey: qk.board(withProject(params, id)),
          queryFn: () => api.board.get(withProject(params, id)),
        }))
      : [],
  });

  if (!multi) return single;

  const pending = results.some((result) => result.isPending);
  const failed = results.find((result) => result.isError);
  const data = pending || failed ? undefined : mergeBoards(results.map((result) => result.data));
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

/** 列表页数据源：多选时同样每项目一请求；分页语义见文件头的方案说明。 */
export function useTaskListWithProjects(params: TaskListQuery, options?: Options<Page<TaskListItem>>) {
  const projectIds = useSelectedProjectIds();
  const multi = projectIds.length > 1;

  const single = useQuery({
    queryKey: qk.tasks(multi ? params : withProject(params, projectIds[0])),
    queryFn: () => api.tasks.list(multi ? params : withProject(params, projectIds[0])),
    enabled: multi ? false : options?.enabled,
    placeholderData: options?.placeholderData,
  });

  const results = useQueries({
    queries: multi
      ? projectIds.map((id) => ({
          queryKey: qk.tasks(withProject(params, id)),
          queryFn: () => api.tasks.list(withProject(params, id)),
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

/* ------------------------------------------------------------------ 合并 */

function withProject<T extends { project_id?: string }>(params: T, projectId?: string): T {
  return projectId ? { ...params, project_id: projectId } : params;
}

function isPage(value: unknown): value is Page<import('@/api/types').TaskListItem> {
  return typeof value === 'object' && value !== null && 'items' in value;
}

/**
 * 六列一一对应合并：任务拼一起、计数求和、`has_more` 取或（任一项目还有更多就该显示
 * 「还有 N 条」）。列内顺序沿用各项目请求自己的 pinned/优先级序，项目之间按切换器的选择序。
 */
function mergeBoards(boards: (BoardResponse | undefined)[]): BoardResponse | undefined {
  const valid = boards.filter((board): board is BoardResponse => board !== undefined);
  if (valid.length === 0) return undefined;
  const byStatus = new Map<string, BoardColumn>();
  for (const board of valid) {
    for (const column of board.columns) {
      const merged = byStatus.get(column.status);
      if (merged) {
        merged.tasks.push(...column.tasks);
        merged.count += column.count;
        merged.has_more = merged.has_more || column.has_more;
      } else {
        byStatus.set(column.status, { ...column, tasks: [...column.tasks] });
      }
    }
  }
  // 以第一份响应的列序为准（20.7 固定六列、固定顺序），缺列补空。
  const columns = valid[0].columns.map(
    (column) => byStatus.get(column.status) ?? { ...column, tasks: [], count: 0, has_more: false },
  );
  return {
    generated_at: valid[0].generated_at,
    columns,
    unread_notifications: Math.max(...valid.map((board) => board.unread_notifications)),
  };
}

/**
 * 分页合并：每项目各取一页，items 拼接后按当前排序键重排，total 求和。
 * 深翻页时页界不再严格等于全集的第 N 页（每项目先各截一页），这是单值接口下的取舍。
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
