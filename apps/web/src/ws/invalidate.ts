import type { QueryClient } from '@tanstack/react-query';
import { qk } from '@/api/keys';
import { syncUnreadCount } from '@/api/queries';
import type { WsFrame } from '@/api/types';
import { useFlashStore } from '@/app/store/flash';

/**
 * WS 事件 → react-query 失效：**事件只当失效信号，不做本地增量**（13 章读取模型）。
 * 抽屉是单任务视图、看板是六列快照，重取一次比维护「卡片移动 + Run 状态 + 日志追加」的
 * 增量一致便宜，也避开分页边界上的歧义。
 *
 * 这张表是**唯一**的接线处：feature 不要再自己监听事件去 invalidate，
 * 需要渲染态（高亮、倒计时变红）时用 `useWSEvent` 订阅，别改这张表之外的失效逻辑。
 */

/** 一条事件影响的查询前缀；`taskKey` 为该事件能定位到的任务 id。 */
export function keysForEvent(frame: WsFrame): readonly (readonly unknown[])[] {
  const taskIds = taskIdsOf(frame);
  switch (frame.event) {
    case 'notification.created':
      // 2.2 / 2.3：铃铛与托盘角标只订阅这一个事件，计数由服务端算好带上，不回查列表。
      syncUnreadCount(frame.data.unread_count);
      return [qk.notificationsRoot];
    case 'task.deleted':
      // 删除后既没有 board 里的那张卡，也没有可缓存的抽屉数据；顺带清掉被解锁的下游任务。
      return [qk.boardRoot, qk.tasksRoot, qk.taskAny];
    case 'group.archived':
    case 'group.unarchived':
      // v0.0.4 W4 §5.6 r3：归档/恢复改变分组集合与看板泳道（归档组默认隐藏、
      // claim 排除不改变任务行本身），分组列表与两棵任务树一起失效。
      return [qk.groupsRoot, qk.boardRoot, qk.tasksRoot];
    case 'breakdown.started':
    case 'breakdown.progress':
    case 'breakdown.task_draft':
    case 'breakdown.finished':
    case 'breakdown.cancelled':
      // v0.0.4 W7 §16.3 拆解五条：载荷带 session_id/ref 也只当失效信号，
      // 会话列表与打开着的详情回 GET 拿真相（confirm 建的 task.created 走 default 分支刷看板）。
      return [qk.breakdownRoot];
    default:
      return taskIds.length
        ? [qk.boardRoot, qk.tasksRoot, ...taskIds.map((id) => qk.taskRoot(id))]
        : [qk.boardRoot, qk.tasksRoot];
  }
}

/** 13 章十个事件的载荷字段名不统一（`id` / `task_id` / `unblocked_ids`），这里一次收敛。 */
function taskIdsOf(frame: WsFrame): string[] {
  const data = frame.data as Record<string, unknown>;
  const ids = new Set<string>();
  for (const key of ['id', 'task_id']) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) ids.add(value);
  }
  const unblocked = data.unblocked_ids;
  if (Array.isArray(unblocked)) {
    for (const value of unblocked) if (typeof value === 'string') ids.add(value);
  }
  return [...ids];
}

export function applyEvent(queryClient: QueryClient, frame: WsFrame): void {
  for (const key of keysForEvent(frame)) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
  // 分组事件的 `id` 是分组 id，不是任务 id——闪卡名单只收任务侧事件。
  if (frame.event === 'group.archived' || frame.event === 'group.unarchived') return;
  const ids = taskIdsOf(frame);
  if (ids.length > 0) useFlashStore.getState().mark(ids);
}

/**
 * 重连成功后的强制全量刷（13 章 WS 连接约定）：
 * 断线期间落掉的事件不会补发，只增量失效会让本地列与服务端不一致——
 * 表现就是「拖过去的卡片还在原列」，比多打一次 `/board` 贵得多。
 */
export function refreshAfterReconnect(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.boardRoot, refetchType: 'active' });
  void queryClient.invalidateQueries({ queryKey: qk.tasksRoot, refetchType: 'active' });
  void queryClient.invalidateQueries({ queryKey: qk.notificationsRoot, refetchType: 'active' });
  // W4：断线期间错过 group.archived/unarchived 时，分组集合（含归档折叠区）也要回服务端真相。
  void queryClient.invalidateQueries({ queryKey: qk.groupsRoot, refetchType: 'active' });
  // W7：同理，断线期间错过的 breakdown.* 五条不补发——拆解会话列表与打开着的确认页一起重取。
  void queryClient.invalidateQueries({ queryKey: qk.breakdownRoot, refetchType: 'active' });
  // 打开着的抽屉也要回到服务端真相。
  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey;
    if (Array.isArray(key) && key[0] === 'task') {
      void queryClient.invalidateQueries({ queryKey: key as readonly unknown[], refetchType: 'active' });
    }
  }
}
