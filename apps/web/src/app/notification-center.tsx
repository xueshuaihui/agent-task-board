import { useMemo } from 'react';
import { CheckCheck, Inbox } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { api, qk, useApiMutation, useNotifications } from '@/api';
import type { NotificationItem } from '@/api/types';
import { useShellStore } from '@/app/store/shell';
import { useUnreadStore, badgeText } from '@/app/store/unread';
import { navigate } from '@/app/router';
import { Button, IconButton } from '@/components/ui';
import { transitions } from '@/lib/motion';
import { formatRelative } from '@/lib/time';
import { cn } from '@/lib/cn';

/**
 * v0.0.4 W9 13.9 通知中心：从左侧弹出的面板（13.8「覆盖内容区」），
 * 数据源为存量 `GET /api/v1/notifications` 与 WS `notification.created`（无新增存储，验收 80）。
 *
 * 归类（13.9）：
 * - 「待处理」= 含用户动作的通知。本版存量里只有 `review_pending`（待审核）属于此类；
 *   PRD 新提的 breakdown / creation_request 两组规则后端尚未落库（见报告缺口），
 *   这里按 kind 白名单预留，命中即归「待处理」，未来后端补上即自动生效。
 * - 「一般通知」= 其余（run_failed / lease_expired / review_rejected / task_unblocked）。
 *
 * 交互：
 * - 打开时拉全量（含已读，便分组与展示时间）；未读项前置 ● 标记。
 * - 点单条：标该条已读 + 跳转（有 task_id 开详情抽屉；review_pending 兼跳审核页）。
 * - 「全部已读」：markRead(all) → 角标清零、列表重取。
 * - 角标数字复用 unread store（WS 与列表响应同源，见 store/unread.ts）。
 */

/** 需要用户动作、归入「待处理」的 kind（PRD 预留 breakdown / creation_request 两组）。 */
const ACTIONABLE_KINDS = new Set<string>([
  'review_pending',
  'breakdown_pending',
  'breakdown_confirm',
  'creation_request',
  'task_blocked',
]);

function isActionable(item: NotificationItem): boolean {
  return ACTIONABLE_KINDS.has(item.kind);
}

export function NotificationCenter() {
  const open = useShellStore((state) => state.notificationOpen);
  const setOpen = useShellStore((state) => state.setNotificationOpen);
  const reducedMotion = useReducedMotion();
  const close = () => setOpen(false);

  const count = useUnreadStore((state) => state.count);
  const badge = badgeText(count);

  // 打开才拉全量列表（含已读）；关闭时不发这条请求。
  const list = useNotifications({}, { enabled: open });
  const items = useMemo(() => list.data?.items ?? [], [list.data?.items]);

  const { actionable, general } = useMemo(() => {
    const actionable: NotificationItem[] = [];
    const general: NotificationItem[] = [];
    for (const item of items) (isActionable(item) ? actionable : general).push(item);
    return { actionable, general };
  }, [items]);

  const markRead = useApiMutation<{ ids?: string[]; all?: boolean }, { updated: number }>(
    (body) => api.notifications.markRead(body),
    {
      invalidate: [qk.notificationsRoot],
      onSuccess: (data) => {
        if (data.updated > 0) useUnreadStore.getState().bump(-data.updated);
      },
    },
  );

  const markAll = () => {
    if (count > 0) markRead.mutate({ all: true });
  };

  const openItem = (item: NotificationItem) => {
    if (item.read_at === null) markRead.mutate({ ids: [item.id] });
    // 跳转：review_pending 落审核页；其余有 task_id 的打开详情抽屉。
    if (item.kind === 'review_pending') navigate('review');
    else if (item.task_id) useShellStore.getState().openTask(item.task_id);
    close();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => setOpen(next)}>
      <AnimatePresence>
        {open ? (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay key="nc-overlay" forceMount asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                // 遮罩淡入随面板（overlay 200ms）、淡出 140ms（§4.4）
                exit={{ opacity: 0, transition: transitions.exit }}
                transition={transitions.overlay}
                className="fixed inset-y-0 right-0 z-40 bg-black/45 backdrop-blur-[2px] dark:bg-black/60"
                style={{ left: 'var(--atb-nav-w, 0px)' }}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content
              key="nc-panel"
              forceMount
              asChild
              aria-describedby={undefined}
            >
              <motion.aside
                {...(reducedMotion
                  ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
                  : {
                      initial: { opacity: 0, x: '-100%' },
                      animate: { opacity: 1, x: 0 },
                      // 退场比入场快（§1-L2）：180ms drawerOut，盖过组件级 drawer 档
                      exit: { opacity: 0, x: '-100%', transition: transitions.drawerOut },
                    })}
                transition={transitions.drawer}
                className="fixed top-0 z-40 flex h-full w-[360px] max-w-[calc(100vw-var(--atb-nav-w,0px))] flex-col border-r border-border bg-bg-surface outline-none"
                style={{ left: 'var(--atb-nav-w, 0px)' }}
              >
                <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
                  <DialogPrimitive.Title asChild>
                    <div className="flex min-w-0 flex-1 items-center gap-2 text-section-title text-text-primary">
                      通知
                      {badge ? (
                        <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-badge bg-status-review px-[5px] text-badge text-text-inverse">
                          {badge}
                        </span>
                      ) : null}
                    </div>
                  </DialogPrimitive.Title>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<CheckCheck className="size-4" aria-hidden />}
                    onClick={markAll}
                    disabled={count === 0 || markRead.isPending}
                  >
                    全部已读
                  </Button>
                  <DialogPrimitive.Close asChild>
                    <IconButton label="关闭通知中心" icon={<span aria-hidden className="text-lg leading-none">×</span>} />
                  </DialogPrimitive.Close>
                </header>

                <div className="atb-scroll min-h-0 flex-1 overflow-y-auto">
                  {list.isPending ? (
                    <p className="px-5 py-6 text-aux text-text-secondary">加载中…</p>
                  ) : list.isError ? (
                    <p className="px-5 py-6 text-aux text-status-failed">通知读取失败，请稍后重试。</p>
                  ) : items.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 px-5 py-12 text-center text-aux text-text-secondary">
                      <Inbox className="size-7" aria-hidden />
                      暂无通知
                    </div>
                  ) : (
                    <>
                      <NotificationGroup title="待处理" items={actionable} onOpen={openItem} />
                      <NotificationGroup title="一般通知" items={general} onOpen={openItem} />
                    </>
                  )}
                </div>
              </motion.aside>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        ) : null}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

function NotificationGroup({
  title,
  items,
  onOpen,
}: {
  title: string;
  items: NotificationItem[];
  onOpen: (item: NotificationItem) => void;
}) {
  if (items.length === 0) return null;
  const pending = title === '待处理' ? items.filter((item) => item.read_at === null).length : 0;
  return (
    <section className="border-b border-border last:border-b-0">
      <h2 className="sticky top-0 flex items-center gap-2 bg-bg-surface px-5 py-2 text-aux font-medium text-text-secondary">
        {title === '待处理' ? <span aria-hidden className="text-status-failed">🔴</span> : null}
        {title}
        {title === '待处理' ? <span>({pending})</span> : null}
      </h2>
      <ul>
        {items.map((item) => (
          <NotificationRow key={item.id} item={item} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

function NotificationRow({ item, onOpen }: { item: NotificationItem; onOpen: (i: NotificationItem) => void }) {
  const unread = item.read_at === null;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(item)}
        className={cn(
          'flex w-full items-start gap-2.5 px-5 py-3 text-left transition-colors duration-140 ease-settle hover:bg-bg-muted',
          unread && 'bg-primary-light/40',
        )}
      >
        <span
          aria-hidden
          className={cn('mt-1.5 size-2 shrink-0 rounded-full', unread ? 'bg-primary' : 'bg-transparent')}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-body text-text-primary">{item.message}</span>
          <span className="mt-0.5 block font-mono text-badge text-text-tertiary">
            {item.task_id ? `${item.task_id} · ` : ''}
            {formatRelative(item.created_at)}
          </span>
        </span>
      </button>
    </li>
  );
}
