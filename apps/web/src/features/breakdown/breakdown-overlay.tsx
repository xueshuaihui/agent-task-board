import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ArrowLeft, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { BREAKDOWN_STATUS_LABEL, type BreakdownSession } from '@/api/types';
import { navigate } from '@/app/router';
import { useActiveGroups } from '@/features/groups';
import { useSkills } from '@/features/skills/hooks';
import { useRequirementDrawerStore } from '@/features/requirements';
import { Badge, Button, Card, EmptyState, IconButton, Progress, Skeleton, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { transitions } from '@/lib/motion';
import { formatDateTime } from '@/lib/time';
import { useBreakdownCancel, useBreakdownConfirm, useBreakdownSession, useBreakdownSessions } from './queries';
import { DraftCard } from './draft-card';
import { BreakdownStatusBadge, SessionSwitcher } from './session-switcher';
import { useBreakdownOverlayStore } from './store';
import { SessionActionDialog } from './session-action-dialog';

/**
 * 拆解创建页（§7.3，**覆盖层不是独立路由**）：13.8「覆盖内容区 + 工具栏」——
 * portal 出 `fixed` 层，`left` 让开左侧导航（`--atb-nav-w`，与通知中心同一口径）。
 *
 * 布局按 PRD ASCII 稿：
 * - 头：← 返回 · 「正在接收 Agent 拆解」/「拆解完成：{需求}」 · [取消] [确认创建]；
 * - 顶：会话切换器（§7.3 多会话并发，进行中红点）；
 * - 体：进度清单 + 进度条（阶段 3）、已识别任务卡片流（阶段 4）、状态收尾信息。
 * 编辑能力（§7.4）与流程图不在 W7 web 片范围，草案以只读卡呈现。
 */
export interface BreakdownOverlayProps {
  onClose: () => void;
}

export function BreakdownOverlay({ onClose }: BreakdownOverlayProps) {
  const reduced = useReducedMotion();
  const sessions = useBreakdownSessions();
  const activeId = useBreakdownOverlayStore((state) => state.activeId);
  const setActive = useBreakdownOverlayStore((state) => state.setActive);

  const list = useMemo(() => sessions.data ?? [], [sessions.data]);
  // activeId 失效（首开、或该会话被删）时回落到最新会话（列表按 created_at 倒序）。
  const currentId = activeId && list.some((s) => s.id === activeId) ? activeId : (list[0]?.id ?? null);
  const detail = useBreakdownSession(currentId);
  const session = detail.data?.session ?? list.find((s) => s.id === currentId) ?? null;

  const body = detail.isPending ? (
    <div className="flex flex-col gap-3 p-4">
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  ) : !session ? (
    <EmptyState
      title="还没有拆解会话"
      description="Agent 调用 board.begin_breakdown 后会话会出现在这里。"
      className="m-4"
    />
  ) : (
    <SessionDetail session={session} detail={detail.data} />
  );

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 4 }}
      transition={transitions.overlay}
      role="dialog"
      aria-label="拆解创建页"
      data-testid="breakdown-overlay"
      className="fixed inset-y-0 right-0 z-40 flex min-w-0 flex-col bg-bg-app"
      style={{ left: 'var(--atb-nav-w, 0px)' }}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg-surface px-3">
        <IconButton variant="ghost" label="返回" onClick={onClose} data-testid="breakdown-back">
          <ArrowLeft className="size-4" aria-hidden />
        </IconButton>
        <h2 className="min-w-0 flex-1 truncate text-section-title text-text-primary">
          {session?.status === 'receiving'
            ? '正在接收 Agent 拆解'
            : session?.status === 'reviewing'
              ? `拆解完成：${session.parent_title}`
              : (session?.parent_title ?? '拆解会话')}
        </h2>
        {session ? <SessionActions session={session} draftCount={detail.data?.drafts.length ?? session.actual_tasks ?? 0} /> : null}
      </header>
      <SessionSwitcher sessions={list} activeId={currentId} onSelect={setActive} />
      <div className="atb-scroll min-h-0 flex-1 overflow-y-auto">{body}</div>
    </motion.div>
  );
}

/** 头部右侧动作区：receiving/reviewing 可取消，只有 reviewing 能确认创建（§7.7）。 */
function SessionActions({ session, draftCount }: { session: BreakdownSession; draftCount: number }) {
  const toast = useToast();
  const hide = useBreakdownOverlayStore((state) => state.hide);
  const groups = useActiveGroups();
  const confirm = useBreakdownConfirm();
  const cancel = useBreakdownCancel();
  const [dialog, setDialog] = useState<'confirm' | 'cancel' | null>(null);

  const runConfirm = async () => {
    try {
      const result = await confirm.mutateAsync(session.id);
      // 阶段 8：Toast 报「已创建 N 个任务，1 个需求」，关闭覆盖层并落到生成结果。
      toast.success(
        `已创建 ${result.task_ids.length} 个任务，1 个需求`,
        `需求「${session.parent_title}」与子任务已进入需求池`,
      );
      hide();
      navigate('board');
      useRequirementDrawerStore.getState().openRequirement(result.parent_task_id);
    } catch {
      /* useApiMutation 已弹错误 Toast（含 BREAKDOWN_BAD_STATE 文案），对话框留在可重试。 */
    }
  };

  const runCancel = async () => {
    try {
      await cancel.mutateAsync(session.id);
      toast.success('已取消拆解会话', `「${session.parent_title}」的草案不会创建任务`);
      setDialog(null);
    } catch {
      /* 同上，错误已由 mutation 弹卡。 */
    }
  };

  const canCancel = session.status === 'receiving' || session.status === 'reviewing';
  if (!canCancel && session.status !== 'completed') {
    return <BreakdownStatusBadge status={session.status} />;
  }
  const groupName = session.group_id
    ? (groups.data?.items ?? []).find((g) => g.id === session.group_id)?.name
    : null;

  return (
    <div className="flex shrink-0 items-center gap-2">
      {groupName ? <Badge tone="neutral">{groupName}</Badge> : null}
      {canCancel ? (
        <Button variant="default" size="sm" onClick={() => setDialog('cancel')} data-testid="breakdown-cancel-btn">
          取消
        </Button>
      ) : null}
      {session.status === 'reviewing' ? (
        <Button
          variant="primary"
          size="sm"
          onClick={() => setDialog('confirm')}
          loading={confirm.isPending}
          data-testid="breakdown-confirm-btn"
        >
          确认创建
        </Button>
      ) : null}
      {session.status === 'completed' && session.parent_task_id ? (
        <Button
          variant="default"
          size="sm"
          onClick={() => useRequirementDrawerStore.getState().openRequirement(session.parent_task_id as string)}
          data-testid="breakdown-open-requirement"
        >
          查看需求
        </Button>
      ) : null}
      <SessionActionDialog
        kind={dialog ?? 'confirm'}
        session={dialog ? session : null}
        draftCount={draftCount}
        busy={dialog === 'confirm' ? confirm.isPending : cancel.isPending}
        onClose={() => setDialog(null)}
        onAction={() => {
          if (dialog === 'confirm') void runConfirm();
          else void runCancel();
        }}
      />
    </div>
  );
}

/** 单会话主体：进度清单（阶段 3）+ 草案卡片流（阶段 4）+ 状态收尾。 */
function SessionDetail({
  session,
  detail,
}: {
  session: BreakdownSession;
  detail: ReturnType<typeof useBreakdownSession>['data'];
}) {
  const skills = useSkills(undefined, { enabled: true });
  const skillNames = useMemo(
    () => (skills.data ? new Map(skills.data.items.map((s) => [s.id, s.name])) : null),
    [skills.data],
  );

  const progress = detail?.progress ?? [];
  const drafts = detail?.drafts ?? [];
  const latest = progress[progress.length - 1];
  const percent = latest ? Math.round((latest.step / latest.total) * 100) : null;
  const receiving = session.status === 'receiving';

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* 会话摘要：需求文本 + 来源 Agent + 时间（§7.6 列集里读得到的都放这一行）。 */}
      <Card className="flex flex-col gap-1 p-3">
        <div className="flex items-center gap-2">
          <BreakdownStatusBadge status={session.status} />
          <span className="text-aux text-text-tertiary">
            {session.agent_name ? `来自 ${session.agent_name}` : 'Agent 拆解'} · {formatDateTime(session.created_at)}
          </span>
        </div>
        <p className="line-clamp-2 text-body text-text-primary" title={session.requirement_text}>
          {session.requirement_text}
        </p>
      </Card>

      {/* 阶段 3：进度清单 + 「已完成 x/y」 + 进度条。 */}
      {progress.length > 0 ? (
        <section className="flex flex-col gap-2" data-testid="breakdown-progress">
          <div className="flex items-center gap-2 text-aux text-text-secondary">
            {receiving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            <span>
              {receiving ? `正在接收 ${session.agent_name ?? 'Agent'} 的拆解结果…` : '接收过程'}
            </span>
          </div>
          <ul className="flex flex-col gap-1">
            {progress.map((row, index) => {
              const done = !receiving || row !== latest;
              const current = receiving && row === latest;
              return (
                <li key={row.id} className="flex items-center gap-2 text-aux">
                  {done ? (
                    <CheckCircle2 className="size-3.5 shrink-0 text-status-done" aria-hidden />
                  ) : current ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-status-running" aria-hidden />
                  ) : (
                    <Circle className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
                  )}
                  <span className={cn(done ? 'text-text-primary' : current ? 'text-text-primary' : 'text-text-tertiary')}>
                    {row.message ?? `步骤 ${index + 1}`}
                  </span>
                </li>
              );
            })}
          </ul>
          {latest ? (
            <>
              <p className="text-aux text-text-secondary tabular-nums">
                已完成 {latest.step}/{latest.total}
              </p>
              <Progress value={percent} flowing={receiving} />
            </>
          ) : null}
        </section>
      ) : null}

      {/* 阶段 4/5：草案卡片流。 */}
      <section className="flex flex-col gap-2">
        <h3 className="text-section-title text-text-primary">
          已识别任务 ({drafts.length})
          {session.estimated_tasks ? (
            <span className="ml-1 text-aux font-normal text-text-tertiary">· 预估 {session.estimated_tasks}</span>
          ) : null}
        </h3>
        {drafts.length === 0 ? (
          <p className="text-aux text-text-tertiary" data-testid="breakdown-drafts-empty">
            {receiving ? '等待 Agent 上报草案…' : '本会话没有收到任何草案。'}
          </p>
        ) : (
          <div className={cn('grid grid-cols-1 gap-2', 'min-[720px]:grid-cols-2')} data-testid="breakdown-drafts">
            {drafts.map((draft) => (
              <DraftCard key={draft.id} draft={draft} skillNames={skillNames} />
            ))}
          </div>
        )}
      </section>

      {/* 待确认页脚（ASCII 稿「● 共 6 个任务 · 依赖检查通过」）与终态说明。 */}
      {session.status === 'reviewing' ? (
        <p className="flex items-center gap-2 text-aux text-text-secondary" data-testid="breakdown-footer-line">
          <span aria-hidden className="size-2 rounded-full bg-status-done" />
          共 {drafts.length} 个任务 · 确认后创建 1 个需求 + {drafts.length} 个子任务（成环/缺前置由服务端在确认时拒绝，§7.8）
        </p>
      ) : null}
      {session.status === 'cancelled' || session.status === 'interrupted' ? (
        <p className="text-aux text-text-tertiary">
          {BREAKDOWN_STATUS_LABEL[session.status]}
          {session.cancelled_at ? ` · ${formatDateTime(session.cancelled_at)}` : ''}。草案保留供回看，不会再流转。
        </p>
      ) : null}
    </div>
  );
}
