import { useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, Dialog } from '@/components/ui';
import type { BreakdownSession } from '@/api/types';

/**
 * §7.3 两个决策动作的破坏性确认（交付 2「按 PRD」：确认创建批量建任务、取消即弃草案，
 * 都不可逆，一律二次确认）。样式沿 `features/groups/group-delete-dialog.tsx`：
 * 警示图标 + 说明 + danger 主按钮。
 */
export interface SessionActionDialogProps {
  kind: 'confirm' | 'cancel';
  session: BreakdownSession | null;
  draftCount: number;
  busy: boolean;
  onClose: () => void;
  onAction: () => void;
}

export function SessionActionDialog({
  kind,
  session,
  draftCount,
  busy,
  onClose,
  onAction,
}: SessionActionDialogProps) {
  // 退场动画接线（统一套路）：ref 保留末次非空 session + open 受控——
  // session 变 null 时不卸载，Dialog 经历 true→false 过渡帧播 140ms 退场，内容仍是刚才那份。
  const lastSessionRef = useRef<BreakdownSession | null>(null);
  if (session) lastSessionRef.current = session;
  const shown = session ?? lastSessionRef.current;
  if (!shown) return null;
  const isConfirm = kind === 'confirm';
  return (
    <Dialog
      open={session !== null}
      size="form"
      dismissible={!busy}
      onClose={onClose}
      title={isConfirm ? '确认创建任务？' : '取消拆解会话？'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            返回
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={onAction}
            data-testid={isConfirm ? 'breakdown-confirm-go' : 'breakdown-cancel-go'}
          >
            {isConfirm ? `确认创建 ${draftCount + 1} 个任务` : '确认取消'}
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-review" aria-hidden />
        <p className="text-body text-text-primary">
          {isConfirm ? (
            <>
              将按草案批量创建 <b>1 个需求</b>「{shown.parent_title}」与{' '}
              <b>{draftCount} 个子任务</b>，并自动建立依赖、绑定技能（§7.2 阶段 7）。
              点「确认创建」后进入 <b>5 秒撤销窗口</b>（§7.8），倒计时结束前可撤销。
            </>
          ) : (
            <>
              会话「{shown.parent_title}」将标记为<b>已取消</b>，已接收的 {draftCount}{' '}
              条草案不会创建任何任务。
            </>
          )}
        </p>
      </div>
    </Dialog>
  );
}
