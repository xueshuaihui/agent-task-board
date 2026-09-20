import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { cn } from '@/lib/cn';
import { DEPENDENCY_TYPE_LABEL } from '@/lib/labels';

/**
 * 流程图连线（§6.4.4 连线规格 + §6.4.10「边 label / edgeLabelRenderer」）：
 * - blocks 实线 2px、relates 虚线 2px；
 * - 关键路径加粗 3px 橙、阻塞链红色；悬停高亮主色（globals.css 的 `.atb-flow-edge:hover`）；
 * - label 用 EdgeLabelRenderer 画在 DOM 层，标注依赖类型中文；箭头由视图层
 *   `markerEnd: MarkerType.ArrowClosed`（颜色与描边同档）给出。
 */

export interface FlowEdgeData extends Record<string, unknown> {
  depType: 'blocks' | 'relates';
  onCritical: boolean;
  onBlocking: boolean;
  dimmed: boolean;
}

export function DependencyEdge(props: EdgeProps) {
  const data = props.data as FlowEdgeData | undefined;
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
  });
  const critical = data?.onCritical === true;
  const blocking = data?.onBlocking === true;
  const dashed = data?.depType === 'relates';

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        className={cn('atb-flow-edge', data?.dimmed && 'atb-flow-edge--dimmed')}
        style={{
          strokeWidth: critical ? 3 : 2,
          strokeDasharray: dashed ? '6 4' : undefined,
          stroke: blocking
            ? 'var(--color-status-failed)'
            : critical
              ? 'var(--color-status-running)'
              : 'var(--color-border-strong)',
        }}
        markerEnd={props.markerEnd}
      />
      <EdgeLabelRenderer>
        <div
          className={cn(
            'pointer-events-none absolute rounded-tag border border-border bg-bg-surface px-1 text-[10px] leading-4 text-text-tertiary',
            data?.dimmed && 'opacity-30',
          )}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {DEPENDENCY_TYPE_LABEL[data?.depType ?? 'blocks']}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
