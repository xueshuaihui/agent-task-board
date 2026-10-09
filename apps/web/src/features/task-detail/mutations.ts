import { api, qk, useApiMutation } from '@/api';
import type {
  CommentInput,
  DependencyType,
  TaskPatchInput,
  TaskStatus,
} from '@/api';

/**
 * 抽屉的写入层。全部走基座的 `useApiMutation`：失败必弹 Toast（10.4），
 * 成功必失效 `qk.taskRoot(id)` —— 抽屉的六个 Tab、日志分页、产物缓存都挂在这个前缀下，
 * 于是「改完标题概览就旧了」这类问题不会出现第二次。
 *
 * 看板与列表页也一起失效：抽屉里的流转/编辑会让列位变化（原型 4.9「卡片列位变化 + 顶部 Toast」）。
 */

/**
 * 基座的 `TaskPatchInput` 由 `Partial<TaskCreateInput>` 与 `{description?: string|null}`
 * 交叉而来，清空字段要写的 `null` 会被交叉类型吃掉。抽屉需要「把描述/截止时间清空」
 * （4.4 编辑态），所以在本 feature 内补一层口径，不改 `src/api`。
 */
export type DrawerTaskPatch = Omit<TaskPatchInput, 'description' | 'due_at'> & {
  description?: string | null;
  due_at?: string | null;
};

/** 每个写操作都要打的三个前缀（20.7：board 是看板唯一数据源，不能只刷 tasks）。 */
function keysFor(taskId: string): readonly (readonly unknown[])[] {
  return [qk.taskRoot(taskId), qk.boardRoot, qk.tasksRoot];
}

export function usePatchTask(taskId: string) {
  return useApiMutation(
    (body: DrawerTaskPatch) => api.tasks.patch(taskId, body as TaskPatchInput),
    { invalidate: () => keysFor(taskId) },
  );
}

export function useSetPinned(taskId: string, pinned: boolean) {
  return useApiMutation(
    () => (pinned ? api.tasks.unpin(taskId) : api.tasks.pin(taskId)),
    { invalidate: () => keysFor(taskId) },
  );
}

/** 4.3 操作表：确认可执行 / 撤回 / 重试 / 退回需求池都是 transition，非法流转 409 由服务端文案兜。 */
export function useTransitionTask(taskId: string) {
  return useApiMutation(
    (to: TaskStatus) => api.tasks.transition(taskId, { to }),
    { invalidate: () => keysFor(taskId) },
  );
}

/** 4.3.1 规则 2：强制停止只吊销租约，确认文案必须写明「Agent 可能仍在继续执行」。 */
export function useStopTask(taskId: string) {
  return useApiMutation(
    (reason?: string) => api.tasks.stop(taskId, reason ? { reason } : {}),
    { invalidate: () => keysFor(taskId) },
  );
}

export function useArchiveTask(taskId: string) {
  return useApiMutation(() => api.tasks.archive(taskId), {
    invalidate: () => keysFor(taskId),
  });
}

/** 4.3「恢复」：清 `archived_at`，仅已归档任务用得到（6.13.1）。 */
export function useRestoreTask(taskId: string) {
  return useApiMutation(() => api.tasks.restore(taskId), {
    invalidate: () => keysFor(taskId),
  });
}

export function useDeleteTask(taskId: string) {
  return useApiMutation(() => api.tasks.remove(taskId), {
    invalidate: [qk.taskAny, qk.boardRoot, qk.tasksRoot],
  });
}

/**
 * 5.8 添加依赖：`409 DEPENDENCY_CYCLE` 要**留在弹窗里**显示链路，不弹 Toast
 * （Toast 3 秒就没了，而用户需要照着链路决定删哪条边）。
 */
export function useAddDependency(taskId: string) {
  return useApiMutation(
    (vars: { depends_on: string; type: DependencyType }) =>
      api.tasks.addDependency(taskId, vars),
    { invalidate: () => keysFor(taskId), toastOnError: false },
  );
}

export function useRemoveDependency(taskId: string) {
  return useApiMutation(
    (depId: string) => api.tasks.removeDependency(taskId, depId),
    { invalidate: () => keysFor(taskId) },
  );
}

/** 4.8：评论只有「新增」，编辑与删除都不提供（`comments` 无 updated_at / deleted_at）。 */
export function useAddComment(taskId: string) {
  return useApiMutation(
    (body: CommentInput) => api.tasks.addComment(taskId, body),
    { invalidate: () => keysFor(taskId) },
  );
}
