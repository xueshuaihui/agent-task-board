import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { AlertTriangle, ClipboardList, Undo2 } from 'lucide-react';
import { api, errorMessage, isApiError } from '@/api';
import type { CreationDecisionInput } from '@/api/types';
import { useShellStore } from '@/app/store/shell';
import { useActiveGroups } from '@/features/groups';
import { useSkills } from '@/features/skills/hooks';
import { Badge, Button, IconButton, Progress, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { transitions } from '@/lib/motion';
import { priorityLabel } from '@/lib/labels';
import { CreationEditDialog } from './creation-edit-dialog';
import { decideCreationRequest } from './queries';
import {
  agentUndoMsLeft,
  useCreationStore,
  type CreationCard as CardState,
} from './store';

/**
 * §8.4 轻确认卡片（右下角浮层里的单张）：
 * 「📋 创建任务？」 + 载荷摘要 + 分组/类型/优先级/技能 + 来自哪个 Agent +
 * [取消][编辑][创建] + 锚 `expires_at` 的倒计时条（§8.3 的 30 秒超时）。
 *
 * 三条终态推进路径（api 侧终结不广播，PRD §16.3 明确不私加 resolved 事件）：
 * 1. decision 回包成功 → 用回包视图收口（created/cancelled）；
 * 2. 本地倒计时过 `decision_deadline_at`（expires_at + 5s 宽限）→ 判 timeout；
 * 3. 点得比服务端慢，decision 回 409 `CREATION_REQUEST_RESOLVED` → 就地转终态并说明原因。
 */

export interface CreationCardProps {
  card: CardState;
}

export function CreationCard({ card }: CreationCardProps) {
  const reduced = useReducedMotion();
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const tick = useTicker(card.status === 'pending');
  // §8.6：created 之后的 5 秒撤销窗只在「本次会话里刚点出来」的卡片上给——
  // 断线重连补齐的历史 created 卡早过窗口，不给撤销入口。
  const createdAtRef = useRef<number | null>(null);

  const expiresAt = Date.parse(card.expires_at);
  const deadlineAt = Date.parse(card.decision_deadline_at);
  const total = Math.max(1, expiresAt - Date.parse(card.created_at));
  const remaining = Math.max(0, expiresAt - tick);
  const secondsLeft = Math.ceil(remaining / 1000);
  const graceOver = tick >= deadlineAt;

  const dismiss = useCreationStore((state) => state.dismiss);
  const upsert = useCreationStore((state) => state.upsert);
  const settle = useCreationStore((state) => state.settle);
  const expireLocally = useCreationStore((state) => state.expireLocally);

  // 宽限（expires_at → decision_deadline_at，共 5s）内按钮仍可点：服务端这段时间还收决策；
  // 过点即本地判 timeout，动作区消失。
  useEffect(() => {
    if (card.status === 'pending' && graceOver) expireLocally(card.request_id);
  }, [card.status, card.request_id, graceOver, expireLocally]);

  const submit = useCallback(
    async (action: CreationDecisionInput['action'], payload?: CreationDecisionInput['payload']) => {
      if (submitting) return;
      setSubmitting(true);
      try {
        const view = await decideCreationRequest(card.request_id, { action, payload });
        upsert(view);
        if (view.status === 'created' || view.status === 'edited') createdAtRef.current = Date.now();
      } catch (error) {
        // v0.0.4 真机补验修复：decision 失败必须 toast——编辑弹窗关闭后卡片终态区
        // 不在第一视线内，静默收口让用户误以为创建成功。弹窗语义统一为「失败也关闭、
        // 结果一律由 toast + 卡片说明承载」；pending 卡仍在，可重新点「编辑」。
        if (isApiError(error) && error.code === 'CREATION_REQUEST_RESOLVED') {
          // 409 的 context.status 是服务端给的归宿（created/cancelled/timeout 都可能）。
          const status = (error.context.status as CardState['status']) ?? 'timeout';
          settle(
            card.request_id,
            status,
            status === 'timeout' ? '已超时（30s + 5s 宽限），未创建' : '已被处理，卡片动作已失效',
          );
          toast.error('请求已超时或已被处理，未创建任务');
        } else {
          toast.error(errorMessage(error));
        }
      } finally {
        setSubmitting(false);
        setEditOpen(false);
      }
    },
    [card.request_id, settle, submitting, toast, upsert],
  );

  // §8.6：created 之后的 5 秒撤销窗只在「本次会话里刚点出来」的卡片上给——
  // 断线重连补齐的历史 created 卡早过窗口，不给撤销入口。
  const groupNames = useActiveGroups();
  const skills = useSkills(undefined, { enabled: card.skills.length > 0 });

  const groupName = useMemo(
    () =>
      (groupNames.data?.items ?? []).find((group) => group.id === card.group_id)?.name ??
      card.group_id,
    [groupNames.data, card.group_id],
  );
  const skillNames = useMemo(() => {
    const items = skills.data?.items ?? [];
    return card.skills.map((slug) => {
      const hit = items.find((item) => item.id === slug || item.name === slug);
      return hit ? hit.name : slug;
    });
  }, [skills.data, card.skills]);

  const pending = card.status === 'pending';
  const actionable = pending && !graceOver;

  return (
    <motion.article
      {...(reduced
        ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
        : { initial: { opacity: 0, y: 12, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: 8, scale: 0.98 } })}
      transition={transitions.overlay}
      className={cn(
        'pointer-events-auto w-[360px] max-w-[calc(100vw-2rem)] rounded-card border border-border bg-bg-surface shadow-pop',
        !pending && 'opacity-[.94]',
      )}
      data-testid="creation-card"
      data-status={card.status}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ClipboardList className="size-4 shrink-0 text-primary" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-card-title text-text-primary">
          {cardTitle(card)}
        </h2>
        <IconButton
          label="关闭卡片"
          size="iconSm"
          variant="ghost"
          icon={<span aria-hidden className="text-base leading-none">×</span>}
          onClick={() => dismiss(card.request_id)}
        />
      </header>

      {card.duplicates.length > 0 ? (
        <div className="border-b border-border bg-status-review-soft/60 px-3 py-2">
          <p className="flex items-center gap-1.5 text-aux font-medium text-text-primary">
            <AlertTriangle className="size-3.5 text-status-review" aria-hidden />
            疑似重复（{card.duplicates.length}），可仍然创建
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {card.duplicates.map((hit) => (
              <li key={hit.task_id}>
                <button
                  type="button"
                  onClick={() => useShellStore.getState().openTask(hit.task_id)}
                  className="flex w-full items-baseline gap-1.5 text-left text-aux text-text-secondary hover:text-primary"
                >
                  <span className="shrink-0 font-mono text-badge text-text-tertiary">
                    {hit.task_id}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{hit.title}</span>
                  <span className="shrink-0 font-mono text-badge text-text-tertiary">
                    {Math.round(hit.similarity * 100)}%
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 px-3 py-2.5">
        <p className="line-clamp-2 text-body font-medium text-text-primary">{card.title}</p>
        {card.description ? (
          <p className="line-clamp-3 text-aux text-text-secondary">{card.description}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-1.5 text-aux text-text-secondary">
          <span className="min-w-0 max-w-full truncate" title={groupName}>
            📁 {groupName}
          </span>
          <Badge tone="outline">{card.type}</Badge>
          <Badge tone="outline">{priorityLabel(card.priority)}</Badge>
        </div>

        {skillNames.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-aux text-text-tertiary" aria-hidden>
              📋 技能
            </span>
            {skillNames.map((name) => (
              <span
                key={name}
                className="rounded-control bg-bg-muted px-1.5 py-[1px] text-badge text-text-secondary"
              >
                {name}
              </span>
            ))}
          </div>
        ) : null}

        <p className="text-badge text-text-tertiary">
          来自: {card.agent_name}
          {card.session_id ? ` · ${card.session_id}` : ''}
          {card.tags.length > 0 ? ` · ${card.tags.join(' / ')}` : ''}
        </p>

        {pending ? (
          actionable ? (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={submitting}
                onClick={() => void submit('cancel')}
              >
                取消
              </Button>
              <Button variant="default" size="sm" disabled={submitting} onClick={() => setEditOpen(true)}>
                编辑
              </Button>
              <Button
                variant="primary"
                size="sm"
                className="ml-auto"
                loading={submitting}
                disabled={submitting}
                onClick={() => void submit('create')}
              >
                创建
              </Button>
            </div>
          ) : (
            <p className="text-aux text-text-tertiary">宽限收尾中…</p>
          )
        ) : (
          <CreationCardResult
            card={card}
            createdAtMs={createdAtRef.current}
            onUndone={() => toast.success('已撤销，任务已删除')}
          />
        )}

        {pending ? (
          <div className="flex items-center gap-2">
            <Progress
              value={Math.round((remaining / total) * 100)}
              danger={secondsLeft <= 10}
              className="min-w-0 flex-1"
            />
            <span className="shrink-0 font-mono text-badge text-text-tertiary">{secondsLeft}s</span>
          </div>
        ) : null}
      </div>

      {editOpen ? (
        <CreationEditDialog
          card={card}
          submitting={submitting}
          onClose={() => setEditOpen(false)}
          onSubmit={(payload) => void submit('edit', payload)}
        />
      ) : null}
    </motion.article>
  );
}

function cardTitle(card: CardState): string {
  if (card.status === 'pending') return '创建任务？';
  if (card.undone) return '任务已撤销';
  return {
    created: '任务已创建',
    edited: '任务已创建（编辑后）',
    cancelled: '已取消创建',
    timeout: '创建超时',
  }[card.status];
}

/**
 * 终态区：§8.6 的「✅ 任务已创建 · T-xxxx · [查看任务] [撤销]」就地放在卡片里
 * （本仓 Toast 组件不支持动作按钮，见 components/ui/toast.tsx 的 ToastItem 形状）。
 */
function CreationCardResult({
  card,
  createdAtMs,
  onUndone,
}: {
  card: CardState;
  createdAtMs: number | null;
  onUndone: () => void;
}) {
  const toast = useToast();
  const markUndone = useCreationStore((state) => state.markUndone);
  const [busy, setBusy] = useState(false);
  // 只作 5 秒窗的重渲染驱动，数值走 agentUndoMsLeft(Date.now())。
  useTicker(card.status === 'created' && createdAtMs !== null && !card.undone);

  const created = (card.status === 'created' || card.status === 'edited') && card.task_id !== null;
  // 与 agent-undo-stack 同一口径：数值渲染时现算（agentUndoMsLeft + Date.now()），
  // undoLeft 只作重渲染驱动，杜绝旧 tick 造成的首帧倒计时虚高。
  const msLeft =
    created && createdAtMs !== null
      ? agentUndoMsLeft({ createdAtMs, undone: card.undone === true }, Date.now())
      : 0;
  const canUndo = created && msLeft > 0 && !card.undone;

  const undo = async () => {
    if (!card.task_id || busy) return;
    setBusy(true);
    try {
      await api.tasks.remove(card.task_id);
      markUndone(card.request_id);
      onUndone();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <p
        className={cn(
          'text-aux',
          card.status === 'timeout' || card.resolvedNote ? 'text-status-failed' : 'text-text-secondary',
        )}
      >
        {card.resolvedNote ??
          (card.status === 'cancelled'
            ? '已取消，未创建任务'
            : card.status === 'timeout'
              ? '已超时（30s + 5s 宽限），未创建任务'
              : created && !card.undone
                ? `${card.task_id} 已创建`
                : `${card.task_id} 已撤销`)}
      </p>
      {created ? (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => useShellStore.getState().openTask(card.task_id as string)}
          >
            查看任务
          </Button>
          {canUndo ? (
            <Button
              variant="outlineDanger"
              size="sm"
              className="ml-auto"
              loading={busy}
              icon={<Undo2 className="size-3.5" aria-hidden />}
              onClick={() => void undo()}
            >
              撤销 {Math.ceil(msLeft / 1000)}s
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 秒级倒计时：pending 期间 250ms 一跳（进度条要平滑，判决时刻要准）。 */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
