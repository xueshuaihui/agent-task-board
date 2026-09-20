import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/cn';
import { statusLabel } from '@/lib/labels';
import { knownStatus } from '@/features/board/model';
import type { FlowDirection } from './view-prefs';

/**
 * 流程图节点（§6.4.3 节点规格）：180×88、圆角 8、边框 2px 状态色 30% 透明、
 * 左侧 4px 状态色条；ID + 标题 + 状态 + 优先级 + 阻塞数。
 *
 * 简化态（§6.4.9，节点数 ≥ 设置阈值）：180×44，只留左条 + ID + 标题，
 * 大图下减少布局与绘制成本；高亮环（关键路径 / 阻塞链）仍用描边表达，不丢语义。
 *
 * 高亮互斥优先级：阻塞链（红）> 关键路径（橙）> 选中（主色）——问题状态优先于导航状态。
 * 聚焦/多选淡出用 `dimmed`（§6.4.7 聚焦模式只保留链路，其余整卡降透明）。
 */

export const FLOW_NODE_WIDTH = 180;
export const FLOW_NODE_HEIGHT = 88;
export const FLOW_NODE_SIMPLE_HEIGHT = 44;

/** 状态 → 色 token（与 lib/status-style.ts 同源的一批 @theme 变量，颜色不落 hex 字面量）。 */
const STATUS_VAR: Record<string, string> = {
  BACKLOG: 'var(--color-status-backlog)',
  READY: 'var(--color-status-ready)',
  RUNNING: 'var(--color-status-running)',
  BLOCKED: 'var(--color-status-blocked)',
  REVIEW: 'var(--color-status-review)',
  DONE: 'var(--color-status-done)',
  FAILED: 'var(--color-status-failed)',
};
const STATUS_VAR_FALLBACK = 'var(--color-status-blocked)';

export function statusColor(status: string): string {
  const known = knownStatus(status);
  return (known && STATUS_VAR[known]) || STATUS_VAR_FALLBACK;
}

export interface TaskFlowNodeData extends Record<string, unknown> {
  taskId: string;
  /** 布局方向：决定 Handle 落在上/下（TB）还是左/右（LR）。 */
  direction: FlowDirection;
  title: string;
  status: string;
  priority: number;
  progress: number | null;
  blockedCount: number;
  agentName: string | null;
  simplified: boolean;
  onCritical: boolean;
  onBlocking: boolean;
  dimmed: boolean;
}

function handlePositions(direction: FlowDirection) {
  return direction === 'LR'
    ? { target: Position.Left, source: Position.Right }
    : { target: Position.Top, source: Position.Bottom };
}

export function TaskFlowNode({ data, selected }: NodeProps) {
  const node = data as TaskFlowNodeData;
  const positions = handlePositions(node.direction === 'LR' ? 'LR' : 'TB');
  const color = statusColor(node.status);
  const highlight = node.onBlocking
    ? 'var(--color-status-failed)'
    : node.onCritical
      ? 'var(--color-status-running)'
      : undefined;

  const border = highlight
    ? highlight
    : selected
      ? 'var(--color-primary)'
      : `color-mix(in srgb, ${color} 30%, transparent)`;

  return (
    <div
      className={cn(
        'relative rounded-[8px] border-2 bg-bg-surface shadow-card transition-opacity',
        node.dimmed && 'opacity-30',
        selected && 'ring-2 ring-primary/40',
      )}
      style={{
        width: FLOW_NODE_WIDTH,
        height: node.simplified ? FLOW_NODE_SIMPLE_HEIGHT : FLOW_NODE_HEIGHT,
        borderColor: border,
      }}
      data-testid={`flow-node-${node.taskId}`}
    >
      <Handle
        type="target"
        position={positions.target}
        className="!size-2 !border-0 !bg-border-strong"
      />
      <Handle
        type="source"
        position={positions.source}
        className="!size-2 !border-0 !bg-border-strong"
      />
      {/* 左侧 4px 状态色条（§6.4.3）：绝对定位盖圆角左缘。 */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-1 rounded-l-[6px]"
        style={{ background: color }}
      />
      {node.simplified ? (
        <div className="flex h-full min-w-0 flex-col justify-center gap-0.5 pl-3 pr-2">
          <span className="truncate font-mono text-[10px] leading-none text-text-tertiary">
            {node.taskId}
          </span>
          <span className="truncate text-[12px] font-medium leading-tight text-text-primary">
            {node.title}
          </span>
        </div>
      ) : (
        <div className="flex h-full min-w-0 flex-col gap-1 px-3 py-2">
          <div className="flex items-center justify-between gap-1">
            <span className="truncate font-mono text-[10px] leading-none text-text-tertiary">
              {node.taskId}
            </span>
            <span
              className="shrink-0 rounded-badge px-1 text-[9px] font-semibold"
              style={{ color: `var(--color-priority-${[0, 1, 2, 3].includes(node.priority) ? node.priority : 3})` }}
            >
              {`P${node.priority}`}
            </span>
          </div>
          <span className="line-clamp-2 text-[12px] font-medium leading-tight text-text-primary">
            {node.title}
          </span>
          <div className="mt-auto flex items-center gap-1.5 text-[10px] leading-none text-text-secondary">
            <span aria-hidden className="size-2 rounded-full" style={{ background: color }} />
            <span className="truncate">{statusLabel(node.status)}</span>
            {node.blockedCount > 0 ? (
              <span className="ml-auto shrink-0 text-status-failed">{`🔒${node.blockedCount}`}</span>
            ) : node.agentName ? (
              <span className="ml-auto shrink-0 truncate text-text-tertiary">{node.agentName}</span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
