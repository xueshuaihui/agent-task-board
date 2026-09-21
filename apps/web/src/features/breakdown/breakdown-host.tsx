import { AnimatePresence } from 'motion/react';
import { createPortal } from 'react-dom';
import { ListChecks } from 'lucide-react';
import { useWSEvent } from '@/ws';
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
 * - 数据失效不在这里写：breakdown.* 五条已接进 `src/ws/invalidate.ts` 的统一表。
 */
export function BreakdownOverlayHost() {
  const open = useBreakdownOverlayStore((state) => state.open);
  const hide = useBreakdownOverlayStore((state) => state.hide);
  const sessions = useBreakdownSessions();
  const pendingCount = (sessions.data ?? []).filter((s) => isBreakdownPending(s.status)).length;

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
      {!open && pendingCount > 0
        ? createPortal(
            <button
              type="button"
              onClick={() => useBreakdownOverlayStore.getState().show()}
              data-testid="breakdown-entry-pill"
              className="fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-control border border-border bg-bg-surface px-3 py-2 text-aux text-text-primary shadow-card-hover transition-colors hover:bg-bg-muted"
            >
              <ListChecks className="size-4 text-primary" aria-hidden />
              拆解会话 {pendingCount}
              <span aria-hidden className="size-1.5 rounded-full bg-status-failed" />
            </button>,
            document.body,
          )
        : null}
    </>
  );
}
