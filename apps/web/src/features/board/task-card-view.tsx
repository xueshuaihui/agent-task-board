import { memo, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react';
import { useReducedMotion } from 'motion/react';
import {
  Bell,
  CircleCheck,
  Clock,
  FileCode,
  FileJson,
  FileText,
  Link2,
  Lock,
  Pin,
  SquarePen,
  TriangleAlert,
} from 'lucide-react';
import type { CardArtifact, FieldDef, TaskCard, TaskStatus } from '@/api/types';
import { formatRelative, leaseRemaining } from '@/lib/time';
import { ARTIFACT_TYPE_LABEL, labelOf, priorityText } from '@/lib/labels';
import { FLASH_CLASS, priorityStyle, statusStyle } from '@/lib/status-style';
import { cn } from '@/lib/cn';
import { Badge, IconButton, Progress, StatusDot, TagBadge, Tooltip } from '@/components/ui';
import { useIsFlashed } from '@/app/store/flash';
import { RequirementBadge, useRequirementDrawerStore } from '@/features/requirements';
import {
  artifactOverflow,
  blockedText,
  blockedTip,
  cardFieldEntries,
  knownStatus,
  LEASE_DANGER_MS,
  tagOverflow,
} from './model';
import { CardMenu } from './card-menu';
import type { CardActions } from './card-actions';
import { useLeaseTick, type RunOverlay } from './use-run-overlay';

/**
 * 3.3 卡片：248px 宽（= 列宽 280px − 左右 16px 内边距，所以这里写 `w-full`，
 * 11.1 的 240px 窄列档自动跟着变 208px）、圆角 8px、12px 内边距、左侧 3px 状态条、
 * 最小高 96px。六个状态共用同一副骨架，只在右上角徽标与底行上分叉。
 */

/** 20.6 十类产物 → 图标。图标只是类型标签，点开后的动作差异在预览器里（9 章）。 */
const ARTIFACT_ICON: Record<string, typeof FileText> = {
  diff: FileCode,
  image: FileCode,
  text: FileText,
  log: FileText,
  markdown: FileText,
  json: FileJson,
  html: FileCode,
  pdf: FileText,
  link: Link2,
  file: FileText,
};

export interface BoardCardViewProps {
  card: TaskCard;
  defs: readonly FieldDef[];
  overlay: RunOverlay;
  actions: CardActions;
  /** 拖拽中的原卡：按 3.3 画成「拖拽占位」虚线框。 */
  dragging?: boolean;
  /** DragOverlay 里的克隆体：1.6 旋转 2deg + `shadow-card-drag`，不吃交互。 */
  asOverlay?: boolean;
}

export const BoardCardView = memo(function BoardCardView({
  card,
  defs,
  overlay,
  actions,
  dragging = false,
  asOverlay = false,
}: BoardCardViewProps) {
  const flashed = useIsFlashed(card.id);
  const style = statusStyle(card.status);
  const priority = priorityStyle(card.priority);
  const status = knownStatus(card.status);
  const blocked = card.blocked.count > 0;
  const fields = cardFieldEntries(card, defs);
  const tags = tagOverflow(card.tags);

  const open = (event?: MouseEvent | KeyboardEvent) => {
    event?.stopPropagation();
    if (!asOverlay) actions.open(card);
  };

  return (
    // `data-card-key`：卡片唯一的焦点站，键盘换列后 `board-card.tsx` 按它把焦点要回来（PRD 7.2）。
    <article
      data-card-key
      role="button"
      tabIndex={0}
      aria-label={`${card.id} ${card.title}`}
      onClick={(event) => open(event)}
      onKeyDown={(event) => {
        if (asOverlay) return;
        // `Space`/`Enter` 打开详情抽屉；`←`/`→` 与 `⌘/Ctrl + P` 冒泡给拖拽外壳处理（board-card.tsx）。
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          open(event);
        }
      }}
      className={cn(
        'group relative min-h-24 w-full cursor-grab overflow-hidden rounded-card',
        'border border-border bg-bg-surface py-3 pl-[11px] pr-2 text-left',
        'shadow-card transition-shadow duration-120 ease-out',
        'hover:border-border-strong hover:shadow-card-hover focus-visible:border-primary',
        asOverlay && 'w-card rotate-2 cursor-grabbing shadow-card-drag',
        dragging && 'border-dashed border-border-strong bg-bg-muted opacity-60 shadow-none',
        flashed && FLASH_CLASS,
      )}
    >
      {/* 3.3 左条 3px，取状态色 */}
      <span aria-hidden className={cn('absolute left-0 top-0 h-full w-[3px] rounded-l-card', style.bar)} />

      <header className="flex items-center gap-1">
        <span className="font-mono text-code text-text-tertiary">{card.id}</span>
        <span className="min-w-0 flex-1" />
        {status === 'RUNNING' ? <LeaseBadge card={card} overlay={overlay} /> : null}
        {status === 'REVIEW' ? <Bell className="size-3.5 shrink-0 text-status-review" aria-label="待审核" /> : null}
        {status === 'DONE' ? <CircleCheck className="size-3.5 shrink-0 text-status-done" aria-label="已完成" /> : null}
        {status === 'FAILED' ? (
          <TriangleAlert className="size-3.5 shrink-0 text-status-failed" aria-label="异常或失败" />
        ) : null}
        {card.pinned ? (
          <Pin className="size-3.5 shrink-0 fill-status-pinned text-status-pinned" aria-label="已置顶" />
        ) : null}
        {!asOverlay ? <CardQuickActions card={card} actions={actions} /> : null}
      </header>

      <h3 className="mt-1 line-clamp-2 break-words text-card-title text-text-primary">{card.title}</h3>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Badge tone="neutral">{card.type}</Badge>
        <Badge className={cn(priority.soft, priority.text)} icon={<StatusDot className={priority.dot} />}>
          {priorityText(card.priority)}
        </Badge>
        {tags.shown.map((tag) => (
          <TagBadge key={tag}>{tag}</TagBadge>
        ))}
        {tags.extra > 0 ? <Badge tone="outline">+{tags.extra}</Badge> : null}
      </div>

      {fields.length > 0 ? (
        <dl className="mt-2 flex flex-col gap-0.5">
          {fields.map((field) => (
            <div key={field.key} className="flex min-w-0 items-baseline gap-1">
              <dt className="shrink-0 text-aux text-text-tertiary">{field.label}</dt>
              <dd className="truncate text-aux text-text-secondary" title={field.text}>
                {field.text}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {/* 2.md 4.8：子任务卡片显示所属需求的进度角标；点击打开需求抽屉（壳层单例）。
          外层 span 拦冒泡：点角标不应把任务详情抽屉也带开。 */}
      {card.parent && !asOverlay ? (
        <span
          className="mt-2 block min-w-0"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <RequirementBadge
            parent={card.parent}
            onClick={() => useRequirementDrawerStore.getState().openRequirement(card.parent!.id)}
          />
        </span>
      ) : null}

      {status === 'RUNNING' ? <RunningBody card={card} overlay={overlay} /> : null}

      <div className="my-2 border-t border-border" />

      {blocked ? (
        <Tooltip content={blockedTip(card.blocked.by, card.blocked.count)}>
          <p className="flex min-w-0 items-center gap-1 text-aux text-text-secondary">
            <Lock className="size-3.5 shrink-0" />
            <span className="truncate">{blockedText(card.blocked.count)}</span>
          </p>
        </Tooltip>
      ) : null}

      <CardBody card={card} status={status} actions={actions} asOverlay={asOverlay} />
    </article>
  );
});

/** 底行：按状态分叉（原型 3.3 的六段变体）。 */
function CardBody({
  card,
  status,
  actions,
  asOverlay,
}: {
  card: TaskCard;
  status: TaskStatus | null;
  actions: CardActions;
  asOverlay: boolean;
}) {
  if (status === 'RUNNING') return null; // 执行中的信息在 RunningBody 那块里

  if (status === 'DONE') {
    return <p className="truncate text-aux text-text-secondary">已完成 · {formatRelative(card.updated_at)}</p>;
  }

  if (status === 'FAILED') {
    // 20.7 的卡片 DTO 不带 `stop_reason`，三种失败原因的区分要等后端补字段。
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <p className="truncate text-aux text-text-secondary">
          {card.run_count > 0 ? `已执行 ${card.run_count} 次` : '未被领取'} · {formatRelative(card.updated_at)}
        </p>
        {!asOverlay ? (
          <p className="flex items-center gap-2 text-aux">
            <InlineAction
              label="重试"
              onClick={() => actions.move(card, 'READY')}
              className="text-primary hover:text-primary-hover"
            />
            <span className="text-text-tertiary">·</span>
            <InlineAction
              label="移回需求池"
              onClick={() => actions.move(card, 'BACKLOG')}
              className="text-text-secondary hover:text-text-primary"
            />
          </p>
        ) : null}
      </div>
    );
  }

  const artifacts = status === 'REVIEW' ? artifactOverflow(card.artifacts, card.artifact_count) : null;

  return (
    <p className="flex min-w-0 items-center gap-2 text-aux text-text-secondary">
      <span className="truncate">{card.agent_name ?? '—'}</span>
      <span className="min-w-0 flex-1" />
      {artifacts && artifacts.shown.length > 0 ? (
        <span className="flex shrink-0 items-center gap-1">
          {artifacts.shown.map((artifact) => (
            <ArtifactIcon key={artifact.id} artifact={artifact} />
          ))}
          {artifacts.extra > 0 ? <span className="text-text-tertiary">+{artifacts.extra}</span> : null}
        </span>
      ) : null}
      <span className="shrink-0">{formatRelative(card.updated_at)}</span>
    </p>
  );
}

function InlineAction({
  label,
  onClick,
  className,
}: {
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn('underline-offset-2 hover:underline', className)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {label}
    </button>
  );
}

/** ⏱ 租约倒计时（原型 3.3 + 20.4）：归零只变红，不自行移列，回收由服务端判定。 */
function LeaseBadge({ card, overlay }: { card: TaskCard; overlay: RunOverlay }): ReactElement | null {
  const now = useLeaseTick(true);
  const remaining = leaseRemaining(card.lease_expires_at, now);
  const expired = overlay.leaseExpired === true || remaining.expired;
  if (!card.lease_expires_at) return null;
  return (
    <Tooltip
      content={expired ? '倒计时归零不代表已回收，等服务端判定（20.4）' : `租约 ${card.lease_expires_at} 到期`}
      side="bottom"
    >
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-0.5 font-mono text-aux',
          expired || remaining.remainingMs < LEASE_DANGER_MS ? 'text-status-failed' : 'text-status-running',
        )}
      >
        <Clock className="size-3.5" />
        {expired ? '00:00' : remaining.text}
      </span>
    </Tooltip>
  );
}

/**
 * 执行中卡片的中间块（原型 3.3）：`progress === null`（新 Run 尚未被 Agent 上报，20.2）时
 * 渲染**不确定态占位条**（不画假 0%）：轨道 + 循环滚动的半透明填充，文案并进
 * 「已运行」同一行；reduced-motion 下填充静止居中。progress 有值（含 0）维持精确条。
 */
function RunningBody({ card, overlay }: { card: TaskCard; overlay: RunOverlay }) {
  const progress = overlay.progress ?? card.progress;
  const message = overlay.progressMsg !== undefined ? overlay.progressMsg : card.progress_msg;
  const reducedMotion = useReducedMotion();
  if (progress === null || progress === undefined) {
    return (
      <div className="mt-2 flex flex-col gap-1">
        <p className="truncate text-aux text-text-secondary">
          {card.agent_name ?? 'Agent'} 已运行 {formatRelative(card.updated_at)} · 等待 Agent 上报进度
        </p>
        {/* 不确定态：无百分比可报，aria-hidden，语义由上方文案承载（20.2） */}
        <div aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-bg-muted">
          <div
            className={cn(
              'h-full w-1/3 rounded-full bg-primary/40',
              // motion 口径见 globals.css `.atb-progress-indeterminate`；reduced-motion 静止居中
              reducedMotion ? 'mx-auto' : 'atb-progress-indeterminate',
            )}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-1">
      <p className="flex items-center gap-2 text-aux text-text-secondary">
        <span className="truncate">{card.agent_name ?? 'Agent'}</span>
        <span className="ml-auto shrink-0 font-mono text-text-primary">{progress}%</span>
      </p>
      {/* §4 看板：执行中进度条带流动高光（租约过期转红时高光仍在，语义是「还在跑」） */}
      <Progress value={progress} danger={overlay.leaseExpired === true} flowing />
      {message ? <p className="truncate text-aux text-text-tertiary">{message}</p> : null}
    </div>
  );
}

function ArtifactIcon({ artifact }: { artifact: CardArtifact }) {
  const Icon = ARTIFACT_ICON[artifact.type] ?? FileText;
  return (
    <Tooltip content={`${labelOf(ARTIFACT_TYPE_LABEL, artifact.type)} · ${artifact.name}`} side="bottom">
      <Icon className="size-3.5 text-text-tertiary" aria-label={artifact.name} />
    </Tooltip>
  );
}

/** 3.3「卡片快捷操作（悬停时右上角）」：编辑 / 置顶 / ⋯。 */
function CardQuickActions({ card, actions }: { card: TaskCard; actions: CardActions }) {
  return (
    <span
      className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-120 ease-out group-hover:opacity-100 group-focus-within:opacity-100"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <IconButton
        label="编辑"
        size="iconSm"
        className="size-6"
        icon={<SquarePen className="size-3.5" />}
        onClick={() => actions.open(card)}
      />
      <IconButton
        label={card.pinned ? '取消置顶' : '置顶'}
        size="iconSm"
        className="size-6"
        icon={<Pin className={cn('size-3.5', card.pinned && 'fill-status-pinned text-status-pinned')} />}
        onClick={() => actions.togglePin(card)}
      />
      <CardMenu card={card} actions={actions} />
    </span>
  );
}
