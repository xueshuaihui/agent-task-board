import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  Copy,
  Loader2,
  Plus,
  RotateCcw,
  Undo2,
} from 'lucide-react';
import {
  BREAKDOWN_STATUS_LABEL,
  type BreakdownDraft,
  type BreakdownDraftEdit,
  type BreakdownSession,
} from '@/api/types';
import { api } from '@/api';
import { navigate } from '@/app/router';
import { useSkills } from '@/features/skills/hooks';
import { useRequirementDrawerStore } from '@/features/requirements';
import { Button, Card, EmptyState, ErrorCopy, IconButton, Progress, Skeleton, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { transitions } from '@/lib/motion';
import { formatDateTime } from '@/lib/time';
import {
  useBreakdownCancel,
  useBreakdownConfirm,
  useBreakdownDraftWrite,
  useBreakdownRegenerateDraft,
  useBreakdownRegenerateSession,
  useBreakdownSession,
  useBreakdownSessions,
} from './queries';
import { DraftCard } from './draft-card';
import { BreakdownStatusBadge, SessionSwitcher } from './session-switcher';
import { useBreakdownOverlayStore } from './store';
import { SessionActionDialog } from './session-action-dialog';
import { RegenerationDialog } from './regeneration-dialog';
import { DraftFlowGraph } from './draft-graph';
import { DraftEditor } from './draft-editor';
import { addDraft, hasDependencyCycle, nextDraftRef, patchDraft, removeDraft, toggleDependency } from './draft-edit';
import { copyTextWithFallback } from './copy-text';
import {
  breakdownCopyInstruction,
  canConfirmBreakdown,
  confirmBlockedReason,
  hasPendingRegeneration,
} from './regeneration';
import type { AnnotatedDraft } from './skill-status';

/** §7.8「撤销：5 秒内可撤销」——确认动作延迟 5 秒提交，期间可撤销（api 无事后撤销端点）。 */
const CONFIRM_UNDO_SECONDS = 5;

/**
 * 拆解创建页（§7.3）的**两种外壳，一份内容**（#4.3 方案 B）：
 * - 覆盖层（`BreakdownOverlay`）：portal 出 `fixed` 层，`left` 让开左侧导航
 *   （`--atb-nav-w`，与通知中心同一口径），仍负责「有未处理会话」的快捷入口；
 * - 二级页面（`features/breakdown/breakdown-page.tsx`，`#/requirements/breakdown`）：
 *   把 `BreakdownWorkspace` 铺在内容区，提供进行中/历史、需求过滤与 cursor 分页。
 * 覆盖层不是独立路由的旧口径只对「会话本体」成立——#4.3 起历史/归档需要可直达的
 * 页面地址，但主导航仍不出现「拆解」项。
 *
 * 布局按 PRD ASCII 稿：
 * - 头：← 返回 ·「正在接收 Agent 拆解」/「拆解完成：{需求}」· [取消] [整份重新生成] [确认创建]；
 * - 顶：会话切换器（§7.3 多会话并发，进行中红点）；
 * - 体：进度清单 + 进度条（阶段 3）、已识别任务卡片流（阶段 4）、状态收尾信息；
 * - v0.0.4 W7 遗留 b1 补齐：待确认页流程图（§7.3）、草案最小编辑（§7.4）、
 *   确认后 5 秒撤销窗口（§7.8）；b3 起草案编辑接服务端写端点（乐观更新 + 失败回滚）；
 *   #4 起单条/整份重生成带说明，pending 期间禁用确认并给「复制唤起指令」。
 */
export interface BreakdownOverlayProps {
  onClose: () => void;
}

export function BreakdownOverlay({ onClose }: BreakdownOverlayProps) {
  const reduced = useReducedMotion();
  /** 覆盖层只承载未终结会话（#4：浮标/快捷入口口径），历史会话在二级页面查看。 */
  const sessions = useBreakdownSessions({ scope: 'active' });
  const activeId = useBreakdownOverlayStore((state) => state.activeId);
  const setActive = useBreakdownOverlayStore((state) => state.setActive);

  const list = useMemo(() => sessions.data ?? [], [sessions.data]);
  // activeId 失效（首开、或该会话已终结被 active 过滤掉）时回落到最新会话。
  const currentId = activeId && list.some((s) => s.id === activeId) ? activeId : (list[0]?.id ?? null);

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
      <BreakdownWorkspace
        variant="overlay"
        sessions={list}
        activeId={currentId}
        onSelectSession={setActive}
        onBack={onClose}
        listStatus={sessions}
      />
    </motion.div>
  );
}

/** 列表/详情查询的三态判据（与 useQuery 返回值结构兼容，单测可直传假对象）。 */
export interface BreakdownQueryState {
  isPending: boolean;
  isError: boolean;
  error?: unknown;
}

export interface BreakdownWorkspaceProps {
  variant: 'overlay' | 'page';
  /** 切换器数据源；页面历史详情传空数组（历史不并发切换）。 */
  sessions: BreakdownSession[];
  activeId: string | null;
  onSelectSession: (id: string) => void;
  /** overlay = 关闭；page = 返回需求页（由外壳决定）。 */
  onBack: () => void;
  listStatus: BreakdownQueryState;
  emptyDescription?: string;
}

/**
 * #4.3 共享内容：覆盖层与二级页面都渲染这一份（避免两套业务 JSX 漂移）。
 * 详情自己查（`useBreakdownSession(activeId)`）；外壳只负责定位/滚动与页头返回。
 */
export function BreakdownWorkspace({
  variant,
  sessions,
  activeId,
  onSelectSession,
  onBack,
  listStatus,
  emptyDescription,
}: BreakdownWorkspaceProps) {
  const toast = useToast();
  const detail = useBreakdownSession(activeId);
  const session = detail.data?.session ?? sessions.find((s) => s.id === activeId) ?? null;
  const drafts = detail.data?.drafts ?? [];

  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  useEffect(() => {
    setSelectedRef(null);
  }, [activeId]);

  /** #4 重生成目标：null=关闭；draft=单条；session=整份。 */
  const [regenTarget, setRegenTarget] = useState<
    { kind: 'draft'; ref: string } | { kind: 'session' } | null
  >(null);
  const regenerateDraft = useBreakdownRegenerateDraft();
  const regenerateSession = useBreakdownRegenerateSession();
  const regenBusy = regenerateDraft.isPending || regenerateSession.isPending;

  const title =
    session?.status === 'receiving'
      ? '正在接收 Agent 拆解'
      : session?.status === 'reviewing'
        ? `拆解完成：${session.parent_title}`
        : (session?.parent_title ?? '拆解会话');

  const copyInstruction = async (input?: { refs?: string[]; note?: string | null }) => {
    if (!session) return;
    const pending = drafts.filter((draft) => draft.regeneration_pending);
    // 单条按钮显式给 ref；会话横幅按拍板文案只带 session id/说明/revision。
    const refs = input?.refs;
    // 先看 pending 草案自己的说明：会话级 revision_note 永不清理，不能盖掉后来的单条请求。
    const note =
      input?.note !== undefined
        ? input.note
        : pending.length > 0
          ? (pending.find((draft) => draft.regeneration_note)?.regeneration_note ?? null)
          : session.status === 'receiving'
            ? session.revision_note
            : null;
    const text = breakdownCopyInstruction({
      sessionId: session.id,
      revision: session.revision,
      note,
      refs,
    });
    const copied = await copyTextWithFallback(text);
    if (copied) {
      toast.success('唤起指令已复制', '粘贴到 Agent 会话即可让它继续等待或读取最新草案');
    } else {
      toast.error('复制失败', '请手动选中指令文本复制（浏览器可能拦截了剪贴板权限）');
    }
  };

  const submitRegeneration = async (note: string) => {
    if (!session || !regenTarget) return;
    try {
      if (regenTarget.kind === 'draft') {
        await regenerateDraft.mutateAsync({ id: session.id, ref: regenTarget.ref, note });
        toast.success('已请求重新生成草案', `等待 Agent 重报 #${regenTarget.ref}`);
      } else {
        await regenerateSession.mutateAsync({ id: session.id, note });
        toast.success('已请求整份重新生成', '会话已回到接收中，请等待 Agent 重报');
      }
      setRegenTarget(null);
    } catch {
      /* useApiMutation 已按服务端 message 弹错误 Toast，留在窗内可重试。 */
    }
  };

  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col',
        variant === 'page' && 'overflow-hidden rounded-card border border-border bg-bg-surface',
      )}
    >
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-bg-surface px-3 py-1.5">
        {variant === 'overlay' ? (
          <IconButton variant="ghost" label="返回" onClick={onBack} data-testid="breakdown-back">
            <ArrowLeft className="size-4" aria-hidden />
          </IconButton>
        ) : null}
        <h2 className="min-w-0 flex-1 truncate text-section-title text-text-primary">{title}</h2>
        {session ? (
          <SessionActions
            session={session}
            drafts={drafts}
            onRegenerateSession={() => setRegenTarget({ kind: 'session' })}
          />
        ) : null}
      </header>
      {sessions.length > 0 ? (
        <SessionSwitcher sessions={sessions} activeId={activeId} onSelect={onSelectSession} />
      ) : null}
      <div className={cn('min-h-0 flex-1', variant === 'overlay' && 'atb-scroll overflow-y-auto')}>
        <BreakdownOverlayBody
          sessions={listStatus}
          detail={detail}
          hasSession={session !== null}
          emptyDescription={emptyDescription}
        >
          {session ? (
            <SessionDetail
              session={session}
              detail={detail.data}
              drafts={drafts}
              selectedRef={selectedRef}
              onSelectDraft={setSelectedRef}
              onRegenerateDraft={(ref) => setRegenTarget({ kind: 'draft', ref })}
              onCopyDraftInstruction={(draft) =>
                void copyInstruction({ refs: [draft.ref], note: draft.regeneration_note ?? null })
              }
              onCopySessionInstruction={() => void copyInstruction()}
            />
          ) : null}
        </BreakdownOverlayBody>
      </div>
      {session ? (
        <RegenerationDialog
          open={regenTarget !== null}
          kind={regenTarget?.kind ?? 'session'}
          session={session}
          draftRef={regenTarget?.kind === 'draft' ? regenTarget.ref : null}
          busy={regenBusy}
          onClose={() => {
            if (!regenBusy) setRegenTarget(null);
          }}
          onSubmit={(note) => void submitRegeneration(note)}
        />
      ) : null}
    </div>
  );
}

/**
 * 会话区主体的三态闸（tier-1，2026-09-29「列表报错被渲染成空状态」）。
 *
 * 病灶：`sessions.data ?? []` + `detail.data?.drafts ?? []` 把 500（`skills` 缺表的
 * SCHEMA_MISMATCH 就是实例）折成「没有会话」。这里还有第二种谎：`useBreakdownSession(null)`
 * 是 disabled 查询、`isPending` 恒真，所以列表报错时 body 长期停在骨架——骨架同样是在说「还没好」，
 * 而真相是「不会好了」。判据顺序因此固定为 **error → pending → 空态 → 正文**：
 * 报错永远优先，空态只在查询确实成功且返回零条时才出现。
 *
 * 拆成吃假对象也能渲染的展示件：本仓 vitest 无 DOM / QueryClientProvider，
 * 三态判据要能被 `renderToStaticMarkup` 直钉（见 __tests__/query-error-surface.test.ts）。
 */
export function BreakdownOverlayBody({
  sessions,
  detail,
  hasSession,
  emptyDescription = 'Agent 调用 board.begin_breakdown 后会话会出现在这里。',
  children,
}: {
  sessions: BreakdownQueryState;
  detail: BreakdownQueryState;
  /** 列表或详情任一处能给出会话对象就算有（`session` 的取法见 BreakdownWorkspace）。 */
  hasSession: boolean;
  emptyDescription?: string;
  children: ReactNode;
}) {
  if (sessions.isError) {
    return (
      <div className="m-4 rounded-card border border-border bg-status-failed-soft px-3 py-2.5 text-aux text-status-failed">
        <ErrorCopy error={sessions.error} />
      </div>
    );
  }
  // 详情报错时读视图（session/drafts/progress）都不可信，正文与「本会话没有收到任何草案」都不给。
  if (detail.isError) {
    return (
      <div className="m-4 rounded-card border border-border bg-status-failed-soft px-3 py-2.5 text-aux text-status-failed">
        <ErrorCopy error={detail.error} />
      </div>
    );
  }
  if (!hasSession && !sessions.isPending) {
    return <EmptyState title="还没有拆解会话" description={emptyDescription} className="m-4" />;
  }
  if (!hasSession || detail.isPending) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  return <>{children}</>;
}

/** 头部右侧动作区：receiving/reviewing 可取消，只有 reviewing 能确认创建（§7.7）。 */
function SessionActions({
  session,
  drafts,
  onRegenerateSession,
}: {
  session: BreakdownSession;
  drafts: readonly BreakdownDraft[];
  onRegenerateSession: () => void;
}) {
  const toast = useToast();
  const hide = useBreakdownOverlayStore((state) => state.hide);
  const confirm = useBreakdownConfirm();
  const cancel = useBreakdownCancel();
  const [dialog, setDialog] = useState<'confirm' | 'cancel' | null>(null);
  /* §7.8 撤销窗口：confirm 落库后没有服务端撤销端点，故实现为「延迟 5 秒提交、
   * 期间可撤销」——倒计时归零才真正打 POST confirm。 */
  const [countdown, setCountdown] = useState<number | null>(null);

  const draftCount = drafts.length;
  const pendingRegeneration = hasPendingRegeneration(drafts);
  const blockedReason = confirmBlockedReason(session.status, drafts);
  const canConfirm = canConfirmBreakdown(session.status, drafts);

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
      /* useApiMutation 已弹错误 Toast（含 BREAKDOWN_BAD_STATE 文案），留在页内可重试。 */
    }
  };

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      setCountdown(null);
      void runConfirm();
      return;
    }
    const timer = setTimeout(() => setCountdown((value) => (value === null ? null : value - 1)), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在倒计时推进时重挂表，runConfirm 取最新闭包即可。
  }, [countdown]);

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
  // §19.15·90（r6 R3-C）：原此处按会话归属分组反查组名渲染 badge，已随「分组」
  // 概念从 web 清零退场——r6 后用户既不能管组也不能按组过滤，组名是纯噪声。

  if (countdown !== null) {
    return (
      <div
        className="flex shrink-0 items-center gap-2 rounded-control border border-border bg-bg-raised px-2 py-1"
        data-testid="breakdown-undo-bar"
      >
        {countdown > 0 ? (
          <Loader2 className="size-3.5 animate-spin text-status-running" aria-hidden />
        ) : (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        )}
        <span className="text-aux text-text-primary tabular-nums" data-testid="breakdown-undo-countdown">
          {countdown > 0
            ? `${countdown} 秒后创建 ${draftCount + 1} 个任务（1 需求 + ${draftCount} 子任务）`
            : '正在创建…'}
        </span>
        <Button
          variant="default"
          size="sm"
          disabled={countdown <= 0 || confirm.isPending}
          onClick={() => setCountdown(null)}
          data-testid="breakdown-undo-btn"
        >
          <Undo2 className="size-3.5" aria-hidden />
          撤销
        </Button>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      {pendingRegeneration && session.status === 'reviewing' ? (
        <span className="text-aux text-status-review" data-testid="breakdown-confirm-blocked">
          {blockedReason ?? '有草案待 Agent 重报，确认创建已禁用'}
        </span>
      ) : null}
      {canCancel ? (
        <Button variant="default" size="sm" onClick={() => setDialog('cancel')} data-testid="breakdown-cancel-btn">
          取消
        </Button>
      ) : null}
      {session.status === 'reviewing' ? (
        <>
          <Button
            variant="default"
            size="sm"
            onClick={onRegenerateSession}
            data-testid="breakdown-regenerate-session"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            整份重新生成
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setDialog('confirm')}
            disabled={!canConfirm}
            title={blockedReason ?? undefined}
            loading={confirm.isPending}
            data-testid="breakdown-confirm-btn"
          >
            确认创建
          </Button>
        </>
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
          if (dialog === 'confirm') {
            // §7.8：不立刻提交，进入 5 秒撤销窗口，归零后才真正 confirm（见上方倒计时 effect）。
            setDialog(null);
            setCountdown(CONFIRM_UNDO_SECONDS);
          } else {
            void runCancel();
          }
        }}
      />
    </div>
  );
}

/**
 * #4：待重报横幅（单条或整份都显示）——
 * 说明/时间来自草案级或会话级字段；「复制唤起指令」把 session id、note、
 * after_revision 与 board.wait_for_breakdown / board.get_breakdown 建议一起交给 Agent。
 */
function RegenerationNotice({
  session,
  drafts,
  onCopy,
}: {
  session: BreakdownSession;
  drafts: readonly AnnotatedDraft[];
  onCopy: () => void;
}) {
  const pending = drafts.filter((draft) => draft.regeneration_pending);
  const sessionLevel = session.status === 'receiving' && session.revision_requested_at !== null;
  if (pending.length === 0 && !sessionLevel) return null;
  /* 会话级 revision_note/requested_at 服务端不会清零：有 pending 草案时先读草案自己的
   * 说明/时刻，避免上一次整份重生成的旧说明盖住这次单条请求。 */
  const note =
    pending.length > 0
      ? (pending.find((draft) => draft.regeneration_note)?.regeneration_note ?? null)
      : session.revision_note;
  const requestedAt =
    pending.length > 0
      ? (pending.find((draft) => draft.regeneration_requested_at)?.regeneration_requested_at ?? null)
      : session.revision_requested_at;
  return (
    <div
      className="flex flex-col gap-2 rounded-card border border-status-review/40 bg-status-review-soft px-3 py-2 text-aux text-text-primary"
      data-testid="breakdown-regeneration-notice"
    >
      <p className="flex items-center gap-2 font-medium">
        <Loader2 className="size-3.5 animate-spin text-status-review" aria-hidden />
        {pending.length > 0
          ? `等待 Agent 重报（${pending.map((draft) => `#${draft.ref}`).join('、')}）`
          : '等待 Agent 重报（整份）'}
      </p>
      {note ? <p className="text-text-secondary">说明：{note}</p> : null}
      {requestedAt ? (
        <p className="text-text-tertiary">
          请求于 {formatDateTime(requestedAt)} · 当前 revision {session.revision}
        </p>
      ) : null}
      <Button
        variant="default"
        size="sm"
        className="self-start"
        onClick={onCopy}
        data-testid="breakdown-copy-instruction"
      >
        <Copy className="size-3.5" aria-hidden />
        复制唤起指令
      </Button>
    </div>
  );
}

/** 单会话主体：进度清单（阶段 3）+ 草案卡片流（阶段 4）+ 待确认流程图/编辑（§7.3/7.4，写侧接服务端）+ 状态收尾。 */
function SessionDetail({
  session,
  detail,
  drafts,
  selectedRef,
  onSelectDraft,
  onRegenerateDraft,
  onCopyDraftInstruction,
  onCopySessionInstruction,
}: {
  session: BreakdownSession;
  detail: ReturnType<typeof useBreakdownSession>['data'];
  /** 服务端草案（含条款 81 skills_status 标注）+ 乐观覆盖后的视图（§7.4，写端点为唯一落库通道）。 */
  drafts: AnnotatedDraft[];
  selectedRef: string | null;
  onSelectDraft: (ref: string | null) => void;
  /** #4：打开单条重生成说明输入（真正的 API 调用在 BreakdownWorkspace）。 */
  onRegenerateDraft: (ref: string) => void;
  onCopyDraftInstruction: (draft: AnnotatedDraft) => void;
  onCopySessionInstruction: () => void;
}) {
  const toast = useToast();
  const write = useBreakdownDraftWrite(session.id);
  const skills = useSkills(undefined, { enabled: true });
  const skillNames = useMemo(
    () => (skills.data ? new Map(skills.data.items.map((s) => [s.id, s.name])) : null),
    [skills.data],
  );

  const progress = detail?.progress ?? [];
  const latest = progress[progress.length - 1];
  const percent = latest ? Math.round((latest.step / latest.total) * 100) : null;
  const receiving = session.status === 'receiving';
  const reviewing = session.status === 'reviewing';
  const cycleDetected = reviewing && hasDependencyCycle(drafts);

  /** PATCH 提交：乐观覆盖用纯归约，服务端失败由 write 回滚 + Toast。 */
  const patchOne = (ref: string, patch: BreakdownDraftEdit) =>
    write.commit(patchDraft(drafts, ref, patch), () => api.breakdown.updateDraft(session.id, ref, patch));

  /** POST 添加：ref 与服务端取号同口径（nextDraftRef ≡ nextUserRef），显式带上避免并发改号撞车。 */
  const addOne = () => {
    const ref = nextDraftRef(drafts);
    const next = addDraft(drafts);
    const created = next.at(-1);
    if (!created) return;
    write.commit(next, () =>
      api.breakdown.createDraft(session.id, { ref, title: created.title, sort_order: created.sort_order }),
    );
    onSelectDraft(ref);
  };

  /** DELETE：removeDraft 的级联清边只是乐观视图，真正清悬空靠服务端同事务。 */
  const removeOne = (ref: string) =>
    write.commit(removeDraft(drafts, ref), () => api.breakdown.deleteDraft(session.id, ref));

  /** 点边/点开关共用：断边失败（成环/自环）时给文案，成功后 PATCH 依赖边集合。 */
  const toggleDep = (from: string, to: string) => {
    const result = toggleDependency(drafts, from, to);
    if (!result.ok) {
      toast.warning(
        result.reason === 'self' ? '不能依赖自己' : '依赖成环',
        '该连线会让依赖闭环，服务端也会拒绝（§7.8）。',
      );
      return;
    }
    const nextDeps = result.drafts.find((draft) => draft.ref === to)?.depends_on;
    if (nextDeps) patchOne(to, { depends_on: nextDeps });
  };

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
        {session.revision_requested_at && session.status === 'receiving' ? (
          <p className="text-aux text-text-secondary" data-testid="breakdown-session-revision">
            已请求整份重新生成
            {session.revision_note ? `：${session.revision_note}` : ''} ·{' '}
            {formatDateTime(session.revision_requested_at)} · revision {session.revision}
          </p>
        ) : null}
      </Card>

      {/* #4：待重报横幅（单条/整份都能看到复制唤起指令）。 */}
      <RegenerationNotice session={session} drafts={drafts} onCopy={onCopySessionInstruction} />

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

      {/* §7.3 待确认页流程图：草案节点 + 依赖边（复用 W5 依赖图画布），点节点开编辑、点边断依赖。 */}
      {reviewing ? (
        <section className="flex flex-col gap-2" data-testid="breakdown-review-flow">
          <div className="flex items-center justify-between">
            <h3 className="text-section-title text-text-primary">拆解流程图</h3>
            <Button
              variant="default"
              size="sm"
              onClick={addOne}
              data-testid="breakdown-add-draft"
            >
              <Plus className="size-3.5" aria-hidden />
              添加任务
            </Button>
          </div>
          <DraftFlowGraph
            drafts={drafts}
            className="h-72"
            onNodeSelect={(ref) => onSelectDraft(ref)}
            onEdgeRemove={toggleDep}
          />
          <p className="text-aux text-text-tertiary">
            点击节点编辑草案，点击连线断开依赖；编辑即时写入服务端，图上先乐观更新。
          </p>
          {selectedRef ? (
            <DraftEditor
              drafts={drafts}
              draftRef={selectedRef}
              onSelect={onSelectDraft}
              onPatch={patchOne}
              onDelete={removeOne}
              onAdd={addOne}
              onRegenerate={onRegenerateDraft}
              skillNames={skillNames}
            />
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
              <div key={draft.id} className="flex min-w-0 flex-col gap-1">
                <button
                  type="button"
                  disabled={!reviewing}
                  onClick={() => onSelectDraft(draft.ref)}
                  className={cn(
                    'min-w-0 rounded-card text-left',
                    reviewing && 'cursor-pointer transition-shadow hover:ring-1 hover:ring-primary/40',
                    selectedRef === draft.ref && 'ring-2 ring-primary',
                  )}
                  data-testid="breakdown-draft-open"
                >
                  <DraftCard draft={draft} skillNames={skillNames} />
                </button>
                {draft.regeneration_pending ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="self-start text-primary"
                    onClick={() => onCopyDraftInstruction(draft)}
                    data-testid="breakdown-copy-draft-instruction"
                  >
                    <Copy className="size-3.5" aria-hidden />
                    复制唤起指令
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 待确认页脚（ASCII 稿「● 共 6 个任务 · 依赖检查通过」）与终态说明。 */}
      {reviewing ? (
        <p
          className="flex items-center gap-2 text-aux text-text-secondary"
          data-testid="breakdown-footer-line"
        >
          {cycleDetected ? (
            <>
              <span aria-hidden className="size-2 rounded-full bg-status-failed" />
              共 {drafts.length} 个任务 · 依赖检查未通过（存在环，§7.8 确认时会被拒绝）
            </>
          ) : (
            <>
              <span aria-hidden className="size-2 rounded-full bg-status-done" />
              共 {drafts.length} 个任务 · 依赖检查通过 · 确认后进入 5 秒撤销窗口（§7.8）
            </>
          )}
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
