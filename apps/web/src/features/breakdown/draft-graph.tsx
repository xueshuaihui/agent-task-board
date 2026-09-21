import { useMemo } from 'react';
import type { BreakdownDraft } from '@/api/types';
import { DependencyGraphCanvas } from '@/features/dependency-graph/DependencyGraphCanvas';
import type { GraphEdgeInput, GraphTask } from '@/features/dependency-graph/layout';

/**
 * §7.3 待确认页流程图（v0.0.4 W7 遗留 b1）：草案节点 + 草案依赖边。
 *
 * 不另起渲染器——直接复用 W5 的 DependencyGraphCanvas（分层布局、缩放平移、
 * 环兜底红虚线都现成）：草案 ref 当任务 id 喂给它，depends_on 反向成边
 * （前置 → 被阻塞）。待确认草案没有看板状态，节点统一按 BACKLOG 底色呈现。
 */
export interface DraftFlowGraphProps {
  drafts: readonly BreakdownDraft[];
  className?: string;
  /** 点击节点 → 打开/切换草案详情编辑面板（§7.3「任务详情面板（点击节点展开）」）。 */
  onNodeSelect?: (ref: string) => void;
  /** 点击边 → 断开该依赖（§7.4；只在 reviewing 传入，否则边只读）。 */
  onEdgeRemove?: (from: string, to: string) => void;
}

export function DraftFlowGraph({ drafts, className, onNodeSelect, onEdgeRemove }: DraftFlowGraphProps) {
  const tasks = useMemo<GraphTask[]>(
    () =>
      drafts.map((draft) => ({
        id: draft.ref,
        title: draft.title,
        status: 'BACKLOG',
        priority: draft.priority,
        progress: null,
      })),
    [drafts],
  );
  const edges = useMemo<GraphEdgeInput[]>(
    () =>
      drafts.flatMap((draft) =>
        draft.depends_on.map((dep) => ({
          depId: `${dep}->${draft.ref}`,
          from: dep,
          to: draft.ref,
          type: 'blocks' as const,
        })),
      ),
    [drafts],
  );

  return (
    <div data-testid="breakdown-flow-graph" className={className}>
      <DependencyGraphCanvas
        tasks={tasks}
        edges={edges}
        onNodeClick={onNodeSelect}
        onEdgeClick={onEdgeRemove ? (edge) => onEdgeRemove(edge.from, edge.to) : undefined}
      />
    </div>
  );
}
