import { ClipboardList } from 'lucide-react';
import type { TaskCard } from '@/api';
import { Progress } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * 2.md 4.8：看板/列表卡片上的「需求进度角标」——子任务卡片显示所属需求与聚合进度。
 *
 * 数据直接来自卡片 DTO 的 `parent`（后端 `toCardDto()` 的 `extra.parent`，20.7 卡片不为此另发请求）。
 *
 * **本组件不在看板接线**（features/board 由另一并行任务负责，禁止本 feature 触碰）：
 * 主 agent 在 `features/board/task-card-view.tsx` 里按下面的方式挂一行即可——
 *
 * ```tsx
 * import { RequirementBadge } from '@/features/requirements';
 * // 卡片体内，阻塞徽标附近：
 * {card.parent ? (
 *   <RequirementBadge
 *     parent={card.parent}
 *     onClick={() => useRequirementDrawerStore.getState().openRequirement(card.parent!.id)}
 *   />
 * ) : null}
 * ```
 */

export interface RequirementBadgeProps {
  /** 卡片 DTO 的 `parent` 摘要：`{ id, title, done, total }`。 */
  parent: NonNullable<TaskCard['parent']>;
  /** 可选：点击打开需求抽屉（壳层接线，见 README）。 */
  onClick?: () => void;
  className?: string;
}

export function RequirementBadge({ parent, onClick, className }: RequirementBadgeProps) {
  const percent = parent.total > 0 ? Math.round((parent.done / parent.total) * 100) : 0;
  const inner = (
    <>
      <ClipboardList className="size-3 shrink-0 text-text-tertiary" aria-hidden />
      <span className="max-w-[120px] truncate">{parent.title}</span>
      <span className="shrink-0 font-medium tabular-nums text-text-secondary">
        {parent.done}/{parent.total}
      </span>
      <Progress value={percent} className="h-0.5 w-8 shrink-0" />
    </>
  );

  const base = cn(
    'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-control border border-border bg-bg-surface px-1.5 py-0.5 text-aux text-text-secondary',
    className,
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={`所属需求 ${parent.id} · ${parent.title}`} className={cn(base, 'hover:border-border-strong hover:text-text-primary')}>
        {inner}
      </button>
    );
  }
  return (
    <span title={`所属需求 ${parent.id} · ${parent.title}`} className={base}>
      {inner}
    </span>
  );
}
