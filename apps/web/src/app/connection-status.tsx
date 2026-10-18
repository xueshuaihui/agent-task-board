import { useWS } from '@/ws';
import type { WsStatus } from '@/ws';
import { cn } from '@/lib/cn';

/**
 * 顶栏的实时连接状态指示（issue「连接状态丢失」）。
 *
 * WHY 需要常驻指示：以前整棵树里唯一能看出 WS 状态的是 `app.tsx` 那条断线横幅，
 * 而横幅只在「非 open」时渲染——连上的那一刻它就消失得干干净净，界面上再也找不到
 * 「现在到底连没连上」的任何痕迹；断线期间切页/切窗口回来，用户也无从判断数据是否还在实时更新。
 * 这里把 `useWS().status` 的五种态固定摆在顶栏（与 Agent 状态 chip 同一行），
 * 颜色 + 短词 + title 三层可辨：open 绿点、reconnecting 黄点、断开红点、握手前灰点。
 *
 * 交互：非 open 时可点，调 `reconnect()` 走 `WsClient.restart()`（跳过一轮指数退避），
 * 于是「托盘重启服务」之后不必等下一个退避窗口。open 态不做按钮（点了没有语义），
 * 用只读的 `<span>` 呈现，避免一个点了没反应的假按钮。
 *
 * 措辞与 `COPY.wsReconnecting` / `COPY.wsGone` 同源（断线横幅也用同一份文案），
 * 因此不存在「横幅说正在重连、角标说已断开」这种两处不一致。
 */

/** 短词给角标；`title` 给完整一句（点开前先看得懂），`dot` 与状态色板同源。 */
const STATUS_META: Record<WsStatus, { label: string; dot: string; title: string }> = {
  idle: {
    label: '连接中',
    dot: 'bg-border-strong',
    title: '正在建立与本地服务的实时连接…',
  },
  connecting: {
    label: '连接中',
    dot: 'bg-border-strong',
    title: '正在建立与本地服务的实时连接…',
  },
  open: {
    label: '实时连接',
    dot: 'bg-status-done',
    title: '实时连接正常：任务与通知会立即同步',
  },
  reconnecting: {
    label: '重连中',
    dot: 'bg-status-running',
    title: '实时连接已断开，正在重连…（点击立即重试）',
  },
  closed: {
    label: '已断开',
    dot: 'bg-status-failed',
    title: '实时连接已断开（点击重新连接）',
  },
};

export function ConnectionStatus() {
  const { status, reconnect } = useWS();
  const meta = STATUS_META[status];
  const connected = status === 'open';

  const label = (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5">
      <span className={cn('size-1.5 shrink-0 rounded-full', meta.dot)} aria-hidden />
      {meta.label}
    </span>
  );
  const className = 'inline-flex shrink-0 items-center rounded-badge border border-border bg-bg-muted px-2 py-0.5 text-badge';

  if (connected) {
    return (
      <span title={meta.title} className={cn(className, 'text-text-secondary')}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={meta.title}
      aria-label={meta.title}
      onClick={reconnect}
      className={cn(
        className,
        'text-text-primary transition-colors hover:border-primary hover:text-primary',
      )}
    >
      {label}
    </button>
  );
}
