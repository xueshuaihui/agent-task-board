import { useRef, useState, type ReactNode } from 'react';
import type { TaskDetail } from '@/api';
import { Button, Dialog, useToast } from '@/components/ui';
import { statusLabel } from '@/lib/labels';
import { COPY } from '@/lib/copy';
import { useShellStore } from '@/app/store/shell';
import { actionsFor, headerMenuItems, type TaskAction } from './actions';
import {
  useArchiveTask,
  useDeleteTask,
  useRestoreTask,
  useStopTask,
  useTransitionTask,
} from './mutations';

/**
 * 抽屉里所有写动作的唯一执行处（原型 4.9 底部按钮 + 4.2 右上 `⋯` 都调它）。
 *
 * 4.9 要求「改状态成功的反馈是卡片列位变化 + 顶部 Toast，抽屉不自动关闭」，
 * 基座 `useApiMutation` 只负责失败 Toast，所以成功提示在这里补；
 * 抽屉不关闭、数据刷新交给 `src/ws/invalidate.ts` 的失效（本文件不写 invalidateQueries）。
 */
export interface DrawerActionsOptions {
  detail: TaskDetail;
  /** 4.9「查看日志」：切到执行 Tab 并展开当前 Run 的日志块。 */
  onJumpToLogs: (runId: string | null) => void;
}

export interface DrawerActionsApi {
  actions: TaskAction[];
  /** 4.2 右上 `⋯` 与 4.9 底部 `⋯` 共用这一份（原型 3.3：同一份按状态生成的动作集）。 */
  menuActions: TaskAction[];
  /** 有确认文案的动作会先弹二次确认（4.3.1 规则 2、4）。 */
  run: (action: TaskAction) => void;
  /** 正在飞的动作用来做按钮 loading，避免用户连点。 */
  busyId: TaskAction['id'] | null;
  copyId: () => void;
  confirmNode: ReactNode;
}

export function useDrawerActions({ detail, onJumpToLogs }: DrawerActionsOptions): DrawerActionsApi {
  const toast = useToast();
  const [busyId, setBusyId] = useState<TaskAction['id'] | null>(null);
  const [confirmAction, setConfirmAction] = useState<TaskAction | null>(null);

  const transition = useTransitionTask(detail.id);
  const stop = useStopTask(detail.id);
  const archive = useArchiveTask(detail.id);
  const restore = useRestoreTask(detail.id);
  const remove = useDeleteTask(detail.id);

  const actions = actionsFor(detail);

  const settle = (action: TaskAction) => ({
    onSettled: () => setBusyId(null),
    onSuccess: () => {
      toast.success(successText(action));
      setConfirmAction(null);
    },
  });

  const perform = (action: TaskAction) => {
    setBusyId(action.id);
    switch (action.id) {
      case 'review':
      case 'reject_rerun':
        setBusyId(null);
        // 4.3：退回重跑等价于「弹审核表单并预填 结论=驳回」，表单在 features/review，抽屉不复制一份。
        useShellStore
          .getState()
          .openReview(detail.id, action.id === 'reject_rerun' ? { conclusion: 'REJECT' } : null);
        return;
      case 'view_logs':
        setBusyId(null);
        onJumpToLogs(detail.current_run_id);
        return;
      case 'stop':
        stop.mutate(undefined, settle(action));
        return;
      case 'archive':
        archive.mutate(undefined, settle(action));
        return;
      case 'restore':
        restore.mutate(undefined, settle(action));
        return;
      case 'delete':
        remove.mutate(undefined, {
          ...settle(action),
          onSuccess: (data) => {
            toast.success(
              `已删除 ${data.id}`,
              COPY.deleteConfirm(data.deleted_runs, data.unblocked_ids.length),
            );
            setConfirmAction(null);
          },
        });
        return;
      default:
        if (action.to) transition.mutate(action.to, settle(action));
        else setBusyId(null);
    }
  };

  const run = (action: TaskAction) => {
    if (action.confirm) {
      setConfirmAction(action);
      return;
    }
    perform(action);
  };

  const copyId = () => {
    void navigator.clipboard
      ?.writeText(detail.id)
      .then(() => toast.success(`已复制 ${detail.id}`))
      .catch(() => toast.info(detail.id));
  };

  // 退场动画接线（统一套路）：ref 保留末次非空 confirmAction + open 受控——
  // 关闭时 Dialog 不立即卸载（return null），经历 true→false 过渡帧播 140ms 退场，内容仍是刚才那份。
  const lastConfirmRef = useRef<TaskAction | null>(null);
  if (confirmAction) lastConfirmRef.current = confirmAction;
  const shownConfirm = confirmAction ?? lastConfirmRef.current;
  const confirmNode = shownConfirm ? (
    <Dialog
      open={confirmAction !== null}
      title={shownConfirm.confirm?.title ?? '确认操作'}
      onClose={() => setConfirmAction(null)}
      footer={
        <>
          <Button size="sm" onClick={() => setConfirmAction(null)}>
            取消
          </Button>
          <Button
            size="sm"
            variant={shownConfirm.danger ? 'danger' : 'primary'}
            loading={busyId === shownConfirm.id}
            onClick={() => perform(shownConfirm)}
          >
            {shownConfirm.label}
          </Button>
        </>
      }
    >
      <p className="text-body text-text-primary">{detail.title}</p>
      <p className="mt-2 text-body text-text-secondary">{shownConfirm.confirm?.body}</p>
      {shownConfirm.id === 'delete' ? (
        <p className="mt-2 text-aux text-text-tertiary">
          物理删除并级联产物文件，不可撤销（4.3.1 规则 4）。
        </p>
      ) : null}
    </Dialog>
  ) : null;

  return { actions, menuActions: headerMenuItems(actions), run, busyId, copyId, confirmNode };
}

function successText(action: TaskAction): string {
  switch (action.id) {
    case 'stop':
      return '已强制停止：租约已吊销，任务转为异常/失败';
    case 'archive':
      return '已归档（任务列表页「已归档」可查，6.13.1）';
    case 'restore':
      return '已恢复为未归档';
    case 'delete':
      return '已删除任务';
    default:
      return action.to ? `已转为「${statusLabel(action.to)}」` : '已更新';
  }
}
