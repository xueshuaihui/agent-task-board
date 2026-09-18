import type { ReactNode } from 'react';
import { STATUS_STYLE } from '@/lib/status-style';
import { cn } from '@/lib/cn';
import { CardSkeleton } from '@/components/ui';
import type { Swimlane } from './grouping';
import type { GroupingOptions } from './useGroupingState';
import { SwimlaneHead } from './SwimlaneHead';

/**
 * 7.4 / 4.1 泳道：泳道头 + （次分组嵌套的）状态列网格。
 * 卡片渲染由调用方注入（renderCard），本目录不重复实现卡片——
 * 接线时传 features/board 里现有的卡片组件即可（见 README）。
 */
export interface SwimlaneViewProps {
  lane: Swimlane;
  collapsed: boolean;
  options: GroupingOptions;
  loading?: boolean;
  onToggleCollapse: () => void;
  moreMenu?: ReactNode;
  onViewRequirement?: () => void;
  renderCard: (task: Swimlane['groups'][number]['columns'][number]['tasks'][number]) => ReactNode;
  /** 列头右侧挂点（新建任务等），不传不渲染。 */
  columnHeaderExtra?: (status: Swimlane['groups'][number]['columns'][number]) => ReactNode;
}

/** 4.3 泳道内列头：8×8 色点 + 列名 13px/500 + 计数 12px，高 36px。 */
export function LaneColumnHead({
  column,
  extra,
}: {
  column: Swimlane['groups'][number]['columns'][number];
  extra?: ReactNode;
}) {
  const style = STATUS_STYLE[column.status];
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 px-3">
      <span className={cn('size-2 rounded-full', style.dot)} />
      <span className="text-[13px] font-medium text-text-primary">{column.label}</span>
      <span className="text-aux text-text-tertiary">{column.count}</span>
      <span className="ml-auto">{extra}</span>
    </div>
  );
}

export function SwimlaneView({
  lane,
  collapsed,
  options,
  loading = false,
  onToggleCollapse,
  moreMenu,
  onViewRequirement,
  renderCard,
  columnHeaderExtra,
}: SwimlaneViewProps) {
  return (
    <section className="overflow-hidden rounded-[10px] border border-border bg-bg-surface">
      <SwimlaneHead
        lane={lane}
        collapsed={collapsed}
        options={options}
        onToggleCollapse={onToggleCollapse}
        moreMenu={moreMenu}
        onViewRequirement={onViewRequirement}
      />
      {!collapsed &&
        lane.groups.map((group) => (
          <div key={group.key} className={cn(lane.groups.length > 1 && 'border-b border-border last:border-b-0')}>
            {group.label !== null && (
              <div className="flex h-9 items-center gap-2 bg-bg-raised px-5 text-aux text-text-secondary">
                <span aria-hidden>{lane.icon}</span>
                {group.label}
                <span className="text-text-tertiary">{group.count}</span>
              </div>
            )}
            <div className="flex gap-3 overflow-x-auto p-3">
              {group.columns.map((column) => (
                <div
                  key={column.status}
                  className="flex w-[280px] shrink-0 flex-col rounded-lg bg-bg-app"
                  data-lane={lane.key}
                  data-status={column.status}
                >
                  <LaneColumnHead column={column} extra={columnHeaderExtra?.(column)} />
                  <div className="flex flex-1 flex-col gap-2 px-2 pb-2">
                    {loading
                      ? [...Array(Math.min(column.count, 3) || 1)].map((_, index) => <CardSkeleton key={index} />)
                      : column.tasks.map((task) => <div key={task.id}>{renderCard(task)}</div>)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
    </section>
  );
}
