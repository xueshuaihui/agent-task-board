import { useEffect } from 'react';
import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { api } from '.';
import { qk } from './keys';
import type {
  AuditEntry,
  AuditQuery,
  BoardQuery,
  BoardResponse,
  FieldDef,
  NotificationListResult,
  Page,
  Settings,
  TaskDetail,
  TaskListItem,
  TaskListQuery,
  TaskTab,
} from './types';
import { useUnreadStore } from '@/app/store/unread';

/**
 * 跨 feature 共享的读查询放这一处（key 一律出自 `qk`）。
 * 单页专用的查询写进各自 feature 的 `queries.ts`，但要复用这里的 key 规则：
 * 看板和列表可以各写一次 `useQuery({ queryKey: qk.board(...) })`，
 * 不允许出现第三种 key 形状——WS 失效表只认 `qk` 里的前缀。
 */

type Options<TData> = Pick<
  UseQueryOptions<TData, Error, TData>,
  'enabled' | 'staleTime' | 'refetchInterval' | 'placeholderData' | 'select'
>;

/** 20.7 看板唯一数据源。WS 重连后的强制全量刷也打在这个 key 上（见 src/ws/invalidate.ts）。 */
export function useBoard(params?: BoardQuery, options?: Options<BoardResponse>) {
  const query = useQuery({
    queryKey: qk.board(params),
    queryFn: () => api.board.get(params ?? {}),
    ...options,
  });
  const unread = query.data?.unread_notifications;
  useSyncUnreadCount(unread);
  return query;
}

/** 3.8 列表页 + 审核页的「待审核」表格都走它。 */
export function useTaskList(params: TaskListQuery, options?: Options<Page<TaskListItem>>) {
  return useQuery({
    queryKey: qk.tasks(params),
    queryFn: () => api.tasks.list(params),
    ...options,
  });
}

/** 6.9 字段定义：看板筛选、卡片展示、详情表单、设置页四处都要，所以只此一份缓存。 */
export function useFieldDefs(options?: Options<{ items: FieldDef[] }>) {
  return useQuery({
    queryKey: qk.fieldDefs(),
    queryFn: () => api.fieldDefs.list(),
    staleTime: 30_000,
    ...options,
  });
}

/** 20.3 标签候选。 */
export function useTags(options?: Options<{ tags: string[] }>) {
  return useQuery({
    queryKey: qk.tags(),
    queryFn: () => api.tags.list(),
    staleTime: 30_000,
    ...options,
  });
}

/** 20.9 设置：壳层取 `ui_theme`/`board_column_limit`，设置页取全量。 */
export function useSettings(options?: Options<Settings>) {
  return useQuery({
    queryKey: qk.settings(),
    queryFn: () => api.settings.get(),
    ...options,
  });
}

export function useNotifications(
  params: { unread?: boolean } = {},
  options?: Options<NotificationListResult>,
) {
  const query = useQuery({
    queryKey: qk.notifications(params),
    queryFn: () => api.notifications.list(params),
    ...options,
  });
  useSyncUnreadCount(query.data?.unread_count);
  return query;
}

export function useAudit(params?: AuditQuery, options?: Options<Page<AuditEntry>>) {
  return useQuery({
    queryKey: qk.audit(params),
    queryFn: () => api.audit.list(params),
    ...options,
  });
}

/**
 * 13 章读取模型：抽屉每个 Tab 一个 `['task', id, tab]` 缓存，切走再切回不重复请求。
 * `id` 为 null 时 enabled=false，所以抽屉关闭不会留一个挂着的请求。
 */
export function useTaskTab<TData>(
  id: string | null,
  tab: TaskTab,
  fetcher: (taskId: string) => Promise<TData>,
  ...keyParts: unknown[]
) {
  return useQuery({
    queryKey: qk.taskTab(id ?? '', tab, ...keyParts),
    queryFn: () => fetcher(id as string),
    enabled: Boolean(id),
  });
}

/** 概览单独给一个：`['task', id, 'overview']`，与 `qk.task(id)` 同形。 */
export function useTaskOverview(id: string | null) {
  return useQuery({
    queryKey: qk.task(id ?? ''),
    queryFn: (): Promise<TaskDetail> => api.tasks.detail(id as string),
    enabled: Boolean(id),
  });
}

/** 未读数写进 store 的唯一入口：谁拿到带计数的响应/事件，谁调它。 */
export function syncUnreadCount(count: number | undefined): void {
  if (typeof count === 'number' && Number.isFinite(count)) useUnreadStore.getState().set(count);
}

function useSyncUnreadCount(count: number | undefined): void {
  useEffect(() => {
    syncUnreadCount(count);
  }, [count]);
}
