import { api, qk, useApiMutation } from '@/api';
import type { TaskCard, TaskCreateInput, TaskDetail, TaskPatchInput, TaskStatus } from '@/api/types';
import { STATUS_LABEL } from '@/lib/labels';
import { useToast } from '@/components/ui';

/**
 * 看板的全部写操作。三条统一约定（基座注释里也写了）：
 * - 失效只打 `qk.*` 前缀，写完不手 refetch；
 * - 失败一律先 Toast 服务端 `message`（4.5 的文案由服务端单点产出），
 *   只有需要内联回显字段错误的表单（快速新建）把 `toastOnError` 关掉；
 * - 不做「先动卡片再回滚」的乐观更新（PRD 7.2）：卡片位置只跟 `/board` 的返回走。
 */
export function useBoardMutations() {
  const toast = useToast();

  /** 4.5 的 ✅ 落点与卡片菜单里的流转项共用这一条。 */
  const move = useApiMutation<{ id: string; to: TaskStatus }, unknown>(
    ({ id, to }) => api.tasks.transition(id, { to }),
    {
      invalidate: ({ vars }) => [qk.boardRoot, qk.tasksRoot, qk.taskRoot(vars.id)],
      onSuccess: (_data, vars) => toast.success(`任务已移到「${STATUS_LABEL[vars.to]}」`),
    },
  );

  /** 4.3：置顶不改状态，只影响抓取顺序（5.6）。 */
  const togglePin = useApiMutation<TaskCard, TaskCard>(
    (card) => (card.pinned ? api.tasks.unpin(card.id) : api.tasks.pin(card.id)),
    {
      invalidate: ({ vars }) => [qk.boardRoot, qk.tasksRoot, qk.taskRoot(vars.id)],
      onSuccess: (card) => toast.success(card.pinned ? '已置顶' : '已取消置顶'),
    },
  );

  /** 4.3.1 规则 2：只吊销租约，不下发中止指令。 */
  const stop = useApiMutation<{ id: string; reason?: string }, unknown>(
    ({ id, reason }) => api.tasks.stop(id, reason ? { reason } : {}),
    {
      invalidate: ({ vars }) => [qk.boardRoot, qk.tasksRoot, qk.taskRoot(vars.id)],
      onSuccess: (_data, vars) => toast.warning('已强制停止', `${vars.id} 转入异常/失败`),
    },
  );

  /** 6.13：仅 DONE；被依赖阻塞时服务端回 `409 ARCHIVE_BLOCKED_BY_DEPENDENCY`，文案即 4.5 那句。 */
  const archive = useApiMutation<string, { id: string; archived: true }>(
    (id) => api.tasks.archive(id),
    {
      invalidate: ({ vars }) => [qk.boardRoot, qk.tasksRoot, qk.taskRoot(vars)],
      onSuccess: (_data, id) => toast.success('任务已归档', `${id} 移出看板`),
    },
  );

  /** 4.3.1 规则 4：物理删除并级联；响应带回滚不回来的 N/M，用在成功提示里说清楚。 */
  const remove = useApiMutation<string, { id: string; deleted_runs: number; unblocked_ids: string[] }>(
    (id) => api.tasks.remove(id),
    {
      invalidate: [qk.boardRoot, qk.tasksRoot, qk.taskAny],
      onSuccess: (result) => {
        const unblocked = result.unblocked_ids.length;
        toast.success(
          `已删除 ${result.id}`,
          `同时删除 ${result.deleted_runs} 条执行记录及其产物${unblocked > 0 ? `；${unblocked} 个下游任务已解除阻塞` : ''}`,
        );
      },
    },
  );

  /** 列底快速新建：创建恒落 BACKLOG（服务端 `create` 写死），进 READY 要靠 `advance`。 */
  const create = useApiMutation<TaskCreateInput, TaskDetail>(
    (body) => api.tasks.create(body),
    {
      invalidate: [qk.boardRoot, qk.tasksRoot],
      toastOnError: false,
    },
  );

  /** 快速新建的第二次提交：任务已落在需求池，补填的字段先 PATCH 再流转（不重复建行）。 */
  const patch = useApiMutation<{ id: string; body: TaskPatchInput }, unknown>(
    ({ id, body }) => api.tasks.patch(id, body),
    {
      invalidate: ({ vars }) => [qk.boardRoot, qk.tasksRoot, qk.taskRoot(vars.id)],
      toastOnError: false,
    },
  );

  /** 6.9.2 的拦截点：必填自定义字段未填时服务端 422，任务留在需求池。 */
  const advance = useApiMutation<string, unknown>(
    (id) => api.tasks.transition(id, { to: 'READY' }),
    {
      invalidate: ({ vars }) => [qk.boardRoot, qk.tasksRoot, qk.taskRoot(vars)],
      toastOnError: false,
    },
  );

  return { move, togglePin, stop, archive, remove, create, patch, advance };
}

export type BoardMutations = ReturnType<typeof useBoardMutations>;
