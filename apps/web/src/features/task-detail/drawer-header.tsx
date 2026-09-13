import { useEffect, useState, type ReactNode } from 'react';
import { Lock, MoreHorizontal, Pin, PinOff } from 'lucide-react';
import type { TaskDetail } from '@/api';
import { Badge, IconButton, Input, Menu, StatusDot, TagBadge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { COPY } from '@/lib/copy';
import { priorityText, statusLabel } from '@/lib/labels';
import { priorityStyle, statusStyle } from '@/lib/status-style';
import { leaseRemaining } from '@/lib/time';
import { usePatchTask, useSetPinned } from './mutations';
import type { DrawerActionsApi } from './use-drawer-actions';

/**
 * 原型 4.2 头部 + 4.3 标签栏。
 *
 * 基座 `Drawer` 的头部固定 56px（1.5），装得下「任务 ID + 标题」两行，装不下 4.2 的第三行，
 * 所以类型/优先级/标签/状态这一行与 📌 `⋯` 一起落到 `headerExtra`：
 * 📌 与 `⋯` 排在 Tab 条的右端，关闭 × 仍在基座给的位置。
 *
 * 字号取 `text-section-title`（16px/600）而不是 4.2 写的 18px：1.2 的字号表里没有 18px 这一档，
 * 而「只用 @theme token」是硬约束，就近取 16px/600。
 */

export function DrawerTitle({ detail }: { detail: TaskDetail }) {
  const patch = usePatchTask(detail.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(detail.title);

  // 非编辑态跟着详情走；编辑态不能把用户正在打的字覆盖掉。
  useEffect(() => {
    if (!editing) setDraft(detail.title);
  }, [detail.title, editing]);

  const close = () => {
    setEditing(false);
    setDraft(detail.title);
  };

  const commit = () => {
    const next = draft.trim();
    if (!next || next === detail.title) {
      close();
      return;
    }
    patch.mutate({ title: next }, { onSuccess: () => setEditing(false) });
  };

  if (!editing) {
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-mono text-code leading-4 text-text-tertiary" data-selectable>
          {detail.id}
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="点击编辑标题（4.2）"
          className="min-w-0 truncate text-left text-section-title text-text-primary hover:text-primary"
        >
          {detail.title}
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="shrink-0 font-mono text-code text-text-tertiary">{detail.id}</span>
      <Input
        value={draft}
        autoFocus
        disabled={patch.isPending}
        aria-label="任务标题"
        className="h-8 min-w-0 flex-1"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
        onBlur={commit}
      />
      {patch.isError ? (
        <span className="shrink-0 text-aux text-status-failed">未保存</span>
      ) : null}
    </div>
  );
}

/** 4.2 第三行：类型 + 优先级 + 标签（左），状态色点 + 文本、租约倒计时（右）。 */
export function DrawerMetaRow({ detail }: { detail: TaskDetail }) {
  const style = statusStyle(detail.status);
  const priority = priorityStyle(detail.priority);
  const shownTags = detail.tags.slice(0, 3);
  const overflow = detail.tags.length - shownTags.length;
  const lease = useLease(detail);

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-5 pt-2">
      <Badge tone="neutral">{detail.type}</Badge>
      <Badge className={cn(priority.soft, priority.text)} icon={<StatusDot className={priority.dot} />}>
        {priorityText(detail.priority)}
      </Badge>
      {shownTags.map((tag) => (
        <TagBadge key={tag}>{tag}</TagBadge>
      ))}
      {overflow > 0 ? (
        <span title={`其余标签：${detail.tags.slice(3).join('、')}`}>
          <Badge tone="outline">{`+${overflow}`}</Badge>
        </span>
      ) : null}
      {detail.blocked.count > 0 ? (
        <span title={`${detail.blocked.by.map((item) => item.id).join('、')} 未完成（5.4）`}>
          <Badge tone="outline" icon={<Lock className="size-3" aria-hidden />}>
            {`被 ${detail.blocked.count} 个前置阻塞`}
          </Badge>
        </span>
      ) : null}

      <span className="flex-1" />

      {lease ? (
        <span
          className={cn(
            'shrink-0 font-mono text-aux',
            lease.expired ? 'text-status-failed' : 'text-text-secondary',
          )}
          title={
            lease.expired
              ? COPY.leaseExpired
              : `租约至 ${detail.lease_expires_at}；到期由服务端定时回收（9.3）`
          }
        >
          {lease.expired ? COPY.leaseExpired : `租约 ${lease.text}`}
        </span>
      ) : null}

      <span className="flex shrink-0 items-center gap-1.5 text-aux">
        <span className="text-text-secondary">状态:</span>
        <StatusDot className={style.dot} />
        <span className={cn('font-medium', style.text)}>{statusLabel(detail.status)}</span>
      </span>
    </div>
  );
}

/** Tab 条 + 4.2 的右上图标（置顶、更多）。`⋯` 与底部操作栏共用同一份动作集。 */
export function DrawerTabRow({
  detail,
  actions,
  tabs,
}: {
  detail: TaskDetail;
  actions: DrawerActionsApi;
  tabs: ReactNode;
}) {
  return (
    <div className="mt-2 flex items-stretch gap-1 pr-3">
      <span className="flex min-w-0 flex-1">{tabs}</span>
      <span className="flex shrink-0 items-center gap-1">
        <PinButton taskId={detail.id} pinned={detail.pinned} />
        <Menu
          align="end"
          width={240}
          trigger={({ open, toggle, id }) => (
            <IconButton
              label="更多操作"
              id={id}
              aria-expanded={open}
              onClick={toggle}
              icon={<MoreHorizontal className="size-4" />}
            />
          )}
          groups={[
            {
              label: `状态：${statusLabel(detail.status)}`,
              items: [
                { id: 'copy-id', label: '复制任务 ID', onSelect: actions.copyId },
                ...actions.menuActions.map((action) => ({
                  id: action.id,
                  label: action.label,
                  danger: action.danger,
                  hint: action.hint,
                  onSelect: () => actions.run(action),
                })),
              ],
            },
          ]}
        />
      </span>
    </div>
  );
}

/** 置顶要在渲染期拿 mutation，所以单独成组件而不是在 onClick 里现造 hook。 */
function PinButton({ taskId, pinned }: { taskId: string; pinned: boolean }) {
  const setPinned = useSetPinned(taskId, pinned);
  return (
    <IconButton
      label={pinned ? '取消置顶' : '置顶'}
      title={`${pinned ? '取消置顶' : '置顶'}（5.6 影响抓取顺序）`}
      disabled={setPinned.isPending}
      onClick={() => setPinned.mutate(undefined)}
      icon={
        pinned ? (
          <PinOff className="size-4 text-status-pinned" />
        ) : (
          <Pin className="size-4" />
        )
      }
    />
  );
}

/** 倒计时每秒一格；`RUNNING` 之外不给（4.2 的租约只对执行中的任务有意义）。 */
function useLease(detail: TaskDetail) {
  const expiresAt = detail.lease_expires_at;
  const running = detail.status === 'RUNNING';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running || !expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running, expiresAt]);

  if (!running || !expiresAt) return null;
  return leaseRemaining(expiresAt, now);
}
