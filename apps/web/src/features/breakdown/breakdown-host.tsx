import { AnimatePresence } from 'motion/react';
import { createPortal } from 'react-dom';
import { ListChecks } from 'lucide-react';
import { errorMessage } from '@/api';
import { useWSEvent } from '@/ws';
import { cn } from '@/lib/cn';
import { isBreakdownPending } from './status-meta';
import { useBreakdownSessions } from './queries';
import { BreakdownOverlay } from './breakdown-overlay';
import { useBreakdownOverlayStore } from './store';

/**
 * 拆解覆盖层的全局宿主（`app/overlay-slot.tsx` 挂一次）：
 * - 阶段 2（§7.2）：`breakdown.started` 到达且当前不在拆解页 → 自动进入最新会话；
 *   已在页内时只让切换器长出一枚新会话（列表查询由 ws/invalidate 刷新），不抢视图。
 * - 浮标入口：覆盖层关闭、且存在未终结会话（接收中/待确认/创建中）时，右下角常驻
 *   计数入口——错过 WS 瞬间或从托盘回来后进页不回翻路由（§7.3「不是独立路由」）。
 *   会话列表报错时浮标也要出现（数字给「—」）：隐藏浮标等于把失败说成「没有待处理会话」。
 * - 数据失效不在这里写：breakdown.* 五条已接进 `src/ws/invalidate.ts` 的统一表。
 */
export function BreakdownOverlayHost() {
  const open = useBreakdownOverlayStore((state) => state.open);
  const hide = useBreakdownOverlayStore((state) => state.hide);
  const sessions = useBreakdownSessions();
  const pendingCount = (sessions.data ?? []).filter((s) => isBreakdownPending(s.status)).length;
  /* 计数档（2026-09-29「列表报错被渲染成空状态」）：报错时 `sessions.data ?? []` 把待处理数折成 0，
   * 而 0 在本处的既有语义是「隐藏浮标」——失败与「确实没有待处理会话」于是长得一模一样。
   * 报错时浮标照常出现、数字给「—」（0 是一个断言，破折号不是），文案说明是加载失败；
   * 点进去由覆盖层给细化文案 + 折叠详情（浮标自身是 <button>，不能再嵌折叠按钮）。 */
  const showPill = !open && (sessions.isError || pendingCount > 0);

  useWSEvent(['breakdown.started'], ({ data }) => {
    const store = useBreakdownOverlayStore.getState();
    if (!store.open) store.show(data.session_id);
  });

  return (
    <>
      {createPortal(
        <AnimatePresence>
          {open ? <BreakdownOverlay key="breakdown-overlay" onClose={hide} /> : null}
        </AnimatePresence>,
        document.body,
      )}
      {showPill
        ? createPortal(
            <button
              type="button"
              onClick={() => useBreakdownOverlayStore.getState().show()}
              title={sessions.isError ? errorMessage(sessions.error) : undefined}
              data-testid="breakdown-entry-pill"
              className={cn(
                'fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-control border border-border bg-bg-surface px-3 py-2 text-aux text-text-primary shadow-card-hover transition-colors hover:bg-bg-muted',
                sessions.isError && 'border-status-failed',
              )}
            >
              <ListChecks className={cn('size-4', sessions.isError ? 'text-status-failed' : 'text-primary')} aria-hidden />
              {sessions.isError ? '拆解会话 —（加载失败）' : `拆解会话 ${pendingCount}`}
              <span aria-hidden className="size-1.5 rounded-full bg-status-failed" />
            </button>,
            document.body,
          )
        : null}
    </>
  );
}
