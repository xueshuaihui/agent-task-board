import { useShellStore } from './store/shell';
import { TaskDetailDrawer } from '@/features/task-detail';
import { ReviewFormDialog } from '@/features/review';
import { useWSEvent } from '@/ws';

/**
 * 覆盖层宿主：抽屉与审核表单都只在这里挂一份。
 *
 * 为什么不由页面自己渲染：打开任务详情的入口有四个（看板卡片、列表行、审核页表格、
 * 通知跳转），审核表单的入口有三个（拖到「审核」、抽屉「审核 →」、审核页按钮）。
 * 各页面各挂一份就会各有一份缓存和各自的关闭时机，2.1「路由切换不关闭抽屉」直接破功。
 */
export function OverlaySlot() {
  const openTaskId = useShellStore((state) => state.openTaskId);
  const reviewTaskId = useShellStore((state) => state.reviewTaskId);
  const reviewPrefill = useShellStore((state) => state.reviewPrefill);
  const closeTask = useShellStore((state) => state.closeTask);
  const closeReview = useShellStore((state) => state.closeReview);

  // 任务被删后不能留一个空壳抽屉：`src/ws/invalidate.ts` 清掉了数据，
  // 但「该不该收起」是壳层自己的状态，服务端事件在这里只做一次收敛。
  useWSEvent(['task.deleted'], ({ data }) => {
    const shell = useShellStore.getState();
    if (shell.openTaskId === data.task_id) shell.closeTask();
    if (shell.reviewTaskId === data.task_id) shell.closeReview();
  });

  return (
    <>
      <TaskDetailDrawer taskId={openTaskId} onClose={closeTask} />
      <ReviewFormDialog taskId={reviewTaskId} prefill={reviewPrefill} onClose={closeReview} />
    </>
  );
}
