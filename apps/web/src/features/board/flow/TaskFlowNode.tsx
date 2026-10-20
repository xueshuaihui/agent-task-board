import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/cn';
import { statusLabel } from '@/lib/labels';
import { knownStatus } from '@/features/board/model';
import { progressReportDisplay } from '../progress-staleness';
import { isRunningStatus } from './flow-motion';
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
 *
 * 运行态（Issue #7）：仅 RUNNING 节点带 `is-running`——根节点呼吸光晕
 * （box-shadow 动画）+ SVG 覆盖层流动虚线描边（stroke-dashoffset，画在节点外侧、
 * 绝对定位不占布局）；简化态不画复杂描边，改用右上角脉冲圆点。
 * 非 RUNNING 节点不挂运行态 class，视觉与原先一致。
 *
 * 进度展示（Issue #6）：`progress` 非 null 时在节点内画细条 + 百分比；
 * 简化态只画 1px 小条、百分比并进 ID 行。两种形态都不改外部高度契约
 * （FLOW_NODE_HEIGHT / FLOW_NODE_SIMPLE_HEIGHT），靠压缩行距保证不溢出。
 * `progressUpdatedAt` 只做原生 title 提示，不是交互。
 */

export const FLOW_NODE_WIDTH = 180;
export const FLOW_NODE_HEIGHT = 88;
export const FLOW_NODE_SIMPLE_HEIGHT = 44;
/** 运行态虚线描边相对节点外扩的像素（画在覆盖层里，不参与布局）。 */
const RUNNING_RING_OVERHANG = 3;
/** 节点边框宽度（border-2）：绝对定位子元素的包含块是 padding box，需补偿。 */
const NODE_BORDER_WIDTH = 2;

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
  /** #6：最后一次进度上报时间（ISO；历史 Run 可能为 null），仅用于进度条 title。 */
  progressUpdatedAt: string | null;
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

/** 进度百分比兜底：四舍五入并夹到 0~100，脏数据不会把条画出节点。 */
function progressPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function TaskFlowNode({ data, selected }: NodeProps) {
  const node = data as TaskFlowNodeData;
  const positions = handlePositions(node.direction === 'LR' ? 'LR' : 'TB');
  const color = statusColor(node.status);
  const running = isRunningStatus(node.status);
  const height = node.simplified ? FLOW_NODE_SIMPLE_HEIGHT : FLOW_NODE_HEIGHT;
  const highlight = node.onBlocking
    ? 'var(--color-status-failed)'
    : node.onCritical
      ? 'var(--color-status-running)'
      : undefined;
  // #6：progress 非 null 才画条；progressUpdatedAt 只进原生 title（历史 Run 可为 null）。
  const percent =
    node.progress === null || node.progress === undefined || !Number.isFinite(node.progress)
      ? null
      : progressPercent(node.progress);
  const report = percent === null ? null : progressReportDisplay(node.progressUpdatedAt);
  const progressTitle = report?.text
    ? `${report.text}${report.stale ? '，可能已停滞' : ''}`
    : undefined;

  const border = highlight
    ? highlight
    : selected
      ? 'var(--color-primary)'
      : `color-mix(in srgb, ${color} 30%, transparent)`;

  return (
    <div
      className={cn(
        'atb-flow-node relative rounded-[8px] border-2 bg-bg-surface shadow-card transition-opacity',
        running && 'is-running',
        node.dimmed && 'opacity-30',
        selected && 'ring-2 ring-primary/40',
      )}
      style={{
        width: FLOW_NODE_WIDTH,
        height,
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
      {/* 运行态流动虚线描边（Issue #7）：SVG 覆盖层，stroke-dashoffset 动画不占布局。 */}
      {running && !node.simplified ? (
        <svg
          aria-hidden
          className="atb-flow-node-ring"
          width={FLOW_NODE_WIDTH + RUNNING_RING_OVERHANG * 2}
          height={height + RUNNING_RING_OVERHANG * 2}
          viewBox={`0 0 ${FLOW_NODE_WIDTH + RUNNING_RING_OVERHANG * 2} ${height + RUNNING_RING_OVERHANG * 2}`}
          style={{
            left: -(RUNNING_RING_OVERHANG + NODE_BORDER_WIDTH),
            top: -(RUNNING_RING_OVERHANG + NODE_BORDER_WIDTH),
          }}
        >
          <rect
            x={0.75}
            y={0.75}
            width={FLOW_NODE_WIDTH + RUNNING_RING_OVERHANG * 2 - 1.5}
            height={height + RUNNING_RING_OVERHANG * 2 - 1.5}
            rx={9}
            ry={9}
          />
        </svg>
      ) : null}
      {/* 简化态没有状态行，用右上角脉冲圆点表达运行中（Issue #7）。 */}
      {running && node.simplified ? (
        <span
          aria-hidden
          className="atb-flow-status-dot absolute right-2 top-2 size-1.5 rounded-full"
          style={{ background: 'var(--color-status-running)' }}
        />
      ) : null}
      {node.simplified ? (
        <div
          className={cn(
            'flex h-full min-w-0 flex-col justify-center gap-0.5 pl-3',
            running ? 'pr-5' : 'pr-2',
          )}
        >
          <div className="flex min-w-0 items-center justify-between gap-1">
            <span className="truncate font-mono text-[10px] leading-none text-text-tertiary">
              {node.taskId}
            </span>
            {percent !== null ? (
              <span className="shrink-0 font-mono text-[9px] leading-none text-text-secondary">
                {percent}%
              </span>
            ) : null}
          </div>
          <span className="truncate text-[12px] font-medium leading-tight text-text-primary">
            {node.title}
          </span>
          {percent !== null ? (
            <NodeProgressTrack percent={percent} color={color} title={progressTitle} thin />
          ) : null}
        </div>
      ) : (
        <div
          className={cn(
            'flex h-full min-w-0 flex-col px-3',
            // 有进度条时压缩行距腾出 13px；无进度条维持原间距（#7 视觉不变）。
            percent !== null ? 'gap-0.5 py-1.5' : 'gap-1 py-2',
          )}
        >
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
          {percent !== null ? (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center justify-between gap-1 text-[9px] leading-none">
                <span className="text-text-tertiary">进度</span>
                <span className="font-mono text-text-secondary">{percent}%</span>
              </div>
              <NodeProgressTrack percent={percent} color={color} title={progressTitle} />
            </div>
          ) : null}
          <div className="mt-auto flex items-center gap-1.5 text-[10px] leading-none text-text-secondary">
            <span aria-hidden className="atb-flow-status-dot size-2 rounded-full" style={{ background: color }} />
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

/** 节点内进度细条（#6）：正常态 2px、简化态 1px，宽度夹在 0~100%。 */
function NodeProgressTrack({
  percent,
  color,
  title,
  thin = false,
}: {
  percent: number;
  color: string;
  title?: string;
  thin?: boolean;
}) {
  return (
    <div
      aria-hidden
      title={title}
      className={cn(
        'atb-flow-progress w-full overflow-hidden rounded-full bg-bg-muted',
        thin ? 'h-px' : 'h-0.5',
      )}
    >
      <div className="h-full rounded-full" style={{ width: `${percent}%`, background: color }} />
    </div>
  );
}
