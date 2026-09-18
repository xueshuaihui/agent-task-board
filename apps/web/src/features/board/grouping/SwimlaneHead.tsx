import type { ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Swimlane } from './grouping';
import type { GroupingOptions } from './useGroupingState';

/**
 * 7.5 / 4.2 泳道头：折叠图标 + 分组图标 + 分组名 + 元信息（需求泳道）+ 统计 + 更多菜单挂点。
 * 拖拽排序（7.6）走 dnd-kit sortable：把手是左侧 grip，点 grip 拖动不影响折叠按钮。
 */
export interface SwimlaneHeadProps {
  lane: Swimlane;
  collapsed: boolean;
  options: Pick<GroupingOptions, 'collapsible' | 'showStats'>;
  onToggleCollapse: () => void;
  /** 7.5 ⋯ 挂点（GroupMoreMenu 由调用方传入，保持头组件与菜单解耦）。 */
  moreMenu?: ReactNode;
  /** 需求泳道的「查看需求」入口（4.2）；不传不渲染。 */
  onViewRequirement?: () => void;
}

/** 需求泳道头第二行：项目 · 优先级 · 进度（12px 灰，原型 4.2）。 */
function LaneMetaLine({ lane, onViewRequirement }: { lane: Swimlane; onViewRequirement?: () => void }) {
  if (!lane.meta) return null;
  const meta = lane.meta;
  const parts: ReactNode[] = [];
  if (meta.projectName) {
    parts.push(
      <span key="project" className="inline-flex items-center gap-1">
        <span
          className="inline-block size-2 rounded-full"
          style={meta.projectColor ? { backgroundColor: meta.projectColor } : undefined}
        />
        {meta.projectName}
      </span>,
    );
  }
  if (meta.priority !== null && meta.priority !== undefined) {
    parts.push(<span key="priority">P{meta.priority}</span>);
  }
  if (meta.progress && meta.progress.total > 0) {
    const pct = Math.round((meta.progress.done / meta.progress.total) * 100);
    parts.push(
      <span key="progress" className="inline-flex items-center gap-2">
        进度 {meta.progress.done}/{meta.progress.total}
        <span className="inline-block h-1.5 w-28 overflow-hidden rounded-full bg-bg-muted">
          <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </span>
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <div className="mt-0.5 flex items-center gap-2 pl-6 text-aux text-text-tertiary">
      {parts.map((part, index) => (
        <span key={index} className="inline-flex items-center gap-2">
          {index > 0 && <span>·</span>}
          {part}
        </span>
      ))}
      {onViewRequirement && (
        <button
          type="button"
          onClick={onViewRequirement}
          className="ml-2 rounded px-1.5 py-0.5 text-primary hover:bg-primary-light"
        >
          查看需求
        </button>
      )}
    </div>
  );
}

export function SwimlaneHead({
  lane,
  collapsed,
  options,
  onToggleCollapse,
  moreMenu,
  onViewRequirement,
}: SwimlaneHeadProps) {
  const sortable = useSortable({ id: `lane:${lane.key}`, data: { laneKey: lane.key } });
  const isRequirement = lane.dimension === 'requirement';

  return (
    <div
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Translate.toString(sortable.transform) }}
      className={cn(
        'flex items-start justify-between gap-4 rounded-t-[10px] border-b border-border bg-bg-muted px-5 py-4',
        sortable.isDragging && 'opacity-60',
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleCollapse}
            disabled={!options.collapsible}
            className="rounded p-0.5 text-text-secondary hover:bg-bg-raised disabled:opacity-40"
            aria-label={collapsed ? '展开泳道' : '折叠泳道'}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
          </button>
          <button
            type="button"
            {...sortable.attributes}
            {...sortable.listeners}
            className="cursor-grab rounded p-0.5 text-text-tertiary hover:text-text-secondary active:cursor-grabbing"
            aria-label="拖动调整泳道顺序"
          >
            <GripVertical size={14} />
          </button>
          <span aria-hidden>{lane.icon}</span>
          <span className="text-section-title text-text-primary">{lane.label}</span>
        </div>
        {isRequirement && !collapsed && <LaneMetaLine lane={lane} onViewRequirement={onViewRequirement} />}
      </div>

      <div className="flex shrink-0 items-center gap-3 text-aux text-text-tertiary">
        {options.showStats && (
          <>
            <span>
              {lane.count} {isRequirement ? '子任务' : '任务'}
            </span>
            <span>·</span>
            <span className={cn(lane.reviewCount > 0 && 'text-status-review')}>
              {lane.reviewCount} 待审核
            </span>
          </>
        )}
        {moreMenu}
      </div>
    </div>
  );
}
